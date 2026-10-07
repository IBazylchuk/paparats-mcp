---
'@paparats/server': minor
'@paparats/indexer': minor
'@paparats/cli': minor
'@paparats/shared': minor
---

Stop serving data whose source is gone, harden the server against cross-site use, and update dependencies

An audit of the indexing lifecycle found several ways the index drifted from the source it describes, plus gaps in the request-facing surface. This release fixes them and closes 20 of 22 dependency advisories (the remaining two reach only the release tooling and have no patched version).

**Index no longer keeps what was removed**

- Documents whose markdown file was deleted, renamed, excluded or stopped being markdown are removed on the next index; previously they stayed searchable through `search_docs` indefinitely.
- A source file that is emptied, turns binary or becomes minified has its old chunks removed instead of keeping them.
- Repos removed from `projects.yml` are purged (code, metadata, docs) on hot reload, and a repo that moves to another group or name is purged from the old one.
- `delete_project` and `DELETE /api/project` now also remove the project's docs, and report a failure instead of success when Qdrant could not be reached.

**Index stays correct under failure**

- A file whose re-embedding fails keeps its previously indexed version instead of disappearing until the next full cycle; the same holds for documents. Change detection no longer records a repo as indexed when any file failed.
- A failed read of a file's stored state no longer writes a second copy of its chunks, and files that were already duplicated are healed.
- Files whose chunks only moved are re-indexed, so line numbers and chunk ids stay correct; changes to `service`/`tags` now reach unchanged files.
- The symbol graph is rebuilt when a project has none, so a failed rebuild no longer leaves `find_usages` empty until some file changes.
- Model self-heal for docs and the glossary embeds everything before dropping a collection, so an embed server that is not up yet at boot no longer loses the glossary.
- Git history is attributed to the right chunk (hunks were compared 1-based against 0-based chunk lines).

**Long lines and large inputs**

- No chunk exceeds `maxChunkSize` any more: long single lines are cut, and long comment runs are split.
- When the embed server rejects an input as too large for its batch, only that input is shortened; the rest of the batch embeds normally instead of the whole file failing on every run.

**Security**

- CORS is no longer open to every origin. Cross-origin browser requests are refused unless their origin is listed in the new `PAPARATS_CORS_ORIGINS` (comma-separated exact origins). Non-browser clients and the bundled dashboard are unaffected.
- Files reached through a symlink out of the repository or into `.git` are never indexed, and `indexing.paths` rejects glob metacharacters and symlinked directories that leave the project.
- `PAPARATS_PROJECTS` now scopes every tool, not only code search: chunk lookups, `search_docs`, the glossary, `list_projects`, `delete_project` and the graph tools.
- A malformed `PAPARATS_UI_BASIC_AUTH` now stops startup instead of silently disabling auth.
- MCP sessions are closed when they expire, capped at 1000, and recreated only for well-formed ids.
- CLI-written secrets (`.env`, `install.json`) are created with mode 0600.

**Other fixes**

- Exclude patterns with a `/` (`spec/fixtures`, `vendor/`) and file globs (`*.class`, `Cargo.lock`) now exclude what they name; previously they matched nothing, so expect those files to leave the index.
- Group names ending in `_arch`, `_docs` or `_terms` are rejected: their code collection collided with another group's sidecar, which the startup self-heal could drop. Groups named `docs`, `arch` or `terms` now appear in code search.
- `projects.yml` overrides on a repo with its own `.paparats.yml` are applied the same way as without one (excludes normalized, `paths` honoured, `PAPARATS_GROUP` wins).
- Docs in a markdown-only repository are now classified as prose, so they get the intended relevance floor instead of the stricter one for docs beside code.
- Voyage queries are embedded as queries; identical code in two files is no longer collapsed into one search result; the embedding cache ignores vectors of the wrong dimension.
- Indexer: crons start even when the initial project list is empty; the same repo is never indexed twice at once; `/trigger` requests during a cycle are queued instead of dropped; clones recover from token rotation, force-pushes and default-branch changes.
- CLI: model downloads fail loudly and are verified before use; compose regeneration backs up a hand-edited file; `paparats add` rejects non-GitHub URLs; support mode configures Claude Code through `claude mcp add`.

**Dependencies**

simple-git 4, better-sqlite3 13 (prebuilt Node-API binaries), TypeScript 6, vitest 5, `@qdrant/js-client-rest` 1.19 (`search()` → `query()`), and `prom-client` replaced by its successor `@prometheus-io/client`.
