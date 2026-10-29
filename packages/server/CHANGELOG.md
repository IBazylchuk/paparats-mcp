# @paparats/server

## 2.16.6

### Patch Changes

- bade586: Call graph and `change_impact`:

  - A call on self links to the overrides in the classes below too, found through the classes rather than by name, so `change_impact` follows a template method: a base class method calling the step its subclasses define now depends on each subclass's version. This also holds for a call between two methods of one chunk.
  - A Ruby key without a value (`Report.new(total:)`) calls the method of its name, like a bare call.
  - A Ruby `Foo.new` counts as holding the class only when it is passed or stored. A method that returns a new object (a factory) no longer counts as a dependent of every method of that class, so it is no longer listed a step too near.

  Every Ruby and TypeScript file is extracted again, and every graph is built again, on the next index pass.

- 60baadc: Invented names in the examples of comments, tests and changelog entries. `scripts/check-no-private-refs.sh` now matches patterns with Perl regexes when git supports them (on macOS a `\b` in an extended regex matched nothing, so such a pattern never fired) and checks `CLAUDE.md` too.
- 91deaac: `module_map`: a module's Uses and Used by are calls between the folders the modules are named after. A module also holds files of other folders, and those files used to link it too, so a link read as one between two folders often had no import between them. Now a file counts for the module whose folder holds it most closely, whichever module it was grouped into, and a file in no module's folder links nothing. Two modules named after the same folder are named after a folder below it each when those are apart, else after their most called file, which links now show too, so no two modules share a name. The note naming the file a used module is reached through is gone: a link's files are now always inside the folders it names.
  - @paparats/shared@2.16.6

## 2.16.5

### Patch Changes

- de05082: Fixes in architectural memory and the glossary, from an audit of their write paths:

  - `arch_record_decision` with `supersedes` replaces only a current decision of the same project (or a group-wide one by a group-wide one) that the server's project scope lets the caller see. Before, a decision of one project could retire another project's, also on a server scoped to other projects, and a decision already superseded could be replaced again. When marking the old decision fails, the new card is taken back out, so a retry does not leave two.
  - Updating a glossary term without `aliases`, or a component without `files`, `neighbours` or `anchors`, keeps what the card had. Before, they were emptied, and the exact lookup by acronym depends on the aliases.
  - `arch_list` no longer repeats the last card of a page on the next one: Qdrant's scroll offset includes the point it names, so with `limit: 1` and a project filter it returned the same card forever.
  - Reindexing architectural memory or the glossary (`POST /api/arch/reindex`, and the heal at startup) reports a Qdrant failure instead of answering that there was nothing to reindex. After a change of dimension, a failed write is tried again, and the collection is not dropped while a card cannot be re-embedded.
  - `arch_delete` reports a malformed id as not found instead of failing the whole call, finds an upper-case UUID, and no longer deletes the collection's metadata point. Empty `project` on the glossary tools, and empty `name`, `summary` or `supersedes` on the arch tools, are refused.

- 203266a: Docs: the duplicate thresholds of architectural memory (0.85 / 0.70) were calibrated on bge-m3 and carried over to Qwen3 without being measured again; `docs/architectural-memory.md` now says so instead of presenting them as tuned for Qwen3.
- fe573f3: The default excludes no longer drop source folders named like build output. `build`, `dist`, `out`, `coverage`, `tmp`, `log`, `storage`, `bin`, `target` and a few more were excluded at any depth, so a Next.js route `src/app/build/page.tsx` or a Ruby `lib/storage/` never reached the index. They are now excluded only at the project root and at each package root (a folder with a `package.json`, `Gemfile`, `go.mod`, `Cargo.toml` or another manifest), where build tools write them. Dependency folders such as `node_modules` stay excluded at any depth, and an `exclude` written in `.paparats.yml` is used as before. On the paparats repository the indexed files are the same; a project gains only the source files in such folders and loses none.
- aac86c2: Reindexing with force after a change of embedding model works. Before, `force` dropped only the project's chunks and kept the collection, which still recorded the old model, so every write failed on the mismatch. Now force over a collection built with another model drops the whole collection (old and new vectors cannot be mixed), and the indexer indexes every repository again once the cycle ends. The same applies to `POST /api/index` with `force`. The mismatch error now names this fix.
- 8cd2cc8: `health_check` also reports the indexer: whether it answers, when it last ran, and each repository's status, chunk count and last error. An agent can tell a stale or failing index from an empty one. The server finds the indexer at `PAPARATS_INDEXER_URL`, which the generated compose sets, and waits at most 3 seconds for it.
- 94d29df: The glossary tools' descriptions and comments use invented example terms.
- e0c7053: An optional API key for the server and the indexer. Unset, as before, they answer anyone who reaches their ports, which suits localhost and a server reached over a VPN. With `PAPARATS_API_KEY` set (one key, or several separated by commas, each at least 16 characters), every route asks for `Authorization: Bearer <key>`: the MCP endpoints, `/api/*`, `/metrics` and the indexer's `/trigger`. `/health` stays open for health checks and shows only the status to a caller without the key; `/knowledge/mcp` keeps its own tokens. The `/ui` pages take the key as a basic-auth password, unless `PAPARATS_UI_BASIC_AUTH` guards them. A key the server cannot use stops it from starting.

  The CLI reads the key from `~/.paparats/.env` or its environment and sends it. `paparats install` passes it to Cursor and Claude Code as a header, and `paparats install --mode support --api-key <key>` does the same for a server elsewhere. The generated compose passes `PAPARATS_API_KEY` from `.env` to both services.

  The key does not cover Qdrant, which holds the indexed code, or the embed server, and neither has auth of its own in the generated stack. Their ports are now published on `127.0.0.1` only; the server and the indexer reach them over the compose network, as before. `QDRANT_BIND=0.0.0.0` or `EMBED_BIND=0.0.0.0` in `.env` publishes one to the network again. New `SECURITY.md`: how to report a vulnerability and how a deployment is exposed.

- Updated dependencies [fe573f3]
  - @paparats/shared@2.16.5

## 2.16.4

### Patch Changes

- cb973f7: `change_impact` counts steps by method call, so "3 steps away" means three calls from the change, calls between the methods of one file included:

  - Each chunk records the calls between its own methods, and each edge the steps from its calling method to the other methods of its chunk that reach it. Methods of the changed chunk that call it are listed at their steps, and a dependent's other methods that reach the call are listed as "calls `x` in this file", one step further.
  - `depth` limits steps: what lies further is counted, not listed. Before, it limited chunks, so dependents 4 to 6 calls away were listed under a three-step question.
  - A method too long for one chunk is one dependent, shown on the line where it begins, and its callers are followed from there. Before, its callers were lost when the call sat in a later chunk.
  - A Ruby method called by its bare name without arguments from another method of its class (`total: subtotal`) is a call. A `Foo.new` stored in a variable is no longer read as the class held as a value (which passed on any change to the class); its calls link one by one.
  - When no indexed test reaches the change, the output says the index may leave tests out, not that the code is untested.

  Checked offline on 8 targets drawn at random, against answer keys written from the source by reviewers who did not see the output: 71 of 73 dependents in the keys are listed (47 before). Nearly all of the gain, 22 of 24, comes from two Ruby targets whose callers sit in the same file and were not seen before; on the four TypeScript targets 18 of 19 are listed (16 before). 1 is listed at a step the key disagrees with (7 before), and 3 shown lines are wrong (13 before). Symbols are extracted again once on the next pass; no file is embedded again.

- 420e501: Docs search matches keywords in any script, not only plain Latin letters: Cyrillic, Greek and other words are kept whole, accents on Latin letters are dropped (`cafe` finds `café`, where `über` used to become `ber`), and Chinese and Japanese text is matched by two-character pieces. The keyword statistics are rebuilt once from the stored documents at startup; the documents' own keyword vectors catch up on the next docs pass. Plain ASCII text is tokenised as before.
- cc381d6: `module_map` names a module after the folder that best matches it, holding much of the module and little else of the project (or two folders joined by `+` when they match better), instead of the folder with the most of its files, which often held a small part of the module. Its main files are the most called files of that folder, so a widely called file of another folder the module holds no longer heads them. On the paparats repository, the median F1 of a module against the folder it is named after went from 0.71 to 0.76.
- a27d281: `module_map` keeps each package or app in modules of its own. A module holding the files of another app it imports read as the app using itself, or the other app using it; such a module is now split along packages and apps, and a part of fewer than 3 files joins the module of its own app it links to most. On the paparats repository, files sitting in a module of another package went from 11 to 5, and the output did not grow.
- cb973f7: The TypeScript and JavaScript call graph links a name through its import. It follows barrels (`export * from`, `export { default } from`, `export { default as X } from`), default exports, `import { a as b }` and names destructured from `await import('./x')`. A name the module neither imports nor declares links to nothing in another file (the global `Error` no longer links to a component named `Error`), a member of an imported value (`ThemeContext.Provider`) only to the module it comes from, and nothing links to a `.d.ts` declaration. A call on an object of unknown type is a method call on an object, not a bare name. Checked against the TypeScript compiler on the paparats repository, 94.2% of the edges `change_impact` follows are backed by a real import (92.9% before). Against the compiler's references on 150 exported functions and constants drawn at random from a TypeScript project, `change_impact` lists 85.3% of the dependents in other files within three steps (69.2% before). With fewer false links `module_map` finds more modules there (11 instead of 9) and its output grows by about a third. Symbols are extracted again once on the next pass.
- 0f3d8c5: The TypeScript call graph finds more of what depends on a change:

  - TypeScript, TSX and JavaScript are parsed with tree-sitter-typescript 0.23.2 and tree-sitter-javascript 0.25.0, shipped in `packages/server/grammars`. The older builds failed on a JSX attribute string holding `&` (`className="[&>dt]:italic"`) and read the rest of the file as an error, so a component's inner callbacks were taken for its functions and its callers were lost.
  - A name imported under another one links to its definition under the name it has there: `import Provider from './Provider'` of a `PlanterProvider`, `export { default as Provider } from`. Before, such an import linked to nothing when no definition had the local name, and otherwise `change_impact` did not follow it.
  - `export default memo(Card)`, `forwardRef(Field)` or `withAuth(Page)` exports the component it wraps.
  - `import { Drawer as Trapdoor }` in a file that declares its own `Drawer` is a use of the imported one.
  - A method split over chunks is one row of `change_impact`, the chunk where it begins included.
  - An incremental graph update links again the imports into a changed file that use another name, which it dropped before until the next full rebuild.

  Checked against the TypeScript compiler's references on 150 exported functions and constants drawn at random from a TypeScript project, held out while fixing: of the dependents in other files within three steps, 95.3% are listed (92.3% before, 78.0% in the last release); rows naming the wrong function went from 2.2% to 0.6%, and listed files that depend on nothing stay at 2.2%. Symbols are extracted again once on the next pass; files whose chunks change are embedded again.
  - @paparats/shared@2.16.4

## 2.16.3

### Patch Changes

- 2d895e7: Small fixes from the docs and code audit:

  - **Server.** `health_check` reports the server version.
  - **Server.** A pull request named in brackets, as a GitHub squash merge writes it (`feat: x (#123)`), is now read as a ticket.
  - **Server.** `indexing.extensions` now selects the files to index within `indexing.paths`, in place of the language's patterns. Before, it was accepted and ignored.
  - **CLI.** The native embed config allocates batch buffers of 2048 tokens instead of 8192, as the Docker image does. A chunk is a few hundred tokens, and the larger buffers cost gigabytes of memory.
  - **CLI.** `paparats doctor` no longer fails without a `.paparats.yml`, which is optional, and it now checks the indexer.
  - **CLI.** `paparats doctor` and `paparats status` find the embed server through `EMBED_URL` or `EMBED_PORT` in `~/.paparats/.env`, not a fixed `localhost:18434`.
  - **CLI.** `paparats status` shows whether the indexer is running.

- 8be321a: `change_impact`:

  - A dependent is shown at the line where its calling method is defined, not at the first line of its chunk. Before, a method on line 63 of a class chunk starting at line 2 was shown as `:3`.
  - Each dependent now lists the other methods of its chunk that call it, as "further in this chunk", with their lines. Before, those methods were followed but never named, so the steps they add were invisible.
  - Only a chunk called from many places stops the walk as `[hub]`. Before, a chunk that only calls a lot (a large class) stopped it too.

- 656cf0b: `module_map`: a used module now names, in brackets, the file it is mostly reached through when that file belongs to another package or app than the folder the module is named after (`Uses: 4. extensions/widget/src/lib (src/components/NotFoundView.tsx)`). A module is named after the folder most of its files sit in, but it can also hold files of another app. The output grows by 5% on the paparats repository.
- e755bb4: TypeScript and JavaScript imports through a tsconfig path alias (`~/lib/dates`, `@/components/x`) now link only to the file they name, as relative imports already did. The alias is read from the nearest `tsconfig.json` / `jsconfig.json` above the file, following `extends`, `baseUrl` and a solution config's `references`. Before, such an import linked by name to every definition of it in the project. The paparats repository, which imports relatively, is unchanged. The aliases are resolved when the graph is built, from the symbols already stored. Each project's graph is built again once on its next pass, and no file is extracted or embedded again.
  - @paparats/shared@2.16.3

## 2.16.2

### Patch Changes

- c65ad9d: Descriptions and docs match the code again. Tool descriptions call the score a similarity, not a confidence, and drop the unmeasured "50-90% fewer tokens"; `impact_analysis` says it shows both what a feature depends on and what depends on it; support instructions format GitHub tickets as `#567`, as the extractor returns them. `server.json` points at `/mcp`. The CLI no longer suggests the removed `paparats init`. Docs: indexing steps in order (a file is parsed and chunked before the unchanged check), files without a grammar are cut into fixed-size runs of lines, `change_impact` follows 2 steps by default, `force` is not enough for a model change, the embed image's examples use port 18434, and smaller fixes.
- 3d13f72: With `PAPARATS_LOG_QUERY_TEXT=false` the analytics database no longer keeps the words of a query: `query_tokens`, which the retry rate compares, now holds hashes keyed by a random key that lives only in the server process. Before, the column stored the query's words in plain text whatever the setting. `docs/observability.md` also says that `query_hash` is a plain SHA-1, which hides the text but lets anyone holding the database check a guess.
- 79adaeb: `search_changes` and `recent_changes` read a relative `since` ("7 days ago", "2 weeks", "yesterday"), which their prompts suggest: before, it went to Qdrant as is and the query failed. A date neither ISO 8601 nor relative gets a message saying what to pass. `find_usages` reads a `called_by` / `referenced_by` filter as `calls` / `references`; those types were offered but no edge carried them, so the filter returned nothing.
  - @paparats/shared@2.16.2

## 2.16.1

### Patch Changes

- 46dc00c: Chunk ids in tool output are code spans (`` chunk: `id` ``) instead of italics (`_chunk: id_`). Agents copied the closing `_` with the id, and `get_chunk`, `find_usages`, `change_impact` and `get_chunk_meta` then answered "Chunk not found". Those tools now also read an id with a trailing `_` or the backticks around it.
- c74a50f: A call on an object of a known class that several of its implementations or subclasses answer (a base class calling a hook its subclasses define, an interface with several implementations) is linked to each of them as `INFERRED` instead of `AMBIGUOUS`, so `change_impact` keeps those callers in its list rather than setting them aside with calls on objects of unknown class. A class name that may mean several classes, or a class reopened in several files, stays `AMBIGUOUS`.
- 4c911c9: A Ruby call on `connection` (`connection.select_rows(...)`, `Model.connection.execute(...)`) is a call on ActiveRecord's database adapter, so it no longer links to a project method of the same name. Symbols are extracted again once on the next pass.
- bfcc3fb: A Ruby constant path through a class alias set in the same file (`Saplings = ::Vendors::Acme::Saplings`, then `Saplings::Shears`) now links to that class's constant, instead of to every class of that name.
- 31034be: `change_impact` lists callers linked only through a name several classes define (an AMBIGUOUS edge: a call on an object whose class the code does not show) apart from its dependents at the first step too, as it already did further away, instead of listing them as `[maybe]`. Such links are mostly calls to another class's method of the same name: checked against the TypeScript compiler on this repository's server, 18 of 355 were real. The set-aside names stay listed with their files.
- a41ef9a: When no indexed test reaches a change, `change_impact` names the project's test files that are named after the changed file and its direct callers, instead of guessing paths: each project pass records the project's test files by name (`*_spec.rb`, `*_test.rb`, `*.test.ts` / `.spec.*`, `test_*.py`, `*_test.go`), also those left out of the index such as Ruby specs, and of several namesakes the one sharing most folders with the file is shown. The convention guess remains for content sent without a project directory. On this repository the paths shown that exist went from 0% to 100%.
  - @paparats/shared@2.16.1

