---
'@paparats/server': patch
'@paparats/indexer': patch
'@paparats/cli': patch
'@paparats/shared': patch
---

Keep the indexer container healthy during long indexing cycles. `Indexer.indexProject()` and `Indexer.indexFilesContent()` now yield to the event loop every 10 files so `/health` and `/metrics` on `:9877` no longer hang while tree-sitter parses run — the operator UI stopped flipping to `INDEXER OFFLINE` while indexing was actually in progress. The "Skipped X/Y files (unchanged)" log now reports the current project's skip count instead of a cumulative cycle counter (which could exceed `Y`). The operator-UI indexer health probe timeout is raised from 1.5s to 5s so a single slow GC tick no longer surfaces as a false offline banner.

Fix `SQLITE_BUSY_RECOVERY` crash on indexer startup when the server and indexer share `metadata.db` and `cache/embeddings.db` over the same Docker volume. Every SQLite open now sets `busy_timeout = 5000` so a second writer waits for the first to finish its `CREATE TABLE` / `CREATE INDEX` instead of failing instantly, and `synchronous = NORMAL` is applied uniformly for the standard WAL fast-path. Applied to `MetadataStore`, `EmbeddingCache`, `AnalyticsStore`, and the indexer `StateStore`.
