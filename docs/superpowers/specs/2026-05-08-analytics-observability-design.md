# Analytics & Observability for paparats-mcp

**Date:** 2026-05-08
**Author:** Ilya Bazylchuk (with Claude assistance)
**Status:** Approved (ready for implementation plan)

## Context

paparats-mcp is a semantic code search MCP server. Today it has shallow observability: a small Prometheus surface (`metrics.ts`, opt-in via `PAPARATS_METRICS=true`) that counts searches and watcher events, and unstructured `console.log`/`console.error` calls. There is no notion of caller identity, no request correlation, no distributed traces, no structured analytics store.

We need to answer concrete operational and product questions:

1. **Who is making which queries?** Without identity we cannot attribute usage, debug user-specific issues, or measure adoption per team.
2. **How well is search working?** "Cross-project noise" — when a project is part of a larger group, results often include matches from other projects. Some of that is desirable (logic spans services); some is pure noise. We need to measure the share quantitatively.
3. **What is the real token-saving impact?** Today's "approximate" estimate compares chunk size to whole-file size. That overstates savings — the model doesn't always read whole files. We need an honest measurement based on the chunks the client actually consumed (`get_chunk` after `search_code`).
4. **Where does indexing fail silently?** AST parser falls back to regex; embedding calls time out; chunks are zero-length. None of this surfaces today.
5. **Operational visibility outside this project.** Standard observability stack expects OpenTelemetry; we should integrate so the system is visible in Tempo/Jaeger/Honeycomb/Grafana Cloud/Datadog without bespoke wiring.
6. **Self-serve analytics.** Operators should be able to ask the server itself ("which searches are slowest", "what's the cross-project share for user X") via MCP tools without standing up an external analytics stack.

## Decisions

### Identity model

- Header-based: `X-Paparats-User`, optional `X-Paparats-Session`, optional `X-Paparats-Client`, optional `X-Paparats-Anchor-Project`.
- Configurable via `PAPARATS_IDENTITY_HEADER` (default `X-Paparats-User`).
- No cryptographic verification — server trusts the header. Suitable for trusted clients (IDE plugins, CLI). Missing header → `user='anonymous'`.
- Identity is used for **attribution and quality metrics**, NOT for access enforcement. Existing `PAPARATS_PROJECTS` server-wide scoping stays unchanged.

### Telemetry transport

- **OpenTelemetry SDK** for traces, metrics, and logs. OTLP exporter, configurable endpoint. Covers both MCP/search path and indexing pipeline.
- Existing Prometheus surface (`metrics.ts`, `/metrics` endpoint) stays for backwards compatibility, exposed as one of the sinks inside the new façade.
- **Local SQLite analytics store** at `~/.paparats/analytics.db` for raw events. Independent of any external backend.
- New MCP tools (support mode only) read this store to answer questions interactively.

### Architecture style

Single `Telemetry` façade in `packages/server/src/telemetry/`. All call-sites use one interface (`telemetry.recordSearch(event)`, `telemetry.span('mcp.tool.search_code', fn)`). The façade fans out to three sinks (Prom, SQLite, OTel), each toggleable via env. When all are off the façade becomes a no-op with no overhead.

### Retention & privacy

- All raw events kept; retention controlled by `PAPARATS_ANALYTICS_RETENTION_DAYS` (default 90).
- Daily prune cron runs at `PAPARATS_ANALYTICS_RETENTION_RUN_HOUR` (default 3 AM local).
- File-path logging toggleable via `PAPARATS_LOG_RESULT_FILES` (default `true`).
- Query-text logging toggleable via `PAPARATS_LOG_QUERY_TEXT` (default `true`); when off, only `query_hash` and `query_tokens` are stored.

## Architecture

### Identity propagation

`AsyncLocalStorage` (Node `node:async_hooks`) carries the request-scoped `TelemetryContext` through await chains, `setTimeout`, and `PQueue` workers. Express middleware (`identityMiddleware`) reads headers on every HTTP request and seeds the context.

```ts
// packages/server/src/telemetry/context.ts
interface TelemetryContext {
  user: string; // 'anonymous' if header absent
  session: string | null;
  client: string | null;
  anchorProject: string | null;
  requestId: string; // uuidv7 — correlates SQLite rows + OTel trace
  startedAt: number;
}
```

