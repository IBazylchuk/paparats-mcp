---
'@paparats/server': patch
---

Remove the server's unused file watcher (never started since content-based indexing); index freshness comes from the indexer's change detection.

- `GET /api/stats` no longer returns a `watcher` field (it was always an empty object), and `paparats groups --verbose` no longer prints "File changes processed".
- The `paparats_watcher_events_total` Prometheus metric and its Grafana panel are gone; the metric never incremented.
- `ProjectWatcher`, `WatcherManager`, their types and `WatcherConfig` are no longer exported from `@paparats/server`, and `ProjectConfig` has no `watcher` field. The server drops its `chokidar` dependency.
- A `watcher:` section in `.paparats.yml` is now ignored rather than validated, so existing configs keep loading.
