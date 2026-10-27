# How it works

```
Your repositories            Paparats                               Your agent
                                                                    (Claude Code, Cursor, ...)
  backend/   ──┐      ┌─────────────────────────────┐
  frontend/  ──┼────► │ indexer: chunks, call graph, │          ┌──────────────────┐
  infra/     ──┘      │ git history, embeddings      │          │ search_code      │
                      └──────────────┬──────────────┘          │ find_usages      │
                                     ▼                         │ change_impact    │
                      ┌─────────────────────────────┐  MCP     │ module_map ...   │
                      │ Qdrant + SQLite  ◄── server ├────────► └──────────────────┘
                      └─────────────────────────────┘
```

The **indexer** reads your repositories, cuts the code into chunks, embeds them and builds
the call graph. The **server** answers the agent over MCP. Qdrant holds the vectors,
SQLite the call graph, git history, embedding cache and analytics. Both containers share
one volume, so the server sees what the indexer writes.

## Indexing

Each indexing cycle (the change check, a full pass, `paparats add`, a `projects.yml` edit
or a `POST /trigger`) takes every file in scope through these steps:

1. **Find files.** `indexing.paths`, `.gitignore`, the exclude patterns; binary files are
   skipped.
2. **Skip what did not change.** The file's content hash, chunking and embedding format
   are compared with what is stored; an unchanged file stops here.
3. **Parse once.** tree-sitter (WASM) parses the file. The same tree is used for chunking
   and for symbols.
4. **Chunk.** Chunks follow functions, classes and methods. Small neighbours are merged,
   large ones split. Files without a grammar are split by braces, indentation or blocks.
   The reasons are in [chunking-strategy.md](chunking-strategy.md).
5. **Symbols.** Each chunk records what it defines (top-level functions, classes and
   variables, methods with their class) and what it uses (calls and references), with the
   method each call is made from and the class it is called on. Names declared inside a
   function body stay out: no other file can reach them.
6. **Metadata.** Service, bounded context and tags from the config and the folder layout.
7. **Embed.** Each chunk is embedded with its file path above it (`Filepath: <path>`); the
   cache (by content hash) skips text embedded before.
8. **Store.** Vectors and payload (content, file, lines, symbols, metadata) go to Qdrant
   in batches.
9. **Git history.** `git log` per file; commits are mapped to chunks by the lines their
   diffs touch, ticket references taken from the messages.
10. **Call graph.** Calls and references between chunks become edges in SQLite. Only the
    edges of changed files, and of the uses of the names they define, are worked out
    again; the whole graph is built only for a new project or when more than 300 files
    changed.

With `INDEX_DOCS=true` each repository's markdown also goes through a separate pass into
the documentation layer ([documentation-search.md](documentation-search.md)).

## Search

The query is classified (plain words looking for code, a code snippet, a technical
question) and wrapped in the instruction `bge-code-v1`'s model card gives for that kind.
Qdrant is searched once; when the query names a class or function (`InvoiceTotal`,
`charge_card`, `Billing::Invoice`), the chunks that define it are added to the candidates.
Then the order is adjusted:

- chunks defining a named identifier ×1.1 (×1.25 when the query is only that name), files
  named after it ×1.05;
- test files ×0.9 unless the query is about tests;
- files changed more often slightly up (×1 + 0.05 × their commit-count percentile).

Only the order changes; the score shown stays the similarity (below 30% it
warns that the index may have nothing close; above, the score does not tell whether the
first result is the right one). Results are cached for 5 minutes.

`search_code` searches the query as written. The support tools `explain_feature` and
`impact_analysis` also try 2–3 variants (`auth` ↔ `authentication`, `userAuth` ↔
`user_auth`, plurals, filler words dropped) and merge them: on the
[retrieval benchmark](benchmarking.md) the variants added nothing to `search_code` and
cost up to three times the work.

## The call graph

