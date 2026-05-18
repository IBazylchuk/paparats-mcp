---
'@paparats/shared': minor
'@paparats/cli': minor
'@paparats/server': minor
'@paparats/indexer': minor
---

feat(ui): operator analytics dashboard at /ui

Self-hosted operators can now open `http://<server>/ui` to see a single-screen
analytics console. The page renders 13 tiles:

- **KPIs:** uptime, memory %, normalized CPU load, group / project / chunk
  counts, searches and chunk-fetches in the selected period with derived
  fetch-rate.
- **Activity sparkline:** SVG mini-chart of searches / fetches / errors
  bucketed by period (15 min for 24 h, 2 h for 7 d, 6 h for 30 d).
- **Token-savings ROI:** hero `savings_vs_naive` figure with an editorial
  breakdown of naive baseline → search-only → actually-consumed tokens, plus
  a contextual legend explaining when "realized" savings underread reality
  because the LLM rarely fetches.
- **Slowest searches** and **top queries** (with per-query zero-click rate).
- **Cross-project usage:** per-anchor `off_anchor_share` and
  `off_anchor_fetches`, top knowledge-bridge pairs, and a "scope likely
  anchored" hint when searches are filtered before results.
- **Users in period:** distinct user count plus per-user searches, fetches,
  sessions, top anchor project, last-active timestamp.
- **Indexer status** (proxied from `/health` on port 9877) and **recent
  chunking errors**.
- **Failed searches** with truncated query and error class.
- **Embedding provider health:** p50 / p95 / p99 latency, cache hit-rate,
  errors and timeouts.

Backed by a new `GET /api/analytics?period=24h|7d|30d` aggregation endpoint.
Reuses existing `AnalyticsStore` SQLite queries where possible
(`tokenSavingsReport`, `slowestSearches`, `topQueries`, `failedChunks`) and
adds five new query helpers inline in `analytics-api.ts` for the new tiles:
`crossProjectByAnchor`, `crossProjectTopPairs`, `userActivity`,
`searchesOverTime` (with integer-division `CAST` to fix better-sqlite3's
REAL binding of bucket sizes), `embeddingHealth`, `recentFailedSearches`,
`zeroClickByQueryHash`. No new collectors — all data comes from existing
event tables.

Dashboard is vanilla HTML/CSS/JS — no build step, no framework. Polls every
5 s, renders user data via DOM API (`textContent`, never `innerHTML`),
gracefully degrades when telemetry is disabled or the indexer is unreachable.
Aesthetic: editorial / terminal-style dark theme (JetBrains Mono headers,
IBM Plex Sans body, lime `#c8ff3a` accent).

Optional basic-auth guard via `PAPARATS_UI_BASIC_AUTH=user:pass` — scoped to
`/ui` and `/api/analytics` only, leaves `/mcp`, `/sse`, `/api/search`,
`/health`, and `/metrics` untouched so MCP clients and Prometheus scrapers
keep working.

The Docker Compose generator now sets
`PAPARATS_INDEXER_URL=http://paparats-indexer:9877` on the server container
so the indexer tile resolves to the sibling service over the compose
network instead of the host loopback.

A `?demo=1` query parameter (or `PAPARATS_UI_DEMO=true` env var) makes
`/api/analytics` return a fully-populated synthetic payload, so the
dashboard can be screenshotted or demoed without exposing real users,
queries, or project names.

Also ships `docs/grafana/paparats.json` — an importable Grafana dashboard
covering time-series data the in-browser console can't (latency p99 over
weeks, GC trends, CPU under indexing bursts, watcher event rate). 15
panels across 4 rows: Traffic & latency, Embeddings, Indexing, Process
health. Uses a `${DS_PROMETHEUS}` variable so it works with any
Prometheus datasource. The `/ui` covers the current snapshot; this
dashboard covers history.

README now documents how to wire the existing OpenTelemetry exporter to
Elastic APM Server (which accepts OTLP natively since 7.14). Lists the
six span names we emit (`paparats.search`, `paparats.get_chunk`,
`paparats.mcp.tool`, `paparats.embedding`, `paparats.indexing.run`,
`paparats.indexing.chunking_error`) with their attributes, plus honest
caveats about what's not parented or auto-instrumented yet.
