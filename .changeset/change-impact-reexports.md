---
'@paparats/server': patch
---

`change_impact` lists the barrel files that re-export what you change. In TypeScript and
JavaScript, `export { x } from './x.js'` is now a `references` edge, so changing `x` shows
the `index.ts` or `lib.ts` that publishes it (the package's public API) under "re-exports".
The module map ignores these edges, so a barrel file does not pull every module it
re-exports together. Existing indexes re-extract symbols once on the next pass.
