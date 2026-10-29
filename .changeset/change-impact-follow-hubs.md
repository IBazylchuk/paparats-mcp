---
'@paparats/server': patch
---

`change_impact` follows code called from many places (`[hub]`) instead of stopping there: through the methods it is reached by, after the rest of its step, so when `limit` runs out what lies behind hubs goes first. A hub reached as a whole chunk is still not followed.
