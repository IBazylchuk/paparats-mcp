---
'@paparats/server': patch
---

Docs search: BM25 keywords count each word's rarity once, through Qdrant's IDF modifier, instead of twice (once baked into the stored vectors at index time, and again in the query). English words are cut to their stem, so `creating` finds `created`, and question words such as `how`, `what` and `why` no longer count as keywords. Existing docs collections are rebuilt on the next start, without re-walking the sources.
