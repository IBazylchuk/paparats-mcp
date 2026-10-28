---
'@paparats/server': patch
---

Chunk ids in tool output are code spans (`` chunk: `id` ``) instead of italics (`_chunk: id_`). Agents copied the closing `_` with the id, and `get_chunk`, `find_usages`, `change_impact` and `get_chunk_meta` then answered "Chunk not found": in an A/B run on a private codebase, 35 of 56 calls taking a chunk id failed this way. Those tools now also read an id with a trailing `_` or the backticks around it.
