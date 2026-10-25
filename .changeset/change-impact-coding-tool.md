---
'@paparats/server': minor
---

Add `change_impact` to the coding endpoint: given the chunk you are about to change, it lists the code that depends on it — direct callers, their callers up to three steps out, and the tests that reach it — with file:line and chunk ids. Links that go only through a name defined in several places are marked `[maybe]`, widely-called chunks are listed but not followed, and the output says when it stopped early. `symbol` narrows the walk to one name, `whole_file` treats the chunk's whole file as changed. The coding instructions and the `trace_callers` workflow now point to it before signature changes, renames and deletions.