Background callbacks (chokidar watcher, group-poll timer, MCP cleanup interval, indexer cron) are NOT inside an HTTP request. Each must explicitly seed a context with a synthetic user (`system:watcher`, `system:scheduler`, `system:indexer`) by wrapping its callback in `tctx.run(...)`.

**MCP session identity nuance:** A single MCP session spans many HTTP requests. We capture identity at session-init time (`Map<sessionId, SessionIdentity>` as the fallback), and on every subsequent request the per-request `identityMiddleware` overrides it with fresh headers. Per-request always wins; session identity only fills in when headers are absent.

### Telemetry façade

```ts
// packages/server/src/telemetry/facade.ts
interface Telemetry {
  recordSearch(event: SearchRecordEvent): void;
  recordChunkFetch(event: ChunkFetchEvent): void;
  recordToolCall(event: ToolCallEvent): void;
  recordIndexingRun(event: IndexingRunEvent): void;
  recordChunkingError(event: ChunkingErrorEvent): void;
  recordEmbedding(event: EmbeddingCallEvent): void;
  span<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
}
```

Sinks:

- **`PromSink`** — wraps the existing `metrics.ts` surface. `/metrics` HTTP endpoint unchanged.
- **`SqliteSink`** — writes events to `analytics.db` via `AnalyticsStore`.
- **`OtelSink`** — registers spans and OTel instruments via `@opentelemetry/sdk-node`. Lazy-imported only when `PAPARATS_OTEL_ENABLED=true` to keep cold start fast (~80 ms saved when disabled).

The façade also reads `tctx.get()` to enrich every event automatically with `user/session/client/requestId` — call-sites don't pass identity explicitly.

### Analytics SQLite schema

Located at `~/.paparats/analytics.db` (server) and `/data/analytics.db` (indexer container — separate file; merge happens at OTLP backend, see "Indexer container" below). `better-sqlite3` + `journal_mode=WAL` + `synchronous=NORMAL`.

```sql
CREATE TABLE search_events (
  id              TEXT PRIMARY KEY,        -- uuidv7 (= requestId)
  ts              INTEGER NOT NULL,
  user            TEXT NOT NULL,
  session         TEXT,
  client          TEXT,
  tool            TEXT NOT NULL,
  group_name      TEXT,
  anchor_project  TEXT,                    -- from X-Paparats-Anchor-Project, OR single-value `project` param
  query_text      TEXT,                    -- NULL when PAPARATS_LOG_QUERY_TEXT=false; else truncated to 1024 chars
  query_hash      TEXT NOT NULL,           -- sha1 of normalized query
  query_tokens    TEXT NOT NULL,           -- JSON sorted array (for Jaccard)
  limit_param     INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  result_count    INTEGER NOT NULL,
  cache_hit       INTEGER NOT NULL,
  error           TEXT
);
CREATE INDEX idx_search_user_ts    ON search_events(user, ts);
CREATE INDEX idx_search_session_ts ON search_events(session, ts);
CREATE INDEX idx_search_query_hash ON search_events(query_hash);
CREATE INDEX idx_search_ts         ON search_events(ts);

CREATE TABLE search_results (
  search_id        TEXT NOT NULL,
  rank             INTEGER NOT NULL,
  project          TEXT NOT NULL,
  file             TEXT,                    -- NULL when PAPARATS_LOG_RESULT_FILES=false
  language         TEXT,
  score            REAL NOT NULL,
  start_line       INTEGER NOT NULL,
  end_line         INTEGER NOT NULL,
  chunk_lines      INTEGER NOT NULL,
  file_total_lines INTEGER,                 -- from `files` table; NULL if not yet indexed
  chunk_id         TEXT,
  PRIMARY KEY (search_id, rank)
);
CREATE INDEX idx_search_results_project  ON search_results(project);
CREATE INDEX idx_search_results_chunk_id ON search_results(chunk_id);

CREATE TABLE chunk_fetches (
  id                  TEXT PRIMARY KEY,
  ts                  INTEGER NOT NULL,
  user                TEXT NOT NULL,
  session             TEXT,
  chunk_id            TEXT NOT NULL,
  preceding_search_id TEXT,                 -- resolved at insert
  radius_lines        INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  found               INTEGER NOT NULL
);
CREATE INDEX idx_chunk_fetches_search  ON chunk_fetches(preceding_search_id);
CREATE INDEX idx_chunk_fetches_user_ts ON chunk_fetches(user, ts);

CREATE TABLE tool_calls (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  user        TEXT NOT NULL,
  session     TEXT,
  tool        TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  error       TEXT
);
CREATE INDEX idx_tool_calls_user_tool_ts ON tool_calls(user, tool, ts);

CREATE TABLE indexing_runs (
  id            TEXT PRIMARY KEY,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  group_name    TEXT NOT NULL,
  project_name  TEXT,
  trigger       TEXT NOT NULL,              -- cron|api|watcher|cli
  files_total   INTEGER NOT NULL DEFAULT 0,
  files_skipped INTEGER NOT NULL DEFAULT 0,
  chunks_total  INTEGER NOT NULL DEFAULT 0,
  errors_total  INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL               -- running|success|error
);
CREATE INDEX idx_indexing_runs_started ON indexing_runs(started_at);

CREATE TABLE chunking_errors (
  id           TEXT PRIMARY KEY,
  run_id       TEXT,
  ts           INTEGER NOT NULL,
  group_name   TEXT NOT NULL,
  project_name TEXT NOT NULL,
  file         TEXT NOT NULL,
  language     TEXT,
  error_class  TEXT NOT NULL,                -- ast_parse_failed|ast_chunk_zero|regex_fallback|read_error|binary
  message      TEXT
);
CREATE INDEX idx_chunking_errors_run ON chunking_errors(run_id);

CREATE TABLE embedding_calls (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  user        TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- query|passage|batch
  batch_size  INTEGER NOT NULL DEFAULT 1,
  cache_hits  INTEGER NOT NULL DEFAULT 0,
  cache_miss  INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  timeout     INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
CREATE INDEX idx_embedding_calls_ts ON embedding_calls(ts);

CREATE TABLE files (
  group_name   TEXT NOT NULL,
  project_name TEXT NOT NULL,
  file         TEXT NOT NULL,
  language     TEXT,
  total_lines  INTEGER NOT NULL,
  total_bytes  INTEGER NOT NULL,
  indexed_at   INTEGER NOT NULL,
  PRIMARY KEY (group_name, project_name, file)
);

CREATE TABLE tokens_per_language (
  language        TEXT PRIMARY KEY,
  tokens_per_line REAL NOT NULL
);
-- seeded on startup: ts/tsx/js=5.5, python=4.5, go=5, java=4.5, rust=5, csharp=5, ruby=4.5, php=4.5, markdown=3, yaml=3, json=3, generic=4

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
```

