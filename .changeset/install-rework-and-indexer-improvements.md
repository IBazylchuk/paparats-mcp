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

- Hot-reload `~/.paparats/projects.yml` via a chokidar `ConfigWatcher`. Added/modified repos reindex live; removed repos drop bookkeeping. No restart needed for metadata-only edits.
- Accept `{repos?, force?}` body on `POST /trigger`; `force: true` drops the project's existing chunks before reindexing.
- Bind-mount the whole `~/.paparats` as `/config:ro` (directory mount, not single-file) so atomic rewrites of `projects.yml` survive — single-file mounts pin to host inode and break on rename.

**Project list rename**

- Renamed `~/.paparats/paparats-indexer.yml` → `~/.paparats/projects.yml`. The CLI reads `projects` semantics throughout (`paparats edit projects`, etc.) so the file name now matches.
- `paparats install` automatically renames a legacy `paparats-indexer.yml` to `projects.yml` on first run and prints a one-line notice. No manual migration needed.
- Both the CLI and the indexer fall back to reading `paparats-indexer.yml` when `projects.yml` is absent, so an out-of-sync upgrade (e.g. new indexer image, old CLI) keeps working.

**Server**

- `syncGroupsFromQdrant` now also enumerates projects per group via `listProjectsInGroup` and rebuilds `ProjectConfig` from payload, while preserving any explicit `POST /api/index` registrations.
- `ast-symbol-extractor`: filter out symbols declared inside function bodies (locals, callback args, hook closures). Module-level only — these are the only symbols meaningful for cross-chunk reference analysis. Adds two coverage tests.

**Docs**

- Full README rewrite to match the new install flow, project model, and the actual MCP tool set.
