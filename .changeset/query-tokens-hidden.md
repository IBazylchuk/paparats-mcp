---
'@paparats/server': patch
---

With `PAPARATS_LOG_QUERY_TEXT=false` the analytics database no longer keeps the words of a query: `query_tokens`, which the retry rate compares, now holds hashes keyed by a random key that lives only in the server process. Before, the column stored the query's words in plain text whatever the setting. `docs/observability.md` also says that `query_hash` is a plain SHA-1, which hides the text but lets anyone holding the database check a guess.
