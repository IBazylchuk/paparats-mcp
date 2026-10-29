---
'@paparats/server': patch
---

`health_check` also reports the indexer: whether it answers, when it last ran, and each repository's status, chunk count and last error. An agent can tell a stale or failing index from an empty one. The server finds the indexer at `PAPARATS_INDEXER_URL`, which the generated compose sets, and waits at most 3 seconds for it.
