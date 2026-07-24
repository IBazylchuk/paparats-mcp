---
'@paparats/server': minor
---

Add an `audience` visibility primitive to the docs layer, so a single index can hold documents of mixed sensitivity (e.g. internal vs client-facing) and searches can be constrained by visibility — with a fail-closed, server-enforced ceiling for client-facing deployments.

- **Payload + types.** Docs chunks now carry an `audience` label (free-form string; the core stores and filters on it but prescribes no taxonomy — the indexer decides its meaning). A chunk with no stored audience reads back as `internal` (`DEFAULT_AUDIENCE`) — un-labelled docs never leak to a narrower audience by default. New `audience` payload index on the docs collection.
- **Search filter.** `DocsStore.search` accepts `audience?: string | string[]` (match-any). A chunk with no `audience` field does not match an explicit filter, so e.g. `audience: ['client']` never surfaces un-labelled (internal) docs. `search_docs` gains an optional `audience` parameter.
- **Server-enforced ceiling.** `PAPARATS_DOCS_AUDIENCE` (comma-separated) sets a hard audience ceiling for the whole server, threaded through `createApp` → `McpHandler`. A request's own `audience` is intersected with the ceiling (`applyAudienceScope`) — it can only narrow within it, never widen past it; a disjoint request returns no results rather than silently widening. This is the mechanism a future client-facing endpoint uses to make internal docs physically unreachable, not merely filtered.

Additive and backward-compatible in code. Note: existing docs chunks indexed before this change have no `audience` field and thus read back as `internal` and are excluded by any explicit `audience` filter — re-index the docs layer to populate the field.
