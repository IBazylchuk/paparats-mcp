---
'@paparats/shared': major
'@paparats/cli': major
'@paparats/server': major
'@paparats/indexer': major
---

**BREAKING: migrate to permissively-licensed embedding models.** The default code embedder is now **bge-code-v1** (1536d) and the default arch/docs text embedder is **Qwen3-Embedding-0.6B** (1024d) — both Apache-2.0, replacing the CC-BY-NC `jina-code-embeddings` and `bge-m3`. Both are decoder-based and served with `--pooling last`.

**Why this is breaking:** a model change invalidates every existing vector. Even where the dimension is unchanged (jina→bge-code are both 1536d; bge-m3→qwen are both 1024d), the vector spaces are incompatible, so any pre-existing index must be reindexed before search returns correct results. Collections stamped with the old model raise `CollectionMetaMismatchError` on write.

**Migration (required for existing installs):**

- **Code layer** — reindex from source: drop the old collection (or bump the indexer's reindex epoch) so it rebuilds with the new model.
- **Arch/docs layer** — re-embedded automatically. On startup the server detects any arch collection stamped with a different text model and re-embeds it in place, reconstructing each card's text from its stored payload (no data loss; the collection is only recreated if the dimension changed). No manual step for the OSS/self-hosted path. A manual `POST /api/arch/reindex {"group":"..."}` (and `apiClient.reindexArch`) is also available to force it without a restart.
- The embed image and native `paparats install` ship only the two new GGUFs — no legacy weights are carried; rollback is via a previously published image tag.

**Other changes:**

- **Instruction-aware queries.** Query-type detection (nl2code / code2code / techqa) maps to each model family's instruction template using **verbatim task strings from the model cards** (a paraphrased instruction measurably degrades retrieval). Documents are embedded unprefixed (asymmetric retrieval). Instructions auto-enable for instruction-tuned families and stay off for cloud providers.

See `docs/replacing-embedding-models.md` for the full cutover checklist and the process for swapping models in the future.
