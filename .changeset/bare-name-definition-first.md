---
'@paparats/server': patch
---

`search_code` puts the definition first when the query is only a name (`charge_card`, `Billing::Invoice`). A short chunk that imports, re-exports or explains the name could score well above the code that defines it; for such a query the defining chunk is now raised ×1.25 instead of ×1.1. On 50 bare-name queries built from a private Ruby codebase (a name defined in one file and used in at least two others), the defining file came first for 80% of them instead of 62%; on this repository's query set the right file came first for 79% of all queries instead of 75%. The other query sets have no bare-name queries and did not change.
