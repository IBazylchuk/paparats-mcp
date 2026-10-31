---
'@paparats/server': patch
---

Less context for the same answers. `search_code` lists a chunk it already returned in the session by its location and chunk id, without the code again (`get_chunk` shows it). The coding instructions are half as long: what the docs, glossary and memory tools' own descriptions already say is no longer repeated there. They now say to grep exact text (an error message, a field name) first, and to get the chunk id of a known name with `limit` 1.
