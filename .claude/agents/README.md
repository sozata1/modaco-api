# Agents

Five roles, split by what the work on this project actually divides into rather than by
what sounds thorough. Each carries the specific mistakes that role has made here, so the
knowledge lives with the job instead of in one person's memory.

| Agent | Model | Why that model |
|---|---|---|
| `implementer` | sonnet | Realising a decided design is mostly careful, high-volume work |
| `reviewer` | opus | Judging whether a change breaks an invariant needs the deepest reasoning available |
| `db-analyst` | opus | Query-plan analysis is where confident wrong answers cost the most |
| `verifier` | sonnet | Running things and reporting faithfully; the discipline is procedural, not analytical |
| `docs-editor` | haiku | Consistency and plain-language editing over material that already exists |

A typical change: `db-analyst` measures, `implementer` writes, `verifier` runs it,
`reviewer` judges, `docs-editor` reconciles the prose.

Keeping `reviewer` and `implementer` apart is the point of the split. An agent that has
just written something is the worst judge of whether it is right, and in practice it
rewrites the test rather than the code.
