---
'@paparats/shared': minor
'@paparats/cli': minor
'@paparats/server': minor
'@paparats/indexer': minor
---

Update dependencies and resolve all open Dependabot security advisories.

- Security fixes via resolutions: hono ^4.12.25, undici ^6.27.0, tar ^7.5.16, vite ^8.0.16, brace-expansion ^5.0.6; OpenTelemetry stack bumped to 2.9.0 (exporter 0.220.0) to fix the @opentelemetry/core Baggage advisory.
- Major upgrades: commander 15, js-yaml 5 (namespace imports, `quoteStyle` replaces `quotingType`), @types/node 26.
- **Node baseline raised to 24** (`engines: >=24`); CI and Docker images now use Node 24. commander 15 requires Node ≥22.12.
- Minor/patch bumps across eslint, prettier, vitest, vite, typescript-eslint, better-sqlite3, node-cron, ora, uuid, p-queue, @opentelemetry/semantic-conventions.
- Pinned the bundled Ollama Docker images to 0.24.0 (last 0.2x line; 0.30+ is incompatible).

TypeScript stays on 5.9 and web-tree-sitter on 0.25 — TS 6/7 is blocked by typescript-eslint's peer range, and web-tree-sitter 0.26 breaks the tree-sitter grammar ABI.
