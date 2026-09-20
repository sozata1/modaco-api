# Form 5 — AI Interaction Summary

## 1. Tool Manifest

| Model / Tool | Primary purpose | Effectiveness (1–5) |
|---|---|---|
| **Claude Opus 5** (via Claude Code CLI) | Implementation partner: architecture review, schema design, test authoring, running the stack and interpreting results | **5** — the biggest advantage was not code generation, but being able to run and verify what it produced. Every significant correction below came from a command's output, not from re-reading the code |
| **Claude Opus 4.6** (chat, earlier session) | Produced the initial implementation plan from the case study | **2** — structurally reasonable, but confidently wrong in a few specific, checkable ways. It looked finished, which is what made it dangerous. Section 3 lists what survived review |
| **Gemini 3.1 Pro** | Second opinion across long context: the case, the plan, the ADR drafts and the measurement logs read together, looking for contradictions across the documents rather than defects within a single file. | **4** — caught drift no single-file review would see. No help on anything needing execution, which is where most of section 3 came from |
| **Claude Code subagents** (`.claude/agents/`) | Database analysis and code review were run as separate agents against the finished code, rather than by the agent that wrote it | **4** — the review pass produced findings the implementing agent had not raised about its own work, two of which turned out to be real and measurable. Details in section 3 |

---

## 2. AI Tool Usage Approach

| Phase | Prompting strategy | Human refinement |
|---|---|---|
| **Auditing the plan** | Gave the case, the AI's plan and this form together and asked for the plan to be *attacked*, not summarised — with ten concerns of my own attached: ORM overhead, where effective price should live, Redis versus a plain index, the ambiguity in "one promotion per product" | I rejected the read-path design and changed the approach. Forced the one-promotion rule to become a database constraint instead of an `ORDER BY … LIMIT 1` |
| **Decide, then prove** | I pushed the models beyond ‘it depends’ or ‘this should be fast’. Every options table had to end in a recommendation; every claim about the database had to be executed and its output pasted back | Produced every finding in section 3. Four defects appeared within seconds of running code that read correctly |
| **Questioning the stack** | The plan chose Prisma without examining it. I was the one who questioned this choice. An ORM between the application and queries this tuned looked like it would cost more than it returned. I asked the model to argue against using it | Moved to Kysely — Prisma cannot express `LATERAL` at all, which would have pushed every important query into untyped raw SQL |
| **Supplying what was missing** | Observability appeared nowhere in the plan: no logging, no metrics, no error contract, no shutdown. I specified it and asked for it to be designed in, not bolted on | Became ADR-010. Adding `price_projection_lag_seconds` exposed the unbounded reconciler sweep — the metric had to be cheap, and it was not |
| **Scenario A** | Pushed back on the orchestrator: streaming the whole file to split it moves the timeout risk, it does not remove it. Asked for something whose runtime is independent of file size | Byte-range splitting where the splitter never opens the file, plus a self-handoff when a worker nears its deadline |
| **Splitting the work** | Defined roles in `.claude/agents/` and ran database analysis and review as separate read-only agents over the finished code, on a stronger model. Shared standards live in a 54-line `AGENTS.md` | Caught the reconciler's full-table scan and the projector's missing index — both in code the implementing agent had already reviewed |

**The two most critical prompts.**

1. *"Go through these files one by one. Is the implementation plan sufficient? Find anything
   in it that is used incorrectly or inadequately"* — followed by ten specific concerns.

   Framing it as an audit with my own suspicions attached is what surfaced section 3. A
   neutral "review this plan" produces praise and a few nits.

2. *"Explain the +/- of each option, pick one, and justify it against the others — decide
   from test results."*

   Applied to effective-price storage and to Redis-versus-index. It turned a
   plausible-sounding design document into decisions with measurements behind them, and it
   is why the ADR records rejected alternatives rather than only the path taken.

---

## 3. Judgement, Challenges & Verification

### The biggest architectural mistake

**The plan worked out the discounted price while reading, and then sorted by it.**

Every `GET /products?sort=effective_price` was to compute each product's price with a
`LEFT JOIN LATERAL` and sort the results. On the busiest endpoint, during the busiest event
the case describes. The plan presented this as the solution to the effective-price
requirement.

It makes the requirement unsatisfiable. To know which twenty products are
cheapest you have to work out all of them first, so `LIMIT 20` saves nothing and no index
can help.

I did not spot this by reading it. The explanation was fluent and it came with a confident
note about LATERAL being an optimisation. What exposed it was a narrower question: *which
index serves this ORDER BY?* There is none, and there cannot be one, because the column
does not exist.

Measured on 83,331 products in one category, first page of twenty:

| | Time | Buffers |
|---|---:|---:|
| Materialized column with a composite index | **4.3 ms** | 23 |
| The plan's read-time `LATERAL` approach | **3,353 ms** | 185,885 |

The fix was not to remove the LATERAL join, but to move that work. It now runs on the **write**
path, once per promotion change, instead of once per request. That restructuring is what
turned Scenario B from an endpoint that collapses under its own listing query into one where the expensive work is spread over the write path and reads never wait for it.

