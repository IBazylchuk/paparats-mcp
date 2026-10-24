---
'@paparats/server': patch
'@paparats/indexer': patch
'@paparats/cli': patch
'@paparats/shared': patch
---

Update dependencies and close the open security advisories (body-parser,
undici, zod, fast-uri, ip-address, vite). OpenTelemetry moves to 3.0: the
deprecated `@opentelemetry/sdk-trace-node` is replaced by
`@opentelemetry/sdk-trace`. Also updates p-queue 10 and the
Qdrant client 1.20, and drops chokidar from the CLI, which never used it.
