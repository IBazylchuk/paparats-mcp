---
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

Security bump:

- Patch GHSA-protobufjs prototype-pollution / code-generation gadget (CVSS 8.1 High) by forcing `protobufjs ≥ 8.0.2` via root `resolutions`. The vulnerable 8.0.1 was a transitive dep of `@opentelemetry/exporter-trace-otlp-http` 0.217.0 — the resolution lifts it to 8.3.0 across the workspace. Dependabot couldn't auto-update because protobufjs is not a direct dep.
