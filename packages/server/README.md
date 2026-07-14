# @paparats/server

The MCP server for [Paparats MCP](https://github.com/IBazylchuk/paparats-mcp) — semantic
code search over multiple repos with AST-aware chunking, a cross-chunk symbol graph,
git-history per chunk, and an agent-maintained architectural memory layer.

> **Not published to npm.** This package is consumed as a library by `@paparats/indexer`
> and shipped as a Docker image: [`ibaz/paparats-server`](https://hub.docker.com/r/ibaz/paparats-server).
> End users install through [`@paparats/cli`](https://www.npmjs.com/package/@paparats/cli).

## What this package does

Three jobs in one process:

- **Indexer.** AST-aware chunking (tree-sitter, 11 languages), per-chunk symbol
  extraction, single-parse pipeline, llama-server embedding with SQLite cache, batched
  Qdrant upsert. Post-index passes attach git history, ticket references, and
  cross-chunk symbol edges (calls / called_by / references / referenced_by).
- **Searcher.** Task-prefixed embedding (`nl2code` / `code2code` / `techqa`), query
  expansion (abbreviations, case variants, plurals, filler removal), in-memory LRU
  query cache with per-group invalidation, confidence scoring, token-savings
  telemetry.
- **MCP server.** Two endpoints — `/mcp` (coding) and `/support/mcp` (support) — each
  with its own tool set and system instructions. SSE for Cursor, Streamable HTTP for
  Claude Code. Plus an agent-maintained **architectural memory** layer.

## Endpoints

```
http://<host>:9876/health                  – liveness probe
http://<host>:9876/metrics                 – Prometheus (PAPARATS_METRICS=true)
http://<host>:9876/ui                      – operator console
http://<host>:9876/api/analytics/...       – analytics REST API (UI backend)

http://<host>:9876/mcp                     – MCP, coding mode (Streamable HTTP)
http://<host>:9876/sse                     – MCP, coding mode (SSE / Cursor)
http://<host>:9876/messages                – MCP, coding mode (SSE message channel)

http://<host>:9876/support/mcp             – MCP, support mode
http://<host>:9876/support/sse             – MCP, support mode (SSE)
http://<host>:9876/support/messages        – MCP, support mode (SSE message channel)
```

`POST /api/index` registers a project; `POST /api/watch/...` controls the watcher.
See the [main README](https://github.com/IBazylchuk/paparats-mcp#mcp-tools-reference)
for the full tool inventory per endpoint.

## Architectural memory

Code search tells the agent **what the code does**. The arch-memory layer tells it
**why** — and the agent maintains that knowledge itself, across sessions, without you
authoring a single doc.

Three card kinds in a separate Qdrant collection per group (`paparats_<group>_arch`),
embedded with [`bge-m3`](https://huggingface.co/BAAI/bge-m3) (1024d, cls-pooled,
multilingual):

| Kind          | Fields                                                                            | Idempotency                     |
| :------------ | :-------------------------------------------------------------------------------- | :------------------------------ |
| **Component** | `name`, `summary` (markdown: Does / Owns / Does not / Touched when), `files`, `neighbours`, `anchors` | By `name` (structural)         |
| **Decision**  | `title`, `context`, `decision`, `alternatives_rejected`, `consequences`, `scope`, `supersedes` | Server-side similarity gate    |
| **Lesson**    | `rule`, `why`, `when`, `scope`, `severity`, `evidence`                            | Server-side similarity gate    |

**Similarity gate** (cosine on `bge-m3`):

- `>= 0.85` → duplicate. Decisions are refused so the agent must reconcile or
  supersede. Lessons bump `updatedAt` on the existing card (Reflexion "rule
  confirmed").
- `0.70 – 0.85` → similar. Nothing is written; the agent should refine wording or
  pass `supersedes`.
- `< 0.70` → accepted as a new card.

`supersedes` bypasses the gate and marks the prior decision `status=superseded` so
it disappears from default search but stays in history.

**Reading via `arch_context`** accepts `min_score` (default `0.45`). Each returned
card carries an `updated N ago` stamp and the cosine score so the agent can detect
stale or low-confidence hits.

**Bootstrap with `init_arch_memory`** — a workflow prompt analogous to `/init` in
Claude Code. Walks the repo, identifies 8-20 components by domain boundary, writes
the cards. Followed by `audit_architecture` (sweep stale cards) and
`record_lesson_from_correction` (turn user corrections into structured lessons).

**MCP resources**:

- `arch://schema` — full card-schema reference.
- `arch://stats/{group}` — live counts (total / by kind / by status) and
  oldest/newest `updatedAt`.

**Prometheus metrics** (`PAPARATS_METRICS=true`):

- `paparats_arch_context_calls_total{group}` — counter
- `paparats_arch_write_total{kind, status}` — counter labelled by gate outcome
- `paparats_arch_search_score` — histogram of cosine scores from `arch_context`
- `paparats_arch_collection_size{group, kind, status}` — gauge

`arch_context` is read-only on **both** MCP endpoints. `arch_record_*` is
support-only — recording belongs to the architectural-review workflow.

## Module map

| Module                              | Responsibility                                                                                          |
| :---------------------------------- | :------------------------------------------------------------------------------------------------------ |
| `types.ts`                          | Shared interfaces                                                                                       |
| `lib.ts`                            | Public library entry point (re-exports for programmatic use)                                            |
| `config.ts`                         | `.paparats.yml` reader, 11 language profiles, `autoProjectConfig()`                                     |
| `app.ts`                            | Express app factory, HTTP API routes, request wiring                                                    |
| `index.ts`                          | Server bootstrap — starts HTTP server, wires components, graceful shutdown                              |
| `ast-chunker.ts`                    | AST-based chunking via tree-sitter                                                                      |
| `chunker.ts`                        | Regex chunking fallback (4 strategies)                                                                  |
| `ast-symbol-extractor.ts`           | AST-based per-chunk symbol extraction                                                                   |
| `ast-queries.ts`                    | Tree-sitter S-expression queries per language                                                           |
| `tree-sitter-parser.ts`             | WASM tree-sitter manager — lazy grammar loading                                                         |
| `symbol-graph.ts`                   | Cross-chunk symbol edges                                                                                |
| `embeddings.ts`                     | llama-server provider + SQLite cache + cached wrapper                                                   |
| `indexer.ts`                        | Group-aware Qdrant indexing — `createQdrantClient()`, `toCollectionName()`, single-parse `chunkFile()`  |
| `searcher.ts`                       | Vector search with query expansion, cache, metrics                                                      |
| `query-expansion.ts`                | Abbreviation / case / plural / filler expansion                                                         |
| `task-prefixes.ts`                  | Jina task-prefix detection                                                                              |
| `query-cache.ts`                    | In-memory LRU cache with TTL and per-group invalidation                                                 |
| `metrics.ts`                        | Prometheus metrics (`prom-client`) + `NoOpMetrics` fallback                                             |
| `metadata.ts`                       | Tag resolution + auto-detection from directory structure                                                |
| `metadata-db.ts`                    | SQLite store for git commits, tickets, symbol edges                                                     |
| `git-metadata.ts`                   | Git history extraction — diff-hunk mapping to chunks                                                    |
| `ticket-extractor.ts`               | Jira / GitHub / custom ticket parsing                                                                   |
| `mcp-handler.ts`                    | MCP protocol — dual-mode endpoints with isolated tool sets and instructions                             |
| `watcher.ts`                        | `ProjectWatcher` (chokidar) + `WatcherManager`                                                          |
| `arch/types.ts`                     | Architectural-memory types                                                                              |
| `arch/collection.ts`                | Per-group `paparats_<group>_arch` collection lifecycle                                                  |
| `arch/text-embeddings.ts`           | `bge-m3` text embedder via llama-server                                                                 |
| `arch/store.ts`                     | CRUD + server-side similarity gate + `stats()` aggregation                                              |
| `arch/context.ts`                   | `arch_context` query — top-N across kinds with `min_score` and age stamps                               |

## Configuration (env vars)

| Variable                    | Default                                | Notes                                                        |
| :-------------------------- | :------------------------------------- | :----------------------------------------------------------- |
| `PORT`                      | `9876`                                 | HTTP port                                                    |
| `QDRANT_URL`                | `http://localhost:6333`                | Qdrant endpoint (https → port 443, http → 6333)              |
| `QDRANT_API_KEY`            | —                                      | Qdrant Cloud API key                                         |
| `EMBED_URL`                 | `http://127.0.0.1:11434`               | Embed server endpoint (llama-swap; internal port 8080 mapped to host 11434) |
| `EMBED_BATCH_SIZE`          | —                                      | Embeddings per llama-server call                            |
| `EMBED_TTL`                 | `300`                                  | Seconds a model stays resident before idle-unload           |
| `EMBEDDING_PROVIDER`        | `llama`                                | Code embedding provider: `llama` \| `openai` \| `voyage`    |
| `EMBEDDING_MODEL`           | `jina-code-embeddings`                 | Code embedding model                                         |
| `EMBEDDING_DIMENSIONS`      | `1536`                                 | Code embedding dimensions                                    |
| `TEXT_EMBEDDING_PROVIDER`   | `llama`                                | `llama` or `openai` for the arch layer                      |
| `TEXT_EMBEDDING_MODEL`      | `bge-m3`                               | Arch-layer text embedding model                              |
| `TEXT_EMBEDDING_DIMENSIONS` | `1024`                                 | Arch-layer text embedding dimensions                         |
| `PAPARATS_METRICS`          | `false`                                | Set to `true` to expose `/metrics`                           |
| `PAPARATS_PROJECTS`         | —                                      | Comma-separated allow-list of project names                  |
| `PAPARATS_UI_BASIC_AUTH`    | —                                      | `user:pass` for `/ui` and `/api/analytics/...`               |
| `OTEL_*`                    | —                                      | Standard OpenTelemetry env vars (Tempo / Honeycomb / Datadog / Elastic APM)  |

## Programmatic use (library)

The `package.json` `exports` map points at `dist/lib.js`, not the server bootstrap.
Importing `@paparats/server` does **not** start the HTTP server — `@paparats/indexer`
uses this to embed the `Indexer` class as a library:

```ts
import { Indexer, createQdrantClient } from '@paparats/server';

const qdrant = createQdrantClient({ url: process.env.QDRANT_URL! });
const indexer = new Indexer({ qdrant, /* ... */ });
await indexer.indexProject(group, project);
```

## Docker

```bash
docker pull ibaz/paparats-server:latest
docker run --rm -p 9876:9876 \
  -e QDRANT_URL=http://qdrant:6333 \
  -e EMBED_URL=http://embed:8080 \
  ibaz/paparats-server:latest
```

See [`docker-compose.template.yml`](./docker-compose.template.yml) for a complete
stack (Qdrant + embed server + server + indexer).

## Development

```bash
yarn install
yarn workspace @paparats/server build
yarn workspace @paparats/server test
yarn workspace @paparats/server typecheck
```

## Related packages

| Package                                                                 | Purpose                                                 |
| :---------------------------------------------------------------------- | :------------------------------------------------------ |
| [@paparats/cli](https://www.npmjs.com/package/@paparats/cli)            | One-command installer, project management, search       |
| [@paparats/indexer](https://hub.docker.com/r/ibaz/paparats-indexer)     | Automated multi-repo indexer (uses this as a library)   |
| [@paparats/shared](https://www.npmjs.com/package/@paparats/shared)      | Shared utilities (path validation, gitignore, excludes) |
| [ibaz/paparats-embed](https://hub.docker.com/r/ibaz/paparats-embed)     | llama.cpp llama-server + llama-swap with pre-baked `jina-code-embeddings` and `bge-m3` |

## License

MIT
