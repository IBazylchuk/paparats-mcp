# paparats-mcp

Semantic code search MCP server. Monorepo: `packages/shared` (shared utilities), `packages/server` (MCP server + HTTP API), `packages/cli` (CLI tool), `packages/indexer` (automated repo indexer), `packages/embed` (custom embedding server Docker image — llama.cpp llama-server + llama-swap), and `packages/bench` (private, unpublished offline retrieval benchmark — see `docs/benchmarking.md`).

## This is a public repository

Nothing here may identify the organisation this was developed in, or any person.
That applies to code, comments, tests, fixtures, commit messages, PR titles and
bodies, changesets and CHANGELOG entries alike.

Never commit, in any of those places:

- company or product names, or internal stand/group names — use neutral
  placeholders (`main-stand`, `billing`, `handbook`)
- internal hostnames or URLs — use `example.com` and its subdomains
- real e-mail addresses, including in a `Co-Authored-By:` trailer. Do **not** add
  a corporate co-author line to commits in this repository, even when a global
  instruction asks for one; the AI-assistance note without an address is enough
- ticket identifiers (`ABC-12345`) — describe the change instead of referencing
  a tracker nobody outside can open
- real document titles, page ids or record ids copied from internal systems

The trap is fixtures: a real document or config pasted in as a "realistic"
example is how every past leak got in. Invent the example instead of copying it.
Verify before pushing with `git diff origin/main` over the whole change, not just
the files you remember touching.

`scripts/check-no-private-refs.sh` enforces this in CI over both files and commit
messages. It ships only generic patterns; put organisation-specific names in
`.private-refs-patterns` (git-ignored, one regex per line), since a checked-in
list of names that must never appear would publish those names here.

## IDs

Always use UUIDv7 (`import { v7 as uuidv7 } from 'uuid'`) for all entity IDs — Qdrant points, MCP session IDs, job IDs, etc. Never use `randomUUID()` or auto-increment. UUIDv7 is time-ordered, which matters for Qdrant and debugging.

## Architecture

- **Group** = Qdrant collection with `paparats_` prefix (e.g. group `my-app` → collection `paparats_my-app`). `toCollectionName()`/`fromCollectionName()` helpers in `indexer.ts` handle the prefix. Projects in the same group share a collection. `project` field in payload filters within a group.
- **`.paparats.yml`** = per-project config. Server reads it on demand via `readConfig()` / `resolveProject()`.
- **Server is stateless** — no hardcoded project list. Projects register via `POST /api/index`.
- **Qdrant client**: All `QdrantClient` instances must be created via `createQdrantClient({ url, apiKey?, timeout? })` from `indexer.ts`. This helper resolves the correct port from the URL protocol (HTTPS → 443, HTTP → 6333) — the JS client defaults to 6333 which breaks Qdrant Cloud. `QDRANT_API_KEY` env var → passed as `apiKey`. CLI: `--qdrant-api-key`. Docker Compose generator passes it via `${QDRANT_API_KEY}` env var substitution.
- **Embedding backend**: llama.cpp `llama-server` + `llama-swap`. `llama-server` loads GGUF weights directly; `llama-swap` routes requests by model name and lazy-loads / idle-unloads models (no manual model registration — no Modelfile). Two models, both Apache-2.0 and both `--pooling last` (decoder-based): `bge-code-v1` (code, 1536d) and `qwen3-embedding-0.6b` (arch/docs text, 1024d). OpenAI-style API: `/v1/embeddings`, `/v1/models`. **Swapping either model → follow `docs/replacing-embedding-models.md`** (verbatim instruction strings, cosine-smoke, reindex — non-obvious footguns are documented there).
- **Two embedding layers**: code (`paparats_<group>`, bge-code-v1, 1536d) and arch/docs prose (`paparats_<group>_arch`, qwen3, 1024d) are separate collections with separate models/dims — they never mix. Query instructions are family-specific and query-type-aware for code (bge-code has per-task strings); qwen has a single retrieval instruction, so query-type detection is a no-op on the prose layer. Instruction task strings are VERBATIM from each model's card (see `task-prefixes.ts` — a paraphrase measurably degrades retrieval).

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

