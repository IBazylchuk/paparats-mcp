---
'@paparats/server': patch
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/indexer': patch
---

Fix docs search returning confident matches for undocumented topics when BM25 statistics are missing.

Corpus statistics are written by whoever indexes, so a search-only process (the MCP server, whenever indexing runs in a separate container) started with an empty store that nothing ever filled. With no statistics every term looked equally rare, so the keyword half of hybrid search stopped ranking and degenerated into "match any of these words" — which favours overview files like README and CLAUDE.md, because they mention many topics in passing. Those then dominated the fused ranking and the semantic half was effectively ignored.

The query builder now returns an empty sparse vector when the corpus is empty, so search ranks on semantics alone rather than on a meaningless keyword vector. The server also rebuilds missing statistics from the chunks already indexed on startup, restoring the keyword half instead of leaving search permanently dense-only. Indexing behaviour is unchanged.
