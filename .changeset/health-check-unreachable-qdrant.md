---
'@paparats/server': patch
---

`health_check` now says when Qdrant cannot be reached, with the reason (`ECONNREFUSED`, `ENOTFOUND`, ...) and the setting to check, instead of returning Node's bare `fetch failed`.
