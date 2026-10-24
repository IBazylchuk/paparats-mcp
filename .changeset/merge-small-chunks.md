---
'@paparats/server': patch
'@paparats/indexer': patch
---

The AST chunker now merges adjacent small chunks. Splitting an oversized class or function used to emit every field, statement and closing `}` as its own chunk, so about a quarter of all chunks were a single line. Search filled its result slots with these fragments and, after deduplication, sometimes returned fewer results than requested. Neighbours separated only by blank lines are now joined up to `chunkSize`, and a fragment under 64 characters may join up to `maxChunkSize`.

On the retrieval benchmark the chunk count drops from 2275 to 1513. File-level MRR@10 goes from 0.767 to 0.825 and chunk-level Recall@5 from 0.702 to 0.789.

Existing indexes are re-chunked automatically. The indexer's reindex epoch is bumped, so the first run after the upgrade does a full pass. The server re-chunks a file on its next index because the stored chunk ranges no longer match.
