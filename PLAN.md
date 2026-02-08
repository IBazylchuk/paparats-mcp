# paparats-mcp — Implementation Plan

## Phase 1a — Core Server Modules [DONE]

- [x] Project scaffolding (monorepo, tsconfig, workspaces)
- [x] Shared types (`types.ts`)
- [x] Config system (`config.ts`) — `.paparats.yml` reader with 11 language profiles
- [x] Chunker (`chunker.ts`) — ported from JS, 4 strategies (blocks, braces, indent, fixed)
- [x] Embeddings (`embeddings.ts`) — OllamaProvider + SQLite cache
- [x] Indexer (`indexer.ts`) — group-aware collections, project payload filtering

## Phase 1b — Server Runtime [DONE]

- [x] Searcher (`searcher.ts`) — search within group collection, optional project filter, token savings metrics
- [x] MCP Handler (`mcp-handler.ts`) — SSE + Streamable HTTP transports, `search_code` / `health_check` / `reindex` tools
- [x] File Watcher (`watcher.ts`) — chokidar-based `ProjectWatcher` + `WatcherManager`, debounce, pattern matching
- [x] HTTP Server (`index.ts`) — Express server with `/api/search`, `/api/index`, `/api/file-changed`, `/health`, `/api/stats`
- [x] Docker Setup — `Dockerfile` (node:20-alpine) + `docker-compose.template.yml` (Qdrant + paparats-mcp)

---

## Phase 1c — CLI Tool [DONE]

- [x] CLI entry (`index.ts`) — Commander-based with 8 commands
- [x] Shared utilities — `api-client.ts` (HTTP client), `config.ts` (.paparats.yml reader + writer + language detection)
- [x] `paparats init` — interactive setup with @inquirer/prompts (group, language detection, paths, .gitignore)
- [x] `paparats install` — Docker setup, Ollama model download + Modelfile registration, health checks
- [x] `paparats index` — POST /api/index with ora spinner, progress summary
- [x] `paparats search` — POST /api/search, chalk-formatted results with token savings
- [x] `paparats status` — Docker, Ollama, config, server health, groups overview
- [x] `paparats watch` — chokidar file watcher, debounce, POST /api/file-changed
- [x] `paparats doctor` — 6 diagnostic checks (Docker, Qdrant, Ollama, config, MCP server, install)
- [x] `paparats groups` — GET /api/stats, formatted group/project listing

---

## Future Phases

### Phase 2 — Distribution

- Publish CLI to npm as `paparats-mcp`
- Publish Docker image to Docker Hub
- GitHub Actions for CI/CD
- Auto-configure Claude Code / Cursor MCP settings

### Phase 3 — Enhancements

- OpenAI embedding provider
- Incremental indexing (skip unchanged files via hash comparison)
- Git-aware indexing (respect `.gitignore`, index only tracked files)
- Multi-group search (search across groups)
- Web UI for search and index management
