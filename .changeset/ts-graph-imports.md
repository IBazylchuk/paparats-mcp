---
'@paparats/server': patch
'@paparats/indexer': patch
---

The TypeScript and JavaScript call graph links a name through its import. It follows barrels (`export * from`, `export { default } from`, `export { default as X } from`), default exports, `import { a as b }` and names destructured from `await import('./x')`. A name the module neither imports nor declares links to nothing in another file (the global `Error` no longer links to a component named `Error`), a member of an imported value (`ThemeContext.Provider`) only to the module it comes from, and nothing links to a `.d.ts` declaration. A call on an object of unknown type is a method call on an object, not a bare name. Checked against the TypeScript compiler on the paparats repository, 94.2% of the edges `change_impact` follows are backed by a real import (92.9% before). With fewer false links `module_map` finds more modules there (11 instead of 9) and its output grows by about a third. Symbols are extracted again once on the next pass.
