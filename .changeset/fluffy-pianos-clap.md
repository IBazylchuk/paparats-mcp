---
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

fix(indexer): exclude docs and terminology sidecar collections from listGroups

`listGroups()` only filtered out `_arch` collections, so `paparats_<group>_docs`
and `paparats_<group>_terms` surfaced as phantom code groups. search_code without
an explicit group fanned out into them and Qdrant rejected the unnamed-vector
query with "Not existing vector name" (Bad Request). The same leak let
stale-group cleanup probe docs/terms collections and potentially evict a
project's docs chunks during re-indexing.
