---
'@paparats/cli': patch
---

The root `CHANGELOG.md` and the GitHub Release notes now include every package's entries. They were built from the server package's changelog alone, so changes that bumped only the CLI were missing — eleven entries, including the 2.11.0 release-flow fix and the 2.10.0 README rewrite, are restored. Dependency-bump lines and empty "Patch Changes" headings are no longer copied.
