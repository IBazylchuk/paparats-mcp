---
'@paparats/server': minor
'@paparats/indexer': minor
'@paparats/cli': minor
'@paparats/shared': minor
---

Add a docs-only knowledge MCP endpoint for external agents, audience labels at index time, and `get_document`

A service in another network — an agent backend behind a load balancer — can now search curated documentation without reaching anything else on the server.

**Knowledge endpoint (`/knowledge/mcp`)**

- Opt-in: set `PAPARATS_KNOWLEDGE_TOKENS` (comma-separated bearer tokens, at least 16 characters each) and `PAPARATS_KNOWLEDGE_AUDIENCE` (the labels it may serve). Optional `PAPARATS_KNOWLEDGE_PROJECTS` restricts it to some projects — recommended, so a stray `audience:` in a code repository's README cannot widen what it serves. With neither variable set the route does not exist; with only one, or a value that is empty after trimming, the server refuses to start. `internal` is refused as a label for this endpoint.
- Serves `search_docs` and `get_document` only: no code search, glossary, project listing, health, analytics, resources or workflow prompts. Its own system instructions tell the agent to cite source links, fetch whole documents when an excerpt is not enough, report an empty result as "not documented", and never treat the docs as a source of numbers or live data.
- Every request needs `Authorization: Bearer <token>`, compared in constant time and checked before the body is read (`401` with `WWW-Authenticate: Bearer` otherwise). The route has a 64 kB body limit and a 1000-character query cap.
- Stateless Streamable HTTP: a fresh server and transport per `POST`, no session id, `GET` and `DELETE` answer `405` — a load balancer needs no sticky sessions or idle-timeout tuning.
- Its audience ceiling and project allowlist apply to it alone and are narrowed further by `PAPARATS_DOCS_AUDIENCE` / `PAPARATS_PROJECTS` when set. A document outside them reads exactly like a missing one, and backend failures are reported without internal details.
- `search_docs` there returns `structuredContent` (title, heading path, source URL, project, file, excerpt, included and total sections, last modified, score) with an `outputSchema`, so a wrapping service can build citations without parsing markdown.
- Tool calls are recorded with their endpoint in analytics (`tool_calls.mode`, added by a schema migration) and OpenTelemetry (`paparats.mcp_mode`), attributed to a forwarded `X-Paparats-User` header.

**Audience labels at index time**

- Documents get an audience label when they are indexed: frontmatter `audience:` first, then `docs.audience` from `.paparats.yml` or `projects.yml` (per repo or under `defaults`, merged like `docs.kind`), otherwise `internal` as before.
- Labels must match `^[a-z0-9][a-z0-9_-]{0,63}$`. An invalid label in a config file stops it from loading; an invalid or non-scalar frontmatter value is logged and that document is stored as `internal`, never as the possibly wider project default.
- Every indexing run rewrites every document, so a changed label takes effect on the next run without a migration.

**`get_document`**

- Returns a whole document rebuilt from its stored sections, in order and without the breadcrumb added for embedding, paged at about 40,000 characters (`from_section` continues). Keyed by project and file, which survive re-indexing.
- Available on the knowledge and support endpoints; support's `search_docs` excerpts now point at it, since support users cannot open files. The coding endpoint is unchanged.
