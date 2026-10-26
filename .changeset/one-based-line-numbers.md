---
'@paparats/server': patch
'@paparats/cli': patch
---

Line numbers in tool output now count from 1, as editors and `grep -n` do. Chunks store lines from 0, and `search_code`, `get_chunk`, `find_usages`, `change_impact` and the support tools printed the stored values, so every `file:line` pointed one line above the code: a chunk shown as `:30-54` started on line 31. `paparats search` had the same offset. JSON from the HTTP API is unchanged.
