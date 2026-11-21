---
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

Update dependencies: chokidar 6 and ora 10, newer better-sqlite3, simple-git, graphql, OpenTelemetry, glob and minimatch, and every transitive package within its range. Closes two advisories in `@hono/node-server` (a crash on a reset WebSocket upgrade, a backslash read as a path separator).
