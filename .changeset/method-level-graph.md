---
'@paparats/server': patch
'@paparats/indexer': patch
---

The symbol graph now links methods, not whole chunks, and uses the class a call names.

- Each use records the method it is made from, also when that method continues into the next chunk. `change_impact` passes a change on only through the method that calls it, so a neighbouring method in the same chunk no longer drags in its own callers. `find_usages` and `change_impact` name that method instead of the chunk's first symbol.
- A call that names its class (`Usage.claim`, `::Billing::Usage.claim`, `self.claim`, a bare call inside a Ruby class, `this.save()`) links only to that class's method when the class defines it. Classes are compared by full path, and a relative name is looked up the way Ruby looks up a constant, from the namespace of the call outwards, so `Api::Parser` and `Extraction::Parser` stay apart. An exact match in one file is `EXTRACTED`: it counts even through a common name and is exempt from the fan-out cap. A class found only by the end of its path is `INFERRED`; several matching classes, or a method defined in several files, `AMBIGUOUS`. Other calls are matched by name as before.
- A call to another class's method of the same name is no longer dropped as recursion: since 2.15.0 counted `def self.claim` as a definition, a `def self.claim` delegating to `Ledger.claim(...)` lost that call.
- Single-file updates now keep the graph current. `updateFile`, `POST /api/file-changed`, `POST /api/file-deleted` and content batches from the CLI (`POST /api/index`) replaced a file's chunks but left its edges alone, so edges pointed at chunks that were gone and the new chunks had none; a project indexed only through the CLI had no graph at all. Each of them now schedules a rebuild of the project's graph, a few seconds after the last change.
- The module map is rebuilt after the indexer writes edges. Edge versions were kept in the server's memory, so edges written by the indexer container never reached the map until the server restarted. They are now stored per project in the metadata database; a group's map is put together from per-project maps, so only projects whose edges changed are mapped again.

On a private Ruby codebase, for 1,392 class methods whose class name is declared in one file only (so a grep for `Class.method` finds exactly their callers; migrations left out): callers found 76% → 97%, real among those found 65% → 80%. `change_impact` over whole files at depth 2 lists 37% fewer dependents.

`symbol_format` goes to 3 and the indexer's reindex epoch to 5, so symbols are extracted again once after the upgrade.
