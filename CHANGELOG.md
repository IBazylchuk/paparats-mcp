# Changelog

<!-- BEGIN AGGREGATED -->

> **Releases from 0.3.0 onward** are aggregated automatically from per-package Changesets entries by `scripts/aggregate-changelog.js`. Per-package detail lives in `packages/<name>/CHANGELOG.md`. Entries for **0.2.24 and earlier** are the historical monorepo-level archive (preserved below the aggregated block).

## [1.2.0] - 2026-05-25

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Minor Changes

- ebda708: feat(arch): `arch_list` enumeration tool plus retrieval-ranking fixes for `arch_context`

  Three coupled changes for the architectural memory layer, motivated by a real audit/dedupe session that surfaced ranking blind spots in `arch_context`.
  - **`arch_list(group, project?, kinds?, include_history?, limit?, offset?)`**. Unranked, paginated enumeration. No vector, no similarity threshold. Use this when you need every card (audit, dedupe, migration) rather than the top-N most similar. `arch_context` is for relevance-ranked retrieval; `arch_list` is for ground truth. Coding mode only.
  - **Per-kind limits in `arch_context`**. Previously a single top-20 was bucketed post-fetch, which let a verbose decision bucket starve components out of the result entirely. Each kind now has its own top-N budget (default 5 per kind, overridable via `limits: { component, decision, lesson }`, max 50; 0 suppresses the kind). Three small kind-scoped Qdrant searches in parallel; arch collections are tiny so the cost is negligible.
  - **Project-scoped retrieval boost**. When `arch_context` is called with `project=X`, cards whose payload matches that project get a small additive rank boost (~one calibrated tier of bge-m3 score bands, currently `+0.05`). This breaks the short-text cosine bias that lets one-line global decisions outrank longer project-scoped components. Globals stay visible but no longer dominate. The similarity gate (`findNearest`, used by `arch_record_decision`/`arch_record_lesson` for dedupe) intentionally stays on raw cosine — boost is retrieval-only.

  Tool-output and ranking change: callers that rely on a specific ordering of `arch_context` results when passing `project` will see project-scoped cards moved up. Use `arch_list` if you need a stable unranked view.

### Patch Changes

- @paparats/shared@1.2.0

## [1.1.0] - 2026-05-24

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Minor Changes

