# Grammars

WASM grammars loaded by `tree-sitter-parser.ts` in place of the older builds in
`tree-sitter-wasms`, which fail on JSX attribute strings holding `&`
(`className="[&>dt]:italic"`) and parse the rest of such a file as an error.

| File | Package | Version |
| --- | --- | --- |
| `tree-sitter-typescript.wasm` | `tree-sitter-typescript` | 0.23.2 |
| `tree-sitter-tsx.wasm` | `tree-sitter-typescript` | 0.23.2 |
| `tree-sitter-javascript.wasm` | `tree-sitter-javascript` | 0.25.0 |

Copied from the npm packages, whose install step builds a native addon this
server does not use. MIT, see `LICENSE`.
