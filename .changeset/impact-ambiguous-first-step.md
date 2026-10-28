---
'@paparats/server': patch
---

`change_impact` lists callers linked only through a name several classes define (an AMBIGUOUS edge: a call on an object whose class the code does not show) apart from its dependents at the first step too, as it already did further away, instead of listing them as `[maybe]`. Such links are mostly calls to another class's method of the same name: in a blind check against the code on a private Ruby codebase, 6 of 40 were real, against 53 of 53 for links certain by file or class; checked against the TypeScript compiler on this repository's server, 18 of 355 were real. Over 300 targets of that Ruby codebase, the direct callers listed went from 1,699 to 1,364; the set-aside names stay listed with their files.