| Module                    | Responsibility                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                | Shared interfaces — all type definitions live here                                                                                                                               |
| `lib.ts`                  | Public library entry point — all re-exports for programmatic use (imported by `index.ts`, used by `@paparats/indexer`)                                                           |
| `config.ts`               | `.paparats.yml` reader, 11 built-in language profiles, `loadProject()`, `detectLanguages()`, `autoProjectConfig()`                                                               |
| `app.ts`                  | Express app factory (`createApp()`), HTTP API routes, `withTimeout()`, `sanitizeForLog()`                                                                                        |
| `index.ts`                | Server bootstrap — starts HTTP server, wires components, graceful shutdown                                                                                                       |
| `ast-chunker.ts`          | AST-based code chunking via tree-sitter — groups small nodes, splits large ones recursively                                                                                      |
| `chunker.ts`              | Regex-based code splitting (fallback) — 4 strategies (blocks, braces, indent, fixed)                                                                                             |
| `ast-symbol-extractor.ts` | AST-based symbol extraction — `extractSymbolsForChunks()` (defines/uses per chunk, 11 languages)                                                                                 |
| `ast-queries.ts`          | Tree-sitter S-expression query patterns per language                                                                                                                             |
| `tree-sitter-parser.ts`   | WASM tree-sitter manager — `createTreeSitterManager()`, lazy grammar loading                                                                                                     |
| `symbol-graph.ts`         | Cross-chunk symbol edges (`calls`, `called_by`, `references`, `referenced_by`)                                                                                                   |
| `change-impact.ts`        | `collectDependents()` — breadth-first walk over incoming edges for the coding-mode `change_impact` tool: each dependent once at its nearest hop, `certain` false when every path is AMBIGUOUS, hubs and tests listed but not expanded |
| `embeddings.ts`           | `LlamaServerProvider`, `EmbeddingCache` (SQLite), `CachedEmbeddingProvider`                                                                                                           |
| `indexer.ts`              | Group-aware Qdrant indexing — `createQdrantClient()`, `toCollectionName()`/`fromCollectionName()` prefix helpers, single-parse `chunkFile()` (AST chunking + symbols), file CRUD |
| `searcher.ts`             | Vector search with project filtering, query expansion (support tools only), query cache, metrics instrumentation                                                                                      |
| `query-expansion.ts`      | Abbreviation, case variant, plural, filler word expansion for search queries                                                                                                     |
| `task-prefixes.ts`        | Query-type detection (nl2code / code2code / techqa) mapped to verbatim bge-code-v1 / Qwen3 query instructions                                                                    |
| `embed-text.ts`           | `chunkEmbedText()` — the text a code chunk is embedded as: `Filepath: <path>`, `---`, the chunk. Payload `content` stays the plain chunk. `EMBED_TEXT_FORMAT` is stored as `embed_format` and is part of the unchanged-file check, so bumping it re-embeds every file |
| `ranking.ts`              | `rankKey()` — rank-time order for `search_code`: test files ×0.9 unless the query mentions tests; for a query naming identifiers (`identifierTokens()`), chunks defining one ×1.1 and files named after one ×1.05, and `definitionCandidatesFilter()` adds the chunks that define them to the candidates; every result ×(1 + 0.05·`file_churn`); the shown score stays the similarity |
| `file-churn.ts`           | `readFileCommitCounts()` (`git log` per file, relative to the project) and `churnPercentiles()` — each file's commit-count percentile in its project, rounded to 20 steps. The indexer writes it as `file_churn` after a project pass that wrote chunks (one payload update per step); no git history leaves it unset |
| `query-cache.ts`          | In-memory LRU cache with TTL and group-level invalidation for search results                                                                                                     |
| `qdrant-errors.ts`        | `isMissingCollection()` — tells a missing collection (nothing indexed yet) apart from a Qdrant failure; `describeQdrantError()` — names a connection failure (`ECONNREFUSED`, ...) behind Node's bare `fetch failed` |
| `metrics.ts`              | Prometheus metrics (`@prometheus-io/client`) with `NoOpMetrics` fallback. Opt-in via `PAPARATS_METRICS=true`                                                                     |
| `metadata.ts`             | Tag resolution (`resolveTags()`) + auto-detection from directory structure                                                                                                       |
| `metadata-db.ts`          | SQLite store for git commits, tickets, and symbol edges                                                                                                                          |
| `git-metadata.ts`         | Git history extraction — commit mapping to chunks by diff hunk overlap                                                                                                           |
| `ticket-extractor.ts`     | Jira/GitHub/custom ticket reference parsing from commit messages                                                                                                                 |
| `mcp-handler.ts`          | MCP protocol — three endpoints: coding (`/mcp`), support (`/support/mcp`) and knowledge (`/knowledge/mcp`, opt-in) with isolated tool sets and instructions                    |
| `knowledge-mode.ts`       | Knowledge mode — `parseKnowledgeModeEnv()`, bearer auth (constant-time), 64 kB body limit guards mounted before the global parser, scope intersection                          |

