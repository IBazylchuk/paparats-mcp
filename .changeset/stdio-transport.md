---
'@paparats/server': minor
---

Add a stdio transport: `node packages/server/dist/index.js --stdio` serves the coding endpoint over stdin/stdout instead of HTTP, for MCP clients and registry inspectors that spawn the server. Logging moves to stderr in this mode and the process exits when the client closes stdin.
