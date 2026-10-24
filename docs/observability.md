# Monitoring and observability

Paparats ships with three observability layers that work together:

1. **Prometheus** (`PAPARATS_METRICS=true`) — the server and the indexer each expose
   `/metrics`.
2. **Local SQLite analytics store** at `~/.paparats/analytics.db` inside the server's data
   volume (on by default) — raw search, tool and indexing events. Six MCP tools on the
   support endpoint query it directly: `token_savings_report`, `top_queries`,
   `cross_project_share`, `retry_rate`, `slowest_searches`, `failed_chunks`. The built-in
   `/ui` operator console reads the same store.
3. **OpenTelemetry** (`PAPARATS_OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT`) — spans
   for every search, MCP tool call, embedding, indexing run and chunking error. Works with
   Tempo, Jaeger, Honeycomb, Datadog, Grafana Cloud, Elastic APM — anything that speaks
   OTLP/HTTP.

## Setting environment variables on the stack

`PAPARATS_METRICS`, the analytics and the OTel variables are not wired into the compose
file that `paparats install` generates, so add them by hand to the `environment:` block of
the `paparats` service (and of `paparats-indexer` for indexer metrics) in
`~/.paparats/docker-compose.yml` — `paparats edit compose` opens it — then run
`paparats restart`.

> `paparats add`, `paparats remove`, `paparats edit projects` and `paparats update`
> regenerate the compose file when its contents change. The previous file is kept as
> `~/.paparats/docker-compose.yml.bak`; re-apply your hand edits from there after such a
> change.

## Prometheus

### Metrics endpoints

```bash
curl http://localhost:9876/metrics   # server: search, embeddings, caches, arch memory
curl http://localhost:9877/metrics   # indexer: files, chunks and errors indexed
```

Each process only exposes `/metrics` when `PAPARATS_METRICS=true` is set in its own
environment.

### Key metrics

| Metric                              | Type      | Exposed by | Description                         |
| ----------------------------------- | --------- | ---------- | ----------------------------------- |
| `paparats_search_total`             | Counter   | server     | Search requests by group and method |
| `paparats_search_duration_seconds`  | Histogram | server     | Search latency                      |
| `paparats_embedding_duration_seconds` | Histogram | both     | Embedding request latency           |
| `paparats_query_cache_hit_rate`     | Gauge     | server     | Query result cache hit rate         |
| `paparats_embedding_cache_hit_rate` | Gauge     | server     | Embedding cache hit rate            |
| `paparats_index_files_total`        | Counter   | indexer    | Files indexed                       |
| `paparats_index_chunks_total`       | Counter   | indexer    | Chunks indexed                      |
| `paparats_index_errors_total`       | Counter   | indexer    | Indexing errors                     |
| `paparats_arch_*`                   | various   | server     | Architectural memory reads, writes and sizes (see the README) |

### Prometheus scrape config

Scrape both processes — the indexing counters only exist on the indexer:

```yaml
scrape_configs:
  - job_name: paparats
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:9876', 'localhost:9877']
```

### Pre-built Grafana dashboard

The built-in `/ui` covers the current snapshot. For history (latency p99 over weeks, GC
trends, CPU under indexing bursts) wire `/metrics` to Prometheus and import
[`grafana/paparats.json`](grafana/paparats.json) — 15 panels across four rows:
**Traffic & latency**, **Embeddings**, **Indexing**, **Process health**.

1. Set `PAPARATS_METRICS: 'true'` on the `paparats` and `paparats-indexer` services (see
   above) and run `paparats restart`.
2. Point your Prometheus at `http://<server>:9876/metrics` and `http://<server>:9877/metrics`.
3. In Grafana: Dashboards → Import → upload `docs/grafana/paparats.json` → pick your
   Prometheus datasource → Import.

The dashboard uses a `${DS_PROMETHEUS}` variable, so it works with any Prometheus instance
(local, Grafana Cloud, Mimir, VictoriaMetrics).

## Query cache

Search results are cached in memory on the server (LRU, default 1000 entries, 5-minute
TTL). The server drops a group's cached entries when it changes that group itself — files
indexed or deleted through its HTTP API, or a project deleted. Chunks written by the
indexer container become visible to a repeated identical query once its cached entry
expires, so at most 5 minutes later with the defaults. Configure via environment
variables:

