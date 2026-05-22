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

**Min-score threshold for reads.** `arch_context` accepts a `min_score` parameter
(default `0.45`, cosine over [bge-m3](https://ollama.com/library/bge-m3)). Hits below
the threshold are dropped, and the tool returns an explicit low-confidence hint when
nothing matched — the agent now knows to rephrase or lower `min_score` instead of
inventing context.

**No memory rot.** Every card carries an `updated N ago` stamp **and a cosine score**
in `arch_context` output. The support-mode system prompt instructs the agent to verify
stale cards (>90 days) against current code and update or supersede them.

**`arch_context` is now read-only on the coding endpoint too** (`/mcp`). Refactors
need to know about prior decisions before renaming or moving code. Writes
(`arch_record_*`) remain support-only — recording belongs to the architectural-review
workflow, not to every line edit.

**Workflow prompts** for the boring scaffolding:

- **`init_arch_memory`** — `/init`-style first-run bootstrap. Walks the repo, identifies
  8-20 components by domain boundary, writes them, captures obvious decisions.
- **`audit_architecture`** — sweep stale cards, verify anchors against live code,
  surface a punch list of updates and supersedes.
- **`record_lesson_from_correction`** — convert a user correction into a structured
  lesson card without overrecording typos.

**MCP resources** for live introspection:

- **`arch://schema`** — full card-schema reference.
- **`arch://stats/{group}`** — live counts (total / by kind / by status) plus
  oldest/newest `updatedAt`.

**Prometheus metrics** (opt-in via `PAPARATS_METRICS=true`):

- `paparats_arch_context_calls_total{group}` — counter
- `paparats_arch_write_total{kind, status}` — counter (every gate outcome is labelled)
- `paparats_arch_search_score` — histogram of cosine scores returned by `arch_context`
- `paparats_arch_collection_size{group, kind, status}` — gauge

**Four new MCP tools** on the support endpoint (`/support/mcp`): `arch_context`,
`arch_record_component`, `arch_record_decision`, `arch_record_lesson`. Cards live in
a separate Qdrant collection per group (`paparats_<group>_arch`), embedded with
`bge-m3` (1024d, mean-pooled, multilingual) — the code index is untouched.

Keywords: architectural memory, ADR memory, decision records, lessons learned,
living architecture, Reflexion, agent memory, knowledge base, cross-session continuity,
init prompt, /init, audit, observability, Prometheus metrics, min_score, threshold.
