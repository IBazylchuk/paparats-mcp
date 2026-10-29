---
'@paparats/server': patch
'@paparats/indexer': patch
---

A call on self reaching an override in a class below is stored as `overrides` instead of `calls` (`find_usages` can filter on it). `change_impact` follows it as before; `module_map` no longer reads it as the base class's folder using the subclass's folder, the other way round from what the code says. Every graph is built again on the next index pass.
