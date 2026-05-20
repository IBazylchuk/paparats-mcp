---
'@paparats/server': patch
'@paparats/indexer': patch
'@paparats/cli': patch
'@paparats/shared': patch
---

Fix empty Prometheus metrics. Cache and Qdrant-collection gauges now refresh on a 15s interval (previously only on `/api/stats` hits). Index file/chunk/error counters and the embedding-duration histogram are wired into `Indexer` and `CachedEmbeddingProvider`. The indexer process now exposes its own `GET /metrics` on port 9877 — Prometheus must scrape both `:9876/metrics` (server) and `:9877/metrics` (indexer) to see indexing counters.
