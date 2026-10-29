---
'@paparats/server': patch
'@paparats/indexer': patch
---

Reindexing with force after a change of embedding model works. Before, `force` dropped only the project's chunks and kept the collection, which still recorded the old model, so every write failed on the mismatch. Now force over a collection built with another model drops the whole collection (old and new vectors cannot be mixed), and the indexer indexes every repository again once the cycle ends. The same applies to `POST /api/index` with `force`. The mismatch error now names this fix.
