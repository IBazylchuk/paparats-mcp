# paparats-mcp

Semantic code search MCP server. Monorepo: `packages/shared` (shared utilities), `packages/server` (MCP server + HTTP API), `packages/cli` (CLI tool), `packages/indexer` (automated repo indexer), and `packages/ollama` (custom Ollama Docker image).

## IDs

Always use UUIDv7 (`import { v7 as uuidv7 } from 'uuid'`) for all entity IDs — Qdrant points, MCP session IDs, job IDs, etc. Never use `randomUUID()` or auto-increment. UUIDv7 is time-ordered, which matters for Qdrant and debugging.

## Architecture

- **Group** = Qdrant collection with `paparats_` prefix (e.g. group `my-app` → collection `paparats_my-app`). `toCollectionName()`/`fromCollectionName()` helpers in `indexer.ts` handle the prefix. Projects in the same group share a collection. `project` field in payload filters within a group.
- **`.paparats.yml`** = per-project config. Server reads it on demand via `readConfig()` / `resolveProject()`.
- **Server is stateless** — no hardcoded project list. Projects register via `POST /api/index`.
- **Embedding model**: `jina-code-embeddings` is a local Ollama alias for `jinaai/jina-code-embeddings-1.5b-GGUF`, registered via Modelfile. Not in Ollama registry.

## TypeScript conventions

- ESM only (`"type": "module"`). Imports use `.js` extension: `import { Foo } from './foo.js'`
- `strict: true`, `noUncheckedIndexedAccess: true` — always handle `T | undefined` from array/object indexing
- Target ES2022, module Node16
- Build: `yarn build` (runs `tsc` in each package)
- Lint: `yarn lint`, format: `yarn prettier`

## Module structure

**packages/shared**

- `path-validation.ts` — `validateIndexingPaths()` — rejects absolute paths and path traversal in `indexing.paths` (used by server and CLI)
- `exclude-patterns.ts` — `normalizeExcludePatterns()` — bare dir names (e.g. `node_modules`) become `**/node_modules/**` for glob
- `gitignore.ts` — `createGitignoreFilter()` (per-file checks), `filterFilesByGitignore()` (bulk filter) — used by CLI collectProjectFiles, server indexer, watch
- `language-excludes.ts` — `LANGUAGE_EXCLUDE_DEFAULTS`, `getDefaultExcludeForLanguages()` — per-language exclude patterns

