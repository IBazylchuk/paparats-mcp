---
'@paparats/shared': minor
'@paparats/cli': minor
'@paparats/server': minor
'@paparats/indexer': minor
---

fix(group): default to a shared `default` group instead of project name

A regression introduced when `paparats add` landed silently siloed every
project in its own Qdrant collection, breaking the multi-project model
("group = collection, projects share via the `project` payload filter").

What changed:

- `@paparats/shared` exports `DEFAULT_GROUP = 'default'` as the single
  source of truth.
- `paparats add` no longer writes `group: <name>` when `--group` is
  omitted — the entry inherits `defaults.group` from `projects.yml` or
  falls back to `DEFAULT_GROUP`. CLI `list` / `remove` resolve through
  the same path.
- The indexer container falls back to `DEFAULT_GROUP` (still respects
  `PAPARATS_GROUP` env and per-repo `group:` override).
- `autoProjectConfig` in the server falls back to `DEFAULT_GROUP`.
- `Indexer.indexProject` now evicts the project's chunks from any other
  group before indexing, so a project that was renamed out of its old
  group doesn't leave behind stale chunks (whose `chunk_id` would no
  longer match symbol-graph edges, silently breaking `find_usages`).

Migration: no action required for new installs. Existing installs with
per-project groups continue to work — the eviction pass kicks in only
when the project moves between groups.