FK relationships are logical (not enforced) — events are retained even when the file/run they refer to is gone.

**Transactions:** every `recordSearch` writes one row to `search_events` and N rows to `search_results` in a single `db.transaction(() => {...})()`. Indexer per-file emits go through the same pattern.

### OpenTelemetry instrumentation map

Service: `paparats-mcp` (server) / `paparats-indexer` (indexer container). Resource attributes include `service.namespace=paparats`, `service.version` from `package.json`. `BatchSpanProcessor` with `maxQueueSize=2048`, `scheduledDelayMillis=5000`. Exporter back-pressure drops spans silently — never blocks the request.

Every span carries `paparats.user`, `paparats.session`, `paparats.client`, `paparats.request_id` from `tctx.get()`.

| Path                                 | Span name             | Key attributes                                                                                   | Children                                                       |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| MCP tool dispatch (per-tool wrapper) | `mcp.tool.<name>`     | `mcp.mode`, `mcp.session_id`, `mcp.tool.args.limit`, `paparats.group`, `paparats.anchor_project` | per tool: see below                                            |
| `Searcher.expandedSearch`            | `search.expanded`     | `search.query.length`, `search.variations`                                                       | `search.execute` × variations                                  |
| `Searcher._searchInternal`           | `search.execute`      | `search.group`, `search.project`, `search.limit`, `search.cache_hit`, `search.result_count`      | `search.cache_lookup`, `search.embed`, `qdrant.search`         |
| Embedding (cache-checked)            | `search.embed`        | `embed.cache_hit`, `embed.text_chars`, `embed.model`                                             | `embedding.generate` on miss                                   |
| Ollama call                          | `embedding.generate`  | `embed.model`, `embed.batch_size`, `embed.attempts`, `embed.timeout`                             | —                                                              |
| Qdrant search retry body             | `qdrant.search`       | `qdrant.collection`, `qdrant.attempt`, `qdrant.filter.projects`                                  | —                                                              |
| `Indexer.indexProject`               | `index.run`           | `index.group`, `index.project`, `index.trigger`, `index.files_total`                             | `index.file` × files                                           |
| `Indexer.indexFile`                  | `index.file`          | `index.file.path`, `index.file.bytes`, `index.skipped`                                           | `index.chunk_file`, `index.embed_batch`, `index.qdrant_upsert` |
| `Indexer.chunkFile`                  | `index.chunk_file`    | `chunk.method` (`ast`/`ast_zero_fallback`/`regex`), `chunk.count`                                | —                                                              |
| Embed batch                          | `index.embed_batch`   | `embed.batch_size`, `embed.cache_hits`, `embed.cache_miss`                                       | `embedding.generate` per Ollama call                           |
| Qdrant upsert                        | `index.qdrant_upsert` | `qdrant.points`, `qdrant.batch_size`                                                             | —                                                              |
| Watcher dispatch                     | `watcher.event`       | `watcher.event_type`, `watcher.group`, `watcher.project`                                         | downstream `index.file`                                        |

