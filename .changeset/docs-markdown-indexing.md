---
'@paparats/server': minor
'@paparats/indexer': minor
'@paparats/cli': minor
'@paparats/shared': minor
---

Add a markdown documentation search layer, hybrid retrieval, and an agent-authored glossary.

- **Docs layer** — index long-form markdown (Confluence exports, RFCs, runbooks) into a
  separate per-group Qdrant collection embedded with qwen3. A structural chunker splits by
  heading, sub-splits oversized sections (~320 tokens, overlap 0), and prepends the heading
  breadcrumb to each chunk. Strict markdown detection: non-markdown input is skipped, never
  indexed. See `docs/chunking-strategy.md` for the research behind these choices.
- **Hybrid search** — dense (qwen3) + BM25 sparse fused server-side via the Qdrant Query API
  (RRF), with auto-merge of neighbouring chunks for context. BM25 weights are computed
  in-process; corpus IDF lives in its own SQLite file, separate from `metadata.db`.
- **Terminology (glossary) layer** — an agent-authored store of domain terms, abbreviations,
  and service names with a duplicate/similar write gate, plus a `/extract-terminology` skill
  to bulk-seed it from docs and code. Glossary matches optionally enrich docs queries.
- **New MCP tools** — `search_docs` (coding + support), `term_search` / `term_list`
  (coding + support), `term_record` / `term_delete` (coding).
- **Indexer** — an opt-in `INDEX_DOCS` flag makes the indexer daemon walk each repo's
  markdown into the docs layer; off by default, so existing deployments are unaffected.
