# Paparats MCP

<img src="docs/paparats-kvetka.png" alt="Paparats-kvetka (fern flower)" width="200" align="right">

[![npm version](https://img.shields.io/npm/v/@paparats/cli?color=01696f)](https://www.npmjs.com/package/@paparats/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-01696f.svg)](LICENSE)
[![PulseMCP](https://img.shields.io/badge/PulseMCP-listed-01696f)](https://www.pulsemcp.com/servers/paparats-mcp)

**Paparats-kvetka** — a magical flower from Slavic folklore that blooms on Kupala Night
and grants power to whoever finds it. Likewise, paparats-mcp helps you find the right
code across a sea of repositories.

> 🌿 Works with **Claude Code · Cursor · Windsurf · Copilot · Codex** · any MCP-compatible agent

**Semantic code search for AI coding assistants.** Give your coding agent deep understanding
of your entire codebase — single repo or multi-project workspaces. Search by meaning,
not keywords. Keep your index fresh with real-time file watching. Return only relevant
chunks instead of full files to save tokens.

**100% local.** No cloud. No API keys. No telemetry. Your code never leaves your machine —
perfect for proprietary and enterprise codebases.

---

## Table of Contents

- [Why Paparats?](#why-paparats)
- [Quick Start](#quick-start)
- [Deployment Guides](#deployment-guides)
  - [Developer Local Setup](#developer-local-setup)
  - [Server / Production Setup](#server--production-setup)
  - [Support Agent Setup](#support-agent-setup)
- [How It Works](#how-it-works)
- [Key Features](#key-features)
- [Use Cases](#use-cases)
  - [For Developers (Coding)](#for-developers-coding)
  - [For Support Teams](#for-support-teams)
- [Configuration](#configuration)
- [MCP Tools Reference](#mcp-tools-reference)
  - [Coding Endpoint](#coding-endpoint-mcp)
  - [Support Endpoint](#support-endpoint-supportmcp)
- [Connecting MCP](#connecting-mcp)
- [CLI Commands](#cli-commands)
- [Docker & Ollama](#docker--ollama)
  - [Local Ollama](#local-ollama)
  - [Docker Ollama](#docker-ollama)
  - [External Qdrant](#external-qdrant)
- [Monitoring](#monitoring)
- [Architecture](#architecture)
- [Embedding Model Setup](#embedding-model-setup)
- [Comparison with Alternatives](#comparison-with-alternatives)
- [Token Savings Metrics](#token-savings-metrics)
- [Contributing](#contributing)
- [Links](#links)

---

## Why Paparats?

AI coding assistants are smart, but they can only see files you open. They don't know your codebase structure, where the authentication logic lives, or how services connect. **Paparats fixes that.**

### What you get

- **Semantic code search** — ask "where is the rate limiting logic?" and get exact code ranked by meaning, not grep matches
- **Real-time sync** — edit a file, and 2 seconds later it's re-indexed. No manual re-runs
- **LSP intelligence** — go-to-definition, find-references, rename symbols via [CCLSP](https://github.com/nicobailon/cclsp) integration
- **Token savings** — return only relevant chunks instead of full files to reduce context size
- **Multi-project workspaces** — search across backend, frontend, infra repos in one query
- **100% local & private** — Qdrant vector database + Ollama embeddings. Nothing leaves your laptop
- **AST-aware chunking** — code split by AST nodes (functions/classes) via tree-sitter, not arbitrary character counts (TypeScript, JavaScript, TSX, Python, Go, Rust, Java, Ruby, C, C++, C#; regex fallback for Terraform)
- **Rich metadata** — each chunk knows its symbol name (from tree-sitter AST), service, domain context, and tags from directory structure
- **Symbol graph** — find usages and cross-chunk relationships powered by AST-based symbol extraction (defines/uses analysis)
- **Git history per chunk** — see who last modified a chunk, when, and which tickets (Jira, GitHub) are linked to it

### Who benefits

| Use Case                    | How Paparats Helps                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Solo developers**         | Quickly navigate unfamiliar codebases, find examples of patterns, reduce context-switching             |
| **Multi-repo teams**        | Cross-project search (backend + frontend + infra), consistent patterns, faster onboarding              |
| **AI agents**               | Foundation for product support bots, QA automation, dev assistants — any agent that needs code context |
| **Legacy modernization**    | Find all usages of deprecated APIs, identify migration patterns, discover hidden dependencies          |
| **Contractors/consultants** | Accelerate ramp-up on client codebases, reduce "where is X?" questions                                 |

---

## Quick Start

```bash
# 1. Install CLI
npm install -g @paparats/cli

# 2. One-time setup (downloads ~1.6 GB GGUF model, starts Docker containers)
paparats install

# 3. In your project
cd your-project
paparats init   # creates .paparats.yml
paparats index  # index the codebase

# 4. Keep index fresh with file watching
paparats watch  # run in background or separate terminal

# 5. Connect your IDE (Cursor, Claude Code) — see "Connecting MCP" below
```

### Prerequisites

Install these **before** running `paparats install`:

| Tool               | Purpose                            | Install                                                                  |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------ |
| **Docker**         | Runs Qdrant vector DB + MCP server | [docker.com](https://docker.com)                                         |
| **Docker Compose** | Orchestrates containers (v2)       | Included with Docker Desktop; Linux: `apt install docker-compose-plugin` |
| **Ollama**         | Local embedding model (on host)    | [ollama.com](https://ollama.com) (or use `--ollama-mode docker`)         |

The CLI checks that `docker` and `ollama` (or `docker` only in Docker Ollama mode) are available. If missing, it exits with installation links.

---

## Deployment Guides

Paparats supports three deployment modes, each designed for a different use case:

### Developer Local Setup

The default mode — for developers using Claude Code, Cursor, or other AI assistants locally.

```bash
# Install with local Ollama (default, requires Ollama installed on host)
paparats install --mode developer

# Or with Docker Ollama (no host Ollama needed)
paparats install --mode developer --ollama-mode docker

# Or with an external Qdrant instance (e.g. Qdrant Cloud)
paparats install --mode developer --qdrant-url http://your-qdrant:6333

# Then, in each project:
cd your-project
paparats init   # creates .paparats.yml
paparats index  # index the codebase
paparats watch  # auto-reindex on file changes
```

**What happens:**

1. Checks Docker (and Ollama if local mode)
2. Asks whether to use an external Qdrant instance (or pass `--qdrant-url` to skip the prompt)
3. Generates docker-compose with qdrant + paparats server (+ ollama if docker mode). When using external Qdrant, the Qdrant container is omitted
4. Downloads and registers the embedding model (local mode) or uses pre-baked Docker image (docker mode)
5. Auto-configures Cursor MCP if `~/.cursor/` exists

### Server / Production Setup

For teams wanting a self-contained Docker stack that auto-indexes repos on a schedule. No IDE integration — headless operation.

```bash
# Full stack: qdrant + ollama + paparats server + indexer
paparats install --mode server --repos org/repo1,org/repo2

# With private repos
paparats install --mode server \
  --repos org/private-repo,org/other \
  --github-token ghp_xxx

# Custom schedule (default: every 6 hours)
paparats install --mode server \
  --repos org/repo \
  --cron "0 */2 * * *"

# With external Qdrant (e.g. Qdrant Cloud)
paparats install --mode server \
  --repos org/repo \
  --qdrant-url https://qdrant.example.com \
  --qdrant-api-key your-api-key

# All repos in one shared collection
paparats install --mode server \
  --repos org/repo1,org/repo2 \
  --group shared-index
```

**What happens:**

1. Checks Docker only (no Ollama check — runs in Docker)
2. Asks whether to use an external Qdrant instance (or pass `--qdrant-url` to skip the prompt)
3. Generates docker-compose with all services: qdrant + ollama + paparats + indexer. When using external Qdrant, the Qdrant container is omitted
4. Creates `~/.paparats/.env` with `REPOS`, `GITHUB_TOKEN`, `CRON`, `PAPARATS_GROUP`, `QDRANT_API_KEY` (as applicable)
5. Starts all containers
6. Indexer clones repos and indexes them on the configured schedule

**After setup:**

```bash
# Trigger immediate reindex
curl -X POST http://localhost:9877/trigger

# Trigger specific repos only
curl -X POST http://localhost:9877/trigger -H 'Content-Type: application/json' \
  -d '{"repos": ["org/repo1"]}'

# Check indexer status
curl http://localhost:9877/health

# MCP endpoints for clients
# Coding:  http://localhost:9876/mcp
# Support: http://localhost:9876/support/mcp
```

### Support Agent Setup

For support teams and bots that connect to an existing Paparats server — no Docker, no Ollama needed.

```bash
# Connect to a running server (default: localhost:9876)
paparats install --mode support

# Connect to a remote server
paparats install --mode support --server http://prod-server:9876
```

**What happens:**

1. Verifies the server is reachable (health check)
2. Configures Cursor MCP with support endpoint (`/support/mcp`)
3. Configures Claude Code MCP if `~/.claude/` exists
4. Prints available tools and endpoint info

**Support endpoint tools:** `search_code`, `get_chunk`, `find_usages`, `health_check`, `get_chunk_meta`, `search_changes`, `explain_feature`, `recent_changes`, `impact_analysis`

---

## How It Works

```
Your projects                   Paparats                       AI assistant
                                                               (Claude Code / Cursor)
  backend/                 ┌──────────────────────┐
    .paparats.yml ────────►│  Indexer              │
  frontend/                │   - chunks code       │          ┌──────────────┐
    .paparats.yml ────────►│   - embeds via Ollama │─────────►│ MCP search   │
  infra/                   │   - stores in Qdrant  │          │ tool call    │
    .paparats.yml ────────►│   - watches changes   │          └──────────────┘
                           └──────────────────────┘
```

### Indexing Pipeline

When you run `paparats index` (or a file changes during `paparats watch`), each file goes through this pipeline:

```
 Source file
     │
     ▼
 ┌─────────────────┐
 │ 1. File discovery│  Collect files from indexing.paths, apply
 │    & filtering   │  gitignore + exclude patterns, skip binary
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 2. Content hash  │  SHA-256 of file content → compare with
 │    check         │  existing Qdrant chunks → skip unchanged
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 3. AST parsing   │  tree-sitter parses the file once (WASM)
 │    (single pass) │  → reused for chunking AND symbol extraction
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 4. Chunking      │  AST nodes → chunks at function/class
 │                  │  boundaries. Regex fallback for unsupported
 │                  │  languages (brace/indent/block strategies)
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 5. Symbol        │  AST queries extract defines (function,
 │    extraction    │  class, variable names) and uses (calls,
 │                  │  references) per chunk. 10+ languages
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 6. Metadata      │  Service name, bounded_context, tags from
 │    enrichment    │  config + auto-detected directory tags
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 7. Embedding     │  Jina Code Embeddings 1.5B via Ollama
 │                  │  SQLite cache (content-hash key) → skip
 │                  │  already-embedded content
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 8. Qdrant upsert │  Vectors + payload (content, file, lines,
 │                  │  symbols, metadata) → batched upsert
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │ 9. Git history   │  git log per file → diff hunks → map
 │    (post-index)  │  commits to chunks by line overlap →
 │                  │  extract ticket refs → store in SQLite
 └────────┬────────┘
          ▼
 ┌─────────────────┐
 │10. Symbol graph  │  Cross-chunk edges: calls ↔ called_by,
 │    (post-index)  │  references ↔ referenced_by → SQLite
 └─────────────────┘
```

### Search Flow

AI assistant queries via MCP → server detects query type (nl2code / code2code / techqa) → expands query (abbreviations, case variants, plurals) → all variants searched in parallel against Qdrant → results merged by max score → only relevant chunks returned with confidence scores and symbol info.

### Watching

`paparats watch` monitors file changes via chokidar with debouncing (1s default). On change, only the affected file re-enters the pipeline. Unchanged content is never re-embedded thanks to the content-hash cache.

---

## Key Features

### Better Search Quality

**Task-specific embeddings** — Jina Code Embeddings supports 3 query types (nl2code, code2code, techqa) with different prefixes for better relevance:

- `"find authentication middleware"` → `nl2code` prefix (natural language → code)
- `"function validateUser(req, res)"` → `code2code` prefix (code → similar code)
- `"how does OAuth work in this app?"` → `techqa` prefix (technical questions)

**Query expansion** — every search generates 2-3 variations server-side:

- Abbreviations: `auth` ↔ `authentication`, `db` ↔ `database`
- Case variants: `userAuth` → `user_auth` → `UserAuth`
- Plurals: `users` → `user`, `dependencies` → `dependency`
- Filler removal: `"how does auth work"` → `"auth"`

All variants searched in parallel, results merged by max score.

**Confidence scores** — each result includes a percentage score (≥60% high, 40–60% partial, <40% low) to guide AI next steps.

### Performance

**Embedding cache** — SQLite cache with content-hash keys + Float32 vectors. Unchanged code never re-embedded. LRU cleanup at 100k entries.

**AST-aware chunking** — tree-sitter AST nodes define natural chunk boundaries for 11 languages. Falls back to regex strategies (block-based for Ruby, brace-based for JS/TS, indent-based for Python, fixed-size) for unsupported languages.

**Real-time watching** — `paparats watch` monitors file changes with debouncing (1s default). Edit → save → re-index in ~2 seconds.

### Integrations

**CCLSP (Claude Code LSP)** — during `paparats init`, optionally sets up:

- LSP server for your language (TypeScript, Python, Go, Ruby, etc.)
- MCP config for go-to-definition, find-references, rename
- Typical AI workflow: `search_code` (semantic) → `find_definition` (precise navigation) → `find_references` (impact analysis)

Skip with `--skip-cclsp` if not needed.

---

## Use Cases

### For Developers (Coding)

Connect via the **coding endpoint** (`/mcp`):

| Use Case                     | How                                                         |
| ---------------------------- | ----------------------------------------------------------- |
| **Navigate unfamiliar code** | `search_code "authentication middleware"` → exact locations |
| **Find similar patterns**    | `search_code "retry with exponential backoff"` → examples   |
| **Trace dependencies**       | `find_usages <chunk_id> --direction both` → callers + deps  |
| **Explore context**          | `get_chunk <chunk_id> --radius_lines 50` → expand around    |

### For Support Teams

Connect via the **support endpoint** (`/support/mcp`):

| Use Case              | How                                                                    |
| --------------------- | ---------------------------------------------------------------------- |
| **Explain a feature** | `explain_feature "rate limiting"` → code locations + changes + modules |
| **Recent changes**    | `recent_changes "auth" --since 2024-01-01` → timeline with tickets     |
| **Impact analysis**   | `impact_analysis "payment processing"` → blast radius + service graph  |
| **Change history**    | `get_chunk_meta <chunk_id>` → authors, dates, linked tickets           |

**Support chatbot example:**

```
User: "How do I configure rate limiting?"

Bot workflow (via /support/mcp):
1. explain_feature("rate limiting", group="my-app")
   → returns code locations + recent changes + related modules
2. get_chunk_meta(<chunk_id>)
   → returns who last modified it, when, linked tickets
3. Bot synthesizes response in plain language with ticket references
```

---

## Configuration

`.paparats.yml` in your project root:

```yaml
group: 'my-project-group' # required — maps to Qdrant collection "paparats_my-project-group"
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
  model: 'jina-code-embeddings' # Ollama alias (see below)
  dimensions: 1536 # vector dimensions (default: 1536)

metadata:
  service: 'my-service' # service name (default: project directory name)
  bounded_context: 'identity' # domain context (default: null)
  tags: ['api', 'auth'] # global tags applied to all chunks
  directory_tags: # tags applied to chunks from specific directories
    src/controllers: ['controller']
    src/models: ['model']
  git:
    enabled: true # extract git history per chunk (default: true)
    maxCommitsPerFile: 50 # max commits to analyze per file (1-500, default: 50)
    ticketPatterns: # custom regex patterns for ticket extraction
      - 'TASK_\d+'
      - 'ISSUE-\d+'
```

### Groups

Projects with the same `group` name share a search scope. All indexed together in one Qdrant collection. The `group` name maps to a Qdrant collection with a `paparats_` prefix (e.g. group `my-fullstack` → collection `paparats_my-fullstack`). This prevents namespace collisions when sharing a Qdrant instance with other applications.

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

Now searching `"authentication flow"` finds code in **both** backend and frontend.

**Server mode shared group:** When using the indexer container with multiple repos, set `PAPARATS_GROUP` (or `--group` during install) to index all repos into a single collection:

```bash
paparats install --mode server --repos org/repo1,org/repo2 --group shared-index
```

### Indexer Config File

For per-project control over indexing in server mode, create `~/.paparats/paparats-indexer.yml`:

```yaml
# Global defaults applied to all repos without explicit overrides
defaults:
  group: shared-group
  cron: '0 */2 * * *'
  indexing:
    exclude: [node_modules, dist, vendor]

repos:
  - url: org/frontend
    language: [typescript]
    indexing:
      paths: [src/]
      exclude: [__tests__, storybook]

  - url: org/backend
    language: ruby
    group: backend-group
    indexing:
      exclude: [spec/fixtures, vendor]
    metadata:
      service: payment-api
      tags: [backend, billing]

  - url: org/docs
    # Minimal — auto-detect language, inherit defaults
```

**Priority:** `.paparats.yml` inside the repo > indexer YAML overrides > auto-detection.

When a repo has its own `.paparats.yml`, the indexer YAML overrides are applied on top (e.g., you can override `group` or add extra excludes without modifying the repo). When no `.paparats.yml` exists, the indexer YAML provides the full config.

The config file is mounted into the indexer container at `/config/paparats-indexer.yml`. Falls back to `REPOS` env var when no config file is present (backward compatible).

**Environment variable:** `CONFIG_DIR` controls where the indexer looks for the config file (default: `/config`).

### Metadata

The `metadata` section enriches each indexed chunk with contextual information that improves search filtering and helps AI assistants understand code ownership.

| Field             | Description                                      | Default                |
| ----------------- | ------------------------------------------------ | ---------------------- |
| `service`         | Service name (e.g., `payment-service`)           | Project directory name |
| `bounded_context` | Domain context (e.g., `billing`, `identity`)     | `null`                 |
| `tags`            | Global tags applied to all chunks                | `[]`                   |
| `directory_tags`  | Tags applied to chunks from specific directories | `{}`                   |

Tags from `directory_tags` are matched by path prefix. Additionally, tags are auto-detected from directory structure (e.g., `src/controllers/user.ts` gets a `controllers` tag).

### Git History

When `metadata.git.enabled` is `true` (the default), the server extracts git history after indexing:

1. For each indexed file, runs `git log` to get commit history
2. Parses diff hunks to determine which commits affected which line ranges
3. Maps commits to chunks by line-range overlap
4. Extracts ticket references from commit messages
5. Stores results in a local SQLite database (`~/.paparats/metadata.db`)
6. Enriches Qdrant payloads with `last_commit_at`, `last_author_email`, `ticket_keys`

**Built-in ticket patterns:**

- Jira: `PROJ-123`, `TEAM-456`
- GitHub issues: `#42`
- GitHub cross-repo: `org/repo#99`

**Custom patterns** can be added via `metadata.git.ticketPatterns` — each entry is a regex string. Use a capture group to extract the ticket key, or the full match is used.

| Config                  | Description                                 | Default             |
| ----------------------- | ------------------------------------------- | ------------------- |
| `git.enabled`           | Enable git history extraction               | `true`              |
| `git.maxCommitsPerFile` | Max commits to analyze per file             | `50` (range: 1-500) |
| `git.ticketPatterns`    | Custom regex patterns for ticket extraction | `[]`                |

Git metadata extraction is non-fatal — if a project is not a git repository or git is unavailable, indexing continues normally without git enrichment.

---

## MCP Tools Reference

Paparats exposes 10 tools via the Model Context Protocol on **two separate endpoints**, each with its own tool set and system instructions:

### Coding Endpoint (`/mcp`)

For developers using Claude Code, Cursor, etc. Focus: search code, read chunks, trace symbol dependencies, manage indexing.

| Tool           | Description                                                                                                     |
| :------------- | :-------------------------------------------------------------------------------------------------------------- |
| `search_code`  | Semantic search across indexed projects. Returns code chunks with symbol definitions/uses and confidence scores |
| `get_chunk`    | Retrieve a chunk by ID with optional surrounding context. Returns code with symbol info                         |
| `find_usages`  | Find symbol relationships: incoming (callers), outgoing (dependencies), or both directions                      |
| `health_check` | Indexing status: chunks per group, running jobs                                                                 |
| `reindex`      | Trigger full reindex; track progress with `health_check`                                                        |

### Support Endpoint (`/support/mcp`)

For support teams and bots without direct code access. Focus: feature explanations, change history, impact analysis — all in plain language.

| Tool              | Description                                                                                                                   |
| :---------------- | :---------------------------------------------------------------------------------------------------------------------------- |
| `search_code`     | Semantic search across indexed projects                                                                                       |
| `get_chunk`       | Retrieve a chunk by ID with optional surrounding context                                                                      |
| `find_usages`     | Find symbol relationships: callers, dependencies, or both                                                                     |
| `health_check`    | Indexing status: chunks per group, running jobs                                                                               |
| `get_chunk_meta`  | Git history and ticket references for a chunk: commits, authors, dates, linked tickets. No code                               |
| `search_changes`  | Semantic search filtered by last commit date. Each result shows when it was last changed                                      |
| `explain_feature` | Comprehensive feature analysis: code locations + recent changes + related modules for a question                              |
| `recent_changes`  | Timeline of changes matching a query, grouped by date with commits, tickets, and affected files. Supports `since` date filter |
| `impact_analysis` | Dependency impact subgraph: seed chunks + impact grouped by service/context + dependency edges. 1-2 hop graph traversal       |

### Typical Workflow

**Drill-down workflow** — start broad, zoom in:

```
1. search_code "authentication middleware"     → find relevant chunks with symbols
2. get_chunk <chunk_id> --radius_lines 50      → expand context around a result
3. find_usages <chunk_id> --direction both     → see callers and dependencies
4. get_chunk_meta <chunk_id>                   → see who modified it, when, linked tickets
5. search_changes "auth" --since 2024-01-01    → find recent auth changes
```

**Single-call workflow** — get the full picture in one round-trip:

```
1. explain_feature "How does authentication work?"  → code locations + changes + related modules
2. recent_changes "auth" --since 2024-01-01         → timeline of auth changes with tickets
3. impact_analysis "rate limiting"                   → blast radius: seed chunks + service graph + edges
4. get_chunk <chunk_id>                              → drill into any specific chunk for code
```

---

## Connecting MCP

After `paparats install` and `paparats index`, connect your IDE:

### Cursor

Create or edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

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

For support use case (feature explanations, change history, impact analysis):

```json
{
  "mcpServers": {
    "paparats-support": {
      "type": "http",
      "url": "http://localhost:9876/support/mcp"
    }
  }
}
```

Restart Cursor after changing config.

### Claude Code

```bash
# Coding endpoint (default)
claude mcp add --transport http paparats http://localhost:9876/mcp

# Support endpoint (for support bots/agents)
claude mcp add --transport http paparats-support http://localhost:9876/support/mcp
```

Or add to `.mcp.json` in project root:

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

### Verify

- `paparats status` — check server is running
- **Coding endpoint** (`/mcp`): tools — `search_code`, `get_chunk`, `find_usages`, `health_check`, `reindex`
- **Support endpoint** (`/support/mcp`): tools — `search_code`, `get_chunk`, `find_usages`, `health_check`, `get_chunk_meta`, `search_changes`, `explain_feature`, `recent_changes`, `impact_analysis`
- Ask the AI: _"Search for authentication logic in the codebase"_

---

## CLI Commands

| Command                   | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `paparats init`           | Create `.paparats.yml` (interactive or `--non-interactive`)   |
| `paparats install`        | Set up Docker + Ollama + MCP configuration                    |
| `paparats update`         | Update CLI from npm + pull latest Docker image                |
| `paparats index`          | Index the current project                                     |
| `paparats search <query>` | Semantic search across indexed projects                       |
| `paparats watch`          | Watch files and auto-reindex on changes                       |
| `paparats status`         | System status (Docker, Ollama, config, server health, groups) |
| `paparats doctor`         | Run diagnostic checks                                         |
| `paparats groups`         | List all indexed groups and projects                          |

Most commands support `--server <url>` (default: `http://localhost:9876`) and `--json` for machine-readable output.

### Common Options

**`paparats init`**

- `--force` — Overwrite existing config
- `--group <name>` — Set group (skip prompt)
- `--language <lang>` — Set language (skip prompt)
- `--non-interactive` — Use defaults without prompts
- `--skip-cclsp` — Skip CCLSP language server setup

**`paparats install`**

- `--mode <mode>` — Install mode: `developer` (default), `server`, or `support`
- `--ollama-mode <mode>` — Ollama deployment: `docker` or `local` (default, developer/server mode)
- `--ollama-url <url>` — External Ollama URL (e.g. `http://192.168.1.10:11434`). Implies `--ollama-mode local`. Skips local Ollama binary check and model setup
- `--skip-docker` — Skip Docker setup (developer mode)
- `--skip-ollama` — Skip Ollama model (developer mode)
- `--qdrant-url <url>` — External Qdrant URL — skip Qdrant Docker container (developer/server mode)
- `--qdrant-api-key <key>` — Qdrant API key for authenticated access (e.g. Qdrant Cloud)
- `--repos <repos>` — Comma-separated repos to index (server mode)
- `--github-token <token>` — GitHub token for private repos (server mode)
- `--cron <expression>` — Cron schedule for indexing (server mode, default: `0 */6 * * *`)
- `--group <name>` — Shared Qdrant group — all repos in one collection (server mode). Sets `PAPARATS_GROUP` env var
- `--server <url>` — Server URL to connect to (support mode)
- `-v, --verbose` — Show detailed output

**`paparats index`**

- `-f, --force` — Force reindex (clear existing chunks)
- `--dry-run` — Show what would be indexed
- `--timeout <ms>` — Request timeout (default: 300000)
- `-v, --verbose` — Show skipped files and errors
- `--json` — Output as JSON

**`paparats search <query>`**

- `-n, --limit <n>` — Max results (default: 5)
- `-p, --project <name>` — Filter by project
- `-g, --group <name>` — Override group from config
- `--timeout <ms>` — Request timeout (default: 30000)
- `-v, --verbose` — Show token savings
- `--json` — Output as JSON

**`paparats watch`**

- `--dry-run` — Show what would be watched
- `-v, --verbose` — Show file events
- `--json` — Output events as JSON lines
- `--polling` — Use polling instead of native watchers (fewer file descriptors; use if EMFILE occurs)

---

## Docker & Ollama

Paparats supports two ways to run Ollama: on the host (local) or in Docker.

### Local Ollama

The default mode. Ollama runs on your host machine, and the Docker containers connect to it.

- **Qdrant** and **MCP server** run in Docker containers
- **Ollama** runs on the host (not Docker). Server connects via `host.docker.internal:11434` (Mac/Windows)
- On Linux, set `OLLAMA_URL=http://172.17.0.1:11434` in `~/.paparats/docker-compose.yml`
- **Embedding cache** (SQLite) persists in `paparats_data` Docker volume

```bash
paparats install                            # local Ollama (default)
paparats install --ollama-mode local        # explicit
```

### Docker Ollama

Ollama runs in a Docker container using `ibaz/paparats-ollama` — a custom image with the Jina Code Embeddings model pre-baked (~3 GB). No host Ollama installation needed.

```bash
paparats install --ollama-mode docker       # Docker Ollama
```

**Benefits:**

- Zero host setup — no Ollama binary, no GGUF download
- Model immediately ready on container start
- Consistent across environments

**Trade-offs:**

- ~1.7 GB Docker image (one-time pull)
- CPU-only — no GPU/Metal acceleration (sufficient for embedding generation, but slower than native Ollama on Mac)

### External Ollama

If you run Ollama on a separate machine (e.g. AWS Fargate, a GPU server, or another host on your network), use `--ollama-url` to point the install at it:

```bash
paparats install --ollama-url http://192.168.1.10:11434

# Server mode with external Ollama
paparats install --mode server --ollama-url http://ollama.internal:11434 --repos org/repo1
```

When `--ollama-url` is set:

- The Ollama Docker container is **omitted** from the generated `docker-compose.yml`
- No local `ollama` binary is required — GGUF download and model registration are skipped
- The `OLLAMA_URL` environment variable in the paparats server (and indexer in server mode) points to your external instance
- Implies `--ollama-mode local` (no Docker Ollama)

This is useful when Docker Ollama is too slow (e.g. CPU-only on Mac, where native Ollama can use Metal GPU acceleration) or when you want to share a single Ollama instance across multiple machines.

### External Qdrant

By default, `paparats install` runs Qdrant as a Docker container. If you already have a Qdrant instance (e.g. [Qdrant Cloud](https://cloud.qdrant.io/), a shared cluster, or a host-level install), you can skip the Qdrant container entirely:

```bash
# Via CLI flag
paparats install --qdrant-url http://your-qdrant:6333

# With API key authentication (e.g. Qdrant Cloud)
paparats install --qdrant-url https://xxx.cloud.qdrant.io --qdrant-api-key your-api-key

# Or answer the interactive prompt during install
paparats install
# ? Use an external Qdrant instance? (skip Qdrant Docker container) Yes
# ? Qdrant URL: http://your-qdrant:6333
```

When `--qdrant-url` is set:

- The Qdrant Docker service is **omitted** from the generated `docker-compose.yml`
- The `QDRANT_URL` environment variable in the paparats server (and indexer in server mode) points to your external instance
- Health check during install verifies the external Qdrant is reachable

When `--qdrant-api-key` is set:

- `QDRANT_API_KEY` is passed to all containers (server + indexer) via `docker-compose.yml` and `~/.paparats/.env`
- Can also be set directly as an environment variable: `QDRANT_API_KEY=your-key` on the server or indexer process

This works with both `--mode developer` and `--mode server`.

---

## Monitoring

Paparats exposes Prometheus metrics for operational visibility. Opt in by setting `PAPARATS_METRICS=true` in the server's environment:

```yaml
# In ~/.paparats/docker-compose.yml, under paparats service:
environment:
  PAPARATS_METRICS: 'true'
```

### Metrics endpoint

```bash
curl http://localhost:9876/metrics
```

### Key metrics

| Metric                              | Type      | Description                         |
| ----------------------------------- | --------- | ----------------------------------- |
| `paparats_search_total`             | Counter   | Search requests by group and method |
| `paparats_search_duration_seconds`  | Histogram | Search latency                      |
| `paparats_index_files_total`        | Counter   | Files indexed                       |
| `paparats_index_chunks_total`       | Counter   | Chunks indexed                      |
| `paparats_query_cache_hit_rate`     | Gauge     | Query result cache hit rate         |
| `paparats_embedding_cache_hit_rate` | Gauge     | Embedding cache hit rate            |
| `paparats_watcher_events_total`     | Counter   | File watcher events                 |

### Prometheus scrape config

```yaml
scrape_configs:
  - job_name: paparats
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:9876']
```

### Query cache

Search results are cached in-memory (LRU, default 1000 entries, 5-minute TTL). The cache is automatically invalidated when files change. Configure via environment variables:

- `QUERY_CACHE_MAX_ENTRIES` — max cached queries (default: 1000)
- `QUERY_CACHE_TTL_MS` — TTL in milliseconds (default: 300000)

Cache stats are included in `GET /api/stats` under the `queryCache` field.

---

## Analytics & Observability

Paparats ships with three observability layers that work together:

1. **Prometheus** (`PAPARATS_METRICS=true`, see above) — scrape `/metrics`.
2. **Local SQLite analytics store** at `~/.paparats/analytics.db` (default ON) — raw search/tool/indexing events. Six MCP tools query it directly: `token_savings_report`, `top_queries`, `cross_project_share`, `retry_rate`, `slowest_searches`, `failed_chunks`.
3. **OpenTelemetry** (`PAPARATS_OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT`) — spans for every search, MCP tool call, embedding, indexing run, chunking error. Works with Tempo, Jaeger, Honeycomb, Datadog, Grafana Cloud — anything that speaks OTLP/HTTP.

### Identity attribution

Clients (IDE plugins, CLI) can set `X-Paparats-User`, `X-Paparats-Session`, `X-Paparats-Client`, `X-Paparats-Anchor-Project` headers. The header name for `user` is configurable via `PAPARATS_IDENTITY_HEADER` (default `X-Paparats-User`). Missing header → events are attributed to `anonymous`. There is no cryptographic verification — this is for attribution, not access control.

`GET /api/stats` echoes the resolved identity, useful for verifying header propagation:

```bash
curl -H 'X-Paparats-User: alice' http://localhost:9876/api/stats | jq .identity
```

### Token-savings estimators

Three levels, computed from raw events at query-time:

- **Naive baseline** — what a model would have read if it pulled the whole file for each result.
- **Search-only** — tokens actually returned by `search_code`.
- **Actually consumed** — tokens that the client subsequently fetched via `get_chunk`. The most honest signal, since it discounts noisy results that were never used.

Run `token_savings_report` from any MCP client connected to `/support/mcp`.

### Cross-project noise

When a client passes `X-Paparats-Anchor-Project` (or specifies a single project in the search call), the share of results from _other_ projects in the same group is recorded. Use `cross_project_share` to see how noisy your group's index is for each user.

### Indexer-pipeline visibility

`failed_chunks` aggregates AST parse failures, regex fallbacks, zero-chunk files, and binary skips. `slowest_searches` ranks individual searches by latency.

### Configuration matrix

| Env var                                 | Default                    | Purpose                                                     |
| --------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `PAPARATS_METRICS`                      | `false`                    | Prometheus surface (existing, unchanged)                    |
| `PAPARATS_ANALYTICS_ENABLED`            | `true`                     | Local SQLite analytics writes                               |
| `PAPARATS_ANALYTICS_DB_PATH`            | `~/.paparats/analytics.db` | Analytics DB file                                           |
| `PAPARATS_ANALYTICS_RETENTION_DAYS`     | `90`                       | Daily prune cutoff                                          |
| `PAPARATS_ANALYTICS_RETENTION_RUN_HOUR` | `3`                        | Hour-of-day for prune (local time)                          |
| `PAPARATS_IDENTITY_HEADER`              | `X-Paparats-User`          | Header name for user attribution                            |
| `PAPARATS_LOG_RESULT_FILES`             | `true`                     | If `false`, store NULL for `search_results.file`            |
| `PAPARATS_LOG_QUERY_TEXT`               | `true`                     | If `false`, store NULL for `search_events.query_text`       |
| `PAPARATS_REFORMULATION_WINDOW_MS`      | `90000`                    | Reformulation detection window                              |
| `PAPARATS_TELEMETRY_SAMPLE_RATE`        | `1.0`                      | Sampling rate (errors are always kept)                      |
| `PAPARATS_OTEL_ENABLED`                 | `false`                    | Enable OTel SDK + OTLP exporter                             |
| `OTEL_EXPORTER_OTLP_ENDPOINT`           | unset                      | OTLP HTTP endpoint (e.g. `http://localhost:4318/v1/traces`) |
| `OTEL_EXPORTER_OTLP_HEADERS`            | unset                      | OTLP auth headers (`key=value,key2=value2`)                 |
| `OTEL_SERVICE_NAME`                     | `paparats-mcp`             | OTel resource attribute                                     |
| `OTEL_RESOURCE_ATTRIBUTES`              | unset                      | Extra resource attrs (`key=value,key2=value2`)              |

### PII guidance

- File paths and query text are stored locally by default. For shared deployments where paths could leak sensitive info, set `PAPARATS_LOG_RESULT_FILES=false` and/or `PAPARATS_LOG_QUERY_TEXT=false`.
- OTel spans never carry full query text by default — only `paparats.query.hash` and length.

---

## Architecture

```
paparats-mcp/
├── packages/
│   ├── server/          # MCP server (Docker image: ibaz/paparats-server)
│   │   ├── src/
│   │   │   ├── lib.ts                # Public library exports (for programmatic use)
│   │   │   ├── index.ts              # HTTP server bootstrap + graceful shutdown
│   │   │   ├── app.ts                # Express app + HTTP API routes
│   │   │   ├── indexer.ts            # Group-aware indexing, single-parse chunkFile()
│   │   │   ├── searcher.ts           # Search with query expansion, cache, metrics
│   │   │   ├── query-expansion.ts    # Abbreviation, case, plural expansion
│   │   │   ├── task-prefixes.ts      # Jina task prefix detection
│   │   │   ├── query-cache.ts        # In-memory LRU search result cache
│   │   │   ├── metrics.ts            # Prometheus metrics (opt-in)
│   │   │   ├── ast-chunker.ts        # AST-based code chunking (tree-sitter, primary strategy)
│   │   │   ├── chunker.ts            # Regex-based code chunking (fallback for unsupported languages)
│   │   │   ├── ast-symbol-extractor.ts # AST-based symbol extraction (tree-sitter, 10 languages)
│   │   │   ├── ast-queries.ts        # Tree-sitter S-expression queries per language
│   │   │   ├── tree-sitter-parser.ts # WASM tree-sitter manager
│   │   │   ├── symbol-graph.ts       # Cross-chunk symbol edges
│   │   │   ├── embeddings.ts         # Ollama provider + SQLite cache
│   │   │   ├── config.ts             # .paparats.yml reader + validation
│   │   │   ├── metadata.ts           # Tag resolution + auto-detection
│   │   │   ├── metadata-db.ts        # SQLite store for git commits + tickets
│   │   │   ├── git-metadata.ts       # Git history extraction + chunk mapping
│   │   │   ├── ticket-extractor.ts   # Jira/GitHub/custom ticket parsing
│   │   │   ├── mcp-handler.ts        # MCP protocol — dual-mode (coding /mcp + support /support/mcp)
│   │   │   ├── watcher.ts            # File watcher (chokidar)
│   │   │   └── types.ts              # Shared types
│   │   └── Dockerfile
│   ├── indexer/         # Automated repo indexer (Docker image: ibaz/paparats-indexer)
│   │   ├── src/
│   │   │   ├── index.ts              # Entry: Express mini-server + cron scheduler
│   │   │   ├── config-loader.ts      # paparats-indexer.yml parser + per-repo overrides
│   │   │   ├── repo-manager.ts       # parseReposEnv(), cloneOrPull() using simple-git
│   │   │   ├── scheduler.ts          # node-cron wrapper
│   │   │   └── types.ts              # IndexerConfig, RepoConfig, RepoOverrides, IndexerFileConfig
│   │   └── Dockerfile
│   ├── ollama/          # Custom Ollama with pre-baked model (Docker image: ibaz/paparats-ollama)
│   │   └── Dockerfile
│   ├── cli/             # CLI tool (npm package: @paparats/cli)
│   │   └── src/
│   │       ├── index.ts                    # Commander entry
│   │       ├── docker-compose-generator.ts # Programmatic YAML generation
│   │       └── commands/                   # init, install, update, index, etc.
│   └── shared/          # Shared utilities (npm package: @paparats/shared)
│       └── src/
│           ├── path-validation.ts    # Path validation
│           ├── gitignore.ts          # Gitignore parsing
│           ├── exclude-patterns.ts   # Glob exclude normalization
│           └── language-excludes.ts  # Language-specific exclude defaults
└── examples/
    └── paparats.yml.*   # Config examples per language
```

---

## Stack

- **Qdrant** — vector database (1 collection per group with `paparats_` prefix, cosine similarity, payload filtering)
- **Ollama** — local embeddings via Jina Code Embeddings 1.5B with task-specific prefixes
- **SQLite** — embedding cache (`~/.paparats/cache/embeddings.db`) + git metadata store (`~/.paparats/metadata.db`)
- **MCP** — Model Context Protocol (SSE for Cursor, Streamable HTTP for Claude Code). Dual endpoints: `/mcp` (coding) and `/support/mcp` (support)
- **TypeScript** monorepo with Yarn workspaces

---

## Integration Examples

### Support Chatbot

Use paparats as the knowledge backend for a product support bot. Connect the bot to the **support endpoint** (`/support/mcp`) for access to `explain_feature`, `recent_changes`, `impact_analysis`, and other support-oriented tools:

```
User: "How do I configure rate limiting?"

Bot workflow (via /support/mcp):
1. explain_feature("rate limiting", group="my-app")
   → returns code locations + recent changes + related modules
2. get_chunk_meta(<chunk_id>)
   → returns who last modified it, when, linked tickets
3. Bot synthesizes response in plain language with ticket references
```

### CI/CD (GitHub Actions)

Re-index on every push to keep the search index fresh:

```yaml
name: Reindex Paparats
on:
  push:
    branches: [main]

jobs:
  reindex:
    runs-on: ubuntu-latest
    services:
      qdrant:
        image: qdrant/qdrant:latest
        ports: ['6333:6333']
    steps:
      - uses: actions/checkout@v4
      - uses: jcarpenter/setup-ollama@v1
      - run: npm install -g @paparats/cli
      - run: paparats install --skip-docker
      - run: paparats index --server http://localhost:9876
```

### CI/CD with Indexer Container

For server deployments, trigger the indexer directly via HTTP:

```yaml
name: Trigger Paparats Reindex
on:
  push:
    branches: [main]

jobs:
  reindex:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -X POST http://your-server:9877/trigger \
            -H 'Content-Type: application/json' \
            -d '{"repos": ["your-org/your-repo"]}'
```

### Code Review Assistant

Combine multiple tools to analyze the impact of a pull request:

```
1. explain_feature("the feature being changed")
   → understand what the code does and how it connects
2. impact_analysis("the changed function or module")
   → blast radius: which services and modules are affected
3. search_changes("related area", since="2024-01-01")
   → recent changes that might conflict or overlap
```

---

## Embedding Model Setup

Default: [jinaai/jina-code-embeddings-1.5b-GGUF](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) — code-optimized, 1.5B params, 1536 dims, 32k context. Not in Ollama registry, so we create a local alias.

**Recommended:** `paparats install` automates this:

- **Local mode** (`--ollama-mode local`): Downloads GGUF (~1.65 GB) to `~/.paparats/models/`, creates Modelfile and runs `ollama create jina-code-embeddings`
- **Docker mode** (`--ollama-mode docker`): Uses `ibaz/paparats-ollama` image with model pre-baked — zero setup

**Manual setup:**

```bash
# 1. Download GGUF
curl -L -o jina-code-embeddings-1.5b-Q8_0.gguf \
  "https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF/resolve/main/jina-code-embeddings-1.5b-Q8_0.gguf"

# 2. Create Modelfile
cat > Modelfile <<'EOF'
FROM ./jina-code-embeddings-1.5b-Q8_0.gguf
PARAMETER num_ctx 8192
EOF

# 3. Register in Ollama
ollama create jina-code-embeddings -f Modelfile

# 4. Verify
ollama list | grep jina
```

| Spec         | Value                               |
| ------------ | ----------------------------------- |
| Parameters   | 1.5B                                |
| Dimensions   | 1536                                |
| Context      | 32,768 tokens (recommended ≤ 8,192) |
| Quantization | Q8_0 (~1.6 GB)                      |
| Languages    | 15+ programming languages           |

Task-specific prefixes (nl2code, code2code, techqa) applied automatically.

---

## Comparison with Alternatives

### Feature Matrix

#### Deployment

| Feature     | Paparats | Vexify | SeaGOAT | Augment | Sourcegraph | Greptile | Bloop |
| :---------- | :------: | :----: | :-----: | :-----: | :---------: | :------: | :---: |
| Open source |  ✅ MIT  | ✅ MIT | ✅ MIT  |   ❌    | ⚠️ Partial  |    ❌    | ⚠️ 1  |
| Fully local |    ✅    |   ✅   |   ✅    | ⚠️ No 2 |     ❌      |    ❌    |  ✅   |

#### Search Quality

| Feature         | Paparats  | Vexify | SeaGOAT  |  Augment   | Sourcegraph |  Greptile  | Bloop  |
| :-------------- | :-------: | :----: | :------: | :--------: | :---------: | :--------: | :----: |
| Code embeddings | ✅ Jina 3 |  ⚠️ 4  |   ❌ 5   | ⚠️ Partial | ⚠️ Partial  | ⚠️ Partial |   ✅   |
| Vector database | ✅ Qdrant | SQLite | ChromaDB |  Propri.   |   Propri.   |  pgvector  | Qdrant |
| AST chunking    |    ✅     |   ❌   |    ❌    | ⚠️ Partial | ⚠️ Partial  | ⚠️ Partial |   ✅   |
| Query expansion |   ✅ 6    |   ❌   |    ❌    | ⚠️ Partial | ⚠️ Partial  | ⚠️ Partial |   ❌   |

#### Developer Experience

| Feature            | Paparats  |   Vexify   |  SeaGOAT   |  Augment   | Sourcegraph |  Greptile  |   Bloop    |
| :----------------- | :-------: | :--------: | :--------: | :--------: | :---------: | :--------: | :--------: |
| Real-time watching |  ✅ Auto  |     ❌     |     ❌     |  ⚠️ CI/CD  |     ✅      | ⚠️ Partial | ⚠️ Partial |
| Embedding cache    | ✅ SQLite | ⚠️ Partial |     ❌     | ⚠️ Partial | ⚠️ Partial  | ⚠️ Partial |     ❌     |
| Multi-project      | ✅ Groups |     ✅     |     ❌     |     ✅     |     ✅      |     ✅     |     ✅     |
| One-cmd install    |    ✅     | ⚠️ Partial | ⚠️ Partial |     ❌     |     ❌      |     ❌     |     ❌     |

#### AI Integration

| Feature           | Paparats | Vexify | SeaGOAT |  Augment   | Sourcegraph | Greptile | Bloop |
| :---------------- | :------: | :----: | :-----: | :--------: | :---------: | :------: | :---: |
| MCP native        |    ✅    |   ✅   |   ❌    |     ✅     |     ❌      |  ⚠️ API  |  ❌   |
| LSP integration   | ✅ CCLSP |   ❌   |   ❌    |     ❌     | ⚠️ Partial  |    ❌    |  ❌   |
| Token metrics     |    ✅    |   ❌   |   ❌    | ⚠️ Partial |     ❌      |    ❌    |  ❌   |
| Git history       |    ✅    |   ❌   |   ❌    |     ❌     | ⚠️ Partial  |    ❌    |  ❌   |
| Ticket extraction |    ✅    |   ❌   |   ❌    |     ❌     |     ❌      |    ❌    |  ❌   |

#### Pricing

|      |  Paparats   |   Vexify    |   SeaGOAT   | Augment | Sourcegraph | Greptile |    Bloop    |
| :--- | :---------: | :---------: | :---------: | :-----: | :---------: | :------: | :---------: |
| Cost | ✅ **Free** | ✅ **Free** | ✅ **Free** | ❌ Paid |   ❌ Paid   | ❌ Paid  | ⚠️ Archived |

<details>
<summary>Notes</summary>

1. Bloop archived January 2, 2025
2. Augment Context Engine indexes locally but stores vectors in cloud
3. Jina Code Embeddings 1.5B (1536 dims) with task-specific prefixes (nl2code, code2code, techqa)
4. Vexify supports Ollama models but limited to specific embeddings (jina-embeddings-2-base-code, nomic-embed-text)
5. SeaGOAT locked to all-MiniLM-L6-v2 (384 dims, general-purpose)
6. Abbreviations, case variants, plurals, filler word removal

</details>

---

## Token Savings Metrics

### What we measure (and what we don't)

Paparats provides **estimated** token savings to help you understand the order of magnitude of context reduction. These are heuristics, not precise measurements.

#### Per-search response

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

| Field                     | Calculation                 | Reality Check                                                  |
| ------------------------- | --------------------------- | -------------------------------------------------------------- |
| `tokensReturned`          | `ceil(content.length / 4)`  | Based on actual returned content; /4 is rough approximation    |
| `estimatedFullFileTokens` | `ceil(endLine * 50 / 4)`    | **Heuristic**: assumes 50 chars/line, never loads actual files |
| `tokensSaved`             | `estimated - returned`      | **Derived**: difference between two estimates                  |
| `savingsPercent`          | `(saved / estimated) * 100` | **Relative**: percentage of heuristic estimate                 |

#### Cumulative stats

```bash
curl -s http://localhost:9876/api/stats | jq '.usage'
```

```json
{
  "searchCount": 47,
  "totalTokensSaved": 152340,
  "avgTokensSavedPerSearch": 3241
}
```

These are **sums of estimates**, not measured token counts from a real tokenizer.

---

## License

MIT

---

## Releasing (maintainers)

Releases are driven by [Changesets](https://github.com/changesets/changesets). Versioning + CHANGELOG generation happen in CI; **publishing to npm and tagging happen locally** from a maintainer machine that's authenticated with npm. There are no npm credentials in CI.

### Authoring a changeset (per PR)

```bash
yarn changeset
# Pick affected packages, bump type (patch/minor/major), and write the user-facing summary.
git add .changeset/
git commit -m "chore: changeset"
```

All four packages (`@paparats/shared`, `@paparats/cli`, `@paparats/server`, `@paparats/indexer`) are kept on a **fixed version** — pick any one and the rest are bumped to match.

### How a release happens

**1. CI opens a release PR (automatic).** The [Release workflow](.github/workflows/release.yml) runs on every push to `main`. If pending `.changeset/*.md` files exist, it opens (or updates) a `chore: release` PR with: version bumps in every `package.json`, regenerated per-package `CHANGELOG.md` files, `server.json` synced via `scripts/sync-server-json.js`, and the consumed `.changeset/*.md` files deleted.

**2. Maintainer merges the release PR.** No further CI publish step runs.

**3. Maintainer publishes locally.** From a clean checkout of `main` after the merge:

```bash
git checkout main && git pull
yarn release:local         # or `--dry-run` to preview
```

`yarn release:local` runs `scripts/release-local.sh`, which:

- refuses to run unless you're on `main`, the tree is clean, and you're in sync with `origin/main`;
- refuses if any pending `.changeset/*.md` are present (means the release PR wasn't merged);
- reads the new version from `packages/cli/package.json`;
- builds, runs `yarn changeset publish` (skips already-published versions), then tags `vX.Y.Z` and pushes the tag.

**4. Downstream workflows fire on the tag.** Pushing `vX.Y.Z` triggers [docker-publish.yml](.github/workflows/docker-publish.yml) and [publish-mcp.yml](.github/workflows/publish-mcp.yml) automatically.

### Required credentials

| Where | What                                | Purpose                                           |
| ----- | ----------------------------------- | ------------------------------------------------- |
| CI    | `GITHUB_TOKEN` (auto)               | Open/update the `chore: release` PR               |
| Local | `npm login` (or `NPM_TOKEN` in env) | `yarn changeset publish` to publish `@paparats/*` |

No npm token lives in GitHub secrets — publishing is intentionally a manual, authenticated step.

### Manual / fallback flows

`./scripts/release-docker.sh --push` still builds and pushes the Docker images by hand if needed (e.g. between official releases). It reads the version from `package.json`.

### Docker images

| Image                   | Source                        | Size                   |
| ----------------------- | ----------------------------- | ---------------------- |
| `ibaz/paparats-server`  | `packages/server/Dockerfile`  | ~200 MB                |
| `ibaz/paparats-indexer` | `packages/indexer/Dockerfile` | ~200 MB                |
| `ibaz/paparats-ollama`  | `packages/ollama/Dockerfile`  | ~3 GB (includes model) |

---

## Contributing

Contributions welcome! Areas of interest:

- Additional language support (PHP, Elixir, Scala, Kotlin, Swift)
- Alternative embedding providers (OpenAI, Cohere, local GGUF via llama.cpp)
- Performance optimizations (chunking strategies, cache eviction)
- Agent use cases (support bots, QA automation, code analytics)

Open an issue or pull request to get started.

---

## Links

- [Jina Code Embeddings](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) — embedding model
- [CCLSP](https://github.com/nicobailon/cclsp) — LSP integration for MCP
- [Qdrant](https://qdrant.tech) — vector database
- [Ollama](https://ollama.com) — local LLM runtime
- [MCP](https://modelcontextprotocol.io) — Model Context Protocol

---

**Star the repo if Paparats helps you code faster!**