**Prom → OTel metric mapping** (Prom registry stays for `/metrics`; OTel mirrors via `Counter` / `Histogram` / `ObservableGauge`):

- `paparats_search_total` → `paparats.search.count`
- `paparats_search_duration_seconds` → `paparats.search.duration`
- `paparats_index_files_total` → `paparats.index.files`
- `paparats_index_chunks_total` → `paparats.index.chunks`
- `paparats_index_errors_total` → `paparats.index.errors`
- `paparats_embedding_duration_seconds` → `paparats.embedding.duration`
- `paparats_watcher_events_total` → `paparats.watcher.events`
- gauges → `ObservableGauge`

**OTel-only new instruments:**

- `paparats.search.tokens_returned` (Histogram)
- `paparats.search.tokens_saved_vs_full_file` (Histogram)
- `paparats.search.cross_project_share` (Histogram)
- `paparats.embedding.cache.hit_ratio` (ObservableGauge)
- `paparats.indexing.chunk_method` (Counter labeled by method)
- `paparats.qdrant.retries` (Counter)

### Token-saving estimators

Three estimators, all derived at MCP-tool query time from raw rows. Nothing is precomputed.

```sql
WITH per_search AS (
  SELECT
    se.id,
    SUM(sr.chunk_lines * tpl.tokens_per_line)                                             AS tokens_search_only,
    SUM(COALESCE(sr.file_total_lines, sr.chunk_lines * 5) * tpl.tokens_per_line)          AS tokens_whole_file,
    SUM(CASE WHEN cf.id IS NOT NULL THEN sr.chunk_lines * tpl.tokens_per_line ELSE 0 END) AS tokens_actually_consumed
  FROM search_events se
  JOIN search_results sr ON sr.search_id = se.id
  JOIN tokens_per_language tpl ON tpl.language = COALESCE(sr.language, 'generic')
  LEFT JOIN chunk_fetches cf ON cf.preceding_search_id = se.id AND cf.chunk_id = sr.chunk_id
  WHERE se.ts BETWEEN :since AND :until
  GROUP BY se.id
)
SELECT
  COUNT(*)                                                                          AS searches,
  SUM(tokens_whole_file)                                                            AS naive_baseline,
  SUM(tokens_search_only)                                                           AS search_only,
  SUM(tokens_actually_consumed)                                                     AS actually_consumed,
  1.0 - 1.0*SUM(tokens_search_only)/NULLIF(SUM(tokens_whole_file),0)                AS savings_vs_naive,
  1.0 - 1.0*SUM(tokens_actually_consumed)/NULLIF(SUM(tokens_whole_file),0)          AS savings_realized
FROM per_search;
```

`file_total_lines` is populated by `Indexer.indexFile` writing to the `files` table after `content.split('\n').length`. `tokens_per_language` is seeded on startup with empirical constants. When `PAPARATS_TOKENS_EXACT=true` the analytics tool fetches `content` from Qdrant for each `chunk_id` and runs `tiktoken` instead — slow but exact, opt-in only on the analytics read path.

### Cross-project share

Anchor source: `X-Paparats-Anchor-Project` header, OR the `project` tool param when it's a single non-`'all'` value. Stored in `search_events.anchor_project`. NULL → not counted in this metric.

