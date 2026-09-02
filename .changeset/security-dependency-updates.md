---
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

Clear all 20 open Dependabot security advisories and refresh dependencies.

Seven transitive packages carried advisories, all reachable only through
dependencies we do not call directly. Bumped past each advisory's fix boundary
via the root `resolutions` block: `fast-uri` 3.1.2→3.1.7 (three host-confusion
bypasses), `hono` 4.12.28→4.13.5 (CORS ReDoS, `memo()` cross-user SSR leak,
language-middleware DoS, proxy header leak), `ip-address` 10.2.0→10.7.0 (three
SSRF / trust-boundary bypasses), `postcss` 8.5.15→8.5.26 (sourceMappingURL path
traversal plus its incomplete fix), `undici` 6.27.0→6.28.0 (response
desync, CRLF injection, cookie attribute injection), and `nanoid` 3.3.12→3.3.18
(two infinite-loop DoS paths), newly pinned since it enters only under `postcss`.

`js-yaml` needed three separate pins because three majors coexist in the tree:
3.15.2 and 4.3.2 via resolutions for the transitive copies under
`read-yaml-file` and `@changesets/parse`, and a direct bump to ^5.4.1 in
`server`, `cli` and `indexer` for the flow-collection parsing DoS. We parse
untrusted-ish YAML in `.paparats.yml` and `projects.yml`, so this one is on a
path we actually execute.

Also refreshed in-range direct dependencies (`@types/node`, `vitest`, `eslint`,
`prettier`, `typescript-eslint`, `vite`, `zod`, `@modelcontextprotocol/sdk`,
`@inquirer/prompts`, the OpenTelemetry set and others). `yarn npm audit` now
reports zero advisories; the two remaining notices are deprecations, not
vulnerabilities.

`@qdrant/js-client-rest` is now pinned to an exact `1.18.0`. 1.19.0 removes the
`search()` method in a minor release, which fails typecheck at six call sites in
`searcher.ts`, `arch/store.ts` and `terminology/store.ts`; migrating to `query()`
also changes the return shape from a bare array to `{ points: [...] }`. The exact
pin stops a caret range from pulling that breaking release in unnoticed. No
advisory affects 1.18.0, so this is deferred rather than urgent — the `query()`
migration wants its own change.
