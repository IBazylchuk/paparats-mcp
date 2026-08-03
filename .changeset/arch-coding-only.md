---
'@paparats/server': minor
---

Make the architectural memory layer coding-only, in both directions.

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
