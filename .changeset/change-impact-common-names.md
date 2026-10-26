---
'@paparats/server': patch
---

`change_impact` no longer reports calls such as `set.add(...)` or `map.get(...)` as dependents. The symbol graph links calls to definitions by name, so when one class defines `add`, every `.add(...)` in the codebase used to look like a certain call to it — and the walk then followed their callers too. A name is now treated as common when it is a single lowercase word used from more than √(files) files (at least 8). Callers linked only through such a name are listed apart by file, as probably unrelated, and not followed. The exception is a caller whose file also uses a specific name from the changed file (`new TriggerQueue()` next to `queue.add(...)`): it stays in the main list, marked `[maybe]`. On this repository, the `add` of a small queue class went from 40 reported dependents in 21 files (cut off at the limit) to 7 in 4 files: the class's real users and their callers.