```sql
SELECT
  se.user, se.anchor_project,
  COUNT(*)                                              AS searches,
  AVG(off_anchor.cnt * 1.0 / NULLIF(se.result_count,0)) AS share
FROM search_events se
JOIN (
  SELECT search_id, COUNT(*) AS cnt
  FROM search_results sr
  JOIN search_events e ON e.id = sr.search_id
  WHERE sr.project != e.anchor_project AND e.anchor_project IS NOT NULL
  GROUP BY search_id
) off_anchor ON off_anchor.search_id = se.id
WHERE se.anchor_project IS NOT NULL AND se.ts >= :since
GROUP BY se.user, se.anchor_project
ORDER BY searches DESC;
```

### Reformulation / retry rate

S2 is a reformulation of S1 when:

1. Same `(user, session)`, AND
2. `S2.ts - S1.ts <= PAPARATS_REFORMULATION_WINDOW_MS` (default 90000), AND
3. NO `chunk_fetches` row exists for S1 with `cf.ts < S2.ts`, AND
4. `query_hash` matches OR token-Jaccard `>= 0.3`.

`query_tokens` is computed at write time: lowercase → strip punctuation → split → filter ~50 stopwords → dedupe → sort → JSON. SQLite's `json_each` enables Jaccard in pure SQL:

```sql
WITH pairs AS (
  SELECT s1.id AS prev_id, s2.id AS next_id, s1.query_tokens AS t1, s2.query_tokens AS t2,
         (s2.ts - s1.ts) AS gap_ms, s1.user, s1.session
  FROM search_events s1
  JOIN search_events s2 ON s1.user = s2.user AND s1.session = s2.session
   AND s2.ts > s1.ts AND s2.ts - s1.ts <= :window_ms
   AND NOT EXISTS (
     SELECT 1 FROM chunk_fetches cf
     WHERE cf.preceding_search_id = s1.id AND cf.ts < s2.ts
   )
)
SELECT prev_id, next_id, gap_ms, user,
  ( SELECT COUNT(*) FROM json_each(t1) WHERE value IN (SELECT value FROM json_each(t2)) ) * 1.0 /
  ( SELECT COUNT(DISTINCT value) FROM (
      SELECT value FROM json_each(t1) UNION SELECT value FROM json_each(t2)
    ) ) AS jaccard
FROM pairs
WHERE jaccard >= 0.3
   OR ( SELECT COUNT(*) FROM json_each(t1) WHERE value IN (SELECT value FROM json_each(t2)) )
      = (SELECT COUNT(*) FROM json_each(t1));
```

`retry_rate` MCP tool returns `count(reformulations) / count(searches)` per user/group bucket.

### MCP analytics tools (support mode only)

| Tool                   | Returns                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `token_savings_report` | The three-level estimator across a period × user × group              |
| `top_queries`          | Most-frequent `query_hash` deduplicated, with one example text        |
| `cross_project_share`  | Per-user-per-anchor share of off-anchor results                       |
| `retry_rate`           | Reformulation rate per user/group                                     |
| `slowest_searches`     | Top-N searches by `duration_ms`, broken down into embed/qdrant phases |
| `failed_chunks`        | Grouping of `chunking_errors` by `error_class` × file × language      |

All six read from `analytics.db` via a separate read-only connection.

### Indexer container

The indexer runs in a separate process (often a separate container). It uses `Indexer` from `@paparats/server` as a library. Its analytics live in `/data/analytics.db` (configurable via `PAPARATS_ANALYTICS_DB_PATH` per process). **Two reasons** for separate files:

1. **Cross-container WAL is fragile** — POSIX locks misbehave across container fs layers, especially on macOS bind mounts.
2. **Different telemetry shapes** — server is dominated by `search_events`/`chunk_fetches`; indexer by `indexing_runs`/`chunking_errors`/`embedding_calls`.

Merge happens at the OTLP backend (both processes export with `service.namespace=paparats`). For MCP analytics tools that operate on indexer data, the server can read the indexer's DB read-only when `PAPARATS_INDEXER_ANALYTICS_DB` env points to a readable path.

### Configuration matrix

