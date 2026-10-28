# Comparison with alternatives

Short answers to the usual questions are in the [README FAQ](../README.md#faq).

Facts about other projects come from their own READMEs and documentation as of
2026-10-27; "—" means the project does not document it. Corrections are welcome.

Most tools here build a code graph from the syntax tree and let the agent walk it. Paparats
also has a call graph, but its centre is search by meaning with local embedding models,
over many repositories at once, on one server that a whole team and its agents share.

- **[Graphify](https://github.com/Graphify-Labs/graphify)**: a `/graphify` skill (and an
  optional MCP server) that turns a project, with its docs, SQL schemas and PDFs, into a
  knowledge graph you query instead of grepping. No embeddings: code is parsed locally;
  docs and media go to your assistant's model for a semantic pass. Rebuilt by git hooks or
  a watcher. Cross-repo and a shared team layer are in Graphify Cloud. Paparats searches
  code by meaning across many repositories on a self-hosted shared server.
- **[codegraph](https://github.com/colbymchenry/codegraph)**: a native binary that keeps a
  local SQLite graph of symbols and calls with full-text search, kept fresh by a file
  watcher. Light to install and quick to index; one index per project, no shared server.
  Its main tool returns the relevant code and the call paths in one call. Paparats adds
  search by meaning, many repositories in one query, git history per result and one
  server for a team.
- **[GitNexus](https://github.com/abhigyanpatwari/GitNexus)**: indexes a codebase into a
  graph of symbols, calls and execution flows in an embedded graph database, with impact,
  path tracing and a semantic rename. Embeddings are optional. One HTTP server can serve
  several agents on a machine; a unified graph across repositories is in its Enterprise
  offering. License: PolyForm Noncommercial, so commercial use needs a separate license.
- **[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)**: one native
  binary with a local knowledge graph of code, docs and infrastructure, a type-aware call
  graph, bundled code embeddings, links across repositories in one store and 162
  grammars. Paparats is a Docker stack around a shared server: one index for many people
  and agents, a read-only support endpoint, a docs-only endpoint, git history and tickets
  per chunk, and usage analytics.
- **[claude-context](https://github.com/zilliztech/claude-context)**: hybrid (BM25 +
  vector) code search with OpenAI and Zilliz Cloud in its quick start; each search
  targets one codebase path. The closest to Paparats in approach; Paparats runs locally by
  default, searches many repositories in one query and adds the call graph.
- **[Serena](https://github.com/oraios/serena)**: drives language servers for precise
  symbol lookup, references and editing in the project you work on. Paparats finds code by
  meaning across many repositories and has no editing tools. They work well together.
- **[ast-grep](https://github.com/ast-grep/ast-grep)**: structural search, lint and
  rewrite by code patterns over the tree-sitter syntax tree. You write a pattern that looks
  like code, with wildcards, and it finds code of the same shape; an experimental MCP server
  gives agents its search. It answers "find code shaped like this" and can rewrite it.
  Paparats answers "where is the code that does X" when you know neither its shape nor its
  name, across many repositories.
- **[Sourcegraph MCP](https://sourcegraph.com/docs/api/mcp)**: code search, navigation and
  history from a Sourcegraph Enterprise instance.

|                                  | Paparats                                     | Graphify                                    | codegraph                          | GitNexus                                   | codebase-memory-mcp                        | claude-context                            | Serena                                   |
| :------------------------------- | :------------------------------------------- | :------------------------------------------ | :--------------------------------- | :----------------------------------------- | :----------------------------------------- | :---------------------------------------- | :--------------------------------------- |
| Approach                         | Search by meaning over syntax-based chunks + call graph | Knowledge graph of code, docs and data | Code graph + full-text search    | Code graph in an embedded graph database   | Knowledge graph + structural, keyword and semantic search | Hybrid BM25 + vector search      | Language-server symbol tools             |
| Search by meaning (embeddings)   | ✅ local models                              | ❌ graph queries; docs via your LLM          | ❌ full-text (FTS5)                | ⚠️ optional                                | ✅ bundled model                           | ✅                                        | ❌                                       |
| Runs locally by default          | ✅ Docker stack                              | ✅                                          | ✅                                 | ✅                                         | ✅                                         | ❌ OpenAI + Zilliz Cloud (local possible) | ✅                                       |
| Many repos in one query          | ✅ groups                                    | ⚠️ in Graphify Cloud                        | ⚠️ one project per call            | ⚠️ in Enterprise                           | ✅ cross-repo links in one store           | ❌ one codebase path per search           | ⚠️ active project                        |
| Callers / change impact          | ✅ method-level edges, `change_impact`       | ✅                                          | ✅                                 | ✅                                         | ✅ type-aware                              | —                                         | ✅ via language server                   |
| Git history per result           | ✅ commits + ticket refs per chunk           | —                                           | —                                  | ⚠️ git diff → affected symbols             | ⚠️ git diff → affected symbols             | —                                         | —                                        |
| Keeps the index fresh            | ⚠️ change check every 10 min + full pass     | ✅ git hooks or watcher                     | ✅ file watcher                    | ✅ watch mode                              | ✅ watcher                                 | ✅ sync every 5 min                       | n/a (reads live code)                    |
| One shared server for a team     | ✅ coding, support and docs-only endpoints   | ⚠️ Graphify Cloud                           | ❌                                 | ⚠️ one HTTP server per machine             | ⚠️ shared graph file                       | ❌                                        | —                                        |
| Code editing tools               | ❌                                           | —                                           | ❌                                 | ⚠️ rename                                  | ❌                                         | ❌                                        | ✅                                       |
| Languages                        | 11 (tree-sitter)                             | ~40, plus docs, SQL, PDFs                   | 20+                                | 18                                         | 162 grammars                               | 14                                        | 40+ (language servers)                   |
| Setup                            | Docker + npm CLI, ~2.3 GB of local models    | `uv tool install graphifyy`                 | install script or npm              | `npx gitnexus analyze`                     | install script                             | `npx` + API keys                          | `uv tool install`                        |
| License                          | MIT                                          | Apache-2.0                                  | MIT                                | PolyForm Noncommercial                     | MIT                                        | MIT                                       | GPL-3.0-or-later                         |