The same mistake in a different costume appeared in Scenario A: the plan's orchestrator
streamed the entire 500K-row file inside one invocation in order to split it, which moves
the timeout risk rather than removing it. The splitter now never opens the file at all.

**A business rule that was not enforced anywhere.** "At most one active promotion" was
implemented as `ORDER BY created_at DESC LIMIT 1` plus a warning in the response. That
hides violations instead of preventing them — the table still holds however many overlap.
Checking in application code does not fix it either: `SELECT`-then-`INSERT` is a race, and
a flash sale is exactly when concurrent writes arrive. Now an `EXCLUDE USING gist`
constraint, tested with two concurrent transactions: one commits, one gets `23P01`.

**One confident generalisation that turned out to be wrong.** The plan treated pre-computation as an anti-pattern and rejected it outright. Its three reasons all describe doing 50K updates
inside the HTTP request; applied asynchronously in batches, none of them apply. Its fourth
reason, that pre-computation cannot handle newly created products, was false — a product created during an active 50%-off sale immediately returns `125.00` from a base price of `249.99` even in the same response that creates it.

**A row-loss bug in my own chunking logic, caught before it ever ran.** Reconstructing a file
from independently-parsed chunks gave 199 rows out of 200. When a chunk boundary lands
exactly on a line start, that line looks partial to the next chunk and falls outside the
previous one's range. Each worker now reads one byte before its range to tell the two cases
apart. Verified at nine chunk sizes, then at 500K rows: 499,991 stored, exactly 500,000
minus 9 deliberately malformed.

### Found only by running it

I would not have found these issues by code review alone. They are the argument for making the AI
execute its own claims rather than reviewing them harder.

- **`CREATE INDEX … WHERE ends_at > NOW()`** — plausible, well justified, and rejected
  outright by PostgreSQL: *functions in index predicate must be marked IMMUTABLE*.
- **Every ranged S3 read failed** with `Checksum mismatch: expected "wkL/cQ==" but received
  "xLGsng=="`. Nothing was corrupt. S3 stores a checksum of the whole object and the SDK
  was comparing it against one slice.
- **A review subagent flagged the reconciler**, could not prove it, and handed the claim to
  the database analyst. It cost **3.2 s and 519,208 buffers every minute** to return zero
  rows. The buffer count was the bigger problem: a million touches a minute evicts the
  storefront's hot pages, so the safety net was degrading the cache it protects. Now
  36.9 ms. The same pass found the projector walking the primary key and discarding five
  sixths of what it read.
- **My first fix for that did not work.** The bounded window was ordered by
  `price_computed_at`, so repairing a row would send it to the back of the queue. The queue did not actually make progress: a row found *correct* is never rewritten, so its timestamp never moves. 100
  corrupted rows sat unrepaired for 160 seconds. Progress has to come from the scan, not
  the repair.
- **The reconciler could not see the drift it existed to catch.** `ON DELETE SET NULL`
  clears the promotion id but leaves the discounted price, so the row reads NULL against
  NULL and looks correct. Products sat at 5.00 against a base of 9.99 while the lag gauge
  reported 0. A safety net that checks a proxy for correctness will miss exactly the cases
  that bypass the proxy.
- **Two workloads with opposite needs on one Redis**, surfaced by a startup warning:
  `Eviction policy is allkeys-lru. It should be "noeviction"`. A cache should evict under
  pressure; a queue must not. The policy is per instance, so one instance means choosing
  which of them is allowed to be wrong.
- **The parity test failed on its first run for a reason neither of us predicted.** SQL
  returned `"27479821318"`, TypeScript returned `27479821318`. The formulas agreed; the
  types did not. `node-postgres` returns BIGINT as a string, which in production is string
  concatenation inside a price calculation.
- **Two smaller issues showed the same pattern.** The API crashed before listening because `NODE_ENV`
  decided the log format and the production image has no `pino-pretty`. Consumers
  crash-looped because LocalStack's healthcheck proved SQS was answering, not that its
  bootstrap had finished.

## 4. Overall Reflection

**Ratio: roughly 65% AI-generated, 35% mine.**

By line count it is closer to 80/20 in the AI's favour, but that counts the wrong thing.
The decisions that actually shape this system — putting the one-promotion rule in a
database constraint, storing the effective price instead of working it out on every read,
splitting the file by byte offset, keeping money in integers — all came out of pushing back
on the first answer I got. I did not write most of the code. I wrote most of the arguments.

**What surprised me.** I expected the failure mode to be bad code. It was not. Most of the
code was fine. The problem was that the wrong answers arrived with exactly the same
confidence as the right ones, usually with a justification attached that sounded sensible.
The unusable index came with a performance rationale. The read-time join was described as
the solution to the requirement it makes impossible. Skimming, I would have accepted all of
it, and I did accept some of it for a while.

What helped was not reading more carefully. It was refusing to let anything stand that I
could check instead. Several of the findings in section 3 only exist because something was
running: a checksum error on a ranged read, a string where a number should have been, a
warning Redis prints at startup, a container that had been rebuilt but never restarted.
Review does not find those, however good the reviewer is.

