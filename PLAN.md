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

## Phase 1c — CLI Tool

Goal: `npx paparats-mcp` or global install provides full project management.

### CLI Entry (`packages/cli/src/index.ts`)

Commander-based CLI:

```
paparats init          # create .paparats.yml interactively
paparats install       # set up Docker + Ollama
paparats index         # index current project
paparats search <q>    # search from terminal
paparats status        # show system state
paparats watch         # start file watcher
paparats doctor        # diagnostics
paparats groups        # list all groups
```

### `paparats init` (`commands/init.ts`)

Interactive setup:

1. Prompt for group name (default: parent dir name)
2. Detect language from files in cwd (package.json → typescript, Gemfile → ruby, etc.)
3. Prompt for paths to index
4. Write `.paparats.yml`
5. Optionally add `.paparats.yml` to `.gitignore`

### `paparats install` (`commands/install.ts`)

First-time setup:

1. Create `~/.paparats/` directory
2. Copy `docker-compose.template.yml` → `~/.paparats/docker-compose.yml`
3. `docker compose up -d` (Qdrant + MCP server)
4. Check if Ollama is installed, if not — print install instructions
5. Set up embedding model:
   - Download GGUF from HuggingFace (`jinaai/jina-code-embeddings-1.5b-GGUF`)
   - Write `Modelfile` (FROM gguf, PARAMETER num_ctx 8192)
   - `ollama create jina-code-embeddings -f Modelfile` to register the alias
   - The model is not in Ollama registry — this Modelfile step is required
6. Wait for health check
7. Print connection instructions for Claude Code / Cursor

### `paparats index` (`commands/index-cmd.ts`)

1. Read `.paparats.yml` from cwd
2. POST to `http://localhost:9876/api/index` with project info
3. Show progress spinner (ora)
4. Print summary: files indexed, chunks created, time elapsed

### `paparats search` (`commands/search.ts`)

1. Read group from `.paparats.yml`
2. POST to `http://localhost:9876/api/search`
3. Format results with chalk: file path, score, code snippet
4. Show token savings metrics

### `paparats status` (`commands/status.ts`)

Display:

- Docker containers (running/stopped)
- Qdrant connection status
- Ollama model status
- Current project info (from `.paparats.yml`)
- Groups and chunk counts

### `paparats watch` (`commands/watch.ts`)

1. Read `.paparats.yml` from cwd
2. Start chokidar watcher
3. On file changes: POST to `/api/file-changed`
4. Option: `--daemon` to run as background process

### `paparats doctor` (`commands/doctor.ts`)

Diagnostic checks:

- [ ] Docker installed and running
- [ ] Qdrant reachable
- [ ] Ollama installed and model available
- [ ] `.paparats.yml` valid in cwd
- [ ] MCP server reachable
- [ ] Embedding test (embed a test string, verify dimensions)

### `paparats groups` (`commands/groups.ts`)

1. GET `/api/stats`
2. Print table: group name, projects, chunk count, status

### Verification

After Phase 1c:

1. `npm install -g paparats-mcp` (or `npx`)
2. `paparats init` → creates `.paparats.yml`
3. `paparats install` → Docker + Ollama running
4. `paparats index` → project indexed
5. `paparats search "auth flow"` → results in terminal
6. `paparats status` → all green
7. `paparats doctor` → all checks pass

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
