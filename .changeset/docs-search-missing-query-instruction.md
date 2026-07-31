---
'@paparats/server': patch
---

fix(docs): apply the embedding model's query instruction in docs search

`DocsStore.search` embedded queries with the provider's bare `embed()` instead of
`embedQuery()`, so the instruction prefix the text model was trained to expect was
never applied. The code layer already used `embedQuery()`/`embedBatchPassage()`
correctly — only the docs layer bypassed them.

This matters because the text model is a decoder with last-token pooling: the
instruction is part of its trained query interface, not decoration. Bare queries
land in a different region of the vector space than the instruction-conditioned
one the relevance floors were calibrated against, so the floors were being applied
to the wrong distribution.

Measured on one deployment over 102 answerable and 30 verified absent-topic
queries:

| | precision@1 | recall@5 | absent topics leaking |
| --- | --- | --- | --- |
| bare query (before) | 74.5% | 98.0% | 28/30 |
| instructed query (after) | 87.3% | 97.1% | 5/30 |

Documents are deliberately still embedded unprefixed — instruction-tuned families
instruct queries only (see `prefixPassage`), so no re-indexing is required.

Also adds the prefix-aware methods to the docs test provider fake, which lacked
them and therefore could not distinguish the two paths, and corrects a stale
ranking-accuracy comment in the `search_docs` tool.
