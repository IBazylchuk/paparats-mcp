---
'@paparats/server': patch
---

Code in `search_code`, `get_chunk`, `search_changes` and the analytics tools is fenced with more backticks than any run inside it, so a chunk holding ``` can no longer close the block and have the rest read as part of the answer.
