---
'@paparats/server': patch
'@paparats/indexer': patch
---

`change_impact` no longer lists every file under a Ruby namespace when the file defining the namespace module depends on the change: `module Billing` at the top of each such file was taken for a use of `Billing`. It is now an edge of its own, `opens`, which `module_map` counts as before and `change_impact`, `impact_analysis` and `search_code`'s `Called from:` skip; `find_usages` shows it under that name. An object returned or raised (`return Report.new(x)`, `raise Failed.new(x)`) no longer counts as the class held as a value.
