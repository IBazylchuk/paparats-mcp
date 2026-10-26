---
'@paparats/server': patch
'@paparats/indexer': patch
---

The symbol graph behind `find_usages`, `change_impact` and `module_map` missed several common ways code is written:

- **Ruby class methods.** `def self.overdue` was not a definition, so `Invoice.overdue(...)` linked to nothing and `change_impact` with `symbol: "overdue"` answered that the chunk does not define it. Classes and modules named with a namespace (`class Billing::Invoice`) were not definitions either.
- **Ruby namespaces.** A module that only wraps classes (`module Billing; class Invoice`) counted as a definition of `Billing` in every file under it, so any `Billing::X` linked to all of them. Such a module now defines nothing.
- **React components.** `<PriceBadge />` and `<Ui.Button>` in `.tsx`/`.jsx` were not recorded as uses, so a component had no callers. Lowercase HTML tags are not counted.
- **JavaScript projects.** The JavaScript query named TypeScript-only node types, so it failed to compile and files parsed with the JavaScript grammar got no symbols at all.

On a private Ruby codebase (4,962 files), calls of the form `Class.method` to a `def self.method` now link to the defining file for 63% of call sites instead of 42%, and to the method itself for 40% instead of 0.4%. Most of the rest are short class names defined in many namespaces, which the graph deliberately does not link to every candidate.

Each code point now stores `symbol_format`, which indexing compares like `embed_format`, so unchanged files are rewritten once with their symbols extracted again (vectors come from the embedding cache). The indexer's reindex epoch is bumped, so the first run after the upgrade does a full pass and rebuilds the edges.
