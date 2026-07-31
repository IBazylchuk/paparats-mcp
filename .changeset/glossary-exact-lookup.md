---
'@paparats/server': patch
---

Fix `term_search` returning an unrelated entry for a bare acronym, and never reporting "not found".

Glossary lookups now match canonical names and aliases exactly (case- and space-insensitive) before falling back to vector search, and the fallback applies a relevance floor. A bare acronym is the commonest glossary query and the one the embedder handles worst — measured on a 75-term glossary, one acronym ranked its own entry 21st while an unrelated metric took the top slot. Canonical names take priority over aliases, and an alias shared by several terms returns all of them.
