---
'@paparats/server': minor
'@paparats/cli': minor
'@paparats/indexer': minor
'@paparats/shared': minor
---

Add architectural memory layer — a second Qdrant collection per group storing
components, decisions, and lessons embedded with a text model. New MCP tools
(support mode): `arch_context`, `arch_record_component`, `arch_record_decision`,
`arch_record_lesson`. Initialisation is agent-driven via server instructions.

Card formats are now strict and structured:
- Components carry a markdown summary with `Does / Owns / Does not / Touched when`.
- Decisions split into `context / decision / alternatives_rejected / consequences`.
- Lessons split into `rule / why / when` (replaces the previous freeform `summary`).

Writes go through a server-side similarity gate. Decisions and lessons run
nearest-neighbour search against the same group before persisting; near-duplicates
(cosine >= 0.85) are refused for decisions and bump `updatedAt` for lessons,
similar matches (>= 0.70) are surfaced so the agent can refine or supersede.
`arch_context` now renders each card with an "updated N ago" age stamp so the
agent can spot stale memory.
