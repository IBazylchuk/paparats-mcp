---
'@paparats/server': patch
---

`search_changes` and `recent_changes` read a relative `since` ("7 days ago", "2 weeks", "yesterday"), which their prompts suggest: before, it went to Qdrant as is and the query failed. A date neither ISO 8601 nor relative gets a message saying what to pass. `find_usages` reads a `called_by` / `referenced_by` filter as `calls` / `references`; those types were offered but no edge carried them, so the filter returned nothing.
