# Paparats MCP

<img src="docs/paparats-kvetka.png" alt="Paparats-kvetka (fern flower)" width="200" align="right">

**Paparats-kvetka** — a magical flower from Slavic folklore that blooms on Kupala Night and grants power to whoever finds it. Likewise, paparats-mcp helps you find the right code across a sea of repositories.

**Semantic code search for AI coding assistants.** Give Claude Code, Cursor, Windsurf, Codex and rest deep understanding of your entire codebase — single repo or multi-project workspaces. Search by meaning, not keywords. Keep your index fresh with real-time file watching. Return only relevant chunks instead of full files to save tokens.

Everything runs locally. No cloud. No API keys. Your code never leaves your machine.

---

## Why Paparats?

AI coding assistants are smart, but they can only see files you open. They don't know your codebase structure, where the authentication logic lives, or how services connect. **Paparats fixes that.**

### What you get

- **🔍 Semantic code search** — ask "where is the rate limiting logic?" and get exact code ranked by meaning, not grep matches
- **⚡️ Real-time sync** — edit a file, and 2 seconds later it's re-indexed. No manual re-runs
- **🧠 LSP intelligence** — go-to-definition, find-references, rename symbols via [CCLSP](https://github.com/nicobailon/cclsp) integration
- **💾 Token savings** — return only relevant chunks instead of full files to reduce context size
- **🏢 Multi-project workspaces** — search across backend, frontend, infra repos in one query
- **🔒 100% local & private** — Qdrant vector database + Ollama embeddings. Nothing leaves your laptop
- **🎯 AST-aware chunking** — code split by AST nodes (functions/classes) via tree-sitter, not arbitrary character counts (TypeScript, JavaScript, TSX, Python, Go, Rust, Java, Ruby, C, C++, C#; regex fallback for Terraform)
- **🏷️ Rich metadata** — each chunk knows its symbol name (from tree-sitter AST), service, domain context, and tags from directory structure
- **🔗 Symbol graph** — find usages and cross-chunk relationships powered by AST-based symbol extraction (defines/uses analysis)
- **📜 Git history per chunk** — see who last modified a chunk, when, and which tickets (Jira, GitHub) are linked to it

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
| **Ollama**         | Local embedding model (on host)    | [ollama.com](https://ollama.com)                                         |

The CLI checks that `docker`, `ollama`, and `docker compose` are available. If missing, it exits with installation links.

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

### 🎯 Better Search Quality

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

### ⚡️ Performance

**Embedding cache** — SQLite cache with content-hash keys + Float32 vectors. Unchanged code never re-embedded. LRU cleanup at 100k entries.

**AST-aware chunking** — tree-sitter AST nodes define natural chunk boundaries for 11 languages. Falls back to regex strategies (block-based for Ruby, brace-based for JS/TS, indent-based for Python, fixed-size) for unsupported languages.

**Real-time watching** — `paparats watch` monitors file changes with debouncing (1s default). Edit → save → re-index in ~2 seconds.

### 🔗 Integrations

**CCLSP (Claude Code LSP)** — during `paparats init`, optionally sets up:

- LSP server for your language (TypeScript, Python, Go, Ruby, etc.)
- MCP config for go-to-definition, find-references, rename
- Typical AI workflow: `search_code` (semantic) → `find_definition` (precise navigation) → `find_references` (impact analysis)

Skip with `--skip-cclsp` if not needed.

---

## Comparison with Alternatives

### Feature Matrix

#### Deployment

| Feature     | Paparats | Vexify | SeaGOAT | Augment | Sourcegraph | Greptile | Bloop |
| :---------- | :------: | :----: | :-----: | :-----: | :---------: | :------: | :---: |
| Open source |  ✅ MIT  | ✅ MIT | ✅ MIT  |   ❌    | ⚠️ Partial  |    ❌    | ⚠️ ¹  |
| Fully local |    ✅    |   ✅   |   ✅    |  ❌ ²   |     ❌      |    ❌    |  ✅   |

#### Search Quality

| Feature         | Paparats  | Vexify | SeaGOAT  | Augment | Sourcegraph | Greptile | Bloop  |
| :-------------- | :-------: | :----: | :------: | :-----: | :---------: | :------: | :----: |
| Code embeddings | ✅ Jina ³ |  ⚠️ ⁴  |   ❌ ⁵   |   ⚠️    |     ⚠️      |    ⚠️    |   ✅   |
| Vector database |  Qdrant   | SQLite | ChromaDB | Propri. |   Propri.   | pgvector | Qdrant |
| AST chunking    |    ✅     |   ❌   |    ❌    |   ⚠️    |     ⚠️      |    ⚠️    |   ✅   |
| Query expansion |   ✅ ⁶    |   ❌   |    ❌    |   ⚠️    |     ⚠️      |    ⚠️    |   ❌   |

#### Developer Experience

| Feature            | Paparats  | Vexify | SeaGOAT | Augment  | Sourcegraph | Greptile | Bloop |
| :----------------- | :-------: | :----: | :-----: | :------: | :---------: | :------: | :---: |
| Real-time watching |  ✅ Auto  |   ❌   |   ❌    | ✅ CI/CD |     ✅      |    ⚠️    |  ⚠️   |
| Embedding cache    | ✅ SQLite |   ⚠️   |   ❌    |    ⚠️    |     ⚠️      |    ⚠️    |  ❌   |
| Multi-project      | ✅ Groups |   ✅   |   ❌    |    ✅    |     ✅      |    ✅    |  ✅   |
| One-cmd install    |    ✅     |   ⚠️   | ⚠️ pip  |    ❌    |     ❌      |    ❌    |  ❌   |

#### AI Integration

| Feature           | Paparats | Vexify | SeaGOAT | Augment | Sourcegraph | Greptile | Bloop |
| :---------------- | :------: | :----: | :-----: | :-----: | :---------: | :------: | :---: |
| MCP native        |    ✅    |   ✅   |   ❌    |   ✅    |     ❌      |  ⚠️ API  |  ❌   |
| LSP integration   | ✅ CCLSP |   ❌   |   ❌    |   ❌    |     ⚠️      |    ❌    |  ❌   |
| Token metrics     |    ✅    |   ❌   |   ❌    |   ⚠️    |     ❌      |    ❌    |  ❌   |
| Git history       |    ✅    |   ❌   |   ❌    |   ❌    |     ⚠️      |    ❌    |  ❌   |
| Ticket extraction |    ✅    |   ❌   |   ❌    |   ❌    |     ❌      |    ❌    |  ❌   |

#### Pricing

|      | Paparats |  Vexify  | SeaGOAT  | Augment | Sourcegraph | Greptile |  Bloop   |
| :--- | :------: | :------: | :------: | :-----: | :---------: | :------: | :------: |
| Cost | **Free** | **Free** | **Free** |  Paid   |    Paid     |   Paid   | Archived |

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

### Why Paparats?

**🔒 Privacy-first** — Everything runs locally. Augment and Greptile store your code vectors in the cloud, Sourcegraph requires cloud deployment.

**🧠 Better embeddings** — [Jina Code Embeddings 1.5B](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) (1536 dims) trained specifically for code with task-specific prefixes. Vexify uses smaller jina-embeddings-2-base-code; SeaGOAT uses general-purpose MiniLM (384 dims).

**⚡️ Production-grade stack** — Qdrant handles millions of vectors with sub-100ms latency. SQLite with extensions (Vexify) doesn't scale beyond small projects. ChromaDB (SeaGOAT) is designed for prototyping, not production.

**🎯 Smarter search** — Query expansion (4 strategies) + task prefix detection (nl2code/code2code/techqa) automatically improve relevance. Competitors don't expose these features.

**🔄 True real-time** — `paparats watch` keeps index fresh automatically with 1s debounce. Vexify and SeaGOAT require manual reindex commands. Augment requires CI/CD hooks.

**🔗 LSP included** — CCLSP integration gives your AI go-to-definition, find-references, rename. No other tool bundles this.

**💰 Free forever** — No usage limits, credits, or per-seat fees.

**📊 Transparent metrics** — Every search shows tokens returned vs full-file tokens, savings %, confidence score. Helps AI decide next steps.

---

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

Projects with the same `group` name share a search scope. All indexed together in one Qdrant collection.

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

## MCP Tools

Paparats exposes 10 tools via the Model Context Protocol on **two separate endpoints**, each with its own tool set and system instructions:

### Coding endpoint (`/mcp`)

For developers using Claude Code, Cursor, etc. Focus: search code, read chunks, trace symbol dependencies, manage indexing.

| Tool           | Description                                                                                                     |
| :------------- | :-------------------------------------------------------------------------------------------------------------- |
| `search_code`  | Semantic search across indexed projects. Returns code chunks with symbol definitions/uses and confidence scores |
| `get_chunk`    | Retrieve a chunk by ID with optional surrounding context. Returns code with symbol info                         |
| `find_usages`  | Find symbol relationships: incoming (callers), outgoing (dependencies), or both directions                      |
| `health_check` | Indexing status: chunks per group, running jobs                                                                 |
| `reindex`      | Trigger full reindex; track progress with `health_check`                                                        |

### Support endpoint (`/support/mcp`)

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

## Monitoring

Paparats exposes Prometheus metrics for operational visibility. Opt in with an environment variable:

```bash
PAPARATS_METRICS=true paparats install  # or set in docker-compose.yml
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

## Embedding Model Setup

Default: [jinaai/jina-code-embeddings-1.5b-GGUF](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) — code-optimized, 1.5B params, 1536 dims, 32k context. Not in Ollama registry, so we create a local alias.

**Recommended:** `paparats install` automates this:

- Downloads GGUF (~1.65 GB) to `~/.paparats/models/`
- Creates Modelfile and runs `ollama create jina-code-embeddings`
- Starts Ollama with `ollama serve` if not running

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

## CLI Commands

| Command                   | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `paparats init`           | Create `.paparats.yml` (interactive or `--non-interactive`)   |
| `paparats install`        | Set up Docker + Ollama model (~1.6 GB download)               |
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

- `--skip-docker` — Skip Docker setup (only set up Ollama)
- `--skip-ollama` — Skip Ollama model (only start Docker)
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

## Use Cases Beyond Coding

Paparats is a foundation for building AI agents that need code context:

### 🎯 Product Support Bots

- Index product codebase → support bot answers "how do I configure X?" with exact code examples
- Reduces ticket volume, improves response accuracy

### 🧪 QA Automation

- Index test suites → AI generates new test cases based on existing patterns
- Finds untested code paths by searching for functions without corresponding tests

### 👨‍💻 Developer Onboarding

- New hire asks "where is the payment processing logic?" → instant answers
- Reduces ramp-up time from weeks to days

### 📊 Code Analytics

- Search for anti-patterns: "SQL injection vulnerabilities", "deprecated API usage"
- Find migration candidates: "uses old auth library"

### 🤖 AI Agent Memory

- Persistent code knowledge for agents that span multiple sessions
- Agent learns codebase structure over time

---

## Architecture

```
paparats-mcp/
├── packages/
│   ├── server/          # MCP server (Docker image)
│   │   ├── src/
│   │   │   ├── index.ts              # HTTP server + MCP handler
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
│   ├── cli/             # CLI tool (npm package)
│   │   └── src/
│   │       ├── index.ts        # Commander entry
│   │       └── commands/       # init, install, update, index, etc.
│   └── shared/          # Shared utilities
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

- **Qdrant** — vector database (1 collection per group, cosine similarity, payload filtering)
- **Ollama** — local embeddings via Jina Code Embeddings 1.5B with task-specific prefixes
- **SQLite** — embedding cache (`~/.paparats/cache/embeddings.db`) + git metadata store (`~/.paparats/metadata.db`)
- **MCP** — Model Context Protocol (SSE for Cursor, Streamable HTTP for Claude Code). Dual endpoints: `/mcp` (coding) and `/support/mcp` (support)
- **TypeScript** monorepo with Yarn workspaces

---

## Docker and Ollama

- **Qdrant** and **MCP server** run in Docker containers
- **Ollama** runs on the host (not Docker). Server connects via `host.docker.internal:11434` (Mac/Windows). On Linux, set `OLLAMA_URL=http://172.17.0.1:11434` in `~/.paparats/docker-compose.yml`
- **Embedding cache** (SQLite) persists in `paparats_cache` Docker volume. Re-indexing unchanged code is instant across restarts

---

## Token Savings Metrics

### What we measure (and what we don't)

Paparats provides **estimated** token savings to help you understand the order of magnitude of context reduction. These are heuristics, not precise measurements.

#### Per-search response

```json
{
  "metrics": {
    "tokensReturned": 150, // Actual chunk content length ÷ 4
    "estimatedFullFileTokens": 5000, // Heuristic: maxEndLine × 50 ÷ 4
    "tokensSaved": 4850, // Difference between estimates
    "savingsPercent": 97 // (tokensSaved ÷ estimated) × 100
  }
}
```

| Field                     | Calculation                  | Reality Check                                                     |
| ------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `tokensReturned`          | `Σ ceil(content.length / 4)` | ✅ Based on actual returned content; ÷4 is rough approximation    |
| `estimatedFullFileTokens` | `Σ ceil(endLine × 50 / 4)`   | ⚠️ **Heuristic**: assumes 50 chars/line, never loads actual files |
| `tokensSaved`             | `estimated - returned`       | ⚠️ **Derived**: difference between two estimates                  |
| `savingsPercent`          | `(saved / estimated) × 100`  | ⚠️ **Relative**: percentage of heuristic estimate                 |

#### Cumulative stats

```bash
curl -s http://localhost:9876/api/stats | jq '.usage'
```

```json
{
  "searchCount": 47,
  "totalTokensSaved": 152340, // Sum of all tokensSaved estimates
  "avgTokensSavedPerSearch": 3241 // totalTokensSaved ÷ searchCount
}
```

These are **sums of estimates**, not measured token counts from a real tokenizer.

---

### Why heuristics?

**We don't:**

- Load full files to compare (defeats the purpose of chunking)
- Run a tokenizer on file content (slow, model-dependent)
- Know the exact file size (only chunk line ranges)

**We estimate:**

- **50 chars/line** — typical for code (comments, whitespace, logic)
- **4 chars/token** — rough average for code tokens (OpenAI GPT-3.5/4, Claude)
- **File size from line count** — `endLine × 50` assumes uniform density

These constants work reasonably well across languages, but individual files vary:

- Minified JS: 200+ chars/line → underestimate savings
- Ruby with comments: 30 chars/line → overestimate savings
- Dense C++: 60 chars/line → close to estimate

---

### What the metrics tell you

✅ **Order of magnitude** — are you returning 100 tokens or 10,000?  
✅ **Relative benefit** — is semantic search better than loading full files? (Yes, typically 50–90% reduction)  
✅ **Trend over time** — is avgTokensSavedPerSearch increasing as your codebase grows?

❌ **Exact token count** — don't use this for billing or precise LLM context budgeting  
❌ **Model-specific accuracy** — different tokenizers (GPT-4 vs Claude vs Llama) produce different counts  
❌ **File-level precision** — individual file estimates can be off by 20–40%

---

### Real-world validation

To verify actual savings, compare:

**Without Paparats:**

```
User: "Find authentication logic"
AI: *loads 5 full files*
Context: 25,000 tokens (measured by your LLM API)
```

**With Paparats:**

```
User: "Find authentication logic"
AI: *uses search_code, gets 5 chunks*
Context: 1,200 tokens (measured by your LLM API)
Savings: ~95% (real)
```

The metrics are directionally correct but use `÷4` as a proxy, not your LLM's actual tokenizer.

---

### Why we still show them

Even as estimates, token savings metrics are useful:

1. **AI decision-making** — if `savingsPercent < 40%`, the AI might decide to use grep or file reading instead
2. **Performance monitoring** — track `avgTokensSavedPerSearch` over time to see if chunking strategies need tuning
3. **User feedback** — "search saved ~10k tokens" gives intuition about the benefit

If you need exact counts, instrument your LLM API calls and compare before/after adding Paparats.

---

### Honest comparison

Most code search tools **don't provide any metrics**. When they do:

- **Sourcegraph** — no token metrics, only "results found"
- **Greptile** — API response sizes, not token estimates
- **Vexify** — no metrics
- **SeaGOAT** — no metrics

Paparats shows **rough estimates** to give you visibility into context reduction, even if imperfect. Use them as indicators, not ground truth.

---

## License

MIT

---

## Releasing (maintainers)

1. **Commit** all changes, then **bump and commit version:** `yarn release patch` (or `minor`/`major`). This only syncs version and commits — no tag, no push.
2. **Publish to npm:** `npm login` (if needed), then `yarn publish:npm`. The MCP registry requires the package to exist on npm before it accepts the publish.
3. **Tag and push:** `yarn release:push`. This creates the tag and pushes; [docker-publish.yml](.github/workflows/docker-publish.yml) and [publish-mcp.yml](.github/workflows/publish-mcp.yml) run and will succeed because npm already has the version.

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

**Star the repo if Paparats helps you code faster!** ⭐️
