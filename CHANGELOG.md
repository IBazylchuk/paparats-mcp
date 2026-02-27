# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
