---
'@paparats/server': patch
---

arch_context: surface card id in every result line

The formatted `arch_context` tool output now includes the card id next to each component, decision, and lesson, e.g. `**file indexer** (id ` + "`" + `01926abc-...` + "`" + `, 4d ago, score 0.62) — Indexes files...`. Without this, a caller had no way to obtain ids from the tool output and could not invoke `arch_delete`. The renderer is extracted into `renderArchContextSection` so the contract is regression-tested.