- `QUERY_CACHE_MAX_ENTRIES` — max cached queries (default: 1000)
- `QUERY_CACHE_TTL_MS` — TTL in milliseconds (default: 300000)

Cache stats are included in `GET /api/stats` under the `queryCache` field.

## Operator console (`/ui`)

Open `http://localhost:9876/ui` for a single-screen dashboard that visualises the
analytics store: ROI, top / slowest queries, cross-project usage, per-user activity,
indexer status, embedding p95/p99, and recent failures. Polls every 5 s, no extra
services to run.

- Protect it (optional): `PAPARATS_UI_BASIC_AUTH=user:pass` — applies to `/ui` and
  `/api/analytics` only; `/mcp` and `/api/search` stay open so agents keep working.
- Browser access from other sites is refused on every route (`403` for a foreign
  `Origin`), so a web page cannot read search results or call MCP tools. Allow specific
  origins with `PAPARATS_CORS_ORIGINS=https://app.example.com,...`.
- Show the screenshot view to anyone without touching real data: `PAPARATS_UI_DEMO=true`
  (or append `?demo=1` to the URL once).

## Identity attribution

Clients (IDE plugins, CLI) can set `X-Paparats-User`, `X-Paparats-Session`,
`X-Paparats-Client`, `X-Paparats-Anchor-Project` headers. The header name for `user` is
configurable via `PAPARATS_IDENTITY_HEADER` (default `X-Paparats-User`). Missing header →
events are attributed to `anonymous`. There is no cryptographic verification — this is for
attribution, not access control.

`GET /api/stats` echoes the resolved identity, useful for verifying header propagation:

```bash
curl -H 'X-Paparats-User: alice' http://localhost:9876/api/stats | jq .identity
```

## Sending traces to Elastic APM (or any OTLP backend)

Elastic APM Server accepts OpenTelemetry natively since 7.14 — no agent install, no SDK
injection. Set four env vars on the `paparats` service and restart:

```bash
PAPARATS_OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-apm-server:8200
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <apm-secret-token>
OTEL_SERVICE_NAME=paparats-mcp
```

Within a minute a new service `paparats-mcp` appears in APM → Services. The same env vars
work for Tempo, Jaeger, Honeycomb, Datadog, Grafana Cloud Traces — change the endpoint and
auth header.

**What gets recorded** — one span per event, with paparats-specific attributes for
filtering and grouping:

| Span name                          | Key attributes                                                                                   | When                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `paparats.search`                  | `tool`, `group`, `query.hash`, `query.length`, `search.duration_ms`, `result_count`, `cache_hit` | every `search_code` / `find_usages` |
| `paparats.get_chunk`               | `chunk_id`, `fetch.radius_lines`, `fetch.duration_ms`, `fetch.found`                             | every `get_chunk` call              |
| `paparats.mcp.tool`                | `tool`, `tool.duration_ms`, `tool.ok`                                                            | every MCP tool invocation           |
| `paparats.embedding`               | `kind`, `batch_size`, `cache_hits`, `cache_miss`, `duration_ms`, `timeout`                       | every embedding request             |
| `paparats.indexing.run`            | `group`, `project`, `trigger`, `status`, `files_total`, `chunks_total`, `errors_total`           | every indexer cycle                 |
| `paparats.indexing.chunking_error` | `group`, `project`, `file`, `language`, `error_class`                                            | per-file chunking failure           |