## 2.16.0

### Minor Changes

- fbe43b3: The call graph follows the class a call is made on. A call on a variable or a field links to its class's method when the file shows the class: `x = Report.new(...)`, `plan = Plan.find_by(...)`, `@client ||= Api::Client.new`, a method or `attr_reader` returning one, a constant holding one; in TypeScript a type annotation, `new`, a field, a constructor parameter property or a function's declared return type. The method is looked up the class's ancestry (superclass, `include` / `extend` / `prepend`, `extends` / `implements`), then in the classes below it (an interface's implementations, a mixin's hosts). A call on a builtin, a Node module, an installed package, or a class that defines no such method anywhere up or down its ancestry links to nothing, instead of to whatever else has the name. In TypeScript and JavaScript an imported name links to the module it comes from, names read as values (`retry(fetchPage)`, a constant) are uses, and a call through `await x.f<T>()` is no longer missed; the project's own packages and tsconfig path aliases are read from its `package.json` and `tsconfig*.json` files. A class added, removed or re-parented rebuilds the whole graph; whether a name is common is now counted over every file using it, linked or not.

  Checked against the TypeScript compiler on this repository's server, for edges through names `change_impact` does not set aside as common: 92.6% of edges are real (86.9% before) and 97.7% of the real ones are found, import lines aside (76.3% before). Symbols are extracted again once on the next pass.

### Patch Changes

- @paparats/shared@2.16.0

## 2.15.4

### Patch Changes

