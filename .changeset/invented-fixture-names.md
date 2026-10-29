---
'@paparats/server': patch
'@paparats/indexer': patch
---

Invented names in the examples of comments, tests and changelog entries. `scripts/check-no-private-refs.sh` now matches patterns with Perl regexes when git supports them (on macOS a `\b` in an extended regex matched nothing, so such a pattern never fired) and checks `CLAUDE.md` too.
