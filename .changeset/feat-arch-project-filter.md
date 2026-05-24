---
'@paparats/server': major
---

arch: scope memory by `project` field on every card (breaking)

Architectural memory now carries an explicit `project` per card so multi-project groups (one Qdrant collection spanning more than one repo) can be queried without cross-project noise. No path heuristics — the caller passes the same `project` value the indexer uses in code-chunk `payload.project`.

### Breaking changes

- `arch_record_component` now **requires** `project: string`. Calls without it fail with a Zod error. Component idempotency is now per-(group, project): two projects in the same group may legitimately reuse the same component name (e.g. `indexer`) without overwriting each other.
- `arch_record_decision` and `arch_record_lesson` accept an **optional** `project: string`. Omit it for guidance that applies group-wide.
- `arch_context` replaces `path_prefixes: string[]` with `project: string`. When set:
  - components are filtered hard — a component without `project=X` is dropped;
  - decisions and lessons are filtered soft — cards with `project=X` OR no `project` field at all pass through, so globally-scoped guidance still surfaces.
- Old component cards written before this release have no `project` payload and become invisible to project-scoped queries. There is no automatic migration: rewrite them via `arch_record_component` with the new required field.

### Programmatic API

- `UpsertComponentInput.project: string` is now required.
- `UpsertDecisionInput.project?` and `UpsertLessonInput.project?` added (optional).
- `SearchOpts.pathPrefixes` removed; replaced by `SearchOpts.project?: string`.
- `BuildArchContextOpts.pathPrefixes` removed; replaced by `BuildArchContextOpts.project?: string`.
- Helper `makePrefixPredicate` removed; replaced by `makeProjectPredicate(project)`.

### Implementation notes

- Filtering stays post-fetch (Qdrant's `match.value` / `match.any` can't express "hard for components, soft for non-components" in a single filter). When `project` is set the underlying Qdrant `limit` is overfetched 3× before filtering. Best-effort only: if the filter still leaves fewer than `limit` hits, the short list is returned — there is no recursive top-up.
- `findByName(group, kind, name, project?)` now scopes the lookup by `project` when given, so `upsertComponent` no longer cross-overwrites a same-named component in another project of the same group.
