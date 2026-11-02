---
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

Security: glob 14 and minimatch 11 (GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249). The CLI and the server no longer declare minimatch, which they did not use.
