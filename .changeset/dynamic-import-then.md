---
'@paparats/server': patch
'@paparats/indexer': patch
---

TS/JS: `import('./panel').then((m) => m.Panel)` and `.then(({ Panel }) => Panel)` link to `./panel`'s `Panel`, as `const { Panel } = await import('./panel')` already did, and a member read from a module held whole (`ns.Panel` after `import * as ns`) is a use of that module's `Panel`. Every TS/JS file is extracted again on the next index pass.