| Env var                                 | Default                                                                     | Purpose                                                  |
| --------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `PAPARATS_OTEL_ENABLED`                 | `false`                                                                     | Enable OTel SDK + exporters                              |
| `OTEL_EXPORTER_OTLP_ENDPOINT`           | unset                                                                       | OTLP HTTP endpoint                                       |
| `OTEL_EXPORTER_OTLP_HEADERS`            | unset                                                                       | OTLP auth headers                                        |
| `OTEL_SERVICE_NAME`                     | `paparats-mcp` / `paparats-indexer`                                         | Resource attribute                                       |
| `OTEL_RESOURCE_ATTRIBUTES`              | `service.namespace=paparats`                                                | Extra resource attrs                                     |
| `PAPARATS_ANALYTICS_ENABLED`            | `true`                                                                      | SQLite sink master switch                                |
| `PAPARATS_ANALYTICS_DB_PATH`            | server: `~/.paparats/analytics.db`; indexer container: `/data/analytics.db` | DB file path                                             |
| `PAPARATS_ANALYTICS_RETENTION_DAYS`     | `90`                                                                        | Daily prune cutoff                                       |
| `PAPARATS_ANALYTICS_RETENTION_RUN_HOUR` | `3`                                                                         | Hour-of-day for prune (local time)                       |
| `PAPARATS_IDENTITY_HEADER`              | `X-Paparats-User`                                                           | Header name for user attribution                         |
| `PAPARATS_IDENTITY_TRUST_PROXY`         | `false`                                                                     | Honor `X-Forwarded-*` chains (default off for safety)    |
| `PAPARATS_LOG_RESULT_FILES`             | `true`                                                                      | If `false`, store NULL for `search_results.file`         |
| `PAPARATS_LOG_QUERY_TEXT`               | `true`                                                                      | If `false`, store NULL for `search_events.query_text`    |
| `PAPARATS_OTEL_LOG_QUERY_TEXT`          | `false`                                                                     | If `true`, attach query text to OTel spans (default off) |
| `PAPARATS_TOKENS_EXACT`                 | `false`                                                                     | Use tiktoken on analytics read path                      |
| `PAPARATS_REFORMULATION_WINDOW_MS`      | `90000`                                                                     | Reformulation detection window                           |
| `PAPARATS_TELEMETRY_SAMPLE_RATE`        | `1.0`                                                                       | Sampling rate for spans/events (1.0 = all)               |
| `PAPARATS_METRICS`                      | `false` (existing)                                                          | Existing Prometheus toggle, unchanged                    |
| `PAPARATS_INDEXER_ANALYTICS_DB`         | unset                                                                       | Server reads indexer analytics.db read-only when set     |

## Risks & mitigations

| Risk                                          | Mitigation                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| SQLite write contention at peak QPS           | Single transaction per search (1+N inserts); WAL; `synchronous=NORMAL`                                   |
| Hot-path latency overhead                     | Bench at stage 1 close; ALS+span+inserts <1 ms per search; sampling via `PAPARATS_TELEMETRY_SAMPLE_RATE` |
| OTel SDK cold-start cost (~80 ms, ~30 MB RSS) | Lazy import — only loaded when `PAPARATS_OTEL_ENABLED=true`                                              |
| PII via OTLP (query text, file paths)         | Default off for `PAPARATS_OTEL_LOG_QUERY_TEXT`; toggles for path/text logging on local DB                |
| Retention cron not running                    | Hourly check + sentinel-row last-run timestamp; one-shot delayed by 60 s after boot                      |
| No-op when OTLP endpoint unset                | OTel sink installs only if both `PAPARATS_OTEL_ENABLED=true` AND `OTEL_EXPORTER_OTLP_ENDPOINT` set       |
| File path leakage (`/Users/<name>/...`)       | `PAPARATS_LOG_RESULT_FILES=false` for shared deployments; documented                                     |
| Indexer concurrent SQLite writes              | Avoided by separate analytics.db files per process                                                       |
| OTel exporter back-pressure                   | `BatchSpanProcessor` with bounded queue; drops silently rather than blocking                             |

## Build sequence

Each stage independently mergeable.

1. **Foundation.** `Telemetry` interface + AsyncLocalStorage + identity middleware + `/api/stats` echo of identity. Smoke-testable with curl.
2. **SQLite analytics store.** `AnalyticsStore` + migrations + `tool_calls` writes. Every MCP tool wraps in `recordToolCall`.
3. **Search instrumentation.** `recordSearch` in all `Searcher` paths + `files` table populated by `Indexer.indexFile` + first three analytics tools (`token_savings_report`, `top_queries`, `slowest_searches`).
4. **Behavioral signals.** `chunk_fetches` writes from `get_chunk` with `preceding_search_id` resolution + `cross_project_share` and `retry_rate` tools.
5. **Indexer-pipeline observability.** `chunking_errors` + `embedding_calls` + `indexing_runs` lifecycle + `failed_chunks` tool.
6. **OTel integration.** `OtelSink` + lazy import + Prom→OTel mirroring.
7. **Retention & operational hardening.** Daily prune + sampling + docs + optional tiktoken path.

