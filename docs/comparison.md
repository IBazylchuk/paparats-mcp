# Comparison with alternatives

Short answers to the usual questions are in the [README FAQ](../README.md#faq).

Facts about other projects come from their own READMEs and documentation as of
2026-10-24; "—" means the project does not document it. Corrections are welcome.

- **[claude-context](https://github.com/zilliztech/claude-context)**: an MCP server for
  hybrid (BM25 + vector) code search, with OpenAI and Zilliz Cloud in its quick start
  (Ollama and a self-hosted Milvus are options). It syncs changes every 5 minutes, and each
  search targets one codebase path. Paparats runs locally by default, searches many
  repositories in one query, and adds a call graph, git history per chunk and a shared
  server with separate coding, support and docs endpoints. It has no BM25 on code.
- **[Serena](https://github.com/oraios/serena)**: drives language servers (or a JetBrains
  IDE) for precise symbol lookup, references and editing in the project you work on.
  Paparats finds code by meaning across many repositories and has no editing tools. They
  work well together.
- **[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)**: one native
  binary with a local code knowledge graph, structural, BM25 and semantic search, a
  type-aware call graph, links between services and many more languages, with a lighter
  setup. Paparats is a Docker stack around a shared server: one index for many people and
  agents, a read-only support endpoint, a docs-only endpoint, git history and tickets per
  chunk, and usage analytics.
- **[claude-context-local](https://github.com/FarhanAliRaza/claude-context-local)**: local
  semantic code search with EmbeddingGemma and FAISS (beta; last commit Nov 2025).
- **[Sourcegraph MCP](https://sourcegraph.com/docs/api/mcp)**: code search, navigation and
  history from a Sourcegraph Enterprise instance.
- **[Greptile](https://www.greptile.com/)** is an AI code-review service; its MCP server
  exposes review comments and context rather than a search index, so it is not in the
  table.

|                                   | Paparats                                     | claude-context                                  | Serena                                         | codebase-memory-mcp                              | claude-context-local          | Sourcegraph MCP                      |
| :-------------------------------- | :------------------------------------------- | :---------------------------------------------- | :--------------------------------------------- | :----------------------------------------------- | :---------------------------- | :----------------------------------- |
| Approach                          | Vector search over syntax-based chunks + call graph | Hybrid BM25 + vector search over AST chunks | Language-server symbol tools                | Code knowledge graph + structural/BM25/semantic search | Vector search (FAISS)    | Keyword, natural-language and symbol search |
| Runs locally by default           | ✅ Docker stack                              | ❌ OpenAI + Zilliz Cloud (local setup possible) | ✅                                             | ✅ native binary                                 | ✅                            | ❌ needs a Sourcegraph Enterprise instance |
| Many repos in one query           | ✅ groups                                    | ❌ one codebase path per search                 | ⚠️ active project; can query other projects    | ⚠️ per project; cross-repo service links         | —                             | ✅                                   |
| Callers / references              | ✅ method-level edges from the syntax tree   | —                                               | ✅ via language server (most precise)          | ✅ call graph with type resolution               | —                             | ✅                                   |
| Keyword (BM25) search on code     | ❌ dense vectors + identifier-aware ranking  | ✅                                              | regex search tool                              | ✅                                               | —                             | ✅ keyword search                    |
| Git history per result            | ✅ commits + ticket refs per chunk           | —                                               | —                                              | ⚠️ git diff → affected symbols                   | —                             | ✅ commit and diff search            |
| Keeps the index fresh             | ⚠️ change check every 10 min + scheduled full pass | ✅ Merkle-tree sync every 5 min          | n/a (reads live code)                          | ✅ watches the project of an open session        | ⚠️ incremental on re-index    | ✅ server-side                       |
| Code editing / refactoring tools  | ❌                                           | ❌                                              | ✅                                             | ❌                                               | ❌                            | ❌                                   |
| One shared server for a team      | ✅ coding, support and docs-only endpoints   | ❌ per-user stdio                               | —                                              | ⚠️ per machine; graph artifacts can be shared    | ❌                            | ✅                                   |
| Languages                         | 11 (tree-sitter)                             | 14 listed                                       | 40+ (language servers)                         | 162 (per its README)                             | 9+                            | all (text search)                    |
| Setup                             | Docker + npm CLI, ~2.3 GB of local models    | `npx` + API keys                                | `uv tool install`                              | install script                                   | install script (Python, uv)   | Enterprise admin setup               |
| License / cost                    | MIT, free                                    | MIT; embedding and vector DB usage unless self-hosted | GPL-3.0-or-later, free; paid JetBrains plugin | MIT, free                                | GPL-3.0 (per README), free    | commercial                           |
