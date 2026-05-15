---
'@paparats/cli': minor
'@paparats/indexer': minor
'@paparats/server': minor
'@paparats/shared': minor
---

Rework the install/CLI flow around a single global home, add indexer hot-reload, and clean up the symbol graph.

**CLI**

- Replace per-project `init` / `index` / `watch` with a unified `install` plus `add` / `remove` / `list` / `edit` / `lifecycle` subcommands working off `~/.paparats/`.
- Persist install configuration in `install.json` so `paparats add` / `remove` can regenerate `docker-compose.yml` without losing context.
- Add `--force` to `paparats add` — drops the project's existing chunks before reindexing (use after schema or config changes).
- Drop the legacy `lsp-installers` / `init` / `watch` modules and their tests.

**Indexer**

- Hot-reload `~/.paparats/paparats-indexer.yml` via a chokidar `ConfigWatcher`. Added/modified repos reindex live; removed repos drop bookkeeping. No restart needed for metadata-only edits.
- Accept `{repos?, force?}` body on `POST /trigger`; `force: true` drops the project's existing chunks before reindexing.
- Bind-mount the whole `~/.paparats` as `/config:ro` (directory mount, not single-file) so atomic rewrites of `paparats-indexer.yml` survive — single-file mounts pin to host inode and break on rename.

**Server**

- `syncGroupsFromQdrant` now also enumerates projects per group via `listProjectsInGroup` and rebuilds `ProjectConfig` from payload, while preserving any explicit `POST /api/index` registrations.
- `ast-symbol-extractor`: filter out symbols declared inside function bodies (locals, callback args, hook closures). Module-level only — these are the only symbols meaningful for cross-chunk reference analysis. Adds two coverage tests.

**Docs**

- Full README rewrite to match the new install flow, project model, and the actual MCP tool set.
