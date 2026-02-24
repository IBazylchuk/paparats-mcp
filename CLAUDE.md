# paparats-mcp

Semantic code search MCP server. Monorepo: `packages/shared` (shared utilities), `packages/server` (MCP server + HTTP API), and `packages/cli` (CLI tool).

## IDs

Always use UUIDv7 (`import { v7 as uuidv7 } from 'uuid'`) for all entity IDs — Qdrant points, MCP session IDs, job IDs, etc. Never use `randomUUID()` or auto-increment. UUIDv7 is time-ordered, which matters for Qdrant and debugging.

## Architecture

- **Group** = Qdrant collection. Projects in the same group share a collection. `project` field in payload filters within a group.
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

**packages/server/src/**

| Module                    | Responsibility                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `types.ts`                | Shared interfaces — all type definitions live here                                               |
| `config.ts`               | `.paparats.yml` reader, 11 built-in language profiles, `loadProject()`                           |
| `ast-chunker.ts`          | AST-based code chunking via tree-sitter — groups small nodes, splits large ones recursively      |
| `chunker.ts`              | Regex-based code splitting (fallback) — 4 strategies (blocks, braces, indent, fixed)             |
| `ast-symbol-extractor.ts` | AST-based symbol extraction — `extractSymbolsForChunks()` (defines/uses per chunk, 10 languages) |
| `ast-queries.ts`          | Tree-sitter S-expression query patterns per language                                             |
| `tree-sitter-parser.ts`   | WASM tree-sitter manager — `createTreeSitterManager()`, lazy grammar loading                     |
| `symbol-graph.ts`         | Cross-chunk symbol edges (`calls`, `called_by`, `references`, `referenced_by`)                   |
| `embeddings.ts`           | `OllamaProvider`, `EmbeddingCache` (SQLite), `CachedEmbeddingProvider`                           |
| `indexer.ts`              | Group-aware Qdrant indexing — single-parse `chunkFile()` (AST chunking + symbols), file CRUD     |
| `searcher.ts`             | Vector search with project filtering, query expansion, token savings metrics                     |
| `metadata.ts`             | Tag resolution (`resolveTags()`) + auto-detection from directory structure                       |
| `metadata-db.ts`          | SQLite store for git commits, tickets, and symbol edges                                          |
| `git-metadata.ts`         | Git history extraction — commit mapping to chunks by diff hunk overlap                           |
| `ticket-extractor.ts`     | Jira/GitHub/custom ticket reference parsing from commit messages                                 |
| `mcp-handler.ts`          | MCP protocol — SSE (Cursor) + Streamable HTTP (Claude Code), tools + resources                   |
| `watcher.ts`              | `ProjectWatcher` (chokidar) + `WatcherManager` for file change detection                         |
| `index.ts`                | Express HTTP server entry point, wires everything together                                       |

## Key patterns

- **AST-first chunking**: `indexer.chunkFile()` parses once with tree-sitter, uses the AST for both chunking (`chunkByAst`) and symbol extraction (`extractSymbolsForChunks`), then deletes the tree. Falls back to regex `Chunker` for unsupported languages (Terraform, etc.)
- **Chunk line numbers are 0-indexed** throughout (chunker, AST chunker, symbol extractor, Qdrant payload)
- Qdrant operations use `retryQdrant()` with exponential backoff (3 retries)
- Embedding cache: SQLite at `~/.paparats/cache/embeddings.db`, Float32 vectors, LRU cleanup at 100k entries
- `CachedEmbeddingProvider` wraps any `EmbeddingProvider` — all embedding calls go through cache
- Watcher uses debounce per file (configurable via `.paparats.yml`)

## Testing

```bash
yarn test              # vitest
yarn typecheck         # tsc --noEmit
```

## Versioning

**Single source of truth:** root `package.json` field `version`. All other versions are derived by `scripts/sync-version.js` (writes to packages/shared, packages/cli, packages/server, and server.json). Do not edit version in those files by hand.

- `yarn sync-version` — copy root version into all packages and server.json.
- `yarn release [version]` — bump/set version, sync, commit only (no tag, no push). Then run `yarn publish:npm` and `yarn release:push` so npm has the version before the tag triggers MCP registry.
- `yarn release:push` — tag from root version and push (run after publish:npm).

## Docker

- `packages/server/Dockerfile` — builds and runs the server
- `packages/server/docker-compose.template.yml` — copied to `~/.paparats/` by CLI install command
- Qdrant at `:6333`, MCP server at `:9876`
- Ollama accessed via `host.docker.internal:11434`
