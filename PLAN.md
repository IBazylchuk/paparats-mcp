# paparats-mcp — Implementation Plan

## Phase 1a — Core Server Modules [DONE]

- [x] Project scaffolding (monorepo, tsconfig, workspaces)
- [x] Shared types (`types.ts`)
- [x] Config system (`config.ts`) — `.paparats.yml` reader with 11 language profiles
- [x] Chunker (`chunker.ts`) — ported from JS, 4 strategies (blocks, braces, indent, fixed)
- [x] Embeddings (`embeddings.ts`) — OllamaProvider + SQLite cache
- [x] Indexer (`indexer.ts`) — group-aware collections, project payload filtering

## Phase 1b — Server Runtime

Goal: working HTTP server with MCP protocol, file watcher, and Docker setup.

### Searcher (`packages/server/src/searcher.ts`)

Extract search logic from the old `http-server.mjs` into a dedicated module.

```typescript
search(groupName: string, query: string, options?: { project?: string; limit?: number }): Promise<SearchResponse>
```

- Embed query via provider
- Search Qdrant collection by group name
- Optional `project` filter in payload
- Compute token savings metrics
- Return `SearchResponse` with results + metrics

### HTTP Server (`packages/server/src/index.ts`)

Replace the current barrel export with a full Express HTTP server.

Endpoints:
- `POST /api/search` — `{ group, query, project?, limit? }`
- `POST /api/index` — `{ group, projectDir }` — reads `.paparats.yml` from dir, indexes
- `POST /api/file-changed` — `{ group, project, file }`
- `GET /health` — Qdrant connectivity + collection stats
- `GET /api/stats` — detailed stats + cache size + memory

Key difference from old server: no hardcoded project list. Server is stateless — it receives group/project info per request and reads `.paparats.yml` on demand.

### MCP Handler (`packages/server/src/mcp-handler.ts`)

MCP protocol layer on top of the HTTP server.

Transports:
- SSE (`GET /sse` + `POST /messages`) — for Cursor
- Streamable HTTP (`ALL /mcp`) — for Claude Code

MCP tools:
- `search_code` — `{ query, group?, project?, limit? }`
  - If `group` not specified, read from cwd's `.paparats.yml`
  - `project` defaults to `"all"` (search entire group)
- `health_check` — index status per group
- `reindex` — `{ group?, project? }` — trigger re-index

MCP resources:
- `context://project-overview` — indexed groups/projects summary

### File Watcher (`packages/server/src/watcher.ts`)

Consolidate `host-watcher.mjs` + `file-watcher.mjs` into one module.

- Uses chokidar to watch project directories
- On file change: POST to `/api/file-changed`
- Debounce (configurable per project via `.paparats.yml`)
- Exclude patterns from config
- Can be started standalone or via CLI

### Docker Setup

**`packages/server/Dockerfile`**:
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY packages/server/package.json packages/server/yarn.lock ./
RUN yarn install --production
COPY packages/server/dist ./dist
CMD ["node", "dist/index.js"]
```

**`packages/server/docker-compose.template.yml`**:
```yaml
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports: ["6333:6333"]
    volumes: ["qdrant_data:/qdrant/storage"]

  paparats:
    image: paparats-mcp:latest  # or build from Dockerfile
    ports: ["9876:9876"]
    environment:
      QDRANT_URL: http://qdrant:6333
      OLLAMA_URL: http://host.docker.internal:11434
    extra_hosts: ["host.docker.internal:host-gateway"]

volumes:
  qdrant_data:
```

This template gets copied to `~/.paparats/docker-compose.yml` by `paparats install`.

### Verification

After Phase 1b:
1. `cd paparats-mcp && yarn build` — compiles
2. `docker compose up` — starts Qdrant + MCP server
3. `curl http://localhost:9876/health` — returns OK
4. Create `.paparats.yml` in a test project, trigger index via API, search returns results
5. Connect from Claude Code via Streamable HTTP — `search_code` works
6. Connect from Cursor via SSE — `search_code` works

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
