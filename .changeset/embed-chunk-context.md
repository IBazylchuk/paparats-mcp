---
'@paparats/server': minor
'@paparats/indexer': minor
---

Code chunks are embedded with their file path. A method chunk used to be embedded on its own, with nothing saying which file it belongs to; the embedded text is now `Filepath: <path>`, `---` and the chunk. What search returns is unchanged: results still show the plain chunk.

On the retrieval bench this helps most for questions asked in plain language. On support-style questions over a private Ruby codebase, the right file came first for 38% of queries instead of 21% in plain similarity order (as the support tools rank), and for 33% instead of 21% with `search_code`'s ranking. On this repository's support-style questions it was 55% instead of 45% with the ranking and unchanged without it. On three sets of real agent queries over the private codebase, with the ranking, it was as good or slightly better (71% vs 66%, 61% vs 58%, 82% vs 82%). Also adding the enclosing class and module lines won about as many queries as it lost, so the header carries the path only.

Every file is re-embedded once. Each code point now stores `embed_format`, which the indexer compares like the chunk ranges, so even unchanged files are rewritten, and the indexer's reindex epoch is bumped so the first run after the upgrade does a full pass.
