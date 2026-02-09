# paparats-mcp

<img src="docs/paparats-kvetka.png" alt="Paparats-kvetka (fern flower)" width="200" align="right">

**Paparats-kvetka** — a magical flower from Slavic folklore that blooms on Kupala Night and grants power to whoever finds it. Likewise, paparats-mcp helps you find the right code across a sea of repositories.

Semantic code search across multiple repositories. MCP server powered by Qdrant vector search and Ollama embeddings, designed for AI coding assistants (Claude Code, Cursor).

Drop a `.paparats.yml` into each project, group them together, and get cross-project semantic search via MCP.

## Prerequisites

Install these **before** running `paparats install` (the CLI does not install them):

| Requirement        | Purpose                         | Install                                                                     |
| ------------------ | ------------------------------- | --------------------------------------------------------------------------- |
| **Docker**         | Runs Qdrant and MCP server      | [docker.com](https://docker.com)                                            |
| **Docker Compose** | Orchestrates containers (v2)    | Included with Docker Desktop; on Linux: `apt install docker-compose-plugin` |
| **Ollama**         | Local embedding model (on host) | [ollama.com](https://ollama.com)                                            |

The CLI checks that `docker`, `ollama`, and `docker compose` (or `docker-compose`) are available. If any are missing, it exits with installation links.

## Quick start

```bash
# 1. Ensure Docker, Docker Compose, and Ollama are installed
docker --version && docker compose version && ollama --version

# 2. One-time setup: starts Qdrant + MCP server, downloads GGUF (~1.6 GB), registers model in Ollama
paparats install

# 3. In your project
cd your-project
paparats init   # creates .paparats.yml
paparats index  # index the codebase

# 4. Connect your IDE (Cursor, Claude Code) to the MCP server — see "Connecting MCP" below
```

### Connecting MCP for semantic search

After `paparats install` and `paparats index`, add the MCP server to your IDE so the AI can use semantic search.

**Cursor**

1. Create or edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project)
2. Add the paparats server (default port 9876):

```json
{
  "mcpServers": {
    "paparats": {
      "type": "http",
      "url": "http://localhost:9876/mcp"
    }
  }
}
```

Restart Cursor after changing the config.

**Claude Code**

```bash
claude mcp add --transport http paparats http://localhost:9876/mcp
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "paparats": {
      "type": "http",
      "url": "http://localhost:9876/mcp"
    }
  }
}
```

**Verify**

- Ensure the server is running (`paparats status` or `docker ps`)
- Check MCP tools in your IDE: you should see `search_code` (semantic search) and `health_check`
- Ask the AI: _"Search for authentication logic in the codebase"_

### What `paparats install` does and does not

| Action                                            | Done by `paparats install`?    |
| ------------------------------------------------- | ------------------------------ |
| Install Docker                                    | No — you must install it first |
| Install Docker Compose                            | No — you must install it first |
| Install Ollama                                    | No — you must install it first |
| Copy `docker-compose.yml` to `~/.paparats/`       | Yes                            |
| Start Qdrant + MCP server containers              | Yes                            |
| Download GGUF model (~1.65 GB)                    | Yes — to `~/.paparats/models/` |
| Register model in Ollama (`jina-code-embeddings`) | Yes                            |
| Start Ollama if not running                       | Yes — spawns `ollama serve`    |

Use `--skip-docker` or `--skip-ollama` if you already have parts set up.

## How it works

```
Your projects                     paparats-mcp                    AI assistant
                                                                   (Claude Code / Cursor)
  backend/                   ┌─────────────────────┐
    .paparats.yml ──────────►│  Indexer             │
  frontend/                  │    chunks code       │           ┌──────────────┐
    .paparats.yml ──────────►│    embeds via Ollama │──────────►│  MCP search  │
  infra/                     │    stores in Qdrant  │           │  tool call   │
    .paparats.yml ──────────►│                      │           └──────────────┘
                             └─────────────────────┘
```

## Key concepts

**Groups** — projects that share a search scope. All projects in the same group are stored in one Qdrant collection and searched together. Define it in `.paparats.yml`:

```yaml
# backend/.paparats.yml
group: 'my-fullstack'
language: ruby
indexing:
  paths: ['app/', 'lib/']
```

```yaml
# frontend/.paparats.yml
group: 'my-fullstack'
language: typescript
indexing:
  paths: ['src/']
```

Now searching "authentication flow" finds relevant code in both backend and frontend.

**Language-aware chunking** — code is split at natural boundaries (functions, classes, blocks) rather than fixed sizes. 4 strategies selected per language: block-based (Ruby/Python), brace-based (JS/TS/Go/Rust/Java/C), indent-based, and fixed-size fallback. Supports Ruby, TypeScript, JavaScript, Python, Go, Rust, Java, Terraform, C, C++, C#.

**Embedding cache** — embeddings are cached in SQLite (`~/.paparats/cache/embeddings.db`) using content-hash keys and Float32 vectors, with LRU cleanup at 100k entries. Re-indexing unchanged code is instant.

## Search features

### Jina task-specific prefixes

The [Jina Code Embeddings](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) model is trained with task-specific prefixes that significantly improve embedding quality. Paparats applies them automatically:

- **Indexing time**: every code chunk is prefixed with `"Candidate code snippet:\n"` before embedding
- **Query time**: the query type is auto-detected and the appropriate prefix is applied:
  - `nl2code` — natural language searching for code (default): `"Find the most relevant code snippet..."`
  - `code2code` — searching with a code snippet: `"Find an equivalent code snippet..."`
  - `techqa` — technical questions: `"Find the most relevant technical answer..."`

Detection is automatic: code patterns (`function`, `const`, `import`, `=>`) trigger `code2code`, question patterns (`how`, `what`, `why`, `?`) trigger `techqa`, everything else uses `nl2code`. Prefixes are auto-enabled for Jina models and disabled for other providers.

### Server-side query expansion

AI clients often issue a single search query, missing results that match synonyms or different casing. Paparats expands every search query into 2-3 variations server-side:

1. **Abbreviation expansion/contraction** — bidirectional: `auth` <-> `authentication`, `config` <-> `configuration`, `db` <-> `database`, etc. (~30 pairs)
2. **Filler word stripping** — `"how does the auth flow work"` -> `"auth flow"`
3. **Case variant generation** — `"user authentication"` -> `"userAuthentication"`, `"handleUserAuth"` -> `"handle user auth"`
4. **Plural normalization** — `"users"` -> `"user"`, `"dependencies"` -> `"dependency"`

All variations are searched in parallel via `Promise.all()`, results are merged using max-score-per-hash deduplication, preserving 0-1 score semantics. The embedding cache makes repeated/similar queries near-instant.

The server logs which query variations contributed results for effectiveness monitoring:

```
[searcher] Query expansion: "auth middleware" -> 3 variations, 4 results ["auth middleware" (2), "authentication middleware" (2)]
```

### Confidence-tiered results

Search results are labeled with confidence tiers to help AI assistants decide next steps:

| Score     | Tier            | Guidance                                                 |
| --------- | --------------- | -------------------------------------------------------- |
| >= 60%    | High confidence | Relevant results found                                   |
| 40% - 60% | Partial match   | Supplement with grep or file reading for better coverage |
| < 40%     | Low confidence  | Use grep or file reading instead                         |

### Token savings metrics

Every search response includes metrics showing how much context was saved by returning relevant chunks instead of full files:

```json
{
  "metrics": {
    "tokensReturned": 150,
    "estimatedFullFileTokens": 5000,
    "tokensSaved": 4850,
    "savingsPercent": 97
  }
}
```

## Architecture

```
paparats-mcp/
├── packages/
│   ├── server/          # MCP server (Docker image)
│   │   ├── src/
│   │   │   ├── index.ts           # HTTP server + MCP handler
│   │   │   ├── indexer.ts         # Group-aware indexing
│   │   │   ├── searcher.ts        # Search with query expansion + metrics
│   │   │   ├── query-expansion.ts # Abbreviation, case, plural, filler expansion
│   │   │   ├── task-prefixes.ts   # Jina task-specific prefix detection
│   │   │   ├── chunker.ts         # Language-aware code chunking (4 strategies)
│   │   │   ├── embeddings.ts      # Ollama provider + SQLite cache + prefix-aware methods
│   │   │   ├── config.ts          # .paparats.yml reader + 11 language profiles
│   │   │   ├── mcp-handler.ts     # MCP protocol (SSE + Streamable HTTP)
│   │   │   ├── watcher.ts         # File watcher (chokidar + debounce)
│   │   │   └── types.ts           # Shared types
│   │   └── Dockerfile
│   └── cli/             # CLI tool (npm package)
│       └── src/
│           ├── index.ts        # Commander entry
│           └── commands/       # init, install, update, index, search, status, watch, doctor, groups
└── examples/
    └── paparats.yml.*   # Config examples per language
```

## Stack

- **Qdrant** — vector database (1 collection per group, cosine similarity, payload filtering by project/file)
- **Ollama** — local embeddings via [jina-code-embeddings-1.5b](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) (1.5B params, 1536 dims, 32k context) with task-specific prefixes for nl2code/code2code/techqa
- **MCP** — Model Context Protocol (SSE for Cursor + Streamable HTTP for Claude Code)
- **TypeScript** monorepo with yarn workspaces

## Embedding model setup

The default model is [jinaai/jina-code-embeddings-1.5b-GGUF](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) — a code-optimized embedding model based on Qwen2.5-Coder-1.5B. It's not in the Ollama registry, so we create a local alias via Modelfile. Task-specific prefixes (nl2code, code2code, techqa) are applied automatically to maximize embedding quality.

**Recommended:** `paparats install` automates the full setup:

- Downloads GGUF (~1.65 GB) to `~/.paparats/models/`
- Creates Modelfile and runs `ollama create jina-code-embeddings`
- Starts Ollama with `ollama serve` if not running

**Manual setup** (if you prefer):

```bash
# 1. Download the GGUF file
curl -L -o jina-code-embeddings-1.5b-Q8_0.gguf \
  "https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF/resolve/main/jina-code-embeddings-1.5b-Q8_0.gguf"

# 2. Create the Modelfile
cat > Modelfile <<'EOF'
FROM ./jina-code-embeddings-1.5b-Q8_0.gguf
PARAMETER num_ctx 8192
EOF

# 3. Register as Ollama model
ollama create jina-code-embeddings -f Modelfile

# 4. Verify
ollama list | grep jina
```

| Spec         | Value                                |
| ------------ | ------------------------------------ |
| Parameters   | 1.5B                                 |
| Dimensions   | 1536                                 |
| Context      | 32,768 tokens (recommended <= 8,192) |
| Quantization | Q8_0 (~1.6 GB)                       |
| Languages    | 15+ programming languages            |

## Configuration

`.paparats.yml` in your project root:

```yaml
group: 'my-project-group' # required — Qdrant collection name
language: ruby # required — or array: [ruby, typescript]

indexing:
  paths: ['app/', 'lib/'] # directories to index (default: ["./"])
  exclude: ['vendor/**'] # additional excludes (merged with language defaults)
  extensions: ['.rb'] # override auto-detected extensions
  chunkSize: 1024 # max chars per chunk (default: 1024)
  concurrency: 2 # parallel file processing (default: 2)
  batchSize: 50 # Qdrant upsert batch size (default: 50)

watcher:
  enabled: true # auto-reindex on file changes (default: true)
  debounce: 1000 # ms debounce (default: 1000)

embeddings:
  provider: 'ollama' # embedding provider (default: "ollama")
  model: 'jina-code-embeddings' # Ollama alias (see "Embedding model setup" above)
  dimensions: 1536 # vector dimensions (default: 1536)
```

## Docker and Ollama

- **Qdrant** and **MCP server** run in Docker containers.
- **Ollama** runs on the host (not in Docker). The server connects to it via `host.docker.internal:11434` (Mac/Windows). On Linux, set `OLLAMA_URL=http://172.17.0.1:11434` (or your docker0 IP) in `~/.paparats/docker-compose.yml` or as an env override.
- **Embedding cache** (SQLite) persists in the `paparats_cache` Docker volume, so re-indexing unchanged code is fast across restarts. Cache keys include task prefixes, so switching models doesn't return stale vectors.

## CLI commands

| Command                   | Description                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `paparats init`           | Create `.paparats.yml` in the current directory (interactive or `--non-interactive`) |
| `paparats install`        | Set up Docker (Qdrant + MCP server) and Ollama embedding model                       |
| `paparats update`         | Update CLI from npm and pull/restart latest server Docker image                      |
| `paparats index`          | Index the current project into the vector database                                   |
| `paparats search <query>` | Semantic search across indexed projects                                              |
| `paparats watch`          | Watch for file changes and reindex automatically                                     |
| `paparats status`         | Show system status (Docker, Ollama, config, server health, groups)                   |
| `paparats doctor`         | Run diagnostic checks                                                                |
| `paparats groups`         | List all indexed groups and projects                                                 |

### Common options

Most commands support `--server <url>` (default: `http://localhost:9876`) and `--json` for machine-readable output.

### Command details

**`paparats init`**

- `--force` — Overwrite existing config
- `--group <name>` — Set group (skip prompt)
- `--language <lang>` — Set language (skip prompt)
- `--non-interactive` — Use defaults without prompts

**`paparats install`**

- `--skip-docker` — Skip Docker setup (only set up Ollama model)
- `--skip-ollama` — Skip Ollama model (only start Docker containers)
- `-v, --verbose` — Show detailed output

**`paparats update`**

- `--skip-cli` — Skip CLI update (only pull and restart Docker)
- `--skip-docker` — Skip Docker update (only update CLI from npm)
- `-v, --verbose` — Show detailed output

**`paparats index`**

- `-f, --force` — Force reindex (clear existing chunks)
- `--dry-run` — Show what would be indexed without indexing
- `--timeout <ms>` — Request timeout (default: 300000)
- `-v, --verbose` — Show skipped files and errors
- `--json` — Output as JSON

**`paparats search <query>`**

- `-n, --limit <n>` — Max results (default: 5)
- `-p, --project <name>` — Filter by project (default: all)
- `-g, --group <name>` — Override group from config
- `--timeout <ms>` — Request timeout (default: 30000)
- `-v, --verbose` — Show token savings
- `--json` — Output as JSON

**`paparats watch`**

- `--dry-run` — Show what would be watched without watching
- `-v, --verbose` — Show file events
- `--json` — Output events as JSON lines

**`paparats status`** — Docker, Ollama, config, server health, groups overview

- `--timeout <ms>` — Request timeout (default: 5000)

**`paparats doctor`** — 6 checks: Docker, Qdrant, Ollama, config, MCP server, install

- `-v, --verbose` — Show detailed error messages

**`paparats groups`**

- `-q, --quiet` — Show only group names
- `-v, --verbose` — Show project details
- `--json` — Output as JSON

## License

MIT
