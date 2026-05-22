---
'@paparats/server': minor
'@paparats/cli': minor
'@paparats/indexer': minor
'@paparats/shared': minor
---

**Architectural memory — a living knowledge base your agent maintains itself.**

Code search tells the agent **what** the code does. The new architectural memory layer
tells it **why** — and the agent writes it as it learns, reads it before every
architectural answer, and keeps it clean without you authoring a single doc.

**Three strict card kinds**, each in its own field-by-field shape so the agent
records facts instead of inventing prose:

- **Components** — `name`, plus a markdown summary with `Does / Owns / Does not / Touched when`.
- **Decisions** (ADR-style) — `title`, `context`, `decision`, `alternatives_rejected`,
  `consequences`.
- **Lessons** (Reflexion-style) — `rule`, `why`, `when`.

**Server-side similarity gate** keeps the store clean without trusting the client:
every write runs nearest-neighbour search against the same group first.
Cosine **≥ 0.85** is a duplicate (decisions refused, lessons bump `updatedAt` as
"rule confirmed"); **0.70 – 0.85** is similar and surfaced so the agent can refine or
chain a `supersedes`; below 0.70 is a new card. `supersedes` links bypass the gate
and mark prior decisions as `status=superseded` so they disappear from default search
but stay in history.

**No memory rot.** Every card carries an `updated N ago` stamp in `arch_context`
output, and the support-mode system prompt instructs the agent to verify stale cards
(>90 days) against current code and update or supersede them.

**Four new MCP tools** on the support endpoint (`/support/mcp`): `arch_context`,
`arch_record_component`, `arch_record_decision`, `arch_record_lesson`. Cards live in
a separate Qdrant collection per group (`paparats_<group>_arch`), embedded with
`bge-m3` (1024d, mean-pooled, multilingual) — the code index is untouched.

Keywords: architectural memory, ADR memory, decision records, lessons learned,
living architecture, Reflexion, agent memory, knowledge base, cross-session continuity.