Every span also carries `paparats.user`, `paparats.session`, `paparats.client`,
`paparats.request_id`, and (when present) `paparats.anchor_project` from the
[identity headers](#identity-attribution) — so you can filter APM by user or correlate
spans across a single MCP session.

**What this is good for in Elastic APM:**

- **Errors view** — chunking and embedding failures with stacktrace + file/language/error_class context, aggregated by error class.
- **Transactions** — `paparats.search` becomes a transaction type. Sort by p95/p99/error rate to find the slow workloads. Filter by `paparats.tool=search_code` or `paparats.group=…` to slice by repo.
- **Custom queries / metrics** — every paparats attribute is indexed. Build APM queries like `paparats.embedding.cache_miss:true AND duration_ms>500` to find slow cache-miss embeddings, or aggregate `paparats.search.result_count` per `paparats.group`.
- **Log correlation** — if you ship paparats stdout to Elastic via Filebeat, the `trace.id` field links a log line back to its span.

**What this is _not_ — honest caveats:**

- Spans are flat (one event = one span), not parented. Service Map will show `paparats-mcp` as an isolated node; you won't see a "search → embedding → Qdrant" waterfall. Use the per-span `duration_ms` attributes for stage timing instead.
- Outbound HTTP to Qdrant / the embed server is not auto-instrumented — to see those as separate dependencies in APM you'd need to enable `@opentelemetry/instrumentation-http` (planned, not shipped). For now, embedding and search latency live on the existing spans.
- Per-request token-savings, top queries, and cross-project usage stay in the local SQLite store — they're aggregations, not events. View them in the built-in `/ui` console, not in APM.

For pure metrics (CPU, GC, RSS, request rates) Elastic Metricbeat or the Prometheus
endpoints above are a better fit than APM.

## Token-savings estimators

Three levels, computed from raw events at query-time:

- **Naive baseline** — what a model would have read if it pulled the whole file for each result.
- **Search-only** — tokens actually returned by `search_code`.
- **Actually consumed** — tokens that the client subsequently fetched via `get_chunk`. The most honest signal, since it discounts noisy results that were never used.

Run `token_savings_report` from any MCP client connected to `/support/mcp`. These are
estimates; see [Token Savings Metrics](../README.md#token-savings-metrics) for how each
figure is computed.

## Cross-project noise

When a client passes `X-Paparats-Anchor-Project` (or specifies a single project in the
search call), the share of results from _other_ projects in the same group is recorded.
Use `cross_project_share` to see how noisy your group's index is for each user.

## Indexer-pipeline visibility

`failed_chunks` aggregates AST parse failures, regex fallbacks, zero-chunk files, and
binary skips. `slowest_searches` ranks individual searches by latency.

## Configuration matrix

| Env var                                 | Default                    | Purpose                                                     |
| --------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `PAPARATS_METRICS`                      | `false`                    | Prometheus `/metrics` (server and indexer, each separately) |
| `PAPARATS_ANALYTICS_ENABLED`            | `true`                     | Local SQLite analytics writes                               |
| `PAPARATS_ANALYTICS_DB_PATH`            | `~/.paparats/analytics.db` | Analytics DB file                                           |
| `PAPARATS_ANALYTICS_RETENTION_DAYS`     | `90`                       | Daily prune cutoff                                          |
| `PAPARATS_ANALYTICS_RETENTION_RUN_HOUR` | `3`                        | Hour-of-day for prune (local time)                          |
| `PAPARATS_IDENTITY_HEADER`              | `X-Paparats-User`          | Header name for user attribution                            |
| `PAPARATS_LOG_RESULT_FILES`             | `true`                     | If `false`, store NULL for `search_results.file`            |
| `PAPARATS_LOG_QUERY_TEXT`               | `true`                     | If `false`, store NULL for `search_events.query_text`       |
| `PAPARATS_REFORMULATION_WINDOW_MS`      | `90000`                    | Reformulation detection window                              |
| `PAPARATS_TELEMETRY_SAMPLE_RATE`        | `1.0`                      | Sampling rate (errors are always kept)                      |
| `PAPARATS_OTEL_ENABLED`                 | `false`                    | Enable OTel SDK + OTLP exporter                             |
| `OTEL_EXPORTER_OTLP_ENDPOINT`           | unset                      | OTLP HTTP endpoint (e.g. `http://localhost:4318/v1/traces`) |
| `OTEL_EXPORTER_OTLP_HEADERS`            | unset                      | OTLP auth headers (`key=value,key2=value2`)                 |
| `OTEL_SERVICE_NAME`                     | `paparats-mcp`             | OTel resource attribute                                     |
| `OTEL_RESOURCE_ATTRIBUTES`              | unset                      | Extra resource attrs (`key=value,key2=value2`)              |

## PII guidance

- File paths and query text are stored locally by default. For shared deployments where
  paths could leak sensitive info, set `PAPARATS_LOG_RESULT_FILES=false` and/or
  `PAPARATS_LOG_QUERY_TEXT=false`.
- OTel spans never carry full query text by default — only `paparats.query.hash` and
  length.