`find_usages` returns a chunk's edges by direction: what calls or references it, and what
it calls. A call that names a class (`Invoice.total`, `self.total`, a bare call inside a
class) links only to that class's method: in Ruby by constant lookup on full paths
(certain within one file, inferred by path suffix, ambiguous when several classes match).
Each edge records the methods that make the call. In TypeScript and JavaScript a
re-export (`export { x } from './x.js'`, the usual barrel `index.ts` or `lib.ts`) is a
`reexports` edge, so a change to `x` lists the files that publish it. A call on a new
object (`Rebuild.new(ids).call`, `new Queue().flush()`) links to that class's method. A
Ruby class used as a value (passed, kept in a hash or a variable) is a `references` edge.
A Ruby constant resolves as Ruby looks it up: `Base` inside `module Billing` is
`Billing::Base` when that exists, otherwise the top-level `Base`; the `Billing` in
`Billing::Base` is not a use of its own (the `Scanner` in `Scanner::SCOPE_KEY` is), and a constant defined nowhere in the project (a
gem's `ActiveRecord::Base`) links to nothing. A call on an object does not link to a Ruby
`def self.x`, and reopening a library class (`Time`, `Date`, `ActiveSupport::...`) does
not define it. A TypeScript or JavaScript function that is not exported is reached only
from its own file, where it wins over same-named functions elsewhere.

`change_impact` walks those edges backwards from what you are about to change: callers,
then their callers, up to 3 steps. A caller passes the change on only through the methods
that actually make the call, and the methods of the same chunk that reach those through
the chunk's own calls (a public `call` using a private helper that makes the call). Code
holding the class as a value passes it on whatever method changed. Each dependent appears
once, at its nearest step; it is marked `[maybe]` when every path to it is ambiguous. Past
the first step, links only through a name several classes define are listed apart, not
followed. Very widely used files and tests are listed
but not followed. Callers linked only through a common name (a single lowercase word such
as `add`, `get`, `create`, used from more than 8 files) are set apart unless their file
also uses something specific from the target's file. When no indexed test reaches the
change (Ruby projects leave `spec/` and `test/` out of the index by default), it lists
where the tests would be by convention (`spec/models/invoice_spec.rb`, `src/queue.test.ts`).

## The module map

`module_map` groups files into modules by how much they call each other; re-exports do
not count, or a barrel file would tie every module it publishes together. A use split over
several definitions counts less, and names used everywhere count little. Communities are
found with the Louvain method, oversized ones split again. Tests join the module they call
most, migrations are left out, and files called from much of the code are listed apart as
shared. The tool answers in text and ends with a Mermaid diagram.

The console's **`/ui/map`** page (`http://localhost:9876/ui/map`) shows the same map: walk
a codebase folder by folder, with arrows for who calls whom, modules as groups of files,
and a link for every view. Like the `/ui` console it is protected by
`PAPARATS_UI_BASIC_AUTH` when that is set.

## What runs where

- **Qdrant**, per group: `paparats_<group>` (code), `paparats_<group>_arch`
  (architectural memory), `paparats_<group>_docs` (documentation, vectors + BM25) and
  `paparats_<group>_terms` (glossary).
- **Embed server**: llama.cpp `llama-server` behind `llama-swap`, with `bge-code-v1` for
  code (1536 dimensions) and `qwen3-embedding-0.6b` for prose (1024), both Apache-2.0.
  Models load on the first request and stay loaded (`EMBED_TTL=0`). Or a cloud provider
  instead ([embeddings.md](embeddings.md)).
- **SQLite**, on the `paparats_data` volume: embedding cache, git history, call graph,
  analytics and the indexer's fingerprints.
- **MCP** over Streamable HTTP, with the old SSE routes kept: `/mcp`, `/support/mcp` and
  the opt-in `/knowledge/mcp`.

| Image                   | Source                        | Download (Docker Hub, `latest`) |
| ----------------------- | ----------------------------- | ------------------------------- |
| `ibaz/paparats-server`  | `packages/server/Dockerfile`  | ~100 MB                         |
| `ibaz/paparats-indexer` | `packages/indexer/Dockerfile` | ~100 MB                         |
| `ibaz/paparats-embed`   | `packages/embed/Dockerfile`   | ~2.5 GB, models included        |

## The code

A TypeScript monorepo (Yarn workspaces):

- `packages/server`: the MCP server and HTTP API, and the indexing library
  (`ibaz/paparats-server`);
- `packages/indexer`: clones and indexes on a schedule (`ibaz/paparats-indexer`);
- `packages/cli`: the `paparats` command (`@paparats/cli`);
- `packages/shared`: path checks, `.gitignore` handling, exclude defaults;
- `packages/embed`: the embedding server image (`ibaz/paparats-embed`);
- `packages/bench`: the retrieval benchmark ([benchmarking.md](benchmarking.md)), not
  published.

[CLAUDE.md](../CLAUDE.md) describes every module, for people and agents working on the
code.
