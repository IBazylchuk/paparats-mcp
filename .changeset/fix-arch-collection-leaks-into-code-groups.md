---
'@paparats/server': patch
---

fix(server): stop arch-memory collections leaking into the code-group list

`listGroups()` filtered Qdrant collections by the `paparats_` prefix alone. The architectural-memory collection for a group is named `paparats_<group>_arch`, which also carries that prefix, so it passed the filter and `fromCollectionName` returned a phantom code group `<group>_arch` (e.g. `default_arch`). That phantom entered `getGroupNames()`, and `search_code` — which iterates every known group when none is specified — ran a code-vector search against the arch collection, failing with `Bad Request` on every query.

`listGroups()` now also excludes arch collections via `isArchCollection()`, so they never surface as code groups. The `_arch` suffix is reserved as a result: a code group literally named `<x>_arch` is indistinguishable from group `<x>`'s arch collection and will not be listed.
