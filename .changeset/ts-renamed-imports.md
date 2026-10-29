---
'@paparats/server': patch
'@paparats/indexer': patch
---

The TypeScript call graph finds more of what depends on a change:

- TypeScript, TSX and JavaScript are parsed with tree-sitter-typescript 0.23.2 and tree-sitter-javascript 0.25.0, shipped in `packages/server/grammars`. The older builds failed on a JSX attribute string holding `&` (`className="[&>dt]:italic"`) and read the rest of the file as an error, so a component's inner callbacks were taken for its functions and its callers were lost.
- A name imported under another one links to its definition under the name it has there: `import Provider from './Provider'` of a `LedgerProvider`, `export { default as Provider } from`. Before, such an import linked to nothing when no definition had the local name, and otherwise `change_impact` did not follow it.
- `export default memo(Card)`, `forwardRef(Field)` or `withAuth(Page)` exports the component it wraps.
- `import { Drawer as Trapdoor }` in a file that declares its own `Drawer` is a use of the imported one.
- A method split over chunks is one row of `change_impact`, the chunk where it begins included.
- An incremental graph update links again the imports into a changed file that use another name, which it dropped before until the next full rebuild.

Checked against the TypeScript compiler's references on 150 exported functions and constants drawn at random from a TypeScript project, held out while fixing: of the dependents in other files within three steps, 95.3% are listed (92.3% before, 78.0% in the last release); rows naming the wrong function went from 2.2% to 0.6%, and listed files that depend on nothing stay at 2.2%. Symbols are extracted again once on the next pass; files whose chunks change are embedded again.
