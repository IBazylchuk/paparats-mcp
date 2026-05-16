# Changelog

<!-- BEGIN AGGREGATED -->

> **Releases from 0.3.0 onward** are aggregated automatically from per-package Changesets entries by `scripts/aggregate-changelog.js`. Per-package detail lives in `packages/<name>/CHANGELOG.md`. Entries for **0.2.24 and earlier** are the historical monorepo-level archive (preserved below the aggregated block).

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

## [0.5.0] - 2026-05-16

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

## [0.3.0] - 2026-05-16

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

