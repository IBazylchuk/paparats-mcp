---
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

Security and reliability bumps:

- Patch 9 dependabot advisories via root `resolutions` (fast-uri ≥3.1.2, hono ≥4.12.18, ip-address ≥10.2.0, postcss ≥8.5.14). All four were transitive — pulled in via @modelcontextprotocol/sdk (hono), ajv (fast-uri), express-rate-limit + simple-git/socks (ip-address), and vite devDep (postcss). The advisories range from path traversal in URI parsing through to JWT timestamp validation; resolutions force every consumer onto the patched line without touching direct deps.
- Bump Yarn to 4.14.1, @inquirer/prompts to ^8.4.3.
- Fix flaky `ApiClient.abort` test: aborted requests were being retried with exponential backoff, blowing past the 5s test timeout. Abort errors now short-circuit retry like 4xx and parse errors.
