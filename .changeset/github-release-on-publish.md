---
'@paparats/cli': patch
---

`yarn release:local` now also creates the GitHub Release for each version, with its changelog entry as notes, so directories that track GitHub Releases (such as Glama) pick up new versions. The Docker and MCP Registry workflows now trigger on the version tag only, so a published release no longer starts them a second time.
