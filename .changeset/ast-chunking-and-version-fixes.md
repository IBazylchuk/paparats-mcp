---
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

Bug fixes:

- **`paparats --version` was hardcoded to `0.1.2`**: `packages/cli/src/index.ts` carried a literal version string that the release pipeline never touched, so the flag returned `0.1.2` regardless of what npm had actually installed. Version is now read from the package's own `package.json` at runtime, so it tracks the published version automatically.
- **AST chunker emitted overlapping chunks for large single declarations**: when `splitNode` recursed into a named child that spanned only one line (e.g. the identifier of an `export const homeMarkdown = ...` with a long template literal body), the identifier produced its own (start, start) chunk while the body produced (start, end), leaving the identifier chunk as a redundant subset of the body chunk. Added a `dedupeContainedChunks` post-filter to drop chunks whose range is fully contained inside another chunk's range. Ties are broken by length, then by emission order.
- **`.tsx` / `.jsx` files were parsed with the wrong tree-sitter grammar**: `detectLanguageByPath` returns `'typescript'` for `.tsx` (which keeps `LANGUAGE_PROFILES` simple), but `tree-sitter-typescript` does not understand JSX — tags parse as bogus type expressions and identifier usages inside `<Foo prop={x}/>` or `{value}` are lost. Added `resolveAstLanguage(language, relPath)` which upgrades to the `tsx` grammar for `.tsx`/`.jsx` paths at the AST boundary, leaving the higher-level language profile untouched.
