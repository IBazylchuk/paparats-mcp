# @paparats/shared

## 2.0.3

## 2.0.2

## 2.0.1

## 2.0.0

### Major Changes

- 1a8c124: **BREAKING: migrate to permissively-licensed embedding models.** The default code embedder is now **bge-code-v1** (1536d) and the default arch/docs text embedder is **Qwen3-Embedding-0.6B** (1024d) — both Apache-2.0, replacing the CC-BY-NC `jina-code-embeddings` and `bge-m3`. Both are decoder-based and served with `--pooling last`.

  **Why this is breaking:** a model change invalidates every existing vector. Even where the dimension is unchanged (jina→bge-code are both 1536d; bge-m3→qwen are both 1024d), the vector spaces are incompatible, so any pre-existing index must be reindexed before search returns correct results. Collections stamped with the old model raise `CollectionMetaMismatchError` on write.

  **Migration (required for existing installs):**

  - **Code layer** — reindex from source: drop the old collection (or bump the indexer's reindex epoch) so it rebuilds with the new model.
  - **Arch/docs layer** — re-embedded automatically. On startup the server detects any arch collection stamped with a different text model and re-embeds it in place, reconstructing each card's text from its stored payload (no data loss; the collection is only recreated if the dimension changed). No manual step for the OSS/self-hosted path. A manual `POST /api/arch/reindex {"group":"..."}` (and `apiClient.reindexArch`) is also available to force it without a restart.
  - The embed image and native `paparats install` ship only the two new GGUFs — no legacy weights are carried; rollback is via a previously published image tag.

  **Other changes:**

  - **Instruction-aware queries.** Query-type detection (nl2code / code2code / techqa) maps to each model family's instruction template using **verbatim task strings from the model cards** (a paraphrased instruction measurably degrades retrieval). Documents are embedded unprefixed (asymmetric retrieval). Instructions auto-enable for instruction-tuned families and stay off for cloud providers.

  See `docs/replacing-embedding-models.md` for the full cutover checklist and the process for swapping models in the future.

## 1.7.9

### Patch Changes

- 02b9b8a: fix(metadata): drop pre-cap symbol_edges instead of DELETE; never crash startup

  The one-time pre-cap edge purge used `DELETE FROM symbol_edges`, which logs
  every row to the WAL. On the multi-gigabyte tables the fan-out bug produced,
  this inflated the WAL past the table's own size (14 GB observed), never
  committed, and crashed server startup with `SQLITE_BUSY` in a restart loop —
  the server never came up.

  - The purge now uses `DROP TABLE IF EXISTS symbol_edges`, which deallocates
    pages in bulk instead of logging each row. The table is immediately recreated
    empty by the existing `CREATE TABLE IF NOT EXISTS`, and the indexer's reindex
    epoch rebuilds edges with the fan-out cap applied.
  - The purge is wrapped in try/catch and is no longer a startup precondition: on
    any failure (e.g. a lost lock race) `user_version` is left at 0 so the purge
    retries on the next open, and startup proceeds regardless.

## 1.7.8

### Patch Changes

- 382be43: fix(symbol-graph): cap AMBIGUOUS fan-out and stop blocking the event loop

  Large repos with symbols re-declared across hundreds of chunks (namespace roots,
  lifecycle hooks, shared base-class names) produced a quadratic `uses × defines`
  edge explosion — millions of AMBIGUOUS edges for a single symbol — that inserted
  in one giant SQLite transaction and blocked the Node event loop long enough to
  trip the indexer's health probe.

  - `buildSymbolEdges` now skips any symbol defined in more than
    `MAX_DEFINITION_FANOUT` (50) chunks and reports the count of edges avoided.
    These edges carried no navigational value.
  - `upsertSymbolEdges` commits in bounded batches, yielding between them so the
    synchronous SQLite work no longer monopolises the event loop.
  - The dashboard's indexer health probe timeout is raised 5s → 15s so a busy but
    healthy index cycle isn't reported as unreachable.

  Auto-heals existing installs after upgrade — no manual DB surgery:

  - Opening `metadata.db` purges pre-cap symbol edges once (gated on
    `user_version`), clearing the stale high-fanout rows.
  - The indexer's state store bumps a reindex epoch on first boot after upgrade,
    clearing all repo fingerprints so the next cron cycle re-indexes every repo
    and rebuilds its symbol graph with the cap applied.

## 1.7.7

## 1.7.6

## 1.7.5

## 1.7.4

## 1.7.3

## 1.7.2

## 1.7.1

## 1.7.0

## 1.6.0

### Minor Changes

- 93e1b1e: Replace Ollama with llama.cpp (llama-server) + llama-swap as the embedding backend

  The embedding backend now runs `llama-server` (llama.cpp) fronted by `llama-swap`
  in the new `ibaz/paparats-embed` image, replacing `ibaz/paparats-ollama`. This is
  ~5–9× faster on CPU (measured on an 8-CPU AWS Graviton box) and serves
  `jina-code-embeddings`, which Ollama 0.30+ rejects with HTTP 501. Existing indexes
  stay valid — vectors are cosine-identical to the old Ollama output (per-model
  pooling: jina-code → last, bge-m3 → cls), so **no re-index is required**.

  **Breaking changes for existing installs (compose is regenerated by `paparats install`):**

  - Embedding provider id: `ollama` → `llama` (in `.paparats.yml` `embeddings.provider`
    and the `EMBEDDING_PROVIDER` / `TEXT_EMBEDDING_PROVIDER` env vars).
  - Env vars: `OLLAMA_URL` → `EMBED_URL`, `OLLAMA_BATCH_SIZE` → `EMBED_BATCH_SIZE`.
    New `EMBED_TTL` controls idle-unload seconds for lazy-loaded models.
  - Docker image `ibaz/paparats-ollama` → `ibaz/paparats-embed` (container
    `paparats-ollama` → `paparats-embed`; llama-swap listens on 8080, mapped to host
    11434).
  - CLI flags: `--ollama-mode` → `--embed-mode`, `--ollama-url` → `--embed-url`;
    `--embeddings` accepts `llama | openai | voyage`.
  - Native macOS install now uses `brew install llama.cpp mostlygeek/tap/llama-swap` (Metal
    accelerated) instead of Ollama; no Modelfile / `ollama create` step — llama-swap
    loads models by name on demand.

## 1.5.0

### Minor Changes

- d63a0c5: Add AST-based Terraform/HCL support: symbol extraction and find_usages for `.tf`/`.hcl` files via the tree-sitter terraform grammar, with regex chunking retained as fallback.

  - Default excludes strictly skip secrets and state at any directory depth: `**/*.tfvars`, `**/*.tfvars.json`, `**/*.auto.tfvars`, `**/*.auto.tfvars.json`, `**/*.tfstate`, `**/*.tfstate.*`.
  - `blockLabels` now resolves bare identifier block labels (`resource aws_instance web`), not just quoted string labels.
  - Reference resolution walks consecutive `get_attr` siblings instead of scanning all of a variable expression's parent's children, so unrelated sibling expressions (e.g. `concat(var.x, local.y)`) no longer leak into the attribute chain.
  - `readConfig`/`loadIndexerConfig` no longer crash on a malformed or comment-only config file — js-yaml 5 throws on empty-document input, now caught and surfaced as a clean `Invalid config at <path>` error.

## 1.4.0

### Minor Changes

- 6c8d2b4: Update dependencies and resolve all open Dependabot security advisories.

  - Security fixes via resolutions: hono ^4.12.25, undici ^6.27.0, tar ^7.5.16, vite ^8.0.16, brace-expansion ^5.0.6; OpenTelemetry stack bumped to 2.9.0 (exporter 0.220.0) to fix the @opentelemetry/core Baggage advisory.
  - Major upgrades: commander 15, js-yaml 5 (namespace imports, `quoteStyle` replaces `quotingType`), @types/node 26.
  - **Node baseline raised to 24** (`engines: >=24`); CI and Docker images now use Node 24. commander 15 requires Node ≥22.12.
  - Minor/patch bumps across eslint, prettier, vitest, vite, typescript-eslint, better-sqlite3, node-cron, ora, uuid, p-queue, @opentelemetry/semantic-conventions.
  - Pinned the bundled Ollama Docker images to 0.24.0 (last 0.2x line; 0.30+ is incompatible).

  TypeScript stays on 5.9 and web-tree-sitter on 0.25 — TS 6/7 is blocked by typescript-eslint's peer range, and web-tree-sitter 0.26 breaks the tree-sitter grammar ABI.

## 1.3.2

### Patch Changes

- 40bc275: fix(server): make git metadata enrichment incremental — only files actually reindexed in a cycle are re-enriched, instead of re-running `git log`/`git diff` and rewriting Qdrant payloads for every chunk of the project on every cron tick. Parsed git output is additionally cached in the metadata DB keyed by repo HEAD, so repeated enrichment without new commits skips git subprocesses entirely. Fixes constant `POST /points/payload` spam to Qdrant and high indexer CPU on near-no-op cycles.

## 1.3.1

### Patch Changes

- 48b8bb7: chore(deps): patch/minor dependency upgrades incl. hono security fixes

  Bump `hono` (transitive via `@modelcontextprotocol/sdk`, pinned through `resolutions`) from 4.12.18 to 4.12.23, closing four moderate advisories patched in 4.12.21: ipRestriction non-canonical IPv6 deny bypass, app.mount() undecoded-prefix mis-routing, cookie sameSite/priority Set-Cookie injection, and JWT middleware accepting any Authorization scheme.

  Other patch/minor upgrades within their current major: `@qdrant/js-client-rest` 1.18.0, `better-sqlite3` 12.10.0, `js-yaml` 4.2.0, `p-queue` 9.3.0, `@inquirer/prompts` 8.5.2, the `@opentelemetry/*` packages, `eslint` 10.4.1, `typescript-eslint` 8.60.1, `vite` 8.0.16, `vitest` 4.1.8, `@types/node` 25.9.2, plus `postcss`/`protobufjs` resolutions. Major bumps (commander 15, typescript 6) and `web-tree-sitter` 0.26 (ABI-coupled to the pinned `tree-sitter-wasms` grammars) deliberately deferred.

## 1.3.0

## 1.2.0

## 1.1.0

## 1.0.2

## 1.0.1

## 1.0.0

## 0.11.0

## 0.10.2

## 0.10.1

## 0.10.0

### Minor Changes

- 15ee219: **Architectural memory — a living knowledge base your agent maintains itself.**

  Code search tells the agent **what** the code does. The new architectural memory layer
  tells it **why** — and the agent writes it as it learns, reads it before every
  architectural answer, and keeps it clean without you authoring a single doc.

  **Three strict card kinds**, each in its own field-by-field shape so the agent
  records facts instead of inventing prose:
  - **Components** — `name`, plus a markdown summary with `Does / Owns / Does not / Touched when`.
  - **Decisions** (ADR-style) — `title`, `context`, `decision`, `alternatives_rejected`,
    `consequences`.
  - **Lessons** (Reflexion-style) — `rule`, `why`, `when`.

  **Server-side similarity gate** keeps the store clean without trusting the client:
  every write runs nearest-neighbour search against the same group first.
  Cosine **≥ 0.85** is a duplicate (decisions refused, lessons bump `updatedAt` as
  "rule confirmed"); **0.70 – 0.85** is similar and surfaced so the agent can refine or
  chain a `supersedes`; below 0.70 is a new card. `supersedes` links bypass the gate
  and mark prior decisions as `status=superseded` so they disappear from default search
  but stay in history.

  **Min-score threshold for reads.** `arch_context` accepts a `min_score` parameter
  (default `0.45`, cosine over [bge-m3](https://ollama.com/library/bge-m3)). Hits below
  the threshold are dropped, and the tool returns an explicit low-confidence hint when
  nothing matched — the agent now knows to rephrase or lower `min_score` instead of
  inventing context.

  **No memory rot.** Every card carries an `updated N ago` stamp **and a cosine score**
  in `arch_context` output. The support-mode system prompt instructs the agent to verify
  stale cards (>90 days) against current code and update or supersede them.

  **`arch_context` is now read-only on the coding endpoint too** (`/mcp`). Refactors
  need to know about prior decisions before renaming or moving code. Writes
  (`arch_record_*`) remain support-only — recording belongs to the architectural-review
  workflow, not to every line edit.

  **Workflow prompts** for the boring scaffolding:
  - **`init_arch_memory`** — `/init`-style first-run bootstrap. Walks the repo, identifies
    8-20 components by domain boundary, writes them, captures obvious decisions.
  - **`audit_architecture`** — sweep stale cards, verify anchors against live code,
    surface a punch list of updates and supersedes.
  - **`record_lesson_from_correction`** — convert a user correction into a structured
    lesson card without overrecording typos.

  **MCP resources** for live introspection:
  - **`arch://schema`** — full card-schema reference.
  - **`arch://stats/{group}`** — live counts (total / by kind / by status) plus
    oldest/newest `updatedAt`.

  **Prometheus metrics** (opt-in via `PAPARATS_METRICS=true`):
  - `paparats_arch_context_calls_total{group}` — counter
  - `paparats_arch_write_total{kind, status}` — counter (every gate outcome is labelled)
  - `paparats_arch_search_score` — histogram of cosine scores returned by `arch_context`
  - `paparats_arch_collection_size{group, kind, status}` — gauge

  **Four new MCP tools** on the support endpoint (`/support/mcp`): `arch_context`,
  `arch_record_component`, `arch_record_decision`, `arch_record_lesson`. Cards live in
  a separate Qdrant collection per group (`paparats_<group>_arch`), embedded with
  `bge-m3` (1024d, mean-pooled, multilingual) — the code index is untouched.

  Keywords: architectural memory, ADR memory, decision records, lessons learned,
  living architecture, Reflexion, agent memory, knowledge base, cross-session continuity,
  init prompt, /init, audit, observability, Prometheus metrics, min_score, threshold.

## 0.9.2

### Patch Changes

- 4fc117a: Keep the indexer container healthy during long indexing cycles. `Indexer.indexProject()` and `Indexer.indexFilesContent()` now yield to the event loop every 10 files so `/health` and `/metrics` on `:9877` no longer hang while tree-sitter parses run — the operator UI stopped flipping to `INDEXER OFFLINE` while indexing was actually in progress. The "Skipped X/Y files (unchanged)" log now reports the current project's skip count instead of a cumulative cycle counter (which could exceed `Y`). The operator-UI indexer health probe timeout is raised from 1.5s to 5s so a single slow GC tick no longer surfaces as a false offline banner.

  Fix `SQLITE_BUSY_RECOVERY` crash on indexer startup when the server and indexer share `metadata.db` and `cache/embeddings.db` over the same Docker volume. Every SQLite open now sets `busy_timeout = 5000` so a second writer waits for the first to finish its `CREATE TABLE` / `CREATE INDEX` instead of failing instantly, and `synchronous = NORMAL` is applied uniformly for the standard WAL fast-path. Applied to `MetadataStore`, `EmbeddingCache`, `AnalyticsStore`, and the indexer `StateStore`.

## 0.9.1

### Patch Changes

- 33f5179: Fix empty Prometheus metrics. Cache and Qdrant-collection gauges now refresh on a 15s interval (previously only on `/api/stats` hits). Index file/chunk/error counters and the embedding-duration histogram are wired into `Indexer` and `CachedEmbeddingProvider`. The indexer process now exposes its own `GET /metrics` on port 9877 — Prometheus must scrape both `:9876/metrics` (server) and `:9877/metrics` (indexer) to see indexing counters.

## 0.9.0

### Minor Changes

- 7f69575: feat(ui): operator analytics dashboard at /ui

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

## 0.8.1

### Patch Changes

- [#62](https://github.com/IBazylchuk/paparats-mcp/pull/62) [`69145dd`](https://github.com/IBazylchuk/paparats-mcp/commit/69145dd92caa4b202f884de762cef5507ba047ed) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - CLI: `paparats install --embeddings <ollama|openai|voyage>` chooses the embedding backend at install time. Cloud providers (`openai`, `voyage`) drop the bundled Ollama service from the generated `docker-compose.yml` and pass through `OPENAI_API_KEY` / `VOYAGE_API_KEY` so the server and indexer talk straight to the API — no 1.7 GB image, no GGUF download, no host Ollama. Interactive install prompts for the provider and (for cloud) the API key; `--non-interactive` requires `--embedding-api-key <key>` or the corresponding env var. The choice is persisted in `~/.paparats/install.json`, so later `paparats add | remove | edit projects` keep the same compose shape on regeneration.

  Server: `Indexer.getGroupStats` and `Indexer.listGroups` now subtract the metadata sentinel point introduced in 0.8.0, so reported chunk counts reflect real chunks instead of being off by one.

## 0.8.0

### Minor Changes

- [#60](https://github.com/IBazylchuk/paparats-mcp/pull/60) [`3c9a061`](https://github.com/IBazylchuk/paparats-mcp/commit/3c9a061cf92379ad1e45d04f9e1ac71b7f5c2667) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Add OpenAI and Voyage AI embedding providers, plus a collection-level
  mismatch guard so swapping providers never silently breaks search.
  - **`OpenAIProvider`** (`text-embedding-3-small`, 1536d) and **`VoyageProvider`**
    (`voyage-code-3`, 1024d, Matryoshka-aware) join the existing `OllamaProvider`.
    Both share a single retry helper that treats 4xx (bad key, no credit,
    malformed input) as terminal and retries 429/5xx with exponential backoff.
  - **`resolveEmbeddingConfigFromEnv()`** centralises the env contract for
    server and indexer. Precedence: explicit `EMBEDDING_PROVIDER` →
    `OPENAI_API_KEY` present → `VOYAGE_API_KEY` present → Ollama. Setting just
    an API key auto-switches providers.
  - **Collection metadata sentinel.** Each Qdrant collection now carries a
    hidden `__meta` point recording the provider, model, and dimensions that
    stamped it. Reopening a collection with a different provider raises
    `CollectionMetaMismatchError` with a clear remediation. Legacy collections
    without the sentinel get backfilled with a warning, so existing setups
    continue to work.
  - **Searcher** transparently excludes the sentinel via `must_not __meta=true`
    on every Qdrant search.
  - **Codespaces** now forwards `OPENAI_API_KEY` / `VOYAGE_API_KEY` /
    `EMBEDDING_PROVIDER` from the host shell — set one of those secrets and
    indexing drops from ~15 minutes to a couple of seconds.
  - README documents the three providers with a trade-off table (cost,
    privacy, speed) and the selection precedence.

  Out of scope here: a `paparats install --embeddings <provider>` flag and the
  Docker Compose generator's "skip Ollama service when cloud provider is set"
  flow. Both will follow in a smaller CLI-focused PR.

## 0.7.0

### Minor Changes

- [#58](https://github.com/IBazylchuk/paparats-mcp/pull/58) [`4d46aef`](https://github.com/IBazylchuk/paparats-mcp/commit/4d46aefcf34cd308368f13077f6e902a6728497d) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Add GitHub Codespaces quickstart and fix three rough edges surfaced while
  building it:
  - `.devcontainer/` spins up the full Qdrant + Ollama + paparats stack on
    pre-built images and auto-indexes a small slice of the repo on first
    start, so users can try semantic search in the browser without installing
    anything.
  - `paparats add` no longer fails with a noisy `Indexer returned 404` when
    the indexer's config-watcher hasn't yet picked up the new `projects.yml`
    entry — the CLI retries briefly to ride out the debounce window.
  - `OllamaProvider.embedBatch` adaptively splits batches by total character
    size (default 16k chars per request, override via `OLLAMA_BATCH_CHARS`).
    Previously, 5 large chunks could exceed the 240s CPU embed budget and
    fail the whole batch.
  - `paparats search` without `--group` and without a local `.paparats.yml`
    now infers the group when the server has exactly one — keeps the demo
    flow (and ad-hoc explorers) usable without setup.

## 0.6.0

### Minor Changes

- [#56](https://github.com/IBazylchuk/paparats-mcp/pull/56) [`aafbfc2`](https://github.com/IBazylchuk/paparats-mcp/commit/aafbfc2e98679357f87b98b72f7c1a7155207e23) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Add change-detection to the indexer. Two cron schedules now run side by side: a fast `CRON_FAST` tick (default `*/10 * * * *`) that fingerprints each repo and only re-indexes when it changed, and a slow `CRON` safety-net (default `0 */3 * * *`, was `0 */6 * * *`) that still does a full pass. Remote repos use `git ls-remote HEAD`; bind-mounted local repos use a file mtime/size hash. State persists in `STATE_DB_PATH` (default `/data/indexer-state.db`). Set `CHANGE_DETECTION=false` to opt out.

## 0.5.1

### Patch Changes

- [#54](https://github.com/IBazylchuk/paparats-mcp/pull/54) [`f15fa7a`](https://github.com/IBazylchuk/paparats-mcp/commit/f15fa7a08d11d50ff10cd763c36f39a942387487) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Add six MCP workflow prompts (`find_implementation`, `trace_callers`,
  `onboard_to_project`, `triage_incident`, `prepare_release_notes`,
  `assess_change_impact`) and enforce mode isolation between `/mcp` and
  `/support/mcp` so a coding session id cannot be replayed on the support
  endpoint.

## 0.5.0

### Minor Changes

- [#52](https://github.com/IBazylchuk/paparats-mcp/pull/52) [`a6b60b2`](https://github.com/IBazylchuk/paparats-mcp/commit/a6b60b2efe0b32513b319d34839cecc387e22e80) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - `paparats add <local-path>` now auto-detects the project language from marker files (Gemfile, package.json, Cargo.toml, go.mod, …) and writes a commented `exclude_extra:` starter block beside the entry, listing the language defaults already applied by the server. The `projects.yml` header now documents every supported per-entry field. Existing entries are left untouched.

## 0.4.0

### Minor Changes

- [#49](https://github.com/IBazylchuk/paparats-mcp/pull/49) [`72aab0c`](https://github.com/IBazylchuk/paparats-mcp/commit/72aab0cf524584cbf13eff25ec1fe3afe7c4e185) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Rework the install/CLI flow around a single global home, add indexer hot-reload, and clean up the symbol graph.

  **CLI**
  - Replace per-project `init` / `index` / `watch` with a unified `install` plus `add` / `remove` / `list` / `edit` / `lifecycle` subcommands working off `~/.paparats/`.
  - Persist install configuration in `install.json` so `paparats add` / `remove` can regenerate `docker-compose.yml` without losing context.
  - Add `--force` to `paparats add` — drops the project's existing chunks before reindexing (use after schema or config changes).
  - Drop the legacy `lsp-installers` / `init` / `watch` modules and their tests.

  **Indexer**
  - Hot-reload `~/.paparats/projects.yml` via a chokidar `ConfigWatcher`. Added/modified repos reindex live; removed repos drop bookkeeping. No restart needed for metadata-only edits.
  - Accept `{repos?, force?}` body on `POST /trigger`; `force: true` drops the project's existing chunks before reindexing.
  - Bind-mount the whole `~/.paparats` as `/config:ro` (directory mount, not single-file) so atomic rewrites of `projects.yml` survive — single-file mounts pin to host inode and break on rename.

  **Project list rename**
  - Renamed `~/.paparats/paparats-indexer.yml` → `~/.paparats/projects.yml`. The CLI reads `projects` semantics throughout (`paparats edit projects`, etc.) so the file name now matches.
  - `paparats install` automatically renames a legacy `paparats-indexer.yml` to `projects.yml` on first run and prints a one-line notice. No manual migration needed.
  - Both the CLI and the indexer fall back to reading `paparats-indexer.yml` when `projects.yml` is absent, so an out-of-sync upgrade (e.g. new indexer image, old CLI) keeps working.

  **Server**
  - `syncGroupsFromQdrant` now also enumerates projects per group via `listProjectsInGroup` and rebuilds `ProjectConfig` from payload, while preserving any explicit `POST /api/index` registrations.
  - `ast-symbol-extractor`: filter out symbols declared inside function bodies (locals, callback args, hook closures). Module-level only — these are the only symbols meaningful for cross-chunk reference analysis. Adds two coverage tests.

  **Docs**
  - Full README rewrite to match the new install flow, project model, and the actual MCP tool set.

- [#50](https://github.com/IBazylchuk/paparats-mcp/pull/50) [`d478587`](https://github.com/IBazylchuk/paparats-mcp/commit/d4785877da0a8d67948777441fda3181c6ec0bec) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - fix(group): default to a shared `default` group instead of project name

  A regression introduced when `paparats add` landed silently siloed every
  project in its own Qdrant collection, breaking the multi-project model
  ("group = collection, projects share via the `project` payload filter").

  What changed:
  - `@paparats/shared` exports `DEFAULT_GROUP = 'default'` as the single
    source of truth.
  - `paparats add` no longer writes `group: <name>` when `--group` is
    omitted — the entry inherits `defaults.group` from `projects.yml` or
    falls back to `DEFAULT_GROUP`. CLI `list` / `remove` resolve through
    the same path.
  - The indexer container falls back to `DEFAULT_GROUP` (still respects
    `PAPARATS_GROUP` env and per-repo `group:` override).
  - `autoProjectConfig` in the server falls back to `DEFAULT_GROUP`.
  - `Indexer.indexProject` now evicts the project's chunks from any other
    group before indexing, so a project that was renamed out of its old
    group doesn't leave behind stale chunks (whose `chunk_id` would no
    longer match symbol-graph edges, silently breaking `find_usages`).

  Migration: no action required for new installs. Existing installs with
  per-project groups continue to work — the eviction pass kicks in only
  when the project moves between groups.

## 0.3.2

### Patch Changes

- [#43](https://github.com/IBazylchuk/paparats-mcp/pull/43) [`9051779`](https://github.com/IBazylchuk/paparats-mcp/commit/90517796873fbc537c44b4c9a87955a6cf009939) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Bug fixes:
  - **`paparats --version` was hardcoded to `0.1.2`**: `packages/cli/src/index.ts` carried a literal version string that the release pipeline never touched, so the flag returned `0.1.2` regardless of what npm had actually installed. Version is now read from the package's own `package.json` at runtime, so it tracks the published version automatically.
  - **AST chunker emitted overlapping chunks for large single declarations**: when `splitNode` recursed into a named child that spanned only one line (e.g. the identifier of an `export const homeMarkdown = ...` with a long template literal body), the identifier produced its own (start, start) chunk while the body produced (start, end), leaving the identifier chunk as a redundant subset of the body chunk. Added a `dedupeContainedChunks` post-filter to drop chunks whose range is fully contained inside another chunk's range. Ties are broken by length, then by emission order.
  - **`.tsx` / `.jsx` files were parsed with the wrong tree-sitter grammar**: `detectLanguageByPath` returns `'typescript'` for `.tsx` (which keeps `LANGUAGE_PROFILES` simple), but `tree-sitter-typescript` does not understand JSX — tags parse as bogus type expressions and identifier usages inside `<Foo prop={x}/>` or `{value}` are lost. Added `resolveAstLanguage(language, relPath)` which upgrades to the `tsx` grammar for `.tsx`/`.jsx` paths at the AST boundary, leaving the higher-level language profile untouched.

- [#44](https://github.com/IBazylchuk/paparats-mcp/pull/44) [`8544dc8`](https://github.com/IBazylchuk/paparats-mcp/commit/8544dc83bb91203efbc6f61ad1eaa9f19353901f) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Security bump:
  - Patch GHSA-protobufjs prototype-pollution / code-generation gadget (CVSS 8.1 High) by forcing `protobufjs ≥ 8.0.2` via root `resolutions`. The vulnerable 8.0.1 was a transitive dep of `@opentelemetry/exporter-trace-otlp-http` 0.217.0 — the resolution lifts it to 8.3.0 across the workspace. Dependabot couldn't auto-update because protobufjs is not a direct dep.

## 0.3.1

### Patch Changes

- [#41](https://github.com/IBazylchuk/paparats-mcp/pull/41) [`17c922f`](https://github.com/IBazylchuk/paparats-mcp/commit/17c922f78e3b02d6d8544dd1e89b25f76e081fb0) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Security and reliability bumps:
  - Patch 9 dependabot advisories via root `resolutions` (fast-uri ≥3.1.2, hono ≥4.12.18, ip-address ≥10.2.0, postcss ≥8.5.14). All four were transitive — pulled in via @modelcontextprotocol/sdk (hono), ajv (fast-uri), express-rate-limit + simple-git/socks (ip-address), and vite devDep (postcss). The advisories range from path traversal in URI parsing through to JWT timestamp validation; resolutions force every consumer onto the patched line without touching direct deps.
  - Bump Yarn to 4.14.1, @inquirer/prompts to ^8.4.3.
  - Fix flaky `ApiClient.abort` test: aborted requests were being retried with exponential backoff, blowing past the 5s test timeout. Abort errors now short-circuit retry like 4xx and parse errors.

## 0.3.0

### Minor Changes

- [#37](https://github.com/IBazylchuk/paparats-mcp/pull/37) [`ee217da`](https://github.com/IBazylchuk/paparats-mcp/commit/ee217da9a19dd11416c4b74d3d527cd662e5b3aa) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - **Analytics & observability stack.** Adds a unified telemetry façade with three independently-toggleable sinks:
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
