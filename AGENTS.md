# ModaCo — agent rules

Keep this short. It enters context on every request.

## Stack
Node 22 · TypeScript strict (ESM, NodeNext) · Express · PostgreSQL 16 · Kysely + `pg` · Redis · BullMQ · SQS/S3 · Vitest

## Commands
`npm run build` · `npm test` · `npm run test:e2e` (needs the stack) · `npm run lint`
`npm run up` / `npm run down` (docker) · `npm run seed` · `npm run feed -- 500000` · `npm run bench:detail`

## Roles
`.claude/agents/` defines five: implementer, reviewer, db-analyst, verifier, docs-editor.
Keep reviewer and implementer separate — an agent that just wrote something rewrites the
test rather than the code. `.claude/skills/` holds the two procedures worth not
rediscovering: `stack` (ports are remapped; `--build` alone does not recreate a container)
and `db-explain` (measure a plan, never reason about one).

## Layers — ESLint enforces this, it is not a suggestion
- `packages/core` is **pure domain**: no DB, Redis, HTTP, AWS or fs imports. Take data as parameters.
- `packages/db` owns the schema and repositories. SQL lives here.
- `apps/*` are separate deployment units. They never import each other; shared code moves to `packages/*`.
- Pricing rules exist **only** in `packages/core`. The API and the Lambda call the same function.

## Invariants — a change that breaks one of these is wrong, not clever
- Money is **integer cents** (`BIGINT`). No floats, no Decimal. Percentages are basis points.
- `applyDiscount()` (TS) ≡ `apply_discount()` (SQL). Change one, change the other; a parity test guards it.
- "At most one active promotion" is enforced by an `EXCLUDE` constraint **in the database**.
  Never write SELECT-then-INSERT for it (TOCTOU).
- No `NOW()` in a partial-index predicate — PostgreSQL rejects non-immutable functions there.
- Pagination is **keyset**. No `OFFSET`.
- Redis is a **cache**, never a source of truth. A Redis failure must not produce a 5xx; fail open to the DB.
- Cache invalidation is a **version bump** (`INCR`). No pattern delete via `KEYS`/`SCAN`.

## Code
- No `any`. Use `unknown` and narrow.
- Every error crossing a boundary derives from `AppError`. HTTP bodies are RFC 7807; stacks never leak.
- On hot paths (500K rows) return a `Result`, do not throw.
- No `console.*` — use the `pino` logger.
- Validate external input with `zod`.

## Comments
- A comment explains **why**, not **what**. The code already says what it does.
- Do not comment self-evident code. Do not keep a changelog in comments; git has one.
- Worth a comment: a rejected alternative, a counter-intuitive decision, an external system's quirk, an ADR reference.
- JSDoc only on public APIs and ports.

## Tests
- A domain rule gets a `packages/core` unit test. Write the boundary cases.
- SQL/TS equivalence gets a property-based test against a real database.
- API and repository tests use Testcontainers. Do not mock the database.
- Anything crossing a process boundary — S3 notifications, SQS, the queue, the workers —
  gets an `*.e2e.test.ts` against the running stack. Every defect that reached a running
  system here lived in that gap.
