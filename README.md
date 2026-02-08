# paparats-mcp

<img src="docs/paparats-kvetka.png" alt="Paparats-kvetka (fern flower)" width="200" align="right">

**Paparats-kvetka** — a magical flower from Slavic folklore that blooms on Kupala Night and grants power to whoever finds it. Likewise, paparats-mcp helps you find the right code across a sea of repositories.

Semantic code search across multiple repositories. MCP server powered by Qdrant vector search and Ollama embeddings, designed for AI coding assistants (Claude Code, Cursor).

Drop a `.paparats.yml` into each project, group them together, and get cross-project semantic search via MCP.

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

**Language-aware chunking** — code is split at natural boundaries (functions, classes, blocks) rather than fixed sizes. Supports Ruby, TypeScript, JavaScript, Python, Go, Rust, Java, Terraform, C, C++, C#.

**Embedding cache** — embeddings are cached in SQLite (`~/.paparats/cache/embeddings.db`), so re-indexing unchanged code is instant.

## Architecture

```
paparats-mcp/
├── packages/
│   ├── server/          # MCP server (Docker image)
│   │   ├── src/
│   │   │   ├── index.ts        # HTTP server + MCP handler
│   │   │   ├── indexer.ts      # Group-aware indexing
│   │   │   ├── searcher.ts     # Search with metrics
│   │   │   ├── chunker.ts      # AST-aware code chunking
│   │   │   ├── embeddings.ts   # Ollama provider + SQLite cache
│   │   │   ├── config.ts       # .paparats.yml reader
│   │   │   ├── watcher.ts      # File watcher
│   │   │   └── types.ts        # Shared types
│   │   └── Dockerfile
│   └── cli/             # CLI tool (npm package)
│       └── src/
│           ├── index.ts        # Commander entry
│           └── commands/       # init, install, index, search, status, watch, doctor, groups
└── examples/
    └── paparats.yml.*   # Config examples per language
```

## Stack

- **Qdrant** — vector database (1 collection per group)
- **Ollama** — local embeddings via [jina-code-embeddings-1.5b](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) (1.5B params, 1536 dims, 32k context)
- **MCP** — Model Context Protocol (SSE + Streamable HTTP)
- **TypeScript** monorepo with yarn workspaces

## Embedding model setup

The default model is [jinaai/jina-code-embeddings-1.5b-GGUF](https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF) — a code-optimized embedding model based on Qwen2.5-Coder-1.5B. It's not in the Ollama registry, so we create a local alias via Modelfile.

**One-time setup:**

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

After this, Ollama serves the model under the alias `jina-code-embeddings`, which is the default in `.paparats.yml`.

| Spec         | Value                                |
| ------------ | ------------------------------------ |
| Parameters   | 1.5B                                 |
| Dimensions   | 1536                                 |
| Context      | 32,768 tokens (recommended <= 8,192) |
| Quantization | Q8_0 (~1.6 GB)                       |
| Languages    | 15+ programming languages            |

> `paparats install` (Phase 1c) will automate this setup.

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

## Development status

Phase 1a is complete (core server modules). See [PLAN.md](./PLAN.md) for next steps.

## License

MIT