## Verification

End-to-end checks per stage:

- **Stage 1:** `curl -H 'X-Paparats-User: test' http://localhost:9876/api/stats` → response includes `identity.user='test'`. Run search without header → identity is `'anonymous'`. Verify ALS works through embedding+qdrant: log line in `Searcher.search` shows the same `requestId` as the HTTP entry.
- **Stage 2:** Run any MCP tool; `sqlite3 ~/.paparats/analytics.db 'SELECT * FROM tool_calls ORDER BY ts DESC LIMIT 5'` shows the call with correct user.
- **Stage 3:** Run `search_code`; verify `search_events` and `search_results` have rows with `chunk_lines` and `file_total_lines` populated. Call `token_savings_report` MCP tool; numbers are non-zero.
- **Stage 4:** Run `search_code` then `get_chunk` on a result; verify `chunk_fetches.preceding_search_id` is set. Call `cross_project_share` with anchor header; non-zero result.
- **Stage 5:** Force a chunk to fail (binary file in indexable language); verify `chunking_errors` row. Call `failed_chunks` tool.
- **Stage 6:** Set `PAPARATS_OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces` (e.g. local Jaeger); run search; verify span tree appears with `paparats.user` attributes.
- **Stage 7:** Insert old rows, set `PAPARATS_ANALYTICS_RETENTION_DAYS=1`, advance system time or run prune manually; verify rows >1 day old gone.

Existing test suites:

```bash
yarn test
yarn typecheck
yarn lint
```

A new test file `packages/server/src/telemetry/__tests__/integration.test.ts` covers the end-to-end flow with an in-memory SQLite instance.

## Files to create / modify

**New:**

- `packages/server/src/telemetry/context.ts` — AsyncLocalStorage helper
- `packages/server/src/telemetry/facade.ts` — `Telemetry` interface + factory
- `packages/server/src/telemetry/types.ts` — event shapes
- `packages/server/src/telemetry/analytics-store.ts` — SQLite store
- `packages/server/src/telemetry/migrations.ts` — schema migrations
- `packages/server/src/telemetry/sinks/{noop,prom,sqlite,otel}.ts` — sink impls
- `packages/server/src/telemetry/otel.ts` — OTel SDK init (lazy)
- `packages/server/src/telemetry/tokens.ts` — per-language constants + tiktoken path
- `packages/server/src/telemetry/identity-middleware.ts` — Express middleware
- `packages/server/src/telemetry/queries.ts` — prepared SQL for analytics tools
- `packages/server/src/telemetry/retention.ts` — daily pruner
- `packages/server/src/telemetry/__tests__/...` — unit + integration tests

**Modified:**

- `packages/server/src/index.ts` — bootstrap Telemetry, pass into Searcher/Indexer/McpHandler/WatcherManager
- `packages/server/src/app.ts` — mount identity middleware before MCP routes; accept `telemetry` in options
- `packages/server/src/searcher.ts` — `recordSearch` in three search paths + spans
- `packages/server/src/indexer.ts` — `recordIndexFile`/`recordChunkingError`/`recordEmbedding` + `files` upsert + spans
- `packages/server/src/embeddings.ts` — instrument all embed methods
- `packages/server/src/mcp-handler.ts` — wrap each tool in span + `recordToolCall`; capture session identity at init; resolve `preceding_search_id` for `get_chunk`; register six new analytics tools in `SUPPORT_TOOLS`
- `packages/server/src/watcher.ts` — wrap callbacks in `tctx.run({ user: 'system:watcher', ... })`
- `packages/server/src/types.ts` — export new telemetry types
- `packages/server/src/lib.ts` — re-export `Telemetry`, `createTelemetry`, sink classes
- `packages/server/src/metrics.ts` — adapter role; public API unchanged
- `packages/server/src/prompts/*` — descriptions for new analytics tools
- `packages/indexer/src/index.ts` — bootstrap Telemetry with `/data/analytics.db`; wrap `runIndexCycle`
- `packages/indexer/src/scheduler.ts` — wrap cron callback
- `packages/server/package.json` / `packages/indexer/package.json` — add `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`; optional `tiktoken`
- `README.md` — document env vars and PII guidance
