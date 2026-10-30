---
'@paparats/server': patch
'@paparats/cli': patch
---

`search_code` shows every result whole again: results past the third were cut to their first 15 lines, and agents fetched almost every cut one with `get_chunk`, a step more each time. `Called from:` now says which method of each caller calls which name of the result (`perform` → `write`), so the callers of one method of a class are not taken for the callers of another; the instructions say so.
