---
'@paparats/server': minor
---

arch_context: add optional `path_prefixes` to scope component hits in shared groups

`arch_context` accepts a new `path_prefixes: string[]` parameter. Each entry is matched against component cards via `string.startsWith` on every value in `files[]` — no glob, no regex, no leading-slash normalization. A component passes when at least one of its files starts with at least one of the supplied prefixes. **Decisions and lessons (which carry no `files[]`) always pass through**, so a prefixed call still returns globally-scoped guidance alongside the scoped components.

Use it to silence cross-project noise in groups that hold more than one project under a common collection (single-project groups don't need it).

Implementation notes:

- Filtering is applied post-fetch in `ArchStore.searchWithVector` rather than via a Qdrant payload filter — `match.value` / `match.any` don't express prefix matches, and arch collections are tiny (low thousands), so the post-filter has bounded cost.
- When a prefix is set the underlying Qdrant `limit` is overfetched 3× before filtering, so the result list isn't artificially short. Best-effort only: if the prefix still leaves fewer than `limit` hits, the short list is returned — there is no recursive top-up.

Backwards-compatible: when `path_prefixes` is omitted the tool behaves as before.
