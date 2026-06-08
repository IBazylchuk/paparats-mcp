---
'@paparats/shared': patch
'@paparats/server': patch
'@paparats/cli': patch
'@paparats/indexer': patch
---

chore(deps): patch/minor dependency upgrades incl. hono security fixes

Bump `hono` (transitive via `@modelcontextprotocol/sdk`, pinned through `resolutions`) from 4.12.18 to 4.12.23, closing four moderate advisories patched in 4.12.21: ipRestriction non-canonical IPv6 deny bypass, app.mount() undecoded-prefix mis-routing, cookie sameSite/priority Set-Cookie injection, and JWT middleware accepting any Authorization scheme.

Other patch/minor upgrades within their current major: `@qdrant/js-client-rest` 1.18.0, `better-sqlite3` 12.10.0, `js-yaml` 4.2.0, `p-queue` 9.3.0, `@inquirer/prompts` 8.5.2, the `@opentelemetry/*` packages, `eslint` 10.4.1, `typescript-eslint` 8.60.1, `vite` 8.0.16, `vitest` 4.1.8, `@types/node` 25.9.2, plus `postcss`/`protobufjs` resolutions. Major bumps (commander 15, typescript 6) and `web-tree-sitter` 0.26 (ABI-coupled to the pinned `tree-sitter-wasms` grammars) deliberately deferred.