- 32d4b74: `search_code` puts the definition first when the query is only a name (`charge_card`, `Billing::Invoice`). A short chunk that imports, re-exports or explains the name could score well above the code that defines it; for such a query the defining chunk is now raised ×1.25 instead of ×1.1. On this repository's query set the right file came first for 79% of all queries instead of 75%. The other query sets have no bare-name queries and did not change.
- 61a5e4e: `change_impact` lists the barrel files that re-export what you change. In TypeScript and
  JavaScript, `export { x } from './x.js'` is now a `reexports` edge, so changing `x` shows
  the `index.ts` or `lib.ts` that publishes it (the package's public API) under "re-exports".
  The module map ignores these edges, so a barrel file does not pull every module it
  re-exports together. Existing indexes re-extract symbols once on the next pass.
- 3c5b9ba: `change_impact` no longer loses real dependents past the first step. Since 2.15.1 a caller passes a change on only through the method that makes the call, which cut three common shapes of code:

  - **A private helper.** When a private method calls the change and only the class's own `call` and `preview` call that helper, nothing outside was followed. Each use is now also recorded for the methods of the same chunk that reach it through the chunk's own calls (`reach_symbols` on the edge), including Ruby calls without arguments written as a bare name (`log = ledger_entry`). Labels still name only the method that makes the call.
  - **A call on a new object.** `Rebuild.new(ids).call` in Ruby and `new Queue().flush()` link to that class's method, like `Rebuild.call` does. A bare `new(ids).call` inside a Ruby class is a call on that class. Service objects run this way had no link at all, since `call` is defined in too many classes to link by name.
  - **A class used as a value.** A Ruby class passed as an argument, kept in a hash, an array or a variable, or `Foo.new` kept for later, is a `references` edge, and `change_impact` follows it whatever method of the class changed. Namespaces, `include`, `raise` and calls made on the class at once (`Invoice.overdue`) stay ordinary.

  Past the first step, links only through a name that several classes define (AMBIGUOUS) are listed apart under "Further, only through a name defined in several places", not followed. At the first step they stay as `[maybe]`.

  Symbols are extracted again once on the next pass.

- b20dd2e: The call graph reads Ruby code kept as a heredoc string (`SCRIPT = <<~'RUBY_SOURCE'` in a data migration, any tag containing `RUBY` or `RB`): grep saw the calls there, the parser saw text. Its calls join the chunks holding those lines; methods the heredoc defines stay inside it, and other heredocs (SQL, Markdown) are still text. A bare call next to a top-level definition of the name in the same file (a script's helper) now links to that one instead of to every same-named definition. Symbols are extracted again once on the next pass.

- b2870e9: The call graph links fewer things by name alone, so `change_impact`, `find_usages` and `module_map` see fewer false dependencies:

  - **Ruby constants resolve as Ruby looks them up.** `Base` inside `module Billing` is `Billing::Base` when that exists, otherwise the top-level `Base`. A constant defined nowhere in the project (a gem's `ActionController::Base`, `GraphQL::Dataloader::Source`) links to nothing, instead of to every project class with the same last name. The namespace part of a path (`Billing` in `Billing::Invoice`) is not a use; the class a value constant is read from (`Lexer` in `Lexer::MAX_DEPTH`) is.
  - **Ruby class methods.** A call on an object (`record.batch`) no longer links to a `def self.batch`.
  - **Reopened library classes.** `class Time` or `module ActiveSupport` in a project file adds methods to the library class and no longer counts as defining it, which had made such a file look used by every file.
  - **File-local TypeScript and JavaScript.** A function or class that is not exported is reached only from its own file, and there it wins over same-named exports elsewhere.
  - **Tests that are not indexed.** When no indexed test reaches the change, `change_impact` says so and lists where the tests would be by convention (`spec/models/invoice_spec.rb`, `src/queue.test.ts`): Ruby projects leave `spec/` and `test/` out of the index by default.

  In the module map no file shows as shared by the whole project any more (a reopened library class did). Symbols are extracted again once on the next pass.

- 08f8317: `search_code` no longer tells the agent to fall back to grep for ordinary scores. With the default code model the top result's similarity rarely reaches 60% even when it is right, so over five query sets (218 queries) the old bands called 0–5% of answers high-confidence and 14–38% low-confidence, though the right file was in the top five for 50–96% of the "low" ones. Above 30% the score does not tell whether the first result is right (the right file was in the top five for 84–96% of queries per set and first for 59–84%, and no split of that range separated right from wrong on real agent queries), so there is one note now: below 30% the index may have nothing close. Every bench query has an answer, so that floor is not measured; it sits under the scores of answered queries (2 of 218 fall below). The instructions, the skill and the CLI's `CLAUDE.md` block say the same and ask to read the top few results.
  - @paparats/shared@2.15.4

## 2.15.3

### Patch Changes

- @paparats/shared@2.15.3

## 2.15.2

### Patch Changes

- b1bb87b: The symbol graph is updated for what changed instead of being rebuilt for the whole project.

  - Every file written or removed is recorded with the names its old and new chunks define. The graph then works out again only the edges of those files and every use of those names, reading just the chunks involved, and replaces them in one transaction. A project pass (the indexer container) and single-file updates (`updateFile`, `POST /api/file-changed`, `POST /api/file-deleted`, CLI batches) both go this way. The changes are kept in the metadata database, so an update that did not happen (a crash, a failed write) is applied by the next one.
  - The whole graph is still built when a project has none, or when more than 300 files changed at once.
  - The edges of a file or a project are deleted by id range. The LIKE pattern used before scanned the whole table, once per removed file.

  One changed file updated the graph in 0.25 s (median over 102 files, slowest 1.9 s, the process never blocked for more than 0.07 s). The full rebuild it replaces took 20–25 s, stopped the process for about 4 s while deleting, and left tools with a partial graph for 11–15 s while writing. After the 102 updates the stored graph matched a full rebuild edge for edge.
  - @paparats/shared@2.15.2

## 2.15.1

### Patch Changes

- 69b36f7: The symbol graph now links methods, not whole chunks, and uses the class a call names.

  - Each use records the method it is made from, also when that method continues into the next chunk. `change_impact` passes a change on only through the method that calls it, so a neighbouring method in the same chunk no longer drags in its own callers. `find_usages` and `change_impact` name that method instead of the chunk's first symbol.
  - A call that names its class (`Grove.water`, `::Orchard::Grove.water`, `self.water`, a bare call inside a Ruby class, `this.save()`) links only to that class's method when the class defines it. Classes are compared by full path, and a relative name is looked up the way Ruby looks up a constant, from the namespace of the call outwards, so `Api::Parser` and `Import::Parser` stay apart. An exact match in one file is `EXTRACTED`: it counts even through a common name and is exempt from the fan-out cap. A class found only by the end of its path is `INFERRED`; several matching classes, or a method defined in several files, `AMBIGUOUS`. Other calls are matched by name as before.
  - A call to another class's method of the same name is no longer dropped as recursion: since 2.15.0 counted `def self.water` as a definition, a `def self.water` delegating to `Planter.water(...)` lost that call.
  - Single-file updates now keep the graph current. `updateFile`, `POST /api/file-changed`, `POST /api/file-deleted` and content batches from the CLI (`POST /api/index`) replaced a file's chunks but left its edges alone, so edges pointed at chunks that were gone and the new chunks had none; a project indexed only through the CLI had no graph at all. Each of them now schedules a rebuild of the project's graph, a few seconds after the last change.
  - The module map is rebuilt after the indexer writes edges. Edge versions were kept in the server's memory, so edges written by the indexer container never reached the map until the server restarted. They are now stored per project in the metadata database; a group's map is put together from per-project maps, so only projects whose edges changed are mapped again.

  `symbol_format` goes to 3 and the indexer's reindex epoch to 5, so symbols are extracted again once after the upgrade.
  - @paparats/shared@2.15.1

## 2.15.0

### Minor Changes

- c0eef88: The console's map page (`/ui/map`) is now a code map you walk folder by folder, replacing the single cloud of unlabelled module circles.

  - **Levels.** A group opens at its repositories and a repository at its top folders. Click a folder to go into it; a folder holding only one folder opens that one. Each level shows at most 24 folders and files, the most called first, and the rest are listed from one "more" circle.
  - **What it shows.** Every circle is labelled and sized by its files. Arrows point from caller to called. Dashed circles around the edge are the folders elsewhere that this one calls or is called from.
  - **Files.** Click a file to see what it calls and what calls it, with links to each.
  - **Modules.** The side panel lists the modules with files in the folder. A module opens as its own view: its files, and the modules around it.
  - **Links and navigation.** Every view has its own URL, so back, forward, reload and "open in a new tab" work, and breadcrumbs plus an "up" link lead back. Zoom with the buttons, the wheel or `+`/`-`. A search box finds files anywhere in the group. Group names in the console's corpus table link to their map.
  - **New endpoints.** `GET /api/module-map/tree`, `/module`, `/file` and `/search`, behind the same optional basic auth.

  The module map itself is now built per project. Before, in a group of several repositories, the thresholds for splitting a module and for shared files came from the whole group, so a small repository next to a large one stayed one undivided module. How specific a name is is now also judged within its own repository. This changes `module_map` output for groups with more than one project.

### Patch Changes

- 180f771: `change_impact` and `module_map` no longer trust names like `create` or `digest` in large codebases. A single lowercase word counted as common only when more than √(files) files used it, so in a large app `create` and `digest` stayed specific: every `Model.create` linked to a controller's `create` action, and `OpenSSL::HMAC.digest` to a model's `digest`. The bar is now a fixed 8 files. A real caller through such a name still shows when its file also uses something specific from the changed file, such as the class name. Ruby conversions (`to_s`, `to_h`) now count as common too: a model that defines `to_s` was listed as shared code called from almost every file.

- 180f771: Line numbers in tool output now count from 1, as editors and `grep -n` do. Chunks store lines from 0, and `search_code`, `get_chunk`, `find_usages`, `change_impact` and the support tools printed the stored values, so every `file:line` pointed one line above the code: a chunk shown as `:30-54` started on line 31. `paparats search` had the same offset. JSON from the HTTP API is unchanged.
- 180f771: The symbol graph behind `find_usages`, `change_impact` and `module_map` missed several common ways code is written:

  - **Ruby class methods.** `def self.overdue` was not a definition, so `Invoice.overdue(...)` linked to nothing and `change_impact` with `symbol: "overdue"` answered that the chunk does not define it. Classes and modules named with a namespace (`class Billing::Invoice`) were not definitions either.
  - **Ruby namespaces.** A module that only wraps classes (`module Billing; class Invoice`) counted as a definition of `Billing` in every file under it, so any `Billing::X` linked to all of them. Such a module now defines nothing.
  - **React components.** `<PriceBadge />` and `<Ui.Button>` in `.tsx`/`.jsx` were not recorded as uses, so a component had no callers. Lowercase HTML tags are not counted.
  - **JavaScript projects.** The JavaScript query named TypeScript-only node types, so it failed to compile and files parsed with the JavaScript grammar got no symbols at all.

  Each code point now stores `symbol_format`, which indexing compares like `embed_format`, so unchanged files are rewritten once with their symbols extracted again (vectors come from the embedding cache). The indexer's reindex epoch is bumped, so the first run after the upgrade does a full pass and rebuilds the edges.
  - @paparats/shared@2.15.0

## 2.14.1

### Patch Changes

- @paparats/shared@2.14.1

## 2.14.0

### Minor Changes

- 4c45dce: Add `module_map` to the coding and support endpoints: a map of a codebase's modules, built from the symbol graph. A module is a set of files that call each other much more than they call the rest. Each module shows:

  - its folder name and size;
  - its main files;
  - which modules it uses and which use it;
  - the tests attached to it.

  Code called from most of the rest is listed apart as shared, migrations are left out, and oversized modules are split again. Links through names used from most files (`get`, `add`) count for little, so they do not glue unrelated files together. The answer ends with a Mermaid diagram of the modules and their dependencies (`diagram: false` turns it off).

  The operator console gets a matching page, `/ui/map`:

  - circles sized by file count, arrows to the modules each one uses;
  - click a module for its files, tests and links;
  - pick a group or project, or find which module a file sits in.

  The page is served from `GET /api/module-map`, behind the same optional basic auth as the rest of the console. Both share one cache per group and project, rebuilt after edges change at most every five minutes.

  The `onboard_to_project` workflow and both modes' instructions now start an unfamiliar codebase with the map. On this repository it finds 10 modules, with 70% of files sitting in their module's main folder.

### Patch Changes

- c6e504c: `change_impact` no longer reports calls such as `set.add(...)` or `map.get(...)` as dependents. The symbol graph links calls to definitions by name, so when one class defines `add`, every `.add(...)` in the codebase used to look like a certain call to it — and the walk then followed their callers too. A name is now treated as common when it is a single lowercase word used from more than √(files) files (at least 8). Callers linked only through such a name are listed apart by file, as probably unrelated, and not followed. The exception is a caller whose file also uses a specific name from the changed file (`new TriggerQueue()` next to `queue.add(...)`): it stays in the main list, marked `[maybe]`. On this repository, the `add` of a small queue class went from 40 reported dependents in 21 files (cut off at the limit) to 7 in 4 files: the class's real users and their callers.
  - @paparats/shared@2.14.0

## 2.13.0

### Minor Changes

- 03127a2: Add `change_impact` to the coding endpoint: given the chunk you are about to change, it lists the code that depends on it — direct callers, their callers up to three steps out, and the tests that reach it — with file:line and chunk ids. Links that go only through a name defined in several places are marked `[maybe]`, widely-called chunks are listed but not followed, and the output says when it stopped early. `symbol` narrows the walk to one name, `whole_file` treats the chunk's whole file as changed. The coding instructions and the `trace_callers` workflow now point to it before signature changes, renames and deletions.

### Patch Changes

- @paparats/shared@2.13.0

## 2.12.1

### Patch Changes

- 3a0dee5: Glossary and architecture tools no longer lose or misreport writes:

  - **A Qdrant failure is reported as a failure.** Before, `arch_list`, `arch_context` and the lookups behind `arch_record_*` read any error as "nothing there". An outage could then look like an empty memory, which invites the agent to record everything again. A failed name lookup also wrote a second copy of a component, and a failed similarity search let a duplicate decision or lesson through. Now only a missing collection counts as empty.
  - **A group-wide `term_record` no longer overwrites a project term of the same name.** Before, it also matched project-scoped terms, so the project term was replaced and lost its project.
  - **An exact glossary lookup finds terms past the first 200.**
  - **`arch_record_decision` with `supersedes` checks the id first.** It must belong to a decision in the group. Before, an unknown id failed only after the new decision was written, so retrying the "failed" call wrote it twice.
  - **`term_delete` says when the id does not exist.** It used to report every id as deleted. `term_list` and `term_search` now show each term's id, so there is an id to pass.
  - **A server scoped with `PAPARATS_PROJECTS` keeps arch and glossary writes and deletes to its projects.** `arch_list`, `arch_context` and `arch_delete` hide cards of other projects; group-wide cards stay visible.
  - **Startup re-embedding (`reindexArch`, `reindexTerms`) no longer drops a collection whose vector size it could not read.**
  - @paparats/shared@2.12.1

## 2.12.0

### Minor Changes

- 3790ccb: Code chunks are embedded with their file path. A method chunk used to be embedded on its own, with nothing saying which file it belongs to; the embedded text is now `Filepath: <path>`, `---` and the chunk. What search returns is unchanged: results still show the plain chunk.

  On the retrieval bench this helps most for questions asked in plain language. On this repository's support-style questions the right file came first for 55% of queries instead of 45% with `search_code`'s ranking, and as often without it. Also adding the enclosing class and module lines won about as many queries as it lost, so the header carries the path only.

  Every file is re-embedded once. Each code point now stores `embed_format`, which the indexer compares like the chunk ranges, so even unchanged files are rewritten, and the indexer's reindex epoch is bumped so the first run after the upgrade does a full pass.

- 436b542: `search_code` ranks files that change often slightly higher. After a project is indexed, each file's number of commits is turned into its percentile within the project and stored on its chunks as `file_churn`; the rank key grows by up to 5% with it. Projects without git history rank as before, and a file indexed on its own between project passes counts as unchanged until the next pass. Only the order changes: the similarity percentage stays the cosine similarity.

  The effect is small: on the retrieval bench it put the right file first for one more query of a hold-out set (58% instead of 55%) and changed nothing on the other query sets.

- 9548792: `search_code` puts the definition first when the query names a class or function. A query like `where is InvoiceTotal computed`, `charge_card retry` or `Billing::Invoice` now also fetches the chunks that define those names, so a definition that dense search left out of its candidates still gets ranked, and moves chunks that define a named identifier (×1.1) and files named after one (×1.05, `invoice_total.rb` for `InvoiceTotal`) up. Queries without code-shaped names are ranked as before. As with the test-file demotion, only the order changes: the similarity percentage and the confidence guidance stay the cosine similarity.

  Together with ordering by how often a file changes (a separate entry in this release), nothing changed on this repository's own bench (82% before and after).

### Patch Changes

- @paparats/shared@2.12.0

## 2.11.3

### Patch Changes

- bbe84cf: The AST chunker now merges adjacent small chunks. Splitting an oversized class or function used to emit every field, statement and closing `}` as its own chunk, so about a quarter of all chunks were a single line. Search filled its result slots with these fragments and, after deduplication, sometimes returned fewer results than requested. Neighbours separated only by blank lines are now joined up to `chunkSize`, and a fragment under 64 characters may join up to `maxChunkSize`.

  On the retrieval benchmark the chunk count drops from 2275 to 1513. File-level MRR@10 goes from 0.767 to 0.825 and chunk-level Recall@5 from 0.702 to 0.789.

  Existing indexes are re-chunked automatically. The indexer's reindex epoch is bumped, so the first run after the upgrade does a full pass. The server re-chunks a file on its next index because the stored chunk ranges no longer match.

- a7ade8b: `search_code` ranks test files below implementation code unless the query asks about tests. A test that names a symbol tends to mention it more often than the code that defines it, so identifier queries returned `symbol-graph.test.ts` above `symbol-graph.ts`. On the retrieval bench this moves file MRR 0.825 → 0.881 and file R@1 0.66 → 0.75 with no query worse. Only the order changes: the similarity percentage and the confidence guidance still use the cosine similarity, and the guidance now reads the best similarity in the results rather than the first one.
- f8e5526: `search_code` no longer expands the query into abbreviation, case and plural variants. On the retrieval bench the variants added no quality there (file MRR unchanged, chunk R@10 +0.003) while costing up to three embedding calls and three Qdrant queries per search; `search_code` now answers in about half the time (bench p50 90 → 48 ms). The support-mode `explain_feature` and `impact_analysis` keep query expansion, since their natural-language questions were not measured.
  - @paparats/shared@2.11.3

## 2.11.2

### Patch Changes

- c90e055: `health_check` now says when Qdrant cannot be reached, with the reason (`ECONNREFUSED`, `ENOTFOUND`, ...) and the setting to check, instead of returning Node's bare `fetch failed`.
- 3803ce2: The support endpoint (`/support/mcp`) is read-only again: `term_record` is no longer registered there. Support instructions now tell the agent to pass a new or corrected glossary definition to an engineer, who records it from the coding endpoint, and `term_search` stops suggesting `term_record` where it is unavailable. A test now fails if any support tool is not annotated read-only.
  - @paparats/shared@2.11.2

## 2.11.1

### Patch Changes

- @paparats/shared@2.11.1

## 2.11.0

### Minor Changes

- 8cefe58: Add an offline retrieval benchmark (Recall@k, MRR, nDCG) with a labelled query set over the paparats repository.

### Patch Changes

- @paparats/shared@2.11.0

## 2.10.0

### Minor Changes

- 3ab36ab: Add a stdio transport: `node packages/server/dist/index.js --stdio` serves the coding endpoint over stdin/stdout instead of HTTP, for MCP clients and registry inspectors that spawn the server. Logging moves to stderr in this mode and the process exits when the client closes stdin.

### Patch Changes

- ed3f624: Remove the server's unused file watcher (never started since content-based indexing); index freshness comes from the indexer's change detection.

  - `GET /api/stats` no longer returns a `watcher` field (it was always an empty object), and `paparats groups --verbose` no longer prints "File changes processed".
  - The `paparats_watcher_events_total` Prometheus metric and its Grafana panel are gone; the metric never incremented.
  - `ProjectWatcher`, `WatcherManager`, their types and `WatcherConfig` are no longer exported from `@paparats/server`, and `ProjectConfig` has no `watcher` field. The server drops its `chokidar` dependency.
  - A `watcher:` section in `.paparats.yml` is now ignored rather than validated, so existing configs keep loading.
  - @paparats/shared@2.10.0

## 2.9.1

### Patch Changes

- 94bcbe6: Update dependencies and close the open security advisories (body-parser,
  undici, zod, fast-uri, ip-address, vite). OpenTelemetry moves to 3.0: the
  deprecated `@opentelemetry/sdk-trace-node` is replaced by
  `@opentelemetry/sdk-trace`. Also updates p-queue 10 and the
  Qdrant client 1.20, and drops chokidar from the CLI, which never used it.
- Updated dependencies [94bcbe6]
  - @paparats/shared@2.9.1

## 2.9.0

### Minor Changes

- 0dcd070: Add a docs-only knowledge MCP endpoint for external agents, audience labels at index time, and `get_document`

  A service in another network — an agent backend behind a load balancer — can now search curated documentation without reaching anything else on the server.

  **Knowledge endpoint (`/knowledge/mcp`)**

  - Opt-in: set `PAPARATS_KNOWLEDGE_TOKENS` (comma-separated bearer tokens, at least 16 characters each) and `PAPARATS_KNOWLEDGE_AUDIENCE` (the labels it may serve). Optional `PAPARATS_KNOWLEDGE_PROJECTS` restricts it to some projects — recommended, so a stray `audience:` in a code repository's README cannot widen what it serves. With neither variable set the route does not exist; with only one, or a value that is empty after trimming, the server refuses to start. `internal` is refused as a label for this endpoint.
  - Serves `search_docs` and `get_document` only: no code search, glossary, project listing, health, analytics, resources or workflow prompts. Its own system instructions tell the agent to cite source links, fetch whole documents when an excerpt is not enough, report an empty result as "not documented", and never treat the docs as a source of numbers or live data.
  - Every request needs `Authorization: Bearer <token>`, compared in constant time and checked before the body is read (`401` with `WWW-Authenticate: Bearer` otherwise). The route has a 64 kB body limit and a 1000-character query cap.
  - Stateless Streamable HTTP: a fresh server and transport per `POST`, no session id, `GET` and `DELETE` answer `405` — a load balancer needs no sticky sessions or idle-timeout tuning.
  - Its audience ceiling and project allowlist apply to it alone and are narrowed further by `PAPARATS_DOCS_AUDIENCE` / `PAPARATS_PROJECTS` when set. A document outside them reads exactly like a missing one, and backend failures are reported without internal details.
  - `search_docs` there returns `structuredContent` (title, heading path, source URL, project, file, excerpt, included and total sections, last modified, score) with an `outputSchema`, so a wrapping service can build citations without parsing markdown.
  - Tool calls are recorded with their endpoint in analytics (`tool_calls.mode`, added by a schema migration) and OpenTelemetry (`paparats.mcp_mode`), attributed to a forwarded `X-Paparats-User` header.

  **Audience labels at index time**

  - Documents get an audience label when they are indexed: frontmatter `audience:` first, then `docs.audience` from `.paparats.yml` or `projects.yml` (per repo or under `defaults`, merged like `docs.kind`), otherwise `internal` as before.
  - Labels must match `^[a-z0-9][a-z0-9_-]{0,63}$`. An invalid label in a config file stops it from loading; an invalid or non-scalar frontmatter value is logged and that document is stored as `internal`, never as the possibly wider project default.
  - Every indexing run rewrites every document, so a changed label takes effect on the next run without a migration.

  **`get_document`**

  - Returns a whole document rebuilt from its stored sections, in order and without the breadcrumb added for embedding, paged at about 40,000 characters (`from_section` continues). Keyed by project and file, which survive re-indexing.
  - Available on the knowledge and support endpoints; support's `search_docs` excerpts now point at it, since support users cannot open files. The coding endpoint is unchanged.

### Patch Changes

- Updated dependencies [0dcd070]
  - @paparats/shared@2.9.0

## 2.8.0

### Minor Changes

- d29c2fa: Stop serving data whose source is gone, harden the server against cross-site use, and update dependencies

  An audit of the indexing lifecycle found several ways the index drifted from the source it describes, plus gaps in the request-facing surface. This release fixes them and closes 20 of 22 dependency advisories (the remaining two reach only the release tooling and have no patched version).

  **Index no longer keeps what was removed**

  - Documents whose markdown file was deleted, renamed, excluded or stopped being markdown are removed on the next index; previously they stayed searchable through `search_docs` indefinitely.
  - A source file that is emptied, turns binary or becomes minified has its old chunks removed instead of keeping them.
  - Repos removed from `projects.yml` are purged (code, metadata, docs) on hot reload, and a repo that moves to another group or name is purged from the old one.
  - `delete_project` and `DELETE /api/project` now also remove the project's docs, and report a failure instead of success when Qdrant could not be reached.

  **Index stays correct under failure**

  - A file whose re-embedding fails keeps its previously indexed version instead of disappearing until the next full cycle; the same holds for documents. Change detection no longer records a repo as indexed when any file failed.
  - A failed read of a file's stored state no longer writes a second copy of its chunks, and files that were already duplicated are healed.
  - Files whose chunks only moved are re-indexed, so line numbers and chunk ids stay correct; changes to `service`/`tags` now reach unchanged files.
  - The symbol graph is rebuilt when a project has none, so a failed rebuild no longer leaves `find_usages` empty until some file changes.
  - Model self-heal for docs and the glossary embeds everything before dropping a collection, so an embed server that is not up yet at boot no longer loses the glossary.
  - Git history is attributed to the right chunk (hunks were compared 1-based against 0-based chunk lines).

  **Long lines and large inputs**

  - No chunk exceeds `maxChunkSize` any more: long single lines are cut, and long comment runs are split.
  - When the embed server rejects an input as too large for its batch, only that input is shortened; the rest of the batch embeds normally instead of the whole file failing on every run.

  **Security**

  - CORS is no longer open to every origin. Cross-origin browser requests are refused unless their origin is listed in the new `PAPARATS_CORS_ORIGINS` (comma-separated exact origins). Non-browser clients and the bundled dashboard are unaffected.
  - Files reached through a symlink out of the repository or into `.git` are never indexed, and `indexing.paths` rejects glob metacharacters and symlinked directories that leave the project.
  - `PAPARATS_PROJECTS` now scopes every tool, not only code search: chunk lookups, `search_docs`, the glossary, `list_projects`, `delete_project` and the graph tools.
  - A malformed `PAPARATS_UI_BASIC_AUTH` now stops startup instead of silently disabling auth.
  - MCP sessions are closed when they expire, capped at 1000, and recreated only for well-formed ids.
  - CLI-written secrets (`.env`, `install.json`) are created with mode 0600.

  **Other fixes**

  - Exclude patterns with a `/` (`spec/fixtures`, `vendor/`) and file globs (`*.class`, `Cargo.lock`) now exclude what they name; previously they matched nothing, so expect those files to leave the index.
  - Group names ending in `_arch`, `_docs` or `_terms` are rejected: their code collection collided with another group's sidecar, which the startup self-heal could drop. Groups named `docs`, `arch` or `terms` now appear in code search.
  - `projects.yml` overrides on a repo with its own `.paparats.yml` are applied the same way as without one (excludes normalized, `paths` honoured, `PAPARATS_GROUP` wins).
  - Docs in a markdown-only repository are now classified as prose, so they get the intended relevance floor instead of the stricter one for docs beside code.
  - Voyage queries are embedded as queries; identical code in two files is no longer collapsed into one search result; the embedding cache ignores vectors of the wrong dimension.
  - Indexer: crons start even when the initial project list is empty; the same repo is never indexed twice at once; `/trigger` requests during a cycle are queued instead of dropped; clones recover from token rotation, force-pushes and default-branch changes.
  - CLI: model downloads fail loudly and are verified before use; compose regeneration backs up a hand-edited file; `paparats add` rejects non-GitHub URLs; support mode configures Claude Code through `claude mcp add`.

  **Dependencies**

  simple-git 4, better-sqlite3 13 (prebuilt Node-API binaries), TypeScript 6, vitest 5, `@qdrant/js-client-rest` 1.19 (`search()` → `query()`), and `prom-client` replaced by its successor `@prometheus-io/client`.

### Patch Changes

- Updated dependencies [d29c2fa]
  - @paparats/shared@2.8.0

## 2.7.0

### Minor Changes

- d11a416: Rebuild the analytics dashboard around usage, and fix the docs source links

  The dashboard could not answer whether paparats was being used or for what. It now
  opens with a plain-language summary — questions answered, people asking, typical
  answer time, how much came from documentation, and what is searchable — stated
  without reference to chunks, collections or groups. Below it, per-tool usage shows
  which tools people reach for, with code search visible separately from documentation
  search. Collection sizes per group move to a collapsed section at the bottom and cap
  the row count, so an install with hundreds of projects does not render a list nobody
  scrolls.

  Fixes the data those tiles need, none of which was being recorded:

  - **`tool_calls` was never written.** The telemetry wrapper is installed by patching
    the tool-registration method, and registration had moved to `registerTool`, which
    was not patched. Both methods are patched now, and a test drives a real
    `tools/call` to assert the event is recorded.
  - **`search_events.tool` held Searcher method names**, so `search_code`,
    `explain_feature` and `impact_analysis` collapsed into one `expandedSearch`
    bucket. Search calls now carry the originating MCP tool name.
  - **The indexer container ran without telemetry**, leaving the `files` table empty.
    It now shares the server's analytics DB (already the same mounted volume).

  Token savings no longer reports a constant 80%. The baseline substituted
  `chunk_lines * 5` for an unknown file size, which reduces to `1 - 1/5` regardless
  of the data. Savings are now computed only over results whose file size is known,
  and the response reports that coverage so a partially-measured window is visible
  instead of implied.

  Documentation search results were missing their source link. Markdown frontmatter
  was not parsed at all, so `source_url` was stored as `null` for every chunk, the
  title fell back to the filename, and the modification date fell back to the file's
  mtime — which in a mirrored repo is the clone time. Frontmatter is now parsed for
  the link, title and date, and stripped from the content, so a document's YAML block
  is no longer embedded as prose. Existing documents pick this up on re-index.

  The project count in the overview is now taken from the registered project map
  rather than approximated from the indexer's repo list.

### Patch Changes

- Updated dependencies [d11a416]
  - @paparats/shared@2.7.0

## 2.6.2

### Patch Changes

- 412eaca: Advertise MCP `ToolAnnotations` and a display `title` on all 29 tools, and register them through `registerTool`.

  Clients can now tell a query apart from a write before calling it, and show a human-readable
  name instead of the raw tool id. Registration moves from `server.tool()` — every overload of
  which the SDK marks `@deprecated` — to `server.registerTool()`, matching the `registerPrompt`
  call already in this file.

  Annotations follow the current protocol revision (2026-07-28) rather than stating every field
  everywhere. The spec's defaults are deliberately pessimistic (`readOnlyHint: false`,
  `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`), so only the
  reassuring values carry information; and `destructiveHint`/`idempotentHint` are "meaningful
  only when `readOnlyHint == false`", so they are absent from read-only tools:

  - **22 read-only tools** — `readOnlyHint: true`, `openWorldHint: false`. All search, chunk,
    arch-read, glossary-read, docs and telemetry-report tools.
  - **`arch_record_component`, `arch_record_lesson`, `term_record`** — additive and idempotent:
    each is keyed by name and overwrites in place, so a repeat call leaves the store as it was.
  - **`arch_record_decision`** — additive, but makes no idempotency claim: it mints a fresh id
    per call and guards duplicates behind a similarity threshold, which is not a guarantee.
  - **`delete_project`, `arch_delete`, `term_delete`** — not read-only, idempotent (a second
    delete finds nothing left). `destructiveHint` is left at its default `true`.

  `openWorldHint: false` throughout: every tool reaches only this server's own Qdrant collections
  and SQLite stores — the spec's "memory tool", not its "web search". Classification follows the
  handlers rather than the tool names: the seven non-read-only tools are exactly those reaching a
  mutating store call (`deleteProjectChunks`/`deleteByProject`, `upsertComponent`,
  `upsertDecision`, `upsertLesson`, `deletePoints`, `recordTerm`, `deleteTerm`). Telemetry
  counters are not treated as state changes.

  Titles live next to their descriptions in `prompts.json`; the repeated inline
  `{ description: string }` in the `Prompts` interface is now a named `ToolPrompt`.

  Seven tests drive a real `tools/list` over HTTP in both coding and support mode and assert the
  annotations on the wire, including a guard that no tool ships without annotations or a title —
  an unannotated tool would silently inherit the pessimistic defaults.

  Note for Claude Code specifically: this does **not** suppress plan-mode permission prompts.
  Claude Code evaluates MCP tools uniformly there and does not consult `readOnlyHint`
  (anthropics/claude-code#12368, closed as not planned). Suppressing those prompts requires a
  client-side `PreToolUse` hook. The annotations are correct protocol metadata that other MCP
  clients act on.

- Updated dependencies [412eaca]
  - @paparats/shared@2.6.2

## 2.6.1

### Patch Changes

- 95449c2: Clear all 20 open Dependabot security advisories and refresh dependencies.

  Seven transitive packages carried advisories, all reachable only through
  dependencies we do not call directly. Bumped past each advisory's fix boundary
  via the root `resolutions` block: `fast-uri` 3.1.2→3.1.7 (three host-confusion
  bypasses), `hono` 4.12.28→4.13.5 (CORS ReDoS, `memo()` cross-user SSR leak,
  language-middleware DoS, proxy header leak), `ip-address` 10.2.0→10.7.0 (three
  SSRF / trust-boundary bypasses), `postcss` 8.5.15→8.5.26 (sourceMappingURL path
  traversal plus its incomplete fix), `undici` 6.27.0→6.28.0 (response
  desync, CRLF injection, cookie attribute injection), and `nanoid` 3.3.12→3.3.18
  (two infinite-loop DoS paths), newly pinned since it enters only under `postcss`.

  `js-yaml` needed three separate pins because three majors coexist in the tree:
  3.15.2 and 4.3.2 via resolutions for the transitive copies under
  `read-yaml-file` and `@changesets/parse`, and a direct bump to ^5.4.1 in
  `server`, `cli` and `indexer` for the flow-collection parsing DoS. We parse
  untrusted-ish YAML in `.paparats.yml` and `projects.yml`, so this one is on a
  path we actually execute.

  Also refreshed in-range direct dependencies (`@types/node`, `vitest`, `eslint`,
  `prettier`, `typescript-eslint`, `vite`, `zod`, `@modelcontextprotocol/sdk`,
  `@inquirer/prompts`, the OpenTelemetry set and others). `yarn npm audit` now
  reports zero advisories; the two remaining notices are deprecations, not
  vulnerabilities.

  `@qdrant/js-client-rest` is now pinned to an exact `1.18.0`. 1.19.0 removes the
  `search()` method in a minor release, which fails typecheck at six call sites in
  `searcher.ts`, `arch/store.ts` and `terminology/store.ts`; migrating to `query()`
  also changes the return shape from a bare array to `{ points: [...] }`. The exact
  pin stops a caret range from pulling that breaking release in unnoticed. No
  advisory affects 1.18.0, so this is deferred rather than urgent — the `query()`
  migration wants its own change.

- Updated dependencies [95449c2]
  - @paparats/shared@2.6.1

## 2.6.0

### Minor Changes

- 33c56bf: Make the architectural memory layer coding-only, in both directions.

  Support mode no longer gets any `arch_*` tool — reads included. Arch cards state why
  the code is shaped the way it is, a claim only verifiable against the code itself.
  Reading the layer from a seat that cannot check it invites quoting a rationale as fact;
  writing it invites recording an inference drawn from search results. Support mode drops
  from 26 tools to 20, and the `audit_architecture` workflow is no longer offered there
  (every step of it calls a tool support does not have).

  The glossary keeps its support write path. A definition is a fact about vocabulary,
  checkable by whoever supplied it, and support meets undocumented shorthand first.
  `term_delete` remains coding-only.

  `supportInstructions` loses its architectural-memory section and gains an explicit
  route for "why is it built this way": report what the code does and what changed, then
  say the intent needs an engineer. Without a stated destination the model fills the gap
  by inferring intent from search results and presenting it as the reason.

### Patch Changes

- @paparats/shared@2.6.0

## 2.5.0

### Minor Changes

- 15f7f01: Give support mode write access to the knowledge layers, and document the docs and glossary layers in both modes' server instructions.

  `search_docs`, `term_search` and `term_record` were registered as tools but never mentioned in either instruction set, so an MCP client without our plugin hooks received them with no guidance on when to call them. Both modes now document what each layer holds, how to read the `exact match` vs `similar` label, and that documentation hits are excerpts rather than whole pages.

  Support mode gains `arch_record_component`, `arch_record_decision`, `arch_record_lesson`, `arch_list`, `arch_suggest_components` and `term_record`. Support is usually first to learn a non-obvious constraint — from an incident, an escalation, or customer vocabulary — and previously could not record it. The boundary is now reversibility rather than role: additive writes pass a similarity gate, while the destructive tools (`arch_delete`, `term_delete`, `delete_project`) remain coding-only.

  Both modes are also told that coverage differs per layer: only code is densely indexed, so a miss on docs, glossary or arch memory means "not recorded yet" rather than "does not exist".

### Patch Changes

- @paparats/shared@2.5.0

## 2.4.6

### Patch Changes

- 4df4382: Fix `term_search` returning an unrelated entry for a bare acronym, and never reporting "not found".

  Glossary lookups now match canonical names and aliases exactly (case- and space-insensitive) before falling back to vector search, and the fallback applies a relevance floor. A bare acronym is the commonest glossary query and the one the embedder handles worst — measured on a 75-term glossary, one acronym ranked its own entry 21st while an unrelated metric took the top slot. Canonical names take priority over aliases, and an alias shared by several terms returns all of them.

- ce9540d: Instruct the glossary query vector and recalibrate both relevance floors.

  Glossary vector search embedded the query without the model's retrieval instruction. qwen3 pools on the last token, so that instruction is part of its trained query interface — applying it moved top-1 accuracy on paraphrase lookups from 61% to 91%, and put the right term in the top 8 for every query tested. Stored entries are unprefixed, so no re-index is needed.

  Both floors were re-swept against the new score distribution: the direct `term_search` floor drops to 0.55 (keeping 16 more correct answers at no cost in false positives) and the docs sidecar floor to 0.50 (answering every direct term question instead of 6 in 10).
  - @paparats/shared@2.4.6

## 2.4.5

### Patch Changes

- 31c6986: fix(terminology): recalibrate both glossary thresholds against a populated glossary

  Both similarity floors in the glossary path were calibrated when the store held a
  handful of terms. Neither survived a real vocabulary, and each failed in the
  direction that costs the caller something.

  **The write gate refused legitimate terms.** Importing a 53-entry glossary into a
  store that already held 26 terms, the 0.72 floor rejected 19 of the 53 as
  near-duplicates. Only 3 were genuine — a canonical name colliding with an existing
  alias, which name idempotency already handles. The other 16 (84%) were distinct
  concepts, spread across 0.724–0.889: among them a campaign-strategy template blocked
  against a publisher-side bidding mode, a volume metric against a scoring subsystem,
  and two separate cost metrics from the same family.

  The cause is structural, not a bad number: glossary entries share their phrasing and
  their domain, so cosine between rendered entries tracks the _genre_ of the text more
  than which term it defines — and it gets worse as the glossary grows, because more
  legitimate neighbours crowd the top of the range. The floor is now 0.95, catching
  only near-verbatim restatements. Detecting reworded duplicates is given up on
  deliberately: losing a real term is worse than admitting a near-duplicate an author
  can merge.

  **The sidecar floor attached definitions to almost everything.** `GLOSSARY_MIN_SCORE`
  is applied per candidate term, so the chance that _some_ entry clears it rises with
  vocabulary size. At 0.55 — calibrated when the store held one term — it attached to
  5/102 answerable queries then, and to 85/102 plus 5/30 absent-topic queries once the
  glossary reached 75 terms.

  Re-measured at 75 terms over 102 answerable queries, 30 verified absent-topic ones,
  and 10 probes phrased directly about a term:

  | floor | term shown for a probe | answerable | absent-topic |
  | ----- | ---------------------- | ---------- | ------------ |
  | 0.55  | 10/10                  | 85/102     | 5/30         |
  | 0.60  | 8/10                   | 67/102     | 2/30         |
  | 0.65  | 8/10                   | 43/102     | 0/30         |
  | 0.70  | 6/10                   | 27/102     | 0/30         |

  0.65 is the lowest floor that never fires on an absent topic (those topped out at
  0.645) while still surfacing the term for 8 of 10 direct questions.

  Retrieval quality is unaffected by glossary size either way — precision@1 held at
  85–87% and recall@5 at 97% from 1 term to 78 — because matched terms are reported
  beside the results rather than folded into the query.
  - @paparats/shared@2.4.5

## 2.4.4

### Patch Changes

- 37ec36d: fix(terminology): recalibrate the similarity gate for the text embedding model

  The duplicate/similar bands (0.85 / 0.70) were inherited from the arch layer, where
  they were calibrated against a different embedding model, and were never re-tuned for
  the one the terminology layer actually uses. The lower band landed _inside_ the range
  that genuinely distinct terms occupy, so the gate refused legitimate writes: while
  seeding one real glossary, three separate cost-metric and integration terms were each
  rejected as a near-duplicate of an unrelated term, scoring 0.702–0.709.

  Measured against a real 27-term glossary — all 351 distinct pairs, plus 7 hand-written
  restatements of existing entries:

  |                    | range        |
  | ------------------ | ------------ |
  | genuine duplicates | 0.739 upward |
  | distinct terms     | up to 0.709  |

  The bands are adjacent rather than separated, only ~0.03 apart, because glossary
  entries share heavy structural boilerplate ("Cost Per X — spend divided by Y") — so a
  whole family of real, different metrics sits just below the duplicate band.

  The gate is now a single threshold at 0.72, the widest gap between the two measured
  bands: it catches 7/7 duplicate probes with 0/351 false blocks. The second "similar"
  tier is gone — with a 0.03 window there is nowhere to put it, since any value low
  enough to mean "similar" already blocks legitimate writes. `TermWriteStatus` keeps
  `'similar'` for wire compatibility but nothing produces it.

  The margin is thin on both sides, so the calibration is worth repeating once the
  glossary grows substantially.
  - @paparats/shared@2.4.4

## 2.4.3

### Patch Changes

- 9138675: fix(docs): apply the embedding model's query instruction in docs search

  `DocsStore.search` embedded queries with the provider's bare `embed()` instead of
  `embedQuery()`, so the instruction prefix the text model was trained to expect was
  never applied. The code layer already used `embedQuery()`/`embedBatchPassage()`
  correctly — only the docs layer bypassed them.

  This matters because the text model is a decoder with last-token pooling: the
  instruction is part of its trained query interface, not decoration. Bare queries
  land in a different region of the vector space than the instruction-conditioned
  one the relevance floors were calibrated against, so the floors were being applied
  to the wrong distribution.

  Measured on one deployment over 102 answerable and 30 verified absent-topic
  queries:

  |                          | precision@1 | recall@5 | absent topics leaking |
  | ------------------------ | ----------- | -------- | --------------------- |
  | bare query (before)      | 74.5%       | 98.0%    | 28/30                 |
  | instructed query (after) | 87.3%       | 97.1%    | 5/30                  |

  Documents are deliberately still embedded unprefixed — instruction-tuned families
  instruct queries only (see `prefixPassage`), so no re-indexing is required.

  Also adds the prefix-aware methods to the docs test provider fake, which lacked
  them and therefore could not distinguish the two paths, and corrects a stale
  ranking-accuracy comment in the `search_docs` tool.

- 81c2bf8: fix(docs): report glossary terms beside search results instead of inside the query

  `search_docs` folded matched glossary definitions into the query text before
  embedding it. That pastes corpus wording into the question and pulls the vector
  toward whichever documents the terms came from, so results reflected the glossary
  rather than the question.

  Measured over 102 answerable and 30 verified absent-topic queries, with a glossary
  containing a single term:

  |                               | precision@1 | recall@5 | absent topics leaking |
  | ----------------------------- | ----------- | -------- | --------------------- |
  | definition inside the query   | 6.9%        | 22.5%    | 27/30                 |
  | definition beside the results | 86.3%       | 97.1%    | 5/30                  |

  Two narrower fixes were measured and rejected: judging the relevance floor against
  the original question (14.7% precision@1) and requiring a minimum score before
  expanding (48.0%). Both leave the enriched vector driving retrieval.

  Matched terms now render as a labelled section above the excerpts — context rather
  than an answer, since a term can match a question it does not resolve — and are
  also returned when nothing matched, where they often explain the vocabulary
  mismatch. `GLOSSARY_MIN_SCORE` (0.55) gates which terms appear: term search returns
  the nearest entries regardless of distance, so ungated it attached a definition to
  132/132 queries, none of them on-topic.

  fix(terminology): stop reporting store failures as an empty glossary

  Four read paths in `TerminologyStore` caught every error and returned an empty
  result, making "no terms recorded" indistinguishable from "the store could not be
  reached". Only a missing collection is genuinely empty.

  - `search()` — query enrichment silently stopped matching terms
  - `list()` — `term_list` reported an empty glossary, inviting an agent to
    re-record terms that already existed
  - `findByTerm()` — `recordTerm` read the null as "no such term yet" and minted a
    fresh id, writing a duplicate and resetting the term's `createdAt`
  - `findNearest()` — the duplicate/similar write gate silently stopped gating

  A missing collection is now distinguished by status code and still reads as empty;
  everything else propagates. `deleteTerm` is unchanged — its `false` return already
  surfaces the failure.
  - @paparats/shared@2.4.3

## 2.4.2

### Patch Changes

- 2f63499: Fix docs search returning confident matches for undocumented topics when BM25 statistics are missing.

  Corpus statistics are written by whoever indexes, so a search-only process (the MCP server, whenever indexing runs in a separate container) started with an empty store that nothing ever filled. With no statistics every term looked equally rare, so the keyword half of hybrid search stopped ranking and degenerated into "match any of these words" — which favours overview files like README and CLAUDE.md, because they mention many topics in passing. Those then dominated the fused ranking and the semantic half was effectively ignored.

  The query builder now returns an empty sparse vector when the corpus is empty, so search ranks on semantics alone rather than on a meaningless keyword vector. The server also rebuilds missing statistics from the chunks already indexed on startup, restoring the keyword half instead of leaving search permanently dense-only. Indexing behaviour is unchanged.

- Updated dependencies [2f63499]
  - @paparats/shared@2.4.2

## 2.4.1

### Patch Changes

- 71caa4a: `projects.yml` now accepts a per-repo `docs.kind` override for the docs relevance floor.

  Auto-detection classifies a repo's markdown by whether the repo contains code, which misreads a documentation repository that also ships its own tooling: the tooling makes it look like `code`, so long-form prose gets held to the stricter floor intended for READMEs. `.paparats.yml` already accepted `docs.kind`, but the indexer configures repos through `projects.yml`, leaving the escape hatch unreachable for exactly the deployments that need it.

  ```yaml
  repos:
    - url: org/handbook
      docs:
        kind: prose
  ```

  Works in the `defaults` block as well as per repo.

- Updated dependencies [71caa4a]
  - @paparats/shared@2.4.1

## 2.4.0

### Minor Changes

- 004f873: Docs search now applies a separate relevance floor to markdown that ships inside code repositories, and reports how old a document is.

  Overview-style files (README, CLAUDE.md, design notes) mention many topics in passing, so they score deceptively well against questions they do not answer. A single floor could not separate them: measured over 102 answerable and 30 absent-topic queries, one floor either let half the absent topics through or cost 11 points of precision@1. Per-kind floors (prose 0.45, code 0.60) blocked 29/30 absent topics without losing a single real answer. Classification is automatic — a repo with no detected code languages is prose — and overridable via `docs.kind` in `.paparats.yml`. `search_docs` gains `min_score_code`.

  Results also carry a `Last updated ... ago` line for documents untouched for over a year, so a stale page can be discounted instead of quoted as current. Age is disclosed only, never used for ranking.

### Patch Changes

- Updated dependencies [004f873]
  - @paparats/shared@2.4.0

## 2.3.2

### Patch Changes

- 0a42522: fix(docs): filter docs search by a semantic relevance floor

  `search_docs` answered questions the corpus does not cover with a confident,
  unrelated page. Asked about a topic absent from the corpus, it returned an
  unrelated page that merely shared one common word, at the maximum score of 1.000.

  The cause is that the returned score is RRF (`1/(k+rank)`), a function of position
  alone: whatever ranks first scores high, even when nothing relevant matched. Over
  a 41-query set, topics deliberately absent from the corpus produced RRF scores of
  0.500/0.700/1.000 — indistinguishable from real answers (0.500–1.000), so no
  threshold on that score can exist.

  The dense cosine does separate them: absent topics peaked at 0.410 while real
  answers ran from 0.474 up. Hits below `minCosine` (default 0.45, in the empty band
  between the two) are now dropped, while ranking stays on RRF — which measured
  better on precision@1 than ranking by cosine (100% vs 94% on the first query set),
  so it is kept as the ranker and the cosine is used only as a filter.

  Exposed as `min_score` on the MCP tool; pass 0 to disable. The gate fails open on
  a rescore error, since an empty result set is indistinguishable from "not
  documented" — the very confusion this prevents.

  Measured on the full 41-query set: absent-topic answers 3/3 → 0/3, with
  precision@1 (87%) and recall@5 (97%) unchanged and no real answer lost.

- ccef033: feat(docs): tell the caller when a docs hit is only an excerpt

  A `search_docs` hit is the best-matching chunk plus its immediate neighbours, not
  the whole document — but nothing said so. Measured over one corpus, a hit is a
  median of 60% of its document and as little as 17% for the largest ones; only 25%
  of documents fit entirely in one hit.

  That gap is easy to misread. An agent can take an excerpt as the document's full
  position and conclude it says nothing about a detail that lives in a section never
  returned.

  Hits now carry `docChunkCount` and `includedChunks`, and the MCP tool renders a
  line naming what was left out:

  ```
  Excerpt: sections 31-33 of 65 — read `docs/general/.../big.md` for the rest
  (this passage may not be the document's full answer).
  ```

  Silent when the excerpt IS the whole document, and silent when the count is
  unknown — an invented "0 of 0" would be worse than saying nothing. The count is
  best-effort: a failure leaves it unset rather than failing the search.

  Also states in the result footer, and in the tool description, that the top hit is
  not always the right one and the alternatives are worth scanning. On a 112-query
  measured set the top hit is correct 89% of the time while the right document is in
  the top 3 for 96% — so stopping at the first result loses answers that were
  retrieved.
  - @paparats/shared@2.3.2

## 2.3.1

### Patch Changes

- 032c6b8: fix(docs): elide embedded binary payloads before chunking markdown

  Documentation often embeds base64 — an API example carrying a file upload, an
  inline `data:` image, a certificate. Such a run has no natural language to match
  a query, yet it dominated its chunk's embedding and crowded the page's real prose
  out of the index.

  It could not be fixed downstream either: a payload is typically a single line,
  and the oversized-block fallback splits by lines, so it had nothing to cut. A
  single 16,898-character line produced one ~4225-token chunk.

  Long runs over the base64/base64url/hex alphabet are now replaced with a short
  `[binary data elided, N chars]` placeholder before sectioning. The replacement
  contains no newline, so reported chunk line numbers still match the source.

  Also bounds the remaining case the by-line split could not handle: a single line
  longer than `maxTokens` (a one-line table, a minified asset) is now split on
  character count, preferring a whitespace boundary.

  Measured over a markdown corpus: largest chunk 4225 → 706 tokens, chunks over
  1024 tokens 1 → 0, with p50/p95 chunk size unchanged (405/1331 chars) — only the
  degenerate chunk is affected.
  - @paparats/shared@2.3.1

## 2.3.0

### Minor Changes

- 06ab265: Add an `audience` visibility primitive to the docs layer, so a single index can hold documents of mixed sensitivity (e.g. internal vs client-facing) and searches can be constrained by visibility — with a fail-closed, server-enforced ceiling for client-facing deployments.

  - **Payload + types.** Docs chunks now carry an `audience` label (free-form string; the core stores and filters on it but prescribes no taxonomy — the indexer decides its meaning). A chunk with no stored audience reads back as `internal` (`DEFAULT_AUDIENCE`) — un-labelled docs never leak to a narrower audience by default. New `audience` payload index on the docs collection.
  - **Search filter.** `DocsStore.search` accepts `audience?: string | string[]` (match-any). A chunk with no `audience` field does not match an explicit filter, so e.g. `audience: ['client']` never surfaces un-labelled (internal) docs. `search_docs` gains an optional `audience` parameter.
  - **Server-enforced ceiling.** `PAPARATS_DOCS_AUDIENCE` (comma-separated) sets a hard audience ceiling for the whole server, threaded through `createApp` → `McpHandler`. A request's own `audience` is intersected with the ceiling (`applyAudienceScope`) — it can only narrow within it, never widen past it; a disjoint request returns no results rather than silently widening. This is the mechanism a future client-facing endpoint uses to make internal docs physically unreachable, not merely filtered.

  Additive and backward-compatible in code. Note: existing docs chunks indexed before this change have no `audience` field and thus read back as `internal` and are excluded by any explicit `audience` filter — re-index the docs layer to populate the field.

### Patch Changes

- @paparats/shared@2.3.0

## 2.2.0

### Minor Changes

- 9588d46: Harden indexing against non-source content and embed-server memory blow-ups.

  - **Skip machine-generated / non-source content** — files with a source-file
    extension but no source structure (base64 asset blobs, minified bundles, e.g.
    `convex/export/pptx/assets/*.data.ts`) were being fed to the embedder as a
    single multi-hundred-KB token wall, driving `llama-server` into 502s, 240s
    timeouts, and OOM — indexing stalled at `0 chunks`. A new structural detector
    (`detectNonSource` in `@paparats/shared`) judges content by line length,
    whitespace ratio, and base64-alphabet dominance (name-independent). The indexer
    skips such files before chunking and drops individual non-source chunks before
    embedding, with telemetry. Known classes (`*.min.js`, `*.bundle.js`,
    `*.data.ts`, …) are also added to the default TypeScript/JavaScript excludes.
  - **Embed server memory** — the `paparats-embed` image now sizes the per-model
    llama-server compute buffer via `LLAMA_BATCH` (default 2048, was a hardcoded
    8192 that caused cgroup OOM with two resident models) and exposes
    `LLAMA_THREADS`. The compose generator wires both through and sets an explicit
    memory/CPU limit on the embed service (`EMBED_MEMORY`/`EMBED_CPUS`).

### Patch Changes

- Updated dependencies [9588d46]
  - @paparats/shared@2.2.0

## 2.1.1

### Patch Changes

- 977f854: fix(indexer): exclude docs and terminology sidecar collections from listGroups

  `listGroups()` only filtered out `_arch` collections, so `paparats_<group>_docs`
  and `paparats_<group>_terms` surfaced as phantom code groups. search_code without
  an explicit group fanned out into them and Qdrant rejected the unnamed-vector
  query with "Not existing vector name" (Bad Request). The same leak let
  stale-group cleanup probe docs/terms collections and potentially evict a
  project's docs chunks during re-indexing.

- Updated dependencies [977f854]
  - @paparats/shared@2.1.1

## 2.1.0

### Minor Changes

- 9e29d00: Add a markdown documentation search layer, hybrid retrieval, and an agent-authored glossary.

  - **Docs layer** — index long-form markdown (Confluence exports, RFCs, runbooks) into a
    separate per-group Qdrant collection embedded with qwen3. A structural chunker splits by
    heading, sub-splits oversized sections (~320 tokens, overlap 0), and prepends the heading
    breadcrumb to each chunk. Strict markdown detection: non-markdown input is skipped, never
    indexed. See `docs/chunking-strategy.md` for the research behind these choices.
  - **Hybrid search** — dense (qwen3) + BM25 sparse fused server-side via the Qdrant Query API
    (RRF), with auto-merge of neighbouring chunks for context. BM25 weights are computed
    in-process; corpus IDF lives in its own SQLite file, separate from `metadata.db`.
  - **Terminology (glossary) layer** — an agent-authored store of domain terms, abbreviations,
    and service names with a duplicate/similar write gate, plus a `/extract-terminology` skill
    to bulk-seed it from docs and code. Glossary matches optionally enrich docs queries.
  - **New MCP tools** — `search_docs` (coding + support), `term_search` / `term_list`
    (coding + support), `term_record` / `term_delete` (coding).
  - **Indexer** — an opt-in `INDEX_DOCS` flag makes the indexer daemon walk each repo's
    markdown into the docs layer; off by default, so existing deployments are unaffected.

### Patch Changes

- Updated dependencies [9e29d00]
  - @paparats/shared@2.1.0

## 2.0.3

### Patch Changes

- @paparats/shared@2.0.3

## 2.0.2

### Patch Changes

- @paparats/shared@2.0.2

## 2.0.1

### Patch Changes

- 2933409: Add `PAPARATS_PROJECT_SUFFIX` to isolate two stands sharing one Qdrant.

  When two paparats stands share a single Qdrant instance (isolated only by
  group, e.g. `main-stand-v2` / `main-stand-v3`), `evictProjectFromOtherGroups` matches
  projects by their stored `project` name across **all** groups — so with
  identical names each stand deletes the other's chunks, a symmetric
  delete-each-other war.

  `PAPARATS_PROJECT_SUFFIX` (default `''` — upstream behavior unchanged) appends a
  suffix to the project name in the **storage layer only** (Qdrant payload
  `project`, `chunk_id`, and SQLite metadata rows), while the clean name is still
  used at the MCP boundary: search filters map the clean name to the suffixed one
  on the way in, and results/`list_projects` strip it on the way out. `chunk_id`
  stays opaque/suffixed end-to-end so `get_chunk` / `find_usages` round-trip
  correctly.

  With a suffix set, the eviction scan looks for `<name><suffix>` in other groups
  and finds nothing the other stand wrote — so the war stops from **both** sides,
  including against an older stand whose eviction is hard-wired (it looks for the
  un-suffixed name and misses the suffixed chunks). On the next upgrade only the
  suffix value changes; no code edits.

  To keep the suffix invisible to clients, `getChunkById` strips it from the
  display `project` field it returns, so the `[project]` headers in `get_chunk`,
  `get_chunk_meta`, `find_usages` (and its edge rows), and `arch_suggest_components`
  show the clean name while the embedded `chunk_id` stays suffixed for round-trip
  lookups. With the default empty suffix this is a no-op. `getChunkById` also
  guards against a null Qdrant payload (returns `null` instead of throwing).

  The suffix is applied at a single write chokepoint and callers always pass the
  clean project name — including `evictProjectFromOtherGroups`, which resolves the
  stored form locally for its probe and hands the clean name to
  `deleteProjectChunks`. This means `applyProjectSuffix` simply appends, so a
  project whose name coincides with the active suffix is no longer a special case.

  Note: the architectural-memory layer (`_arch` collections) is intentionally not
  suffixed — it does not participate in cross-group eviction.
  - @paparats/shared@2.0.1

## 2.0.0

### Major Changes

- 1a8c124: **BREAKING: migrate to permissively-licensed embedding models.** The default code embedder is now **bge-code-v1** (1536d) and the default arch/docs text embedder is **Qwen3-Embedding-0.6B** (1024d) — both Apache-2.0, replacing the CC-BY-NC `jina-code-embeddings` and `bge-m3`. Both are decoder-based and served with `--pooling last`.

  **Why this is breaking:** a model change invalidates every existing vector. Even where the dimension is unchanged (jina→bge-code are both 1536d; bge-m3→qwen are both 1024d), the vector spaces are incompatible, so any pre-existing index must be reindexed before search returns correct results. Collections stamped with the old model raise `CollectionMetaMismatchError` on write.

  **Migration (required for existing installs):**

  - **Code layer** — reindex from source: drop the old collection (or bump the indexer's reindex epoch) so it rebuilds with the new model.
  - **Arch/docs layer** — re-embedded automatically. On startup the server detects any arch collection stamped with a different text model and re-embeds it in place, reconstructing each card's text from its stored payload (no data loss; the collection is only recreated if the dimension changed). No manual step for the OSS/self-hosted path. A manual `POST /api/arch/reindex {"group":"..."}` (and `apiClient.reindexArch`) is also available to force it without a restart.
  - The embed image and native `paparats install` ship only the two new GGUFs — no legacy weights are carried; rollback is via a previously published image tag.

  **Other changes:**

  - **Instruction-aware queries.** Query-type detection (nl2code / code2code / techqa) maps to each model family's instruction template using **verbatim task strings from the model cards** (a paraphrased instruction measurably degrades retrieval). Documents are embedded unprefixed (asymmetric retrieval). Instructions auto-enable for instruction-tuned families and stay off for cloud providers.

  See `docs/replacing-embedding-models.md` for the full cutover checklist and the process for swapping models in the future.

### Patch Changes

- Updated dependencies [1a8c124]
  - @paparats/shared@2.0.0

## 1.7.9

### Patch Changes

- 02b9b8a: fix(metadata): drop pre-cap symbol_edges instead of DELETE; never crash startup

  The one-time pre-cap edge purge used `DELETE FROM symbol_edges`, which logs
  every row to the WAL. On the multi-gigabyte tables the fan-out bug produced,
  this inflated the WAL past the table's own size (14 GB observed), never
  committed, and crashed server startup with `SQLITE_BUSY` in a restart loop —
  the server never came up.

  - The purge now uses `DROP TABLE IF EXISTS symbol_edges`, which deallocates
    pages in bulk instead of logging each row. The table is immediately recreated
    empty by the existing `CREATE TABLE IF NOT EXISTS`, and the indexer's reindex
    epoch rebuilds edges with the fan-out cap applied.
  - The purge is wrapped in try/catch and is no longer a startup precondition: on
    any failure (e.g. a lost lock race) `user_version` is left at 0 so the purge
    retries on the next open, and startup proceeds regardless.

- Updated dependencies [02b9b8a]
  - @paparats/shared@1.7.9

## 1.7.8

### Patch Changes

- 382be43: fix(symbol-graph): cap AMBIGUOUS fan-out and stop blocking the event loop

  Large repos with symbols re-declared across hundreds of chunks (namespace roots,
  lifecycle hooks, shared base-class names) produced a quadratic `uses × defines`
  edge explosion — millions of AMBIGUOUS edges for a single symbol — that inserted
  in one giant SQLite transaction and blocked the Node event loop long enough to
  trip the indexer's health probe.

  - `buildSymbolEdges` now skips any symbol defined in more than
    `MAX_DEFINITION_FANOUT` (50) chunks and reports the count of edges avoided.
    These edges carried no navigational value.
  - `upsertSymbolEdges` commits in bounded batches, yielding between them so the
    synchronous SQLite work no longer monopolises the event loop.
  - The dashboard's indexer health probe timeout is raised 5s → 15s so a busy but
    healthy index cycle isn't reported as unreachable.

  Auto-heals existing installs after upgrade — no manual DB surgery:

  - Opening `metadata.db` purges pre-cap symbol edges once (gated on
    `user_version`), clearing the stale high-fanout rows.
  - The indexer's state store bumps a reindex epoch on first boot after upgrade,
    clearing all repo fingerprints so the next cron cycle re-indexes every repo
    and rebuilds its symbol graph with the cap applied.

- Updated dependencies [382be43]
  - @paparats/shared@1.7.8

## 1.7.7

### Patch Changes

- @paparats/shared@1.7.7

## 1.7.6

### Patch Changes

- 5e215f0: Fix `paparats update` leaving the Dockerised server/indexer unable to reach the embed server (`llama-server failed after 3 retries: fetch failed`), and move the native embed off Ollama's port so the two can coexist.

  - **Heal legacy compose on update.** Installs that predate `install.json` (Ollama-era) had compose files generated before the `EMBED_URL` env existed, so the containers fell back to `127.0.0.1` — themselves — instead of `host.docker.internal`. Update previously _skipped_ compose regeneration when `install.json` was missing, so the stale file was never repaired. Update now derives the embed/qdrant config from the existing compose (`deriveRegenerateOptsFromCompose`, scoped to the `services:` block to avoid false positives from `volumes:`/`networks:`), regenerates so `EMBED_URL` is written, and records a fresh `install.json`. `paparats edit` reuses the same helper.
  - **Dedicated embed port 18434 (was 11434).** llama-swap no longer squats Ollama's default port, so a host running Ollama for other tools is unaffected and an embed call can't silently hit Ollama (which rejects the jina-code model). The port is updated consistently across the compose generator, all `EMBED_URL` defaults (server, indexer, CLI), the launchd/spawn listen address, and the doctor/status health checks.
  - @paparats/shared@1.7.6

## 1.7.5

### Patch Changes

- @paparats/shared@1.7.5

## 1.7.4

### Patch Changes

- @paparats/shared@1.7.4

## 1.7.3

### Patch Changes

- @paparats/shared@1.7.3

## 1.7.2

### Patch Changes

- @paparats/shared@1.7.2

## 1.7.1

### Patch Changes

- 7825ad3: Raise the metadata SQLite `busy_timeout` from 5s to 30s to avoid "database is
  locked" errors.

  The server and indexer processes open the same `metadata.db` (shared volume) and
  both write to it — the indexer during indexing, the server on-demand for git
  history. WAL lets readers run during a write, but two writers still serialise,
  and with a 5s timeout a contended write (notably the startup `symbol_edges`
  migration racing an active indexer) failed immediately with `SqliteError:
database is locked`, crashing server startup. Waiting up to 30s comfortably
  covers a full-table migration or a batch upsert, so the writers queue instead of
  erroring.
  - @paparats/shared@1.7.1

## 1.7.0

### Minor Changes

- 1e00455: Fix `find_usages` and the analytics UI hanging (504) during continuous indexing.

  The per-group degree statistics behind `find_usages` were recomputed with two
  full-table `LIKE 'group//%'` scans of `symbol_edges`, and the cache backing them
  was **dropped** on every edge write. Under continuous indexing the cache was
  therefore always cold, so each `find_usages` call blocked on a full-graph scan —
  on a large index (hundreds of thousands of chunks / millions of edges) this
  exceeded proxy timeouts and surfaced as 504s.

  Three changes remove the stall:

  - **Stale-while-revalidate:** reads never block on the full-graph scan. A stale
    or aged snapshot is served immediately and refreshed in the background
    (deduped per group). Only the very first computation for a group is
    synchronous.
  - **Non-destructive invalidation:** edge writes mark the degree cache stale
    instead of deleting it, so a snapshot is always available to serve.
  - **Indexed aggregation:** `symbol_edges` gains a denormalised `grp` column with
    composite indexes `(grp, to_chunk_id)` / `(grp, from_chunk_id)`, so degree
    stats aggregate via an index range scan instead of a full-table `LIKE` scan.
    Existing databases are migrated in place (column added + backfilled from
    `from_chunk_id`); new and reindexed edges populate it directly.

### Patch Changes

- @paparats/shared@1.7.0

## 1.6.0

### Minor Changes

- 93e1b1e: Replace Ollama with llama.cpp (llama-server) + llama-swap as the embedding backend

  The embedding backend now runs `llama-server` (llama.cpp) fronted by `llama-swap`
  in the new `ibaz/paparats-embed` image, replacing `ibaz/paparats-ollama`. This is
  ~5–9× faster on CPU (measured on an 8-CPU AWS Graviton box) and serves
  `jina-code-embeddings`, which Ollama 0.30+ rejects with HTTP 501. Existing indexes
  stay valid — vectors are cosine-identical to the old Ollama output (per-model
  pooling: jina-code → last, bge-m3 → cls), so **no re-index is required**.

  **Breaking changes for existing installs (compose is regenerated by `paparats install`):**

  - Embedding provider id: `ollama` → `llama` (in `.paparats.yml` `embeddings.provider`
    and the `EMBEDDING_PROVIDER` / `TEXT_EMBEDDING_PROVIDER` env vars).
  - Env vars: `OLLAMA_URL` → `EMBED_URL`, `OLLAMA_BATCH_SIZE` → `EMBED_BATCH_SIZE`.
    New `EMBED_TTL` controls idle-unload seconds for lazy-loaded models.
  - Docker image `ibaz/paparats-ollama` → `ibaz/paparats-embed` (container
    `paparats-ollama` → `paparats-embed`; llama-swap listens on 8080, mapped to host
    11434).
  - CLI flags: `--ollama-mode` → `--embed-mode`, `--ollama-url` → `--embed-url`;
    `--embeddings` accepts `llama | openai | voyage`.
  - Native macOS install now uses `brew install llama.cpp mostlygeek/tap/llama-swap` (Metal
    accelerated) instead of Ollama; no Modelfile / `ollama create` step — llama-swap
    loads models by name on demand.

### Patch Changes

- Updated dependencies [93e1b1e]
  - @paparats/shared@1.6.0

## 1.5.0

### Minor Changes

- d63a0c5: Add AST-based Terraform/HCL support: symbol extraction and find_usages for `.tf`/`.hcl` files via the tree-sitter terraform grammar, with regex chunking retained as fallback.

  - Default excludes strictly skip secrets and state at any directory depth: `**/*.tfvars`, `**/*.tfvars.json`, `**/*.auto.tfvars`, `**/*.auto.tfvars.json`, `**/*.tfstate`, `**/*.tfstate.*`.
  - `blockLabels` now resolves bare identifier block labels (`resource aws_instance web`), not just quoted string labels.
  - Reference resolution walks consecutive `get_attr` siblings instead of scanning all of a variable expression's parent's children, so unrelated sibling expressions (e.g. `concat(var.x, local.y)`) no longer leak into the attribute chain.
  - `readConfig`/`loadIndexerConfig` no longer crash on a malformed or comment-only config file — js-yaml 5 throws on empty-document input, now caught and surfaced as a clean `Invalid config at <path>` error.

### Patch Changes

- Updated dependencies [d63a0c5]
  - @paparats/shared@1.5.0

## 1.4.0

### Minor Changes

- 6c8d2b4: Update dependencies and resolve all open Dependabot security advisories.

  - Security fixes via resolutions: hono ^4.12.25, undici ^6.27.0, tar ^7.5.16, vite ^8.0.16, brace-expansion ^5.0.6; OpenTelemetry stack bumped to 2.9.0 (exporter 0.220.0) to fix the @opentelemetry/core Baggage advisory.
  - Major upgrades: commander 15, js-yaml 5 (namespace imports, `quoteStyle` replaces `quotingType`), @types/node 26.
  - **Node baseline raised to 24** (`engines: >=24`); CI and Docker images now use Node 24. commander 15 requires Node ≥22.12.
  - Minor/patch bumps across eslint, prettier, vitest, vite, typescript-eslint, better-sqlite3, node-cron, ora, uuid, p-queue, @opentelemetry/semantic-conventions.
  - Pinned the bundled Ollama Docker images to 0.24.0 (last 0.2x line; 0.30+ is incompatible).

  TypeScript stays on 5.9 and web-tree-sitter on 0.25 — TS 6/7 is blocked by typescript-eslint's peer range, and web-tree-sitter 0.26 breaks the tree-sitter grammar ABI.

### Patch Changes

- Updated dependencies [6c8d2b4]
  - @paparats/shared@1.4.0

## 1.3.2

### Patch Changes

- 40bc275: fix(server): make git metadata enrichment incremental — only files actually reindexed in a cycle are re-enriched, instead of re-running `git log`/`git diff` and rewriting Qdrant payloads for every chunk of the project on every cron tick. Parsed git output is additionally cached in the metadata DB keyed by repo HEAD, so repeated enrichment without new commits skips git subprocesses entirely. Fixes constant `POST /points/payload` spam to Qdrant and high indexer CPU on near-no-op cycles.
- Updated dependencies [40bc275]
  - @paparats/shared@1.3.2

## 1.3.1

### Patch Changes

- 48b8bb7: chore(deps): patch/minor dependency upgrades incl. hono security fixes

  Bump `hono` (transitive via `@modelcontextprotocol/sdk`, pinned through `resolutions`) from 4.12.18 to 4.12.23, closing four moderate advisories patched in 4.12.21: ipRestriction non-canonical IPv6 deny bypass, app.mount() undecoded-prefix mis-routing, cookie sameSite/priority Set-Cookie injection, and JWT middleware accepting any Authorization scheme.

  Other patch/minor upgrades within their current major: `@qdrant/js-client-rest` 1.18.0, `better-sqlite3` 12.10.0, `js-yaml` 4.2.0, `p-queue` 9.3.0, `@inquirer/prompts` 8.5.2, the `@opentelemetry/*` packages, `eslint` 10.4.1, `typescript-eslint` 8.60.1, `vite` 8.0.16, `vitest` 4.1.8, `@types/node` 25.9.2, plus `postcss`/`protobufjs` resolutions. Major bumps (commander 15, typescript 6) and `web-tree-sitter` 0.26 (ABI-coupled to the pinned `tree-sitter-wasms` grammars) deliberately deferred.

- 1e6e73f: fix(server): stop arch-memory collections leaking into the code-group list

  `listGroups()` filtered Qdrant collections by the `paparats_` prefix alone. The architectural-memory collection for a group is named `paparats_<group>_arch`, which also carries that prefix, so it passed the filter and `fromCollectionName` returned a phantom code group `<group>_arch` (e.g. `default_arch`). That phantom entered `getGroupNames()`, and `search_code` — which iterates every known group when none is specified — ran a code-vector search against the arch collection, failing with `Bad Request` on every query.

  `listGroups()` now also excludes arch collections via `isArchCollection()`, so they never surface as code groups. The `_arch` suffix is reserved as a result: a code group literally named `<x>_arch` is indistinguishable from group `<x>`'s arch collection and will not be listed.

- Updated dependencies [48b8bb7]
  - @paparats/shared@1.3.1

## 1.3.0

### Minor Changes

- 9d0ccb1: feat(server): graph-aware tuning for the architectural memory layer

  Five coupled changes inspired by reviewing the design of [graphify](https://github.com/safishamsi/graphify) against ours. graphify keeps a typed knowledge graph (nodes + edges with confidence labels) and runs BFS/DFS with a hub-degree cutoff; we keep a vector store plus a flat symbol-edge graph. Borrow the parts that fit, keep the parts where we're already stronger.
  - **Confidence labels on symbol edges.** `symbol_edges` now carries an `EXTRACTED | INFERRED | AMBIGUOUS` confidence column, surfaced in `find_usages` output beside each relation. EXTRACTED = caller and definition share the same source file (AST-resolved). INFERRED = cross-file, exactly one chunk defines the symbol. AMBIGUOUS = symbol resolves to multiple chunks (any of them could be the target). Existing databases migrate via `ALTER TABLE`; pre-existing rows are tagged `INFERRED` (the conservative legacy default) until the next reindex labels them precisely.
  - **Hub-threshold in `find_usages`.** The tool now consults a per-group p95 degree (computed on-demand from `symbol_edges`, cached for 5 min, invalidated on edge upsert/delete). Callers/callees that are themselves hubs — degree above the threshold — are surfaced with a `[hub]` marker by default; pass `include_hubs: false` to drop them entirely. This stops one mega-utility (a `formatAge`-style helper called from everywhere) from drowning out the real callers when you ask about a normal symbol.
  - **New tool `arch_suggest_components`.** Coding mode only. Reads top-N by in-degree from `symbol_edges` for a `(group, project?)`, filters out files already covered by an existing component card, returns a ranked list of candidates. Read-only — the agent decides whether each candidate is a real architectural boundary before writing it via `arch_record_component`. Useful for initialising the arch layer for a fresh group, or after a large refactor to surface newly central modules.
  - **Sanitise arch-card text before MCP render.** Cards may be authored by other agents (different conversation, different process). Their `name` / `title` / `summary` / `rule` / `why` / `when` / `files` are now stripped of ANSI escapes, C0 control bytes, and zero-width / bidi-override code points before landing in `arch_context` and `arch_list` output. Inline labels are additionally length-capped. Defends against prompt-injection through a card that survives across sessions.
  - **`arch_context` stays uncached on purpose.** Audited the read path: no in-memory cache sits between `buildArchContext` and the Qdrant store. Support mode has no file watcher and no cross-mode invalidation signal, so any cache here would serve stale cards after a coding-mode write. Locked this in with a comment in `arch/context.ts` and a regression test that asserts back-to-back identical calls hit the store both times — anyone adding a cache layer must also wire up cross-mode invalidation first.

### Patch Changes

- @paparats/shared@1.3.0

## 1.2.0

### Minor Changes

- ebda708: feat(arch): `arch_list` enumeration tool plus retrieval-ranking fixes for `arch_context`

  Three coupled changes for the architectural memory layer, motivated by a real audit/dedupe session that surfaced ranking blind spots in `arch_context`.
  - **`arch_list(group, project?, kinds?, include_history?, limit?, offset?)`**. Unranked, paginated enumeration. No vector, no similarity threshold. Use this when you need every card (audit, dedupe, migration) rather than the top-N most similar. `arch_context` is for relevance-ranked retrieval; `arch_list` is for ground truth. Coding mode only.
  - **Per-kind limits in `arch_context`**. Previously a single top-20 was bucketed post-fetch, which let a verbose decision bucket starve components out of the result entirely. Each kind now has its own top-N budget (default 5 per kind, overridable via `limits: { component, decision, lesson }`, max 50; 0 suppresses the kind). Three small kind-scoped Qdrant searches in parallel; arch collections are tiny so the cost is negligible.
  - **Project-scoped retrieval boost**. When `arch_context` is called with `project=X`, cards whose payload matches that project get a small additive rank boost (~one calibrated tier of bge-m3 score bands, currently `+0.05`). This breaks the short-text cosine bias that lets one-line global decisions outrank longer project-scoped components. Globals stay visible but no longer dominate. The similarity gate (`findNearest`, used by `arch_record_decision`/`arch_record_lesson` for dedupe) intentionally stays on raw cosine — boost is retrieval-only.

  Tool-output and ranking change: callers that rely on a specific ordering of `arch_context` results when passing `project` will see project-scoped cards moved up. Use `arch_list` if you need a stable unranked view.

### Patch Changes

- @paparats/shared@1.2.0

## 1.1.0

### Minor Changes

- 7866aea: feat(arch): richer `arch_context` output, safer `arch_delete` docs, and clearer memory-layer guidance
  - **Lesson rendering**: `arch_context` now includes `why:` and `when:` continuation bullets under each lesson rule. The incident context behind a rule is often more load-bearing than the rule itself — the agent needs to see when the rule applies, not just the rule.
  - **Stale marker**: any card whose `updatedAt` is older than 90 days is now prefixed with `⚠ stale` in the rendered output. The 90-day threshold was already documented as a "treat as hypothesis" boundary, but had no visible signal — easy to skip past. New marker makes it impossible to miss.
  - **`arch_delete` safety**: tool description now tells the caller to re-fetch ids via `arch_context` immediately before deleting. Re-upserts allocate fresh UUIDs, so ids cached from earlier in a conversation can silently miss the intended card — and in the worst case, wipe a now-current one if the id was reassigned.
  - **Memory-layer dichotomy**: `arch_record_lesson` description, `codingInstructions`, and the `record_lesson_from_correction` workflow now explicitly distinguish arch lessons (rules about the _code_ — contracts, boundaries, patterns) from agent-side memory (rules about _the user's workflow_ — commit style, branch naming, formatting). Agents were mixing the two, ending up with workflow rules cluttering the arch layer.

  Tool output format change: lessons now span up to three lines per card (rule, `why:`, `when:`) instead of one. Update any downstream consumer that parsed `arch_context` line-by-line.

### Patch Changes

- @paparats/shared@1.1.0

## 1.0.2

### Patch Changes

- bfa9231: arch_context: surface card id in every result line

  The formatted `arch_context` tool output now includes the card id next to each component, decision, and lesson, e.g. `**file indexer** (id ` + "`" + `01926abc-...` + "`" + `, 4d ago, score 0.62) — Indexes files...`. Without this, a caller had no way to obtain ids from the tool output and could not invoke `arch_delete`. The renderer is extracted into `renderArchContextSection` so the contract is regression-tested.
  - @paparats/shared@1.0.2

## 1.0.1

### Patch Changes

- 165fa10: arch: add `arch_delete` tool for hard-removing cards by id

  `arch_delete(group, ids: string[])` permanently removes one or more arch cards from a group's Qdrant collection. Use for cleaning up obsolete cards left over from a refactor, dropping cards for a removed feature, or migrating away from old payload schemas.
  - Idempotent: ids that no longer exist are reported in `notFound` but do not fail the call.
  - No undo, no audit trail — the cards are gone from Qdrant. Prefer `supersedes` on `arch_record_decision` when you have a replacement decision; use `arch_delete` only when there is no replacement (e.g. a removed component or an old per-group lesson that's now project-scoped).
  - Coding-mode only. Support mode stays strictly read-only.

  Programmatic API: `ArchStore.deletePoints(group, ids): Promise<{ deleted: string[]; notFound: string[] }>`. A missing collection is treated as "every id not found" so first-run-of-a-migration is safe to retry.
  - @paparats/shared@1.0.1

## 1.0.0

### Major Changes

- 9c2f41f: arch: scope memory by `project` field on every card (breaking)

  Architectural memory now carries an explicit `project` per card so multi-project groups (one Qdrant collection spanning more than one repo) can be queried without cross-project noise. No path heuristics — the caller passes the same `project` value the indexer uses in code-chunk `payload.project`.

  ### Breaking changes
  - `arch_record_component` now **requires** `project: string`. Calls without it fail with a Zod error. Component idempotency is now per-(group, project): two projects in the same group may legitimately reuse the same component name (e.g. `indexer`) without overwriting each other.
  - `arch_record_decision` and `arch_record_lesson` accept an **optional** `project: string`. Omit it for guidance that applies group-wide.
  - `arch_context` replaces `path_prefixes: string[]` with `project: string`. When set:
    - components are filtered hard — a component without `project=X` is dropped;
    - decisions and lessons are filtered soft — cards with `project=X` OR no `project` field at all pass through, so globally-scoped guidance still surfaces.
  - Old component cards written before this release have no `project` payload and become invisible to project-scoped queries. There is no automatic migration: rewrite them via `arch_record_component` with the new required field.

  ### Programmatic API
  - `UpsertComponentInput.project: string` is now required.
  - `UpsertDecisionInput.project?` and `UpsertLessonInput.project?` added (optional).
  - `SearchOpts.pathPrefixes` removed; replaced by `SearchOpts.project?: string`.
  - `BuildArchContextOpts.pathPrefixes` removed; replaced by `BuildArchContextOpts.project?: string`.
  - Helper `makePrefixPredicate` removed; replaced by `makeProjectPredicate(project)`.

  ### Implementation notes
  - Filtering stays post-fetch (Qdrant's `match.value` / `match.any` can't express "hard for components, soft for non-components" in a single filter). When `project` is set the underlying Qdrant `limit` is overfetched 3× before filtering. Best-effort only: if the filter still leaves fewer than `limit` hits, the short list is returned — there is no recursive top-up.
  - `findByName(group, kind, name, project?)` now scopes the lookup by `project` when given, so `upsertComponent` no longer cross-overwrites a same-named component in another project of the same group.

### Patch Changes

- @paparats/shared@1.0.0

## 0.11.0

### Minor Changes

- bf2b580: arch_context: add optional `path_prefixes` to scope component hits in shared groups

  `arch_context` accepts a new `path_prefixes: string[]` parameter. Each entry is matched against component cards via `string.startsWith` on every value in `files[]` — no glob, no regex, no leading-slash normalization. A component passes when at least one of its files starts with at least one of the supplied prefixes. **Decisions and lessons (which carry no `files[]`) always pass through**, so a prefixed call still returns globally-scoped guidance alongside the scoped components.

  Use it to silence cross-project noise in groups that hold more than one project under a common collection (single-project groups don't need it).

  Implementation notes:
  - Filtering is applied post-fetch in `ArchStore.searchWithVector` rather than via a Qdrant payload filter — `match.value` / `match.any` don't express prefix matches, and arch collections are tiny (low thousands), so the post-filter has bounded cost.
  - When a prefix is set the underlying Qdrant `limit` is overfetched 3× before filtering, so the result list isn't artificially short. Best-effort only: if the prefix still leaves fewer than `limit` hits, the short list is returned — there is no recursive top-up.

  Backwards-compatible: when `path_prefixes` is omitted the tool behaves as before.

### Patch Changes

- @paparats/shared@0.11.0

## 0.10.2

### Patch Changes

- 2e05623: Fix architectural-memory tool exposure per MCP mode. Coding mode now exposes the full arch toolkit (`arch_context` plus all three `arch_record_*` writers and the `init_arch_memory` / `record_lesson_from_correction` workflows), and support mode is strictly read-only (`arch_context` and the `audit_architecture` workflow). Previously the writers were wired into support and missing from coding, which is the opposite of how the modes are used: agents author memory while making changes (coding), while support consumers only read it.
  - @paparats/shared@0.10.2

## 0.10.1

### Patch Changes

- @paparats/shared@0.10.1

## 0.10.0

### Minor Changes

- 15ee219: **Architectural memory — a living knowledge base your agent maintains itself.**

  Code search tells the agent **what** the code does. The new architectural memory layer
  tells it **why** — and the agent writes it as it learns, reads it before every
  architectural answer, and keeps it clean without you authoring a single doc.

  **Three strict card kinds**, each in its own field-by-field shape so the agent
  records facts instead of inventing prose:
  - **Components** — `name`, plus a markdown summary with `Does / Owns / Does not / Touched when`.
  - **Decisions** (ADR-style) — `title`, `context`, `decision`, `alternatives_rejected`,
    `consequences`.
  - **Lessons** (Reflexion-style) — `rule`, `why`, `when`.

  **Server-side similarity gate** keeps the store clean without trusting the client:
  every write runs nearest-neighbour search against the same group first.
  Cosine **≥ 0.85** is a duplicate (decisions refused, lessons bump `updatedAt` as
  "rule confirmed"); **0.70 – 0.85** is similar and surfaced so the agent can refine or
  chain a `supersedes`; below 0.70 is a new card. `supersedes` links bypass the gate
  and mark prior decisions as `status=superseded` so they disappear from default search
  but stay in history.

  **Min-score threshold for reads.** `arch_context` accepts a `min_score` parameter
  (default `0.45`, cosine over [bge-m3](https://ollama.com/library/bge-m3)). Hits below
  the threshold are dropped, and the tool returns an explicit low-confidence hint when
  nothing matched — the agent now knows to rephrase or lower `min_score` instead of
  inventing context.

  **No memory rot.** Every card carries an `updated N ago` stamp **and a cosine score**
  in `arch_context` output. The support-mode system prompt instructs the agent to verify
  stale cards (>90 days) against current code and update or supersede them.

  **`arch_context` is now read-only on the coding endpoint too** (`/mcp`). Refactors
  need to know about prior decisions before renaming or moving code. Writes
  (`arch_record_*`) remain support-only — recording belongs to the architectural-review
  workflow, not to every line edit.

  **Workflow prompts** for the boring scaffolding:
  - **`init_arch_memory`** — `/init`-style first-run bootstrap. Walks the repo, identifies
    8-20 components by domain boundary, writes them, captures obvious decisions.
  - **`audit_architecture`** — sweep stale cards, verify anchors against live code,
    surface a punch list of updates and supersedes.
  - **`record_lesson_from_correction`** — convert a user correction into a structured
    lesson card without overrecording typos.

  **MCP resources** for live introspection:
  - **`arch://schema`** — full card-schema reference.
  - **`arch://stats/{group}`** — live counts (total / by kind / by status) plus
    oldest/newest `updatedAt`.

  **Prometheus metrics** (opt-in via `PAPARATS_METRICS=true`):
  - `paparats_arch_context_calls_total{group}` — counter
  - `paparats_arch_write_total{kind, status}` — counter (every gate outcome is labelled)
  - `paparats_arch_search_score` — histogram of cosine scores returned by `arch_context`
  - `paparats_arch_collection_size{group, kind, status}` — gauge

  **Four new MCP tools** on the support endpoint (`/support/mcp`): `arch_context`,
  `arch_record_component`, `arch_record_decision`, `arch_record_lesson`. Cards live in
  a separate Qdrant collection per group (`paparats_<group>_arch`), embedded with
  `bge-m3` (1024d, mean-pooled, multilingual) — the code index is untouched.

  Keywords: architectural memory, ADR memory, decision records, lessons learned,
  living architecture, Reflexion, agent memory, knowledge base, cross-session continuity,
  init prompt, /init, audit, observability, Prometheus metrics, min_score, threshold.

### Patch Changes

- Updated dependencies [15ee219]
  - @paparats/shared@0.10.0

## 0.9.2

### Patch Changes

- 4fc117a: Keep the indexer container healthy during long indexing cycles. `Indexer.indexProject()` and `Indexer.indexFilesContent()` now yield to the event loop every 10 files so `/health` and `/metrics` on `:9877` no longer hang while tree-sitter parses run — the operator UI stopped flipping to `INDEXER OFFLINE` while indexing was actually in progress. The "Skipped X/Y files (unchanged)" log now reports the current project's skip count instead of a cumulative cycle counter (which could exceed `Y`). The operator-UI indexer health probe timeout is raised from 1.5s to 5s so a single slow GC tick no longer surfaces as a false offline banner.

  Fix `SQLITE_BUSY_RECOVERY` crash on indexer startup when the server and indexer share `metadata.db` and `cache/embeddings.db` over the same Docker volume. Every SQLite open now sets `busy_timeout = 5000` so a second writer waits for the first to finish its `CREATE TABLE` / `CREATE INDEX` instead of failing instantly, and `synchronous = NORMAL` is applied uniformly for the standard WAL fast-path. Applied to `MetadataStore`, `EmbeddingCache`, `AnalyticsStore`, and the indexer `StateStore`.

- Updated dependencies [4fc117a]
  - @paparats/shared@0.9.2

## 0.9.1

### Patch Changes

- 33f5179: Fix empty Prometheus metrics. Cache and Qdrant-collection gauges now refresh on a 15s interval (previously only on `/api/stats` hits). Index file/chunk/error counters and the embedding-duration histogram are wired into `Indexer` and `CachedEmbeddingProvider`. The indexer process now exposes its own `GET /metrics` on port 9877 — Prometheus must scrape both `:9876/metrics` (server) and `:9877/metrics` (indexer) to see indexing counters.
- Updated dependencies [33f5179]
  - @paparats/shared@0.9.1

## 0.9.0

### Minor Changes

- 7f69575: feat(ui): operator analytics dashboard at /ui

  Self-hosted operators can now open `http://<server>/ui` to see a single-screen
  analytics console. The page renders 13 tiles:
  - **KPIs:** uptime, memory %, normalized CPU load, group / project / chunk
    counts, searches and chunk-fetches in the selected period with derived
    fetch-rate.
  - **Activity sparkline:** SVG mini-chart of searches / fetches / errors
    bucketed by period (15 min for 24 h, 2 h for 7 d, 6 h for 30 d).
  - **Token-savings ROI:** hero `savings_vs_naive` figure with an editorial
    breakdown of naive baseline → search-only → actually-consumed tokens, plus
    a contextual legend explaining when "realized" savings underread reality
    because the LLM rarely fetches.
  - **Slowest searches** and **top queries** (with per-query zero-click rate).
  - **Cross-project usage:** per-anchor `off_anchor_share` and
    `off_anchor_fetches`, top knowledge-bridge pairs, and a "scope likely
    anchored" hint when searches are filtered before results.
  - **Users in period:** distinct user count plus per-user searches, fetches,
    sessions, top anchor project, last-active timestamp.
  - **Indexer status** (proxied from `/health` on port 9877) and **recent
    chunking errors**.
  - **Failed searches** with truncated query and error class.
  - **Embedding provider health:** p50 / p95 / p99 latency, cache hit-rate,
    errors and timeouts.

  Backed by a new `GET /api/analytics?period=24h|7d|30d` aggregation endpoint.
  Reuses existing `AnalyticsStore` SQLite queries where possible
  (`tokenSavingsReport`, `slowestSearches`, `topQueries`, `failedChunks`) and
  adds five new query helpers inline in `analytics-api.ts` for the new tiles:
  `crossProjectByAnchor`, `crossProjectTopPairs`, `userActivity`,
  `searchesOverTime` (with integer-division `CAST` to fix better-sqlite3's
  REAL binding of bucket sizes), `embeddingHealth`, `recentFailedSearches`,
  `zeroClickByQueryHash`. No new collectors — all data comes from existing
  event tables.

  Dashboard is vanilla HTML/CSS/JS — no build step, no framework. Polls every
  5 s, renders user data via DOM API (`textContent`, never `innerHTML`),
  gracefully degrades when telemetry is disabled or the indexer is unreachable.
  Aesthetic: editorial / terminal-style dark theme (JetBrains Mono headers,
  IBM Plex Sans body, lime `#c8ff3a` accent).

  Optional basic-auth guard via `PAPARATS_UI_BASIC_AUTH=user:pass` — scoped to
  `/ui` and `/api/analytics` only, leaves `/mcp`, `/sse`, `/api/search`,
  `/health`, and `/metrics` untouched so MCP clients and Prometheus scrapers
  keep working.

  The Docker Compose generator now sets
  `PAPARATS_INDEXER_URL=http://paparats-indexer:9877` on the server container
  so the indexer tile resolves to the sibling service over the compose
  network instead of the host loopback.

  A `?demo=1` query parameter (or `PAPARATS_UI_DEMO=true` env var) makes
  `/api/analytics` return a fully-populated synthetic payload, so the
  dashboard can be screenshotted or demoed without exposing real users,
  queries, or project names.

  Also ships `docs/grafana/paparats.json` — an importable Grafana dashboard
  covering time-series data the in-browser console can't (latency p99 over
  weeks, GC trends, CPU under indexing bursts, watcher event rate). 15
  panels across 4 rows: Traffic & latency, Embeddings, Indexing, Process
  health. Uses a `${DS_PROMETHEUS}` variable so it works with any
  Prometheus datasource. The `/ui` covers the current snapshot; this
  dashboard covers history.

  README now documents how to wire the existing OpenTelemetry exporter to
  Elastic APM Server (which accepts OTLP natively since 7.14). Lists the
  six span names we emit (`paparats.search`, `paparats.get_chunk`,
  `paparats.mcp.tool`, `paparats.embedding`, `paparats.indexing.run`,
  `paparats.indexing.chunking_error`) with their attributes, plus honest
  caveats about what's not parented or auto-instrumented yet.

### Patch Changes

- Updated dependencies [7f69575]
  - @paparats/shared@0.9.0

## 0.8.1

### Patch Changes

- [#62](https://github.com/IBazylchuk/paparats-mcp/pull/62) [`69145dd`](https://github.com/IBazylchuk/paparats-mcp/commit/69145dd92caa4b202f884de762cef5507ba047ed) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - CLI: `paparats install --embeddings <ollama|openai|voyage>` chooses the embedding backend at install time. Cloud providers (`openai`, `voyage`) drop the bundled Ollama service from the generated `docker-compose.yml` and pass through `OPENAI_API_KEY` / `VOYAGE_API_KEY` so the server and indexer talk straight to the API — no 1.7 GB image, no GGUF download, no host Ollama. Interactive install prompts for the provider and (for cloud) the API key; `--non-interactive` requires `--embedding-api-key <key>` or the corresponding env var. The choice is persisted in `~/.paparats/install.json`, so later `paparats add | remove | edit projects` keep the same compose shape on regeneration.

  Server: `Indexer.getGroupStats` and `Indexer.listGroups` now subtract the metadata sentinel point introduced in 0.8.0, so reported chunk counts reflect real chunks instead of being off by one.

- Updated dependencies [[`69145dd`](https://github.com/IBazylchuk/paparats-mcp/commit/69145dd92caa4b202f884de762cef5507ba047ed)]:
  - @paparats/shared@0.8.1

## 0.8.0

### Minor Changes

- [#60](https://github.com/IBazylchuk/paparats-mcp/pull/60) [`3c9a061`](https://github.com/IBazylchuk/paparats-mcp/commit/3c9a061cf92379ad1e45d04f9e1ac71b7f5c2667) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Add OpenAI and Voyage AI embedding providers, plus a collection-level
  mismatch guard so swapping providers never silently breaks search.
  - **`OpenAIProvider`** (`text-embedding-3-small`, 1536d) and **`VoyageProvider`**
    (`voyage-code-3`, 1024d, Matryoshka-aware) join the existing `OllamaProvider`.
    Both share a single retry helper that treats 4xx (bad key, no credit,
    malformed input) as terminal and retries 429/5xx with exponential backoff.
  - **`resolveEmbeddingConfigFromEnv()`** centralises the env contract for
    server and indexer. Precedence: explicit `EMBEDDING_PROVIDER` →
    `OPENAI_API_KEY` present → `VOYAGE_API_KEY` present → Ollama. Setting just
    an API key auto-switches providers.
  - **Collection metadata sentinel.** Each Qdrant collection now carries a
    hidden `__meta` point recording the provider, model, and dimensions that
    stamped it. Reopening a collection with a different provider raises
    `CollectionMetaMismatchError` with a clear remediation. Legacy collections
    without the sentinel get backfilled with a warning, so existing setups
    continue to work.
  - **Searcher** transparently excludes the sentinel via `must_not __meta=true`
    on every Qdrant search.
  - **Codespaces** now forwards `OPENAI_API_KEY` / `VOYAGE_API_KEY` /
    `EMBEDDING_PROVIDER` from the host shell — set one of those secrets and
    indexing drops from ~15 minutes to a couple of seconds.
  - README documents the three providers with a trade-off table (cost,
    privacy, speed) and the selection precedence.

  Out of scope here: a `paparats install --embeddings <provider>` flag and the
  Docker Compose generator's "skip Ollama service when cloud provider is set"
  flow. Both will follow in a smaller CLI-focused PR.

### Patch Changes

- Updated dependencies [[`3c9a061`](https://github.com/IBazylchuk/paparats-mcp/commit/3c9a061cf92379ad1e45d04f9e1ac71b7f5c2667)]:
  - @paparats/shared@0.8.0

## 0.7.0

### Minor Changes

- [#58](https://github.com/IBazylchuk/paparats-mcp/pull/58) [`4d46aef`](https://github.com/IBazylchuk/paparats-mcp/commit/4d46aefcf34cd308368f13077f6e902a6728497d) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Add GitHub Codespaces quickstart and fix three rough edges surfaced while
  building it:
  - `.devcontainer/` spins up the full Qdrant + Ollama + paparats stack on
    pre-built images and auto-indexes a small slice of the repo on first
    start, so users can try semantic search in the browser without installing
    anything.
  - `paparats add` no longer fails with a noisy `Indexer returned 404` when
    the indexer's config-watcher hasn't yet picked up the new `projects.yml`
    entry — the CLI retries briefly to ride out the debounce window.
  - `OllamaProvider.embedBatch` adaptively splits batches by total character
    size (default 16k chars per request, override via `OLLAMA_BATCH_CHARS`).
    Previously, 5 large chunks could exceed the 240s CPU embed budget and
    fail the whole batch.
  - `paparats search` without `--group` and without a local `.paparats.yml`
    now infers the group when the server has exactly one — keeps the demo
    flow (and ad-hoc explorers) usable without setup.

### Patch Changes

- Updated dependencies [[`4d46aef`](https://github.com/IBazylchuk/paparats-mcp/commit/4d46aefcf34cd308368f13077f6e902a6728497d)]:
  - @paparats/shared@0.7.0

## 0.6.0

### Minor Changes

- [#56](https://github.com/IBazylchuk/paparats-mcp/pull/56) [`aafbfc2`](https://github.com/IBazylchuk/paparats-mcp/commit/aafbfc2e98679357f87b98b72f7c1a7155207e23) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Add change-detection to the indexer. Two cron schedules now run side by side: a fast `CRON_FAST` tick (default `*/10 * * * *`) that fingerprints each repo and only re-indexes when it changed, and a slow `CRON` safety-net (default `0 */3 * * *`, was `0 */6 * * *`) that still does a full pass. Remote repos use `git ls-remote HEAD`; bind-mounted local repos use a file mtime/size hash. State persists in `STATE_DB_PATH` (default `/data/indexer-state.db`). Set `CHANGE_DETECTION=false` to opt out.

### Patch Changes

- Updated dependencies [[`aafbfc2`](https://github.com/IBazylchuk/paparats-mcp/commit/aafbfc2e98679357f87b98b72f7c1a7155207e23)]:
  - @paparats/shared@0.6.0

## 0.5.1

### Patch Changes

- [#54](https://github.com/IBazylchuk/paparats-mcp/pull/54) [`f15fa7a`](https://github.com/IBazylchuk/paparats-mcp/commit/f15fa7a08d11d50ff10cd763c36f39a942387487) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Add six MCP workflow prompts (`find_implementation`, `trace_callers`,
  `onboard_to_project`, `triage_incident`, `prepare_release_notes`,
  `assess_change_impact`) and enforce mode isolation between `/mcp` and
  `/support/mcp` so a coding session id cannot be replayed on the support
  endpoint.
- Updated dependencies [[`f15fa7a`](https://github.com/IBazylchuk/paparats-mcp/commit/f15fa7a08d11d50ff10cd763c36f39a942387487)]:
  - @paparats/shared@0.5.1

## 0.5.0

### Minor Changes

- [#52](https://github.com/IBazylchuk/paparats-mcp/pull/52) [`a6b60b2`](https://github.com/IBazylchuk/paparats-mcp/commit/a6b60b2efe0b32513b319d34839cecc387e22e80) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - `paparats add <local-path>` now auto-detects the project language from marker files (Gemfile, package.json, Cargo.toml, go.mod, …) and writes a commented `exclude_extra:` starter block beside the entry, listing the language defaults already applied by the server. The `projects.yml` header now documents every supported per-entry field. Existing entries are left untouched.

### Patch Changes

- Updated dependencies [[`a6b60b2`](https://github.com/IBazylchuk/paparats-mcp/commit/a6b60b2efe0b32513b319d34839cecc387e22e80)]:
  - @paparats/shared@0.5.0

## 0.4.0

### Minor Changes

- [#49](https://github.com/IBazylchuk/paparats-mcp/pull/49) [`72aab0c`](https://github.com/IBazylchuk/paparats-mcp/commit/72aab0cf524584cbf13eff25ec1fe3afe7c4e185) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Rework the install/CLI flow around a single global home, add indexer hot-reload, and clean up the symbol graph.

  **CLI**
  - Replace per-project `init` / `index` / `watch` with a unified `install` plus `add` / `remove` / `list` / `edit` / `lifecycle` subcommands working off `~/.paparats/`.
  - Persist install configuration in `install.json` so `paparats add` / `remove` can regenerate `docker-compose.yml` without losing context.
  - Add `--force` to `paparats add` — drops the project's existing chunks before reindexing (use after schema or config changes).
  - Drop the legacy `lsp-installers` / `init` / `watch` modules and their tests.

  **Indexer**
  - Hot-reload `~/.paparats/projects.yml` via a chokidar `ConfigWatcher`. Added/modified repos reindex live; removed repos drop bookkeeping. No restart needed for metadata-only edits.
  - Accept `{repos?, force?}` body on `POST /trigger`; `force: true` drops the project's existing chunks before reindexing.
  - Bind-mount the whole `~/.paparats` as `/config:ro` (directory mount, not single-file) so atomic rewrites of `projects.yml` survive — single-file mounts pin to host inode and break on rename.

  **Project list rename**
  - Renamed `~/.paparats/paparats-indexer.yml` → `~/.paparats/projects.yml`. The CLI reads `projects` semantics throughout (`paparats edit projects`, etc.) so the file name now matches.
  - `paparats install` automatically renames a legacy `paparats-indexer.yml` to `projects.yml` on first run and prints a one-line notice. No manual migration needed.
  - Both the CLI and the indexer fall back to reading `paparats-indexer.yml` when `projects.yml` is absent, so an out-of-sync upgrade (e.g. new indexer image, old CLI) keeps working.

  **Server**
  - `syncGroupsFromQdrant` now also enumerates projects per group via `listProjectsInGroup` and rebuilds `ProjectConfig` from payload, while preserving any explicit `POST /api/index` registrations.
  - `ast-symbol-extractor`: filter out symbols declared inside function bodies (locals, callback args, hook closures). Module-level only — these are the only symbols meaningful for cross-chunk reference analysis. Adds two coverage tests.

  **Docs**
  - Full README rewrite to match the new install flow, project model, and the actual MCP tool set.

- [#50](https://github.com/IBazylchuk/paparats-mcp/pull/50) [`d478587`](https://github.com/IBazylchuk/paparats-mcp/commit/d4785877da0a8d67948777441fda3181c6ec0bec) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - fix(group): default to a shared `default` group instead of project name

  A regression introduced when `paparats add` landed silently siloed every
  project in its own Qdrant collection, breaking the multi-project model
  ("group = collection, projects share via the `project` payload filter").

  What changed:
  - `@paparats/shared` exports `DEFAULT_GROUP = 'default'` as the single
    source of truth.
  - `paparats add` no longer writes `group: <name>` when `--group` is
    omitted — the entry inherits `defaults.group` from `projects.yml` or
    falls back to `DEFAULT_GROUP`. CLI `list` / `remove` resolve through
    the same path.
  - The indexer container falls back to `DEFAULT_GROUP` (still respects
    `PAPARATS_GROUP` env and per-repo `group:` override).
  - `autoProjectConfig` in the server falls back to `DEFAULT_GROUP`.
  - `Indexer.indexProject` now evicts the project's chunks from any other
    group before indexing, so a project that was renamed out of its old
    group doesn't leave behind stale chunks (whose `chunk_id` would no
    longer match symbol-graph edges, silently breaking `find_usages`).

  Migration: no action required for new installs. Existing installs with
  per-project groups continue to work — the eviction pass kicks in only
  when the project moves between groups.

### Patch Changes

- Updated dependencies [[`72aab0c`](https://github.com/IBazylchuk/paparats-mcp/commit/72aab0cf524584cbf13eff25ec1fe3afe7c4e185), [`d478587`](https://github.com/IBazylchuk/paparats-mcp/commit/d4785877da0a8d67948777441fda3181c6ec0bec)]:
  - @paparats/shared@0.4.0

## 0.3.2

### Patch Changes

- [#43](https://github.com/IBazylchuk/paparats-mcp/pull/43) [`9051779`](https://github.com/IBazylchuk/paparats-mcp/commit/90517796873fbc537c44b4c9a87955a6cf009939) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Bug fixes:
  - **`paparats --version` was hardcoded to `0.1.2`**: `packages/cli/src/index.ts` carried a literal version string that the release pipeline never touched, so the flag returned `0.1.2` regardless of what npm had actually installed. Version is now read from the package's own `package.json` at runtime, so it tracks the published version automatically.
  - **AST chunker emitted overlapping chunks for large single declarations**: when `splitNode` recursed into a named child that spanned only one line (e.g. the identifier of an `export const homeMarkdown = ...` with a long template literal body), the identifier produced its own (start, start) chunk while the body produced (start, end), leaving the identifier chunk as a redundant subset of the body chunk. Added a `dedupeContainedChunks` post-filter to drop chunks whose range is fully contained inside another chunk's range. Ties are broken by length, then by emission order.
  - **`.tsx` / `.jsx` files were parsed with the wrong tree-sitter grammar**: `detectLanguageByPath` returns `'typescript'` for `.tsx` (which keeps `LANGUAGE_PROFILES` simple), but `tree-sitter-typescript` does not understand JSX — tags parse as bogus type expressions and identifier usages inside `<Foo prop={x}/>` or `{value}` are lost. Added `resolveAstLanguage(language, relPath)` which upgrades to the `tsx` grammar for `.tsx`/`.jsx` paths at the AST boundary, leaving the higher-level language profile untouched.

- [#44](https://github.com/IBazylchuk/paparats-mcp/pull/44) [`8544dc8`](https://github.com/IBazylchuk/paparats-mcp/commit/8544dc83bb91203efbc6f61ad1eaa9f19353901f) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Security bump:
  - Patch GHSA-protobufjs prototype-pollution / code-generation gadget (CVSS 8.1 High) by forcing `protobufjs ≥ 8.0.2` via root `resolutions`. The vulnerable 8.0.1 was a transitive dep of `@opentelemetry/exporter-trace-otlp-http` 0.217.0 — the resolution lifts it to 8.3.0 across the workspace. Dependabot couldn't auto-update because protobufjs is not a direct dep.

- Updated dependencies [[`9051779`](https://github.com/IBazylchuk/paparats-mcp/commit/90517796873fbc537c44b4c9a87955a6cf009939), [`8544dc8`](https://github.com/IBazylchuk/paparats-mcp/commit/8544dc83bb91203efbc6f61ad1eaa9f19353901f)]:
  - @paparats/shared@0.3.2

## 0.3.1

### Patch Changes

- [#41](https://github.com/IBazylchuk/paparats-mcp/pull/41) [`17c922f`](https://github.com/IBazylchuk/paparats-mcp/commit/17c922f78e3b02d6d8544dd1e89b25f76e081fb0) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - Security and reliability bumps:
  - Patch 9 dependabot advisories via root `resolutions` (fast-uri ≥3.1.2, hono ≥4.12.18, ip-address ≥10.2.0, postcss ≥8.5.14). All four were transitive — pulled in via @modelcontextprotocol/sdk (hono), ajv (fast-uri), express-rate-limit + simple-git/socks (ip-address), and vite devDep (postcss). The advisories range from path traversal in URI parsing through to JWT timestamp validation; resolutions force every consumer onto the patched line without touching direct deps.
  - Bump Yarn to 4.14.1, @inquirer/prompts to ^8.4.3.
  - Fix flaky `ApiClient.abort` test: aborted requests were being retried with exponential backoff, blowing past the 5s test timeout. Abort errors now short-circuit retry like 4xx and parse errors.

- Updated dependencies [[`17c922f`](https://github.com/IBazylchuk/paparats-mcp/commit/17c922f78e3b02d6d8544dd1e89b25f76e081fb0)]:
  - @paparats/shared@0.3.1

## 0.3.0

### Minor Changes

- [#37](https://github.com/IBazylchuk/paparats-mcp/pull/37) [`ee217da`](https://github.com/IBazylchuk/paparats-mcp/commit/ee217da9a19dd11416c4b74d3d527cd662e5b3aa) Thanks [@IBazylchuk](https://github.com/IBazylchuk)! - **Analytics & observability stack.** Adds a unified telemetry façade with three independently-toggleable sinks:
  - **Prometheus** (existing surface, unchanged) for `/metrics` scraping.
  - **Local SQLite analytics** at `~/.paparats/analytics.db` — raw search/tool/indexing events with 90-day retention. Six new MCP tools query it: `token_savings_report`, `top_queries`, `cross_project_share`, `retry_rate`, `slowest_searches`, `failed_chunks`.
  - **OpenTelemetry** (lazy-loaded) — OTLP/HTTP exporter with spans for every search, MCP tool call, embedding, indexing run, and chunking error. Works with Tempo, Jaeger, Honeycomb, Datadog, Grafana Cloud.

  **Header-based identity** (`X-Paparats-User`, `X-Paparats-Session`, `X-Paparats-Client`, `X-Paparats-Anchor-Project`) is propagated through `AsyncLocalStorage` so every event is attributed without changing call-site signatures. Identity is for attribution, not access control.

  **Three-level token-savings estimator** computed at query-time:
  - _Naive baseline_ — what the model would read if it pulled whole files.
  - _Search-only_ — tokens returned by `search_code`.
  - _Actually consumed_ — tokens the client subsequently fetched via `get_chunk`. The honest signal that discounts noisy results never used.

  **Cross-project noise** — when a client passes `X-Paparats-Anchor-Project` (or specifies a single project), the share of off-anchor results is recorded. The `cross_project_share` MCP tool surfaces this per user.

  **Indexing-pipeline observability** — `failed_chunks` aggregates AST parse failures, regex fallbacks, zero-chunk files, and binary skips. `slowest_searches` ranks by latency.

  See README.md → "Analytics & Observability" for the full configuration matrix and PII guidance.

### Patch Changes

- Updated dependencies [[`ee217da`](https://github.com/IBazylchuk/paparats-mcp/commit/ee217da9a19dd11416c4b74d3d527cd662e5b3aa)]:
  - @paparats/shared@0.3.0
