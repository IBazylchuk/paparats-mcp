---
'@paparats/server': minor
'@paparats/cli': minor
'@paparats/shared': minor
'@paparats/indexer': minor
---

**Analytics & observability stack.** Adds a unified telemetry façade with three independently-toggleable sinks:

- **Prometheus** (existing surface, unchanged) for `/metrics` scraping.
- **Local SQLite analytics** at `~/.paparats/analytics.db` — raw search/tool/indexing events with 90-day retention. Six new MCP tools query it: `token_savings_report`, `top_queries`, `cross_project_share`, `retry_rate`, `slowest_searches`, `failed_chunks`.
- **OpenTelemetry** (lazy-loaded) — OTLP/HTTP exporter with spans for every search, MCP tool call, embedding, indexing run, and chunking error. Works with Tempo, Jaeger, Honeycomb, Datadog, Grafana Cloud.

**Header-based identity** (`X-Paparats-User`, `X-Paparats-Session`, `X-Paparats-Client`, `X-Paparats-Anchor-Project`) is propagated through `AsyncLocalStorage` so every event is attributed without changing call-site signatures. Identity is for attribution, not access control.

**Three-level token-savings estimator** computed at query-time:

- _Naive baseline_ — what the model would read if it pulled whole files.
- _Search-only_ — tokens returned by `search_code`.
- _Actually consumed_ — tokens the client subsequently fetched via `get_chunk`. The honest signal that discounts noisy results never used.

**Cross-project noise** — when a client passes `X-Paparats-Anchor-Project` (or specifies a single project), the share of off-anchor results is recorded. The `cross_project_share` MCP tool surfaces this per user.

**Indexing-pipeline observability** — `failed_chunks` aggregates AST parse failures, regex fallbacks, zero-chunk files, and binary skips. `slowest_searches` ranks by latency.

See README.md → "Analytics & Observability" for the full configuration matrix and PII guidance.