**packages/server/src/**

| Module                    | Responsibility                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                | Shared interfaces — all type definitions live here                                                                                                       |
| `lib.ts`                  | Public library entry point — all re-exports for programmatic use (imported by `index.ts`, used by `@paparats/indexer`)                                   |
| `config.ts`               | `.paparats.yml` reader, 11 built-in language profiles, `loadProject()`                                                                                   |
| `app.ts`                  | Express app factory (`createApp()`), HTTP API routes, `withTimeout()`, `sanitizeForLog()`                                                                |
| `index.ts`                | Server bootstrap — starts HTTP server, wires components, graceful shutdown                                                                               |
| `ast-chunker.ts`          | AST-based code chunking via tree-sitter — groups small nodes, splits large ones recursively                                                              |
| `chunker.ts`              | Regex-based code splitting (fallback) — 4 strategies (blocks, braces, indent, fixed)                                                                     |
| `ast-symbol-extractor.ts` | AST-based symbol extraction — `extractSymbolsForChunks()` (defines/uses per chunk, 10 languages)                                                         |
| `ast-queries.ts`          | Tree-sitter S-expression query patterns per language                                                                                                     |
| `tree-sitter-parser.ts`   | WASM tree-sitter manager — `createTreeSitterManager()`, lazy grammar loading                                                                             |
| `symbol-graph.ts`         | Cross-chunk symbol edges (`calls`, `called_by`, `references`, `referenced_by`)                                                                           |
| `embeddings.ts`           | `OllamaProvider`, `EmbeddingCache` (SQLite), `CachedEmbeddingProvider`                                                                                   |
| `indexer.ts`              | Group-aware Qdrant indexing — `toCollectionName()`/`fromCollectionName()` prefix helpers, single-parse `chunkFile()` (AST chunking + symbols), file CRUD |
| `searcher.ts`             | Vector search with project filtering, query expansion, query cache, metrics instrumentation                                                              |
| `query-expansion.ts`      | Abbreviation, case variant, plural, filler word expansion for search queries                                                                             |
| `task-prefixes.ts`        | Jina task prefix detection (nl2code / code2code / techqa) based on query content                                                                         |
| `query-cache.ts`          | In-memory LRU cache with TTL and group-level invalidation for search results                                                                             |
| `metrics.ts`              | Prometheus metrics (`prom-client`) with `NoOpMetrics` fallback. Opt-in via `PAPARATS_METRICS=true`                                                       |
| `metadata.ts`             | Tag resolution (`resolveTags()`) + auto-detection from directory structure                                                                               |
| `metadata-db.ts`          | SQLite store for git commits, tickets, and symbol edges                                                                                                  |
| `git-metadata.ts`         | Git history extraction — commit mapping to chunks by diff hunk overlap                                                                                   |
| `ticket-extractor.ts`     | Jira/GitHub/custom ticket reference parsing from commit messages                                                                                         |
| `mcp-handler.ts`          | MCP protocol — dual-mode endpoints: coding (`/mcp`) and support (`/support/mcp`) with isolated tool sets and instructions                                |
| `watcher.ts`              | `ProjectWatcher` (chokidar) + `WatcherManager` for file change detection                                                                                 |

**packages/indexer/src/**

| Module            | Responsibility                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `index.ts`        | Entry point — Express mini-server + cron scheduler bootstrap, uses `Indexer` from `@paparats/server` |
| `repo-manager.ts` | `parseReposEnv()`, `cloneOrPull()` using simple-git — clone/pull repos to local filesystem           |
| `scheduler.ts`    | `startScheduler()` — node-cron wrapper for scheduled index cycles                                    |
| `types.ts`        | `IndexerConfig`, `RepoConfig`, `RunStatus`, `HealthResponse`                                         |

**packages/ollama/**

| File         | Responsibility                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile` | Multi-stage build: registers model in `ollama/ollama`, copies into `alpine/ollama` (~1.7 GB, CPU-only, zero-config startup) |

**packages/cli/src/**

| Module                        | Responsibility                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `docker-compose-generator.ts` | Programmatic YAML generation — `generateDockerCompose()` (developer) and `generateServerCompose()` (server mode) |

## Key patterns

- **AST-first chunking**: `indexer.chunkFile()` parses once with tree-sitter, uses the AST for both chunking (`chunkByAst`) and symbol extraction (`extractSymbolsForChunks`), then deletes the tree. Falls back to regex `Chunker` for unsupported languages (Terraform, etc.)
- **Chunk line numbers are 0-indexed** throughout (chunker, AST chunker, symbol extractor, Qdrant payload)
- Qdrant operations use `retryQdrant()` with exponential backoff (3 retries)
- Embedding cache: SQLite at `~/.paparats/cache/embeddings.db`, Float32 vectors, LRU cleanup at 100k entries
- `CachedEmbeddingProvider` wraps any `EmbeddingProvider` — all embedding calls go through cache
- Watcher uses debounce per file (configurable via `.paparats.yml`)
- **Query cache**: in-memory LRU with TTL (default 5min, 1000 entries). Invalidated per-group on file change/delete. Watcher callbacks call `searcher.invalidateGroupCache()` before indexer update
- **Prometheus metrics**: opt-in via `PAPARATS_METRICS=true`. `GET /metrics` exposes counters (search, index, watcher), histograms (search/embedding duration), gauges (cache sizes, hit rates). `NoOpMetrics` fallback when disabled — zero overhead
- **Dual MCP modes**: coding (`/mcp`, `/sse`) and support (`/support/mcp`, `/support/sse`). Each mode has its own tool set and `serverInstructions`. Coding: `search_code`, `get_chunk`, `find_usages`, `health_check`, `reindex`. Support adds `get_chunk_meta`, `search_changes`, `explain_feature`, `recent_changes`, `impact_analysis`. Tool sets defined by `CODING_TOOLS`/`SUPPORT_TOOLS` constants; `createMcpServer(mode)` registers only the relevant tools
- **Orchestration tools** (`explain_feature`, `recent_changes`, `impact_analysis`): support-mode only. Compose search + metadata + edges in a single MCP call. Return structured markdown without code content. Use `resolveChunkLocation()` helper for payload extraction. Gracefully degrade when `metadataStore` is null (skip metadata sections, still return search results)
- **Server lib extraction**: `packages/server/src/lib.ts` is the public library entry point (all re-exports). `index.ts` re-exports from `lib.ts`. Server's `package.json` `exports` map points to `lib.js` so importing `@paparats/server` doesn't execute the server bootstrap
- **Docker Ollama**: `ibaz/paparats-ollama` — multi-stage build: official `ollama/ollama` registers model, then copies into `alpine/ollama` (~70 MB, CPU-only). Final image ~1.7 GB. Model immediately ready on container start
- **Docker Compose generator**: `packages/cli/src/docker-compose-generator.ts` builds YAML programmatically. `generateDockerCompose()` for developer mode, `generateServerCompose()` for server mode (adds indexer service)
- **Install modes**: `paparats install --mode <developer|server|support>`. Developer = current flow + Ollama mode choice. Server = full Docker stack with auto-indexer. Support = client-only MCP config (no Docker)
- **Indexer container**: `packages/indexer` — separate Docker image that clones repos and indexes on a schedule. Uses `Indexer` class from `@paparats/server` as a library. HTTP trigger at `POST /trigger`, health at `GET /health`

## Testing

```bash
yarn test              # vitest
yarn typecheck         # tsc --noEmit
```

## Versioning

**Single source of truth:** root `package.json` field `version`. All other versions are derived by `scripts/sync-version.js` (writes to packages/shared, packages/cli, packages/server, packages/indexer, and server.json). Do not edit version in those files by hand.

- `yarn sync-version` — copy root version into all packages and server.json.
- `yarn release [version]` — bump/set version, sync, commit only (no tag, no push). Then run `yarn publish:npm` and `yarn release:push` so npm has the version before the tag triggers MCP registry.
- `yarn release:push` — tag from root version and push (run after publish:npm).

## Docker

- `packages/server/Dockerfile` — builds and runs the server (`ibaz/paparats-server`)
- `packages/indexer/Dockerfile` — builds the indexer (`ibaz/paparats-indexer`)
- `packages/ollama/Dockerfile` — multi-stage: builds Ollama with pre-baked model using `alpine/ollama` base (`ibaz/paparats-ollama`)
- `packages/server/docker-compose.template.yml` — reference template (install uses generator now)
- `packages/cli/src/docker-compose-generator.ts` — generates docker-compose.yml at install time
- Qdrant at `:6333`, MCP server at `:9876`, Indexer at `:9877`
- Ollama: local mode via `host.docker.internal:11434`, Docker mode via `http://ollama:11434`