**packages/indexer/src/**

| Module             | Responsibility                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`           | Entry point — wiring only: Express mini-server (`POST /trigger`, `GET /health`) + dual cron scheduler bootstrap (fast change-check + slow safety-net) + projects.yml hot reload, all driving `IndexOrchestrator`. Exposes its own `GET /metrics` on port 9877 when `PAPARATS_METRICS=true` — Prometheus must scrape both endpoints (server `:9876/metrics` + indexer `:9877/metrics`) to see indexing counters |
| `config-loader.ts`   | `loadIndexerConfig()`, `tryLoadIndexerConfig()` — parses `projects.yml`, merges per-repo overrides with defaults, returns `RepoConfig[]` + cron + cron_fast |
| `repo-manager.ts`    | `parseReposEnv()`, `cloneOrPull()` using simple-git — clones are a managed cache: an existing one is re-pointed at the current URL and hard-reset to the remote default branch, re-cloned on any failure; credentials are masked in errors |
| `orchestrator.ts`    | `IndexOrchestrator` — runs index cycles, `/trigger` requests and hot-reload work through one per-repo lock; purges repos removed from (or moved within) projects.yml; persists a fingerprint only when indexing and the docs pass both succeeded |
| `project-resolver.ts` | `resolveRepoProject()` — builds a raw config from `.paparats.yml` + projects.yml overrides and resolves it through the server's `resolveProject`; group precedence `PAPARATS_GROUP` > override > `.paparats.yml` |
| `keyed-serializer.ts` | `KeyedSerializer` — one task at a time per key (repo), different keys concurrently                                                                |
| `trigger-queue.ts`   | `TriggerQueue` — merges full-cycle requests that arrive during a running cycle (repo sets union, `force` stays per repo)                                 |
| `scheduler.ts`       | `startScheduler()` — node-cron wrapper for scheduled index cycles                                                                                       |
| `change-detector.ts` | `GitDetector` (remote `ls-remote HEAD`), `MtimeDetector` (file stat hash) — produce fingerprints used to decide whether to re-index                     |
| `state-store.ts`     | SQLite store of per-repo fingerprints (default `/data/indexer-state.db`); persisted between cron ticks                                                  |
| `types.ts`           | `IndexerConfig`, `RepoConfig`, `RepoOverrides`, `IndexerFileConfig`, `RunStatus`, `HealthResponse`                                                      |

**packages/embed/**

| File         | Responsibility                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile` | Builds a llama.cpp `llama-server` + `llama-swap` image with `bge-code-v1` + `qwen3-embedding-0.6b` GGUF pre-baked (~2.1 GB, CPU-only, zero-config startup). llama-swap serves on port 8080, lazy-loads models by name; models stay resident by default (`EMBED_TTL=0`), opt-in idle unload via `EMBED_TTL` |

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
- **Query cache**: in-memory LRU with TTL (default 5min, 1000 entries). `searcher.invalidateGroupCache()` drops a group's entries after the server's own writes: `POST /api/index`, `POST /api/file-changed`, `POST /api/file-deleted`, `DELETE /api/project/:group/:name` and the MCP `delete_project` tool. The indexer container writes to Qdrant directly, so its updates reach search once cached entries expire (TTL)
- **Prometheus metrics**: opt-in via `PAPARATS_METRICS=true`. `GET /metrics` exposes counters (search, index), histograms (search/embedding duration), gauges (cache sizes, hit rates). `NoOpMetrics` fallback when disabled — zero overhead
- **Three MCP modes**: coding (`/mcp`, `/sse`), support (`/support/mcp`, `/support/sse`) and knowledge (`/knowledge/mcp` only). Each mode has its own tool set and `serverInstructions`. Coding: `search_code`, `get_chunk`, `find_usages`, `change_impact`, `health_check`, `list_projects`, `delete_project`, `search_docs`, all `arch_*` tools and `term_*` tools. Support: `search_code`, `get_chunk`, `find_usages`, `health_check`, `list_projects`, `search_docs`, plus `get_chunk_meta`, `search_changes`, `explain_feature`, `recent_changes`, `impact_analysis`, `get_document`, the six analytics tools and `term_search`/`term_list` (no `arch_*`, no `term_*` writes — support is strictly read-only, enforced by a test over tool annotations). Knowledge: `search_docs` + `get_document`, nothing else (no resources, no prompts, no glossary). Tool sets defined by `CODING_TOOLS`/`SUPPORT_TOOLS`/`KNOWLEDGE_TOOLS`; `createMcpServer(mode)` registers only the relevant tools. `node packages/server/dist/index.js --stdio` serves the coding mode over stdin/stdout instead of HTTP (`McpHandler.connectStdio()`; all logging goes to stderr) — used by registry inspectors such as Glama that spawn the server
- **Knowledge mode**: docs-only endpoint for consumers outside the trust boundary. Off unless `PAPARATS_KNOWLEDGE_TOKENS` + `PAPARATS_KNOWLEDGE_AUDIENCE` are both set (one alone refuses to start); optional `PAPARATS_KNOWLEDGE_PROJECTS` allowlist. Bearer auth + 64 kB body limit run before the global 50 MB parser; the handler refuses requests that skipped them. Stateless Streamable HTTP (fresh server + transport per POST, `GET`/`DELETE` → 405). Its ceiling/allowlist are intersected with `PAPARATS_DOCS_AUDIENCE` / `PAPARATS_PROJECTS`; `internal` is never allowed in its ceiling. Out-of-scope documents must read exactly like missing ones; backend errors are reported generically. Texts live in `prompts.json` under `knowledgeInstructions` / `knowledgeTools`
- **Docs audience labels**: every docs chunk stores one `audience`. Resolved per document at index time: frontmatter `audience:` > `docs.audience` (`.paparats.yml`, or `projects.yml` repo/`defaults`, which wins over the repo file) > `internal`. Labels match `^[a-z0-9][a-z0-9_-]{0,63}$`; invalid in config fails loading, invalid in frontmatter is logged and stored as `internal` (never the project default). Each docs pass rewrites every document (new `doc_id`), so label changes need no migration. `get_document` keys by (project, file), not `doc_id`, for that reason
- **Orchestration tools** (`explain_feature`, `recent_changes`, `impact_analysis`): support-mode only. Compose search + metadata + edges in a single MCP call. Return structured markdown without code content. Use `resolveChunkLocation()` helper for payload extraction. Gracefully degrade when `metadataStore` is null (skip metadata sections, still return search results)
- **Server lib extraction**: `packages/server/src/lib.ts` is the public library entry point (all re-exports). `index.ts` re-exports from `lib.ts`. Server's `package.json` `exports` map points to `lib.js` so importing `@paparats/server` doesn't execute the server bootstrap
- **Docker embed server**: `ibaz/paparats-embed` — llama.cpp `llama-server` + `llama-swap` with `bge-code-v1` + `qwen3-embedding-0.6b` GGUF pre-baked (~2.1 GB, CPU-only, both Apache-2.0). llama-swap serves on port 8080, routes by model name, lazy-loads on first request; models stay resident by default (`EMBED_TTL=0` — llama-swap's unload/swap path can deadlock under load, see the `swap: false` group in the config), opt-in idle unload via `EMBED_TTL`. No Modelfile, no `ollama create` — models ready on container start. ~5–9× faster than Ollama on CPU
- **Docker Compose generator**: `packages/cli/src/docker-compose-generator.ts` builds YAML programmatically. `generateDockerCompose()` for developer mode, `generateServerCompose()` for server mode (adds indexer service)
- **Install modes**: `paparats install --mode <developer|server|support>`. Developer = current flow + embed mode choice (`--embed-mode native|docker`). Server = full Docker stack with auto-indexer. Support = client-only MCP config (no Docker). `--embed-url` skips the local embed server entirely (no binary check, no GGUF download). Native macOS embed mode installs via `brew install llama.cpp mostlygeek/llama-swap/llama-swap` (Metal-accelerated)
- **Indexer container**: `packages/indexer` — separate Docker image that clones repos and indexes on a schedule. Uses `Indexer` class from `@paparats/server` as a library. HTTP trigger at `POST /trigger`, health at `GET /health`
- **Indexer config file**: `projects.yml` mounted at `/config/` in the container. Per-repo overrides (`group`, `language`, `indexing.exclude`, etc.) with global `defaults` section. Priority: `.paparats.yml` in repo > indexer YAML overrides > auto-detection. Falls back to `REPOS` env when no config file present. `CONFIG_DIR` env controls the lookup directory
- **Indexer change detection**: two cron schedules run side by side. Fast `CRON_FAST` (default `*/10 * * * *`) computes a fingerprint per repo and only invokes `indexProject()` when it differs from the last persisted value; slow `CRON` (default `0 */3 * * *`) is the safety-net full pass. Remote repos fingerprint via `git ls-remote HEAD`; bind-mounted local repos via mtime/size hash of the project's file set (same patterns/excludes as indexing). State persists in `STATE_DB_PATH` (default `/data/indexer-state.db`). The fingerprint is taken before the repo is pulled and persisted only when every file and the docs pass indexed without error; detector failures fall through to a defensive reindex. Repos removed from projects.yml are purged (code, metadata, docs) on hot reload. Set `CHANGE_DETECTION=false` to opt out

## Testing

```bash
yarn test              # vitest
yarn typecheck         # tsc --noEmit
yarn bench run         # opt-in retrieval benchmark; needs Qdrant + embed server (docs/benchmarking.md)
```

Retrieval changes (ranking, chunking, models, prefixes) should come with a `yarn bench compare` diff against main.

## Versioning

Releases are driven by [Changesets](https://github.com/changesets/changesets) in `fixed` mode — all four publishable packages (`@paparats/shared`, `@paparats/cli`, `@paparats/server`, `@paparats/indexer`) bump together. There is no `yarn release` command; never bump versions by hand.

**Authoring a change:** run `yarn changeset` in your PR, pick patch/minor/major, write a summary, commit the generated `.changeset/<slug>.md`.

**Release flow:**

1. **CI opens a release PR** (`.github/workflows/release.yml`). On every push to `main` with pending `.changeset/*.md` files, `changesets/action@v1` runs `yarn run version` and opens (or updates) a `chore: release X.Y.Z` PR. The `version` script chains: `changeset version` → `scripts/sync-server-json.js` (syncs `server.json` + root `package.json` from `packages/cli/package.json`) → `scripts/aggregate-changelog.js` (mirrors per-package entries into root `CHANGELOG.md`) → `yarn install --no-immutable`.
2. **Maintainer merges the release PR.** No publish runs in CI — npm tokens were intentionally revoked.
3. **Maintainer publishes locally:** `yarn release:local` (or `--dry-run` to preview). The script in `scripts/release-local.sh` verifies main is clean and up-to-date, no pending changesets, then builds, runs `yarn changeset publish`, pushes a `vX.Y.Z` tag and creates the GitHub Release from the version's root `CHANGELOG.md` section. The tag (not the release) triggers `docker-publish.yml` and `publish-mcp.yml`; the GitHub Release is what Glama's Auto-Release builds from.

**Single source of truth for the bumped version:** `packages/cli/package.json`. `sync-server-json.js` propagates it to root `package.json` and `server.json`. The aggregator merges the entries of all four `packages/*/CHANGELOG.md` (a changeset lands only in the changelogs of the packages it names, so no single file is complete), de-duplicates them, drops dependency-bump boilerplate and rewrites a marker-delimited block in the root `CHANGELOG.md` — idempotent, safe to re-run.

## Docker

- `packages/server/Dockerfile` — builds and runs the server (`ibaz/paparats-server`)
- `packages/indexer/Dockerfile` — builds the indexer (`ibaz/paparats-indexer`)
- `packages/embed/Dockerfile` — builds llama.cpp `llama-server` + `llama-swap` with pre-baked `bge-code-v1` + `qwen3-embedding-0.6b` GGUF models (`ibaz/paparats-embed`)
- `packages/server/docker-compose.template.yml` — reference template (install uses generator now)
- `packages/cli/src/docker-compose-generator.ts` — generates docker-compose.yml at install time
- Qdrant at `:6333`, MCP server at `:9876`, Indexer at `:9877`
- Embed server (llama-swap on internal port 8080, mapped to host 18434 — not Ollama's 11434, so both can run): native mode via `host.docker.internal:18434`, Docker mode via `http://embed:8080`, external via `--embed-url`
