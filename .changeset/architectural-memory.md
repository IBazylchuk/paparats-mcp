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
