---
'@paparats/server': patch
---

arch: add `arch_delete` tool for hard-removing cards by id

`arch_delete(group, ids: string[])` permanently removes one or more arch cards from a group's Qdrant collection. Use for cleaning up obsolete cards left over from a refactor, dropping cards for a removed feature, or migrating away from old payload schemas.

- Idempotent: ids that no longer exist are reported in `notFound` but do not fail the call.
- No undo, no audit trail — the cards are gone from Qdrant. Prefer `supersedes` on `arch_record_decision` when you have a replacement decision; use `arch_delete` only when there is no replacement (e.g. a removed component or an old per-group lesson that's now project-scoped).
- Coding-mode only. Support mode stays strictly read-only.

Programmatic API: `ArchStore.deletePoints(group, ids): Promise<{ deleted: string[]; notFound: string[] }>`. A missing collection is treated as "every id not found" so first-run-of-a-migration is safe to retry.