- 7866aea: feat(arch): richer `arch_context` output, safer `arch_delete` docs, and clearer memory-layer guidance
  - **Lesson rendering**: `arch_context` now includes `why:` and `when:` continuation bullets under each lesson rule. The incident context behind a rule is often more load-bearing than the rule itself — the agent needs to see when the rule applies, not just the rule.
  - **Stale marker**: any card whose `updatedAt` is older than 90 days is now prefixed with `⚠ stale` in the rendered output. The 90-day threshold was already documented as a "treat as hypothesis" boundary, but had no visible signal — easy to skip past. New marker makes it impossible to miss.
  - **`arch_delete` safety**: tool description now tells the caller to re-fetch ids via `arch_context` immediately before deleting. Re-upserts allocate fresh UUIDs, so ids cached from earlier in a conversation can silently miss the intended card — and in the worst case, wipe a now-current one if the id was reassigned.
  - **Memory-layer dichotomy**: `arch_record_lesson` description, `codingInstructions`, and the `record_lesson_from_correction` workflow now explicitly distinguish arch lessons (rules about the _code_ — contracts, boundaries, patterns) from agent-side memory (rules about _the user's workflow_ — commit style, branch naming, formatting). Agents were mixing the two, ending up with workflow rules cluttering the arch layer.

  Tool output format change: lessons now span up to three lines per card (rule, `why:`, `when:`) instead of one. Update any downstream consumer that parsed `arch_context` line-by-line.

### Patch Changes

- @paparats/shared@1.1.0

## [1.0.2] - 2026-05-24

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- bfa9231: arch_context: surface card id in every result line

  The formatted `arch_context` tool output now includes the card id next to each component, decision, and lesson, e.g. `**file indexer** (id ` + "`" + `01926abc-...` + "`" + `, 4d ago, score 0.62) — Indexes files...`. Without this, a caller had no way to obtain ids from the tool output and could not invoke `arch_delete`. The renderer is extracted into `renderArchContextSection` so the contract is regression-tested.
  - @paparats/shared@1.0.2

## [1.0.1] - 2026-05-24

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- 165fa10: arch: add `arch_delete` tool for hard-removing cards by id

  `arch_delete(group, ids: string[])` permanently removes one or more arch cards from a group's Qdrant collection. Use for cleaning up obsolete cards left over from a refactor, dropping cards for a removed feature, or migrating away from old payload schemas.
  - Idempotent: ids that no longer exist are reported in `notFound` but do not fail the call.
  - No undo, no audit trail — the cards are gone from Qdrant. Prefer `supersedes` on `arch_record_decision` when you have a replacement decision; use `arch_delete` only when there is no replacement (e.g. a removed component or an old per-group lesson that's now project-scoped).
  - Coding-mode only. Support mode stays strictly read-only.

  Programmatic API: `ArchStore.deletePoints(group, ids): Promise<{ deleted: string[]; notFound: string[] }>`. A missing collection is treated as "every id not found" so first-run-of-a-migration is safe to retry.
  - @paparats/shared@1.0.1

## [1.0.0] - 2026-05-24

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Major Changes

- 9c2f41f: arch: scope memory by `project` field on every card (breaking)

  Architectural memory now carries an explicit `project` per card so multi-project groups (one Qdrant collection spanning more than one repo) can be queried without cross-project noise. No path heuristics — the caller passes the same `project` value the indexer uses in code-chunk `payload.project`.

  ### Breaking changes
  - `arch_record_component` now **requires** `project: string`. Calls without it fail with a Zod error. Component idempotency is now per-(group, project): two projects in the same group may legitimately reuse the same component name (e.g. `indexer`) without overwriting each other.
  - `arch_record_decision` and `arch_record_lesson` accept an **optional** `project: string`. Omit it for guidance that applies group-wide.
  - `arch_context` replaces `path_prefixes: string[]` with `project: string`. When set:
    - components are filtered hard — a component without `project=X` is dropped;
    - decisions and lessons are filtered soft — cards with `project=X` OR no `project` field at all pass through, so globally-scoped guidance still surfaces.
  - Old component cards written before this release have no `project` payload and become invisible to project-scoped queries. There is no automatic migration: rewrite them via `arch_record_component` with the new required field.

  ### Programmatic API
  - `UpsertComponentInput.project: string` is now required.
  - `UpsertDecisionInput.project?` and `UpsertLessonInput.project?` added (optional).
  - `SearchOpts.pathPrefixes` removed; replaced by `SearchOpts.project?: string`.
  - `BuildArchContextOpts.pathPrefixes` removed; replaced by `BuildArchContextOpts.project?: string`.
  - Helper `makePrefixPredicate` removed; replaced by `makeProjectPredicate(project)`.

  ### Implementation notes
  - Filtering stays post-fetch (Qdrant's `match.value` / `match.any` can't express "hard for components, soft for non-components" in a single filter). When `project` is set the underlying Qdrant `limit` is overfetched 3× before filtering. Best-effort only: if the filter still leaves fewer than `limit` hits, the short list is returned — there is no recursive top-up.
  - `findByName(group, kind, name, project?)` now scopes the lookup by `project` when given, so `upsertComponent` no longer cross-overwrites a same-named component in another project of the same group.

### Patch Changes

- @paparats/shared@1.0.0

## [0.11.0] - 2026-05-24

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Minor Changes

- bf2b580: arch_context: add optional `path_prefixes` to scope component hits in shared groups

  `arch_context` accepts a new `path_prefixes: string[]` parameter. Each entry is matched against component cards via `string.startsWith` on every value in `files[]` — no glob, no regex, no leading-slash normalization. A component passes when at least one of its files starts with at least one of the supplied prefixes. **Decisions and lessons (which carry no `files[]`) always pass through**, so a prefixed call still returns globally-scoped guidance alongside the scoped components.

  Use it to silence cross-project noise in groups that hold more than one project under a common collection (single-project groups don't need it).

  Implementation notes:
  - Filtering is applied post-fetch in `ArchStore.searchWithVector` rather than via a Qdrant payload filter — `match.value` / `match.any` don't express prefix matches, and arch collections are tiny (low thousands), so the post-filter has bounded cost.
  - When a prefix is set the underlying Qdrant `limit` is overfetched 3× before filtering, so the result list isn't artificially short. Best-effort only: if the prefix still leaves fewer than `limit` hits, the short list is returned — there is no recursive top-up.

  Backwards-compatible: when `path_prefixes` is omitted the tool behaves as before.

### Patch Changes

- @paparats/shared@0.11.0

## [0.10.2] - 2026-05-23

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- 2e05623: Fix architectural-memory tool exposure per MCP mode. Coding mode now exposes the full arch toolkit (`arch_context` plus all three `arch_record_*` writers and the `init_arch_memory` / `record_lesson_from_correction` workflows), and support mode is strictly read-only (`arch_context` and the `audit_architecture` workflow). Previously the writers were wired into support and missing from coding, which is the opposite of how the modes are used: agents author memory while making changes (coding), while support consumers only read it.
  - @paparats/shared@0.10.2

## [0.10.1] - 2026-05-23

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- @paparats/shared@0.10.1

## [0.10.0] - 2026-05-23

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

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

### Patch Changes

## [0.9.2] - 2026-05-21

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- 4fc117a: Keep the indexer container healthy during long indexing cycles. `Indexer.indexProject()` and `Indexer.indexFilesContent()` now yield to the event loop every 10 files so `/health` and `/metrics` on `:9877` no longer hang while tree-sitter parses run — the operator UI stopped flipping to `INDEXER OFFLINE` while indexing was actually in progress. The "Skipped X/Y files (unchanged)" log now reports the current project's skip count instead of a cumulative cycle counter (which could exceed `Y`). The operator-UI indexer health probe timeout is raised from 1.5s to 5s so a single slow GC tick no longer surfaces as a false offline banner.

  Fix `SQLITE_BUSY_RECOVERY` crash on indexer startup when the server and indexer share `metadata.db` and `cache/embeddings.db` over the same Docker volume. Every SQLite open now sets `busy_timeout = 5000` so a second writer waits for the first to finish its `CREATE TABLE` / `CREATE INDEX` instead of failing instantly, and `synchronous = NORMAL` is applied uniformly for the standard WAL fast-path. Applied to `MetadataStore`, `EmbeddingCache`, `AnalyticsStore`, and the indexer `StateStore`.

## [0.9.1] - 2026-05-20

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- 33f5179: Fix empty Prometheus metrics. Cache and Qdrant-collection gauges now refresh on a 15s interval (previously only on `/api/stats` hits). Index file/chunk/error counters and the embedding-duration histogram are wired into `Indexer` and `CachedEmbeddingProvider`. The indexer process now exposes its own `GET /metrics` on port 9877 — Prometheus must scrape both `:9876/metrics` (server) and `:9877/metrics` (indexer) to see indexing counters.

## [0.9.0] - 2026-05-18

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

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

### Patch Changes

## [0.8.1] - 2026-05-18

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- [#62](https://github.com/IBazylchuk/paparats-mcp/pull/62) [`69145dd`](https://github.com/IBazylchuk/paparats-mcp/commit/69145dd92caa4b202f884de762cef5507ba047ed) CLI: `paparats install --embeddings <ollama|openai|voyage>` chooses the embedding backend at install time. Cloud providers (`openai`, `voyage`) drop the bundled Ollama service from the generated `docker-compose.yml` and pass through `OPENAI_API_KEY` / `VOYAGE_API_KEY` so the server and indexer talk straight to the API — no 1.7 GB image, no GGUF download, no host Ollama. Interactive install prompts for the provider and (for cloud) the API key; `--non-interactive` requires `--embedding-api-key <key>` or the corresponding env var. The choice is persisted in `~/.paparats/install.json`, so later `paparats add | remove | edit projects` keep the same compose shape on regeneration.

  Server: `Indexer.getGroupStats` and `Indexer.listGroups` now subtract the metadata sentinel point introduced in 0.8.0, so reported chunk counts reflect real chunks instead of being off by one.

## [0.8.0] - 2026-05-17

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Minor Changes

- [#60](https://github.com/IBazylchuk/paparats-mcp/pull/60) [`3c9a061`](https://github.com/IBazylchuk/paparats-mcp/commit/3c9a061cf92379ad1e45d04f9e1ac71b7f5c2667) Add OpenAI and Voyage AI embedding providers, plus a collection-level
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

### Patch Changes

## [0.7.0] - 2026-05-25

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Minor Changes

- [#58](https://github.com/IBazylchuk/paparats-mcp/pull/58) [`4d46aef`](https://github.com/IBazylchuk/paparats-mcp/commit/4d46aefcf34cd308368f13077f6e902a6728497d) Add GitHub Codespaces quickstart and fix three rough edges surfaced while
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

### Patch Changes

## [0.6.0] - 2026-05-16

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Minor Changes

- [#56](https://github.com/IBazylchuk/paparats-mcp/pull/56) [`aafbfc2`](https://github.com/IBazylchuk/paparats-mcp/commit/aafbfc2e98679357f87b98b72f7c1a7155207e23) Add change-detection to the indexer. Two cron schedules now run side by side: a fast `CRON_FAST` tick (default `*/10 * * * *`) that fingerprints each repo and only re-indexes when it changed, and a slow `CRON` safety-net (default `0 */3 * * *`, was `0 */6 * * *`) that still does a full pass. Remote repos use `git ls-remote HEAD`; bind-mounted local repos use a file mtime/size hash. State persists in `STATE_DB_PATH` (default `/data/indexer-state.db`). Set `CHANGE_DETECTION=false` to opt out.

### Patch Changes

## [0.5.1] - 2026-05-16

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- [#54](https://github.com/IBazylchuk/paparats-mcp/pull/54) [`f15fa7a`](https://github.com/IBazylchuk/paparats-mcp/commit/f15fa7a08d11d50ff10cd763c36f39a942387487) Add six MCP workflow prompts (`find_implementation`, `trace_callers`,
  `onboard_to_project`, `triage_incident`, `prepare_release_notes`,
  `assess_change_impact`) and enforce mode isolation between `/mcp` and
  `/support/mcp` so a coding session id cannot be replayed on the support
  endpoint.

## [0.5.0] - 2026-05-25

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Minor Changes

- [#52](https://github.com/IBazylchuk/paparats-mcp/pull/52) [`a6b60b2`](https://github.com/IBazylchuk/paparats-mcp/commit/a6b60b2efe0b32513b319d34839cecc387e22e80) `paparats add <local-path>` now auto-detects the project language from marker files (Gemfile, package.json, Cargo.toml, go.mod, …) and writes a commented `exclude_extra:` starter block beside the entry, listing the language defaults already applied by the server. The `projects.yml` header now documents every supported per-entry field. Existing entries are left untouched.

### Patch Changes

## [0.4.0] - 2026-05-15

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Minor Changes

- [#49](https://github.com/IBazylchuk/paparats-mcp/pull/49) [`72aab0c`](https://github.com/IBazylchuk/paparats-mcp/commit/72aab0cf524584cbf13eff25ec1fe3afe7c4e185) Rework the install/CLI flow around a single global home, add indexer hot-reload, and clean up the symbol graph.

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

- [#50](https://github.com/IBazylchuk/paparats-mcp/pull/50) [`d478587`](https://github.com/IBazylchuk/paparats-mcp/commit/d4785877da0a8d67948777441fda3181c6ec0bec) fix(group): default to a shared `default` group instead of project name

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

### Patch Changes

## [0.3.2] - 2026-05-14

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- [#43](https://github.com/IBazylchuk/paparats-mcp/pull/43) [`9051779`](https://github.com/IBazylchuk/paparats-mcp/commit/90517796873fbc537c44b4c9a87955a6cf009939) Bug fixes:
  - **`paparats --version` was hardcoded to `0.1.2`**: `packages/cli/src/index.ts` carried a literal version string that the release pipeline never touched, so the flag returned `0.1.2` regardless of what npm had actually installed. Version is now read from the package's own `package.json` at runtime, so it tracks the published version automatically.
  - **AST chunker emitted overlapping chunks for large single declarations**: when `splitNode` recursed into a named child that spanned only one line (e.g. the identifier of an `export const homeMarkdown = ...` with a long template literal body), the identifier produced its own (start, start) chunk while the body produced (start, end), leaving the identifier chunk as a redundant subset of the body chunk. Added a `dedupeContainedChunks` post-filter to drop chunks whose range is fully contained inside another chunk's range. Ties are broken by length, then by emission order.
  - **`.tsx` / `.jsx` files were parsed with the wrong tree-sitter grammar**: `detectLanguageByPath` returns `'typescript'` for `.tsx` (which keeps `LANGUAGE_PROFILES` simple), but `tree-sitter-typescript` does not understand JSX — tags parse as bogus type expressions and identifier usages inside `<Foo prop={x}/>` or `{value}` are lost. Added `resolveAstLanguage(language, relPath)` which upgrades to the `tsx` grammar for `.tsx`/`.jsx` paths at the AST boundary, leaving the higher-level language profile untouched.

- [#44](https://github.com/IBazylchuk/paparats-mcp/pull/44) [`8544dc8`](https://github.com/IBazylchuk/paparats-mcp/commit/8544dc83bb91203efbc6f61ad1eaa9f19353901f) Security bump:
  - Patch GHSA-protobufjs prototype-pollution / code-generation gadget (CVSS 8.1 High) by forcing `protobufjs ≥ 8.0.2` via root `resolutions`. The vulnerable 8.0.1 was a transitive dep of `@opentelemetry/exporter-trace-otlp-http` 0.217.0 — the resolution lifts it to 8.3.0 across the workspace. Dependabot couldn't auto-update because protobufjs is not a direct dep.

## [0.3.1] - 2026-05-11

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Patch Changes

- [#41](https://github.com/IBazylchuk/paparats-mcp/pull/41) [`17c922f`](https://github.com/IBazylchuk/paparats-mcp/commit/17c922f78e3b02d6d8544dd1e89b25f76e081fb0) Security and reliability bumps:
  - Patch 9 dependabot advisories via root `resolutions` (fast-uri ≥3.1.2, hono ≥4.12.18, ip-address ≥10.2.0, postcss ≥8.5.14). All four were transitive — pulled in via @modelcontextprotocol/sdk (hono), ajv (fast-uri), express-rate-limit + simple-git/socks (ip-address), and vite devDep (postcss). The advisories range from path traversal in URI parsing through to JWT timestamp validation; resolutions force every consumer onto the patched line without touching direct deps.
  - Bump Yarn to 4.14.1, @inquirer/prompts to ^8.4.3.
  - Fix flaky `ApiClient.abort` test: aborted requests were being retried with exponential backoff, blowing past the 5s test timeout. Abort errors now short-circuit retry like 4xx and parse errors.

## [0.3.0] - 2026-05-25

**Packages:** @paparats/shared, @paparats/cli, @paparats/server, @paparats/indexer

### Minor Changes

- [#37](https://github.com/IBazylchuk/paparats-mcp/pull/37) [`ee217da`](https://github.com/IBazylchuk/paparats-mcp/commit/ee217da9a19dd11416c4b74d3d527cd662e5b3aa) **Analytics & observability stack.** Adds a unified telemetry façade with three independently-toggleable sinks:
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

### Patch Changes

<!-- END AGGREGATED -->

## [0.2.24] - 2026-04-23

### Changed

- **Per-file language detection during indexing** — each file is now classified by its own extension (with shebang fallback for extension-less scripts) instead of inheriting the project-wide `languages[0]`. Fixes two long-standing issues: (1) misclassified projects where a stray `pom.xml`/`build.gradle` in a Ruby repo forced every `.rb` file through Java tree-sitter grammar, producing broken AST chunks and no symbols; (2) genuinely multi-language projects (e.g. Rails + JS) where non-primary files were chunked with the wrong grammar. Project-level language is retained as a fallback for files whose extension is not recognized. New `detectLanguageByPath()` helper in `@paparats/shared`; wired into `Indexer.indexFile`, `Indexer.indexFilesContent`, and the `/api/file-changed` HTTP endpoint

## [0.2.22] - 2026-04-07

### Added

- **`exclude_extra` indexing option** — new field in `.paparats.yml` and `paparats-indexer.yml` that appends extra patterns to the resolved exclude list without replacing language defaults. `exclude` still does full replacement for cases that need full control. In indexer YAML, `exclude_extra` from `defaults` and repo-level are concatenated (both additive)
- **Configurable Ollama embedding batch size** — `OLLAMA_BATCH_SIZE` env var controls how many texts are sent per Ollama embedding request (default: 5, was hardcoded 10). Passed through in generated `docker-compose.yml` for both server and indexer containers

### Fixed

- **Remaining `language.query()` deprecation warnings** — replaced two leftover `language.query()` calls in `ast-symbol-extractor.ts` with `new Query(language, source)` API. Commit `6d7312c` missed these

## [0.2.19] - 2026-04-04

### Added

- **Indexer YAML config file** (`paparats-indexer.yml`) — per-project indexing overrides for the indexer container. Supports `group`, `language`, `indexing.exclude`, `indexing.paths`, `metadata`, and more per repo. Global `defaults` section applies to all repos without explicit overrides. Falls back to `REPOS` env var when no config file is present. Mounted into the indexer container at `/config/paparats-indexer.yml`
- **`delete_project` MCP tool** — deletes all indexed data for a specific project (chunks from Qdrant, metadata from SQLite, query cache) via MCP. Available in coding mode. The project will be re-indexed automatically on the next indexer cycle if configured. Replaces the `reindex` MCP tool which was a misplaced responsibility
- **Qdrant API key prompt during install** — `paparats install` now asks for the Qdrant API key when using an external Qdrant instance. Previously only the URL was prompted, causing silent auth failures with Qdrant Cloud
- **Group sync on MCP session init** — MCP server now refreshes group list from Qdrant when a new session connects (SSE, Streamable HTTP, or session recreation). Previously groups were only discovered via 2-minute polling, so clients connecting after a Qdrant auth fix would still see empty results until the next poll tick

### Changed

- **Health check failures no longer block install** — `paparats install` now warns and continues when Qdrant or MCP server health checks fail, instead of throwing and aborting the entire installation. Ollama setup and MCP IDE configuration proceed regardless. Provides actionable `docker compose logs` commands in the warning
- **Docker-compose overwrite confirmation** — `paparats install` now detects an existing `~/.paparats/docker-compose.yml` and asks before overwriting when the content differs. Prevents losing manual edits on re-install

### Removed

- **`reindex` MCP tool** — removed from MCP server. Reindexing is the responsibility of the indexer container, not the MCP server. The tool was a relic from CLI-mode that called `reindexGroup()` (deletes entire Qdrant collection + re-indexes from disk), which doesn't work in server/indexer architecture where the MCP server is stateless. Use `delete_project` + indexer trigger instead

## [0.2.18] - 2026-03-28

### Fixed

- **Missing `language` keyword index in Qdrant** — `ensureCollection()` now creates a keyword index on the `language` payload field. The `list_projects` tool uses Qdrant facet queries on this field, which require a keyword index to function. Older collections that lack the index now gracefully return empty languages instead of failing

## [0.2.17] - 2026-03-25

### Fixed

- **CI arm64 Docker builds crash under QEMU** — `better-sqlite3` v12 dropped prebuilt binaries and always compiles via `node-gyp`, which crashes under QEMU arm64 emulation (`Illegal instruction`). Split CI Docker builds into per-platform jobs: amd64 on `ubuntu-latest`, arm64 on native `ubuntu-24.04-arm`, then merge into multi-arch manifest

## [0.2.16] - 2026-03-24

### Fixed

- **Broken Docker builds after Yarn 4 migration** — Server Dockerfile was missing `COPY packages/indexer/package.json` (required by root workspace resolution). Both Dockerfiles removed stale `COPY` of per-workspace `node_modules` that no longer exist under Yarn 4 (all deps hoisted to root)

## [0.2.15] - 2026-03-20

### Added

- **`list_projects` MCP tool** — lists all indexed projects with metadata (chunk count, languages) grouped by collection. Available in both coding and support modes with optional group filtering. Uses Qdrant facet API for efficient aggregation
- **Yarn 4 migration** — migrated from Yarn Classic to Yarn 4 with Corepack. Dockerfiles and CI updated for `--immutable` installs
- **Dependency updates** — Express 4→5 (fixes 3 path-to-regexp CVEs), `@inquirer/prompts` 7→8, `better-sqlite3` 11→12, `chokidar` 4→5, `commander` 12→14, and more

## [0.2.14] - 2026-02-27

### Fixed

- **Batched API indexing deleted all previously indexed files** — `indexFilesContent()` called `cleanupOrphanedChunks()` after each batch, treating the current batch as the complete file list. When the CLI or indexer sent files in batches of 50, each batch deleted everything indexed by previous batches, leaving only the last ~50 files in the index. Removed orphan cleanup from `indexFilesContent()` — orphan cleanup remains in `indexProject()` (filesystem-based) where the full file list is known

## [0.2.13] - 2026-02-27

### Added

- **`DELETE /api/project/:group/:name` endpoint** — deletes all chunks for a project from Qdrant, cleans up metadata from SQLite, invalidates query cache, and removes the project from the in-memory registry. Enables removing a project without reindexing the entire group

### Changed

- **MCP tool parameters accept string numbers** — all numeric tool parameters (`limit`, `radius_lines`, `commit_limit`, `max_hops`) now use `z.coerce.number()` instead of `z.number()`. LLM clients frequently send numbers as strings (e.g. `"10"` instead of `10`), which previously caused `Invalid input: expected number, received string` validation errors

### Removed

- **Terraform language support** — removed `terraform` from `LANGUAGE_PROFILES`, auto-detection markers (`main.tf`), and default exclude patterns. The `jina-code-embeddings` model produces poor embeddings for HCL/Terraform files, causing them to dominate search results and degrade quality for actual code

## [0.2.12] - 2026-02-27

### Added

- **Periodic group discovery from Qdrant** — server now polls Qdrant every 2 minutes for new groups created by external indexers. Previously groups were only discovered once at startup; now they sync continuously (add new, remove stale). Lazy fallback triggers an async refresh when `getGroupNames()` returns empty
- **Ticket-finding guidance in support mode** — MCP support instructions now include decision tree entries for "find the ticket/RCA for this bug" and "which ticket introduced this bug" workflows (`search_code` → `get_chunk_meta`). `get_chunk_meta` tool description updated to explicitly mention bug reports, RCA, and feature request ticket discovery

### Changed

- **Group restore moved from startup to `app.ts`** — one-time Qdrant group restore in `index.ts` replaced by periodic `syncGroupsFromQdrant()` in `createApp()`. Cleaner separation: `index.ts` no longer reaches into Qdrant directly
- **`CreateAppResult` exposes `stopGroupPoll()`** — graceful shutdown calls `stopGroupPoll()` to clean up the interval timer

## [0.2.11] - 2026-02-25

### Added

- **Language auto-detection in indexer** — when a repo has no `.paparats.yml`, the indexer now detects the language from marker files (`package.json` → typescript, `go.mod` → go, `Gemfile` → ruby, etc.) and applies the correct language profile (patterns, exclude, extensions). Previously defaulted to `generic` with `**/*` pattern and no excludes, causing it to index everything including `node_modules`, `dist`, `.git`, etc.
- **`detectLanguages()` and `autoProjectConfig()`** — new helpers exported from `@paparats/server`. `detectLanguages()` scans for marker files, `autoProjectConfig()` builds a fully-resolved `ProjectConfig` with correct language profiles

### Fixed

- **Indexer default config indexed everything** — `buildDefaultProject()` used `languages: ['generic']` with empty `exclude: []`, ignoring even the generic exclude list. Now uses `autoProjectConfig()` which goes through the standard `resolveProject()` pipeline

## [0.2.10] - 2026-02-25

### Fixed

- **Server mode `--ollama-mode local` missing Ollama setup** — `paparats install --mode server --ollama-mode local` now checks that Ollama is installed, starts it if needed, downloads the embedding model GGUF, and registers the model. Previously it only generated the docker-compose without verifying Ollama was ready

## [0.2.9] - 2026-02-25

### Changed

- **`--ollama-url` skips local Ollama setup** — when `--ollama-url` is provided, `paparats install` no longer requires the `ollama` binary on the host and skips GGUF download + model registration. Enables fully external Ollama (e.g. AWS Fargate, a remote server)

## [0.2.8] - 2026-02-25

### Changed

- **Smaller Ollama embedding batches** — `OLLAMA_MAX_BATCH_SIZE` reduced from 100 to 10. Large batches caused connection aborts on CPU-only Docker (Ollama couldn't finish before the client timed out)
- **Longer Ollama timeouts** — single request timeout increased from 30s to 120s, batch timeout from 60s to 240s. Prevents timeouts during cold-start model loading on slower hardware
- **More frequent index progress logging** — progress logged every 10 files (was 20) with percentage indicator: `[50/200] 25% — 340 chunks`
- **`--ollama-mode` for server mode** — `paparats install --mode server --ollama-mode local` uses native Ollama instead of Docker Ollama. Skips Ollama container, connects via `host.docker.internal:11434`. Default remains `docker` for backward compatibility
- **`--ollama-url` flag** — `paparats install --ollama-url http://192.168.1.10:11434` sets a custom Ollama URL. Implies `--ollama-mode local`. Works in both developer and server modes

### Fixed

- **`paparats update` with external Qdrant** — update command no longer checks `localhost:6333` health when using an external Qdrant instance. Reads the compose file to detect which services are present

## [0.2.7] - 2026-02-25

### Added

- **`createQdrantClient()` helper** — centralized Qdrant client factory with correct HTTPS port handling. Exported from `@paparats/server` for use by indexer and other consumers. Resolves port from URL protocol (HTTPS → 443, HTTP → 6333) and disables version compatibility check

### Fixed

- **Qdrant Cloud HTTPS connectivity** — `@qdrant/js-client-rest` defaults to port 6333 when no port is in the URL, breaking Qdrant Cloud (HTTPS on port 443). All `QdrantClient` instantiation sites now use `createQdrantClient()` which resolves the correct port from the URL protocol
- **Ollama Docker healthcheck** — `alpine/ollama` does not ship `wget` or `curl`, causing the health check to fail immediately and marking the container as unhealthy. Changed health check from `wget` to `ollama list` in both the Dockerfile and docker-compose generator. Increased `start_period` from 5s/10s to 60s for slow startup environments

## [0.2.5] - 2026-02-25

### Added

- **Qdrant collection prefix** — all Qdrant collections now use a `paparats_` prefix (e.g. group `my-app` → collection `paparats_my-app`). Prevents namespace collisions when sharing a Qdrant instance with other applications. `toCollectionName()` and `fromCollectionName()` helpers exported from `@paparats/server`
- **`PAPARATS_GROUP` env var for indexer** — when set, all repos in the indexer container share a single Qdrant collection. Overrides per-repo defaults and `.paparats.yml` group field
- **`--group` flag for server mode install** — `paparats install --mode server --group shared` passes `PAPARATS_GROUP` to the generated docker-compose and `.env` file
- **`listGroups()` filters by prefix** — only returns collections owned by paparats (those with `paparats_` prefix), strips the prefix in output
- **Qdrant API key support** — `QDRANT_API_KEY` env var enables authenticated access to Qdrant (e.g. Qdrant Cloud). Supported in server, indexer, and docker-compose generator. CLI: `paparats install --qdrant-api-key <key>`

### Fixed

- **LIKE wildcard injection in metadata-db** — `deleteByProject()`, `deleteByFile()`, and `deleteEdgesByProject()` now escape `%`, `_`, `\` characters via `escapeLike()` with `ESCAPE '\'` clause
- **Duplicated orphan cleanup code** — extracted `cleanupOrphanedChunks()` private method in `Indexer`, replacing identical code blocks in `indexProject()` and `indexFilesContent()`

## [0.2.4] - 2026-02-25

### Added

- **Multi-project search filtering** — `PAPARATS_PROJECTS` env var scopes all searches to a comma-separated list of projects. Set per MCP server instance in the client's MCP config. Uses Qdrant `match.any` for multi-project filtering. Explicit `project` param intersects with allowed set
- **`getProjectScope()` on Searcher** — returns the active project scope (or `null` for global). Exposed in `GET /health` and `GET /api/stats` as `projectScope`
- **MCP scope notification** — when `PAPARATS_PROJECTS` is set, MCP server instructions include the active project scope so the AI assistant is aware of filtering
- **Startup warning for org/repo-style project names** — logs a warning if `PAPARATS_PROJECTS` contains `/` characters, since project names are directory basenames (e.g. `"billing"` not `"org/billing"`)
- **`PAPARATS_PROJECTS` guidance in install output** — all three install modes (developer, server, support) now mention how to configure project scoping
- **External Qdrant support** — `paparats install --qdrant-url <url>` skips the Qdrant Docker container and connects to an external instance (e.g. Qdrant Cloud, a shared cluster). Works in both developer and server modes
- **Interactive Qdrant prompt** — `paparats install` now asks "Use an external Qdrant instance?" during setup. Skipped when `--qdrant-url` is passed as a flag or `--skip-docker` is set

### Fixed

- **Orphaned chunks from deleted files** — `indexProject()` and `indexFilesContent()` now detect and remove Qdrant chunks for files that no longer exist on disk. Compares current file set against Qdrant's indexed files after each index run
- **Stale metadata after chunk deletion** — `deleteByFile()` method added to `MetadataStore`. Called during orphan cleanup to remove commits, tickets, and symbol edges for deleted files

### Changed

- **MCP instructions document project naming** — both coding and support instructions now explain that project names are directory basenames, not org/repo format

## [0.2.2] - 2026-02-24

### Fixed

- **Restore MANDATORY prompt directives** — the 0.2.0 refactor softened server instructions from `MANDATORY/MUST/REQUIRED` to `Always`, causing Claude Code to skip `search_code` calls and answer from memory. Restored strong directives in `codingInstructions`, `supportInstructions`, `search_code` tool description, and project overview resource
- **Flaky doctor test** — replaced real HTTP servers with mocked `fetch` in Qdrant and Ollama config tests to prevent timeouts under load (e.g. during `npm publish`)

### Changed

- **Lightweight Ollama image** — multi-stage Docker build uses `alpine/ollama` (~70 MB, CPU-only) as final base instead of `ollama/ollama` (~4.8 GB). Final image ~1.7 GB
- **CI builds server + indexer Docker images** — `docker-publish.yml` now uses matrix strategy for `paparats-server` and `paparats-indexer` on tag push
- **Local script builds ollama only** — `release-docker.sh` slimmed to ollama image only (server/indexer handled by CI)
- **Removed `--gpu` flag** — GPU/NVIDIA support removed from CLI, Docker Compose generator, and docs in favor of CPU-only `alpine/ollama`

## [0.2.0] - 2026-02-24

### Added

#### Stable Chunk IDs

- Deterministic `chunk_id` payload field with format `{group}//{project}//{file}//{startLine}-{endLine}//{hash}`
- `buildChunkId()` and `parseChunkId()` helpers in `indexer.ts`
- Qdrant keyword payload index on `chunk_id` for fast lookup

#### AST-Based Symbol Extraction

- New `ast-symbol-extractor.ts` module with tree-sitter WASM-based symbol extraction
- Supports 10 languages: TypeScript/JavaScript/TSX, Python, Go, Rust, Java, Ruby, C, C++, C#
- Extracts `defined_symbols` (name + kind) and `uses_symbols` per chunk from AST
- `kind` classification derived from tree-sitter parent node types (function, class, method, interface, type, enum, constant, variable, module)
- New `ast-queries.ts` — tree-sitter S-expression query patterns per language
- Indexer populates `symbol_name` and `kind` from tree-sitter results (replaces old regex-based extraction)

#### Symbol Graph

- New `symbol-graph.ts` — builds cross-chunk symbol edges (`calls`, `called_by`, `references`, `referenced_by`)
- Edges stored in SQLite metadata store for fast lookup
- Post-indexing hook builds symbol graph automatically when tree-sitter is available

#### New MCP Tool: `find_usages`

- Find all chunks that use a given symbol name
- Powered by Qdrant `defines_symbols` / `uses_symbols` keyword indices

#### New MCP Tool: `list_related_chunks`

- List chunks related to a given chunk via symbol graph edges
- Shows call/reference relationships between chunks

#### Metadata Configuration

- New `metadata` section in `.paparats.yml` supporting `service`, `bounded_context`, `tags`, and `directory_tags`
- New `metadata.ts` module with `resolveTags()` and `autoDetectTags()` helpers
- Auto-detection fallback: `service` defaults to project name, `tags` inferred from directory structure

#### New MCP Tools: `get_chunk` and `get_chunk_meta`

- `get_chunk(chunk_id, radius_lines?)` — retrieve a chunk with optional context expansion
- `get_chunk_meta(chunk_id, commit_limit?)` — git metadata including commits and ticket references

#### New MCP Tool: `search_changes`

- Search for recently changed code with date filter on last commit time

#### Git History Extraction

- New `git-metadata.ts` — extracts commit history per file, maps commits to chunks by diff hunk overlap
- New `metadata-db.ts` — SQLite store for git commits, tickets, and symbol edges
- New `ticket-extractor.ts` — extracts Jira, GitHub, and custom ticket references from commit messages
- Git metadata extraction is non-fatal — errors are logged but don't block indexing

#### Extended Qdrant Payload

- Payload fields per chunk: `chunk_id`, `symbol_name`, `kind`, `service`, `bounded_context`, `tags`, `defines_symbols`, `uses_symbols`, `last_commit_hash`, `last_commit_at`, `last_author_email`, `ticket_keys`
- Keyword indices on `chunk_id`, `kind`, `tags`, `last_commit_at`, `ticket_keys`, `defines_symbols`, `uses_symbols`

#### Searcher: Filtered Search

- New `searchWithFilter()` method — accepts additional Qdrant filter conditions

#### AST-Based Code Chunking

- New `ast-chunker.ts` — tree-sitter AST-based chunking replaces regex heuristics as primary strategy
- `chunkByAst()` uses top-level AST nodes as natural chunk boundaries, groups small nodes, splits large nodes recursively by children
- Fixes broken chunking for Go (`func`), Rust (`fn`), Java (`public class`), C/C++/C# which previously fell through to fixed-size splitting
- Added TSX support in regex chunker fallback (`chunkByBraces`)

#### Dual MCP Endpoints, Query Cache, Prometheus Metrics

- Coding endpoint (`/mcp`) and Support endpoint (`/support/mcp`) with isolated tool sets
- In-memory LRU query cache with TTL and group-level invalidation
- Prometheus metrics (opt-in via `PAPARATS_METRICS=true`)
- Support-mode orchestration tools: `explain_feature`, `recent_changes`, `impact_analysis`

#### Docker-Only Deployment (Infrastructure Overhaul)

- **Ollama in Docker** (`packages/ollama/Dockerfile`) — custom `ibaz/paparats-ollama` image with pre-baked Jina Code Embeddings model (~3 GB). Container starts with model immediately ready — no runtime downloads
- **Docker Compose generator** (`packages/cli/src/docker-compose-generator.ts`) — programmatic YAML generation replaces static template copy. `generateDockerCompose()` for developer mode, `generateServerCompose()` for server mode
- **Install modes** — `paparats install --mode <developer|server|support>`:
  - `developer` (default): Docker + choosable Ollama mode (local/docker) + IDE config
  - `server`: Full Docker stack (qdrant + ollama + paparats + indexer), `--repos`, `--github-token`, `--cron` flags, creates `.env` file
  - `support`: Client-only setup, verifies server reachable, configures Cursor + Claude Code with `/support/mcp` endpoint
- **Ollama mode flag** — `--ollama-mode docker|local` for developer mode (default: local for backward compat)
- **Lightweight Ollama image** — multi-stage build uses `alpine/ollama` (~70 MB, CPU-only) as final base instead of `ollama/ollama` (~4.8 GB). Final image ~1.7 GB

#### Indexer Container (`packages/indexer`)

- New package `@paparats/indexer` — separate Docker image (`ibaz/paparats-indexer`) that clones repos and indexes them on a schedule
- `repo-manager.ts` — `parseReposEnv()` parses comma-separated repos, `cloneOrPull()` clones or pulls repos using simple-git
- `scheduler.ts` — node-cron wrapper for scheduled index cycles
- HTTP endpoints: `POST /trigger` (immediate reindex, optional repo filter), `GET /health` (status per repo, last run, next scheduled)
- Auto-detects language and uses sensible defaults when `.paparats.yml` is missing
- Concurrent index cycle guard — skips if already running
- Uses `Indexer` class from `@paparats/server` as a library (no code duplication)

#### Server Library Extraction

- New `packages/server/src/lib.ts` — extracted all re-exports from `index.ts` into a dedicated library entry point
- Server `package.json` `exports` map points to `lib.js` — importing `@paparats/server` no longer executes the server bootstrap
- `index.ts` re-exports from `lib.ts` so existing consumers still work

#### Release Tooling

- `scripts/release-docker.sh` — builds and optionally pushes the Ollama Docker image (server and indexer are built by CI)
- `scripts/sync-version.js` now syncs to `packages/indexer/package.json`
- `scripts/release.js` now stages `packages/indexer/package.json` in version bump commits

#### Documentation

- README restructured with Table of Contents and three deployment guides (Developer, Server, Support)
- New "Docker & Ollama" section covering Local Ollama and Docker Ollama
- Updated CLI reference with all new flags (`--mode`, `--ollama-mode`, `--repos`, `--github-token`, `--cron`, `--server`)
- Architecture diagram updated with indexer, ollama, and docker-compose-generator
- CLAUDE.md updated with indexer, ollama, and lib.ts modules

### Changed

- Indexer uses single-parse flow: `chunkFile()` parses once with tree-sitter, uses tree for both AST chunking and symbol extraction, then deletes tree
- Symbol extraction moved from regex (chunker) to tree-sitter AST (indexer) — single source of truth
- Removed `symbol-extractor.ts` (regex-based) — replaced by `ast-symbol-extractor.ts`
- Renamed `ts-queries.ts` → `ast-queries.ts`, `ts-symbol-extractor.ts` → `ast-symbol-extractor.ts`
- Removed `symbol_name` and `kind` from `ChunkResult` — indexer now populates these and new symbol fields (`defines_symbols`, `uses_symbols`) directly in the Qdrant payload
- Removed dead `ChunkKind` values (`route`, `resource`, `block`) — never produced by AST system
- Standardized chunk line numbers to 0-indexed throughout (chunker, AST chunker, symbol extractor)
- Chunker no longer enriches chunks with symbol metadata (delegated to indexer)
- `paparats install` now generates docker-compose.yml programmatically instead of copying a template
- `docker-compose.template.yml` is now a reference file only (stale comment updated)
- Root `package.json` build/test/typecheck scripts include `@paparats/indexer` workspace

### Fixed

- `/api/chunk/:chunkId` error responses no longer leak internal error messages
- `getAdjacentChunks` now paginates Qdrant scroll results instead of hardcoding `limit: 100`
- Markdown injection prevention: language fields in code fences are sanitized via `sanitizeLang()`
- `get_chunk_meta` payload access uses safe `typeof` checks instead of unsafe `as` casts
- `getChunkById` and `getAdjacentChunks` catch blocks now log errors instead of silently swallowing
- `parseChunkId` import in `app.ts` changed from dynamic to static
- `PAPARATS_METRICS=true` usage in README corrected (set in server environment, not CLI command)
- Install tests updated to use generator-based flow instead of stale `findTemplatePath` deps
- Added tests for server mode and support mode install paths

### Notes

- All new payload fields and modules are backward compatible — old indexed data is unaffected
- A `reindex` call regenerates all metadata including git history and symbol graph (reindex is the migration path)
- Languages without tree-sitter grammar gracefully fall back to `null` for `symbol_name`/`kind`

## [0.1.10] - 2025-05-22

### Fixed

- Memory leaks in watcher, MCP handler, and HTTP timeout utilities

## [0.1.9] - 2025-05-21

### Changed

- Refactored release process and added `release:push` script

## [0.1.8] - 2025-05-20

### Changed

- Updated publish-mcp workflow to trigger on version tag pushes

