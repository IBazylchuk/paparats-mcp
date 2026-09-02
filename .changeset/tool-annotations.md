---
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

Advertise MCP `ToolAnnotations` and a display `title` on all 29 tools, and register them through `registerTool`.

Clients can now tell a query apart from a write before calling it, and show a human-readable
name instead of the raw tool id. Registration moves from `server.tool()` — every overload of
which the SDK marks `@deprecated` — to `server.registerTool()`, matching the `registerPrompt`
call already in this file.

Annotations follow the current protocol revision (2026-07-28) rather than stating every field
everywhere. The spec's defaults are deliberately pessimistic (`readOnlyHint: false`,
`destructiveHint: true`, `idempotentHint: false`, `openWorldHint: true`), so only the
reassuring values carry information; and `destructiveHint`/`idempotentHint` are "meaningful
only when `readOnlyHint == false`", so they are absent from read-only tools:

- **22 read-only tools** — `readOnlyHint: true`, `openWorldHint: false`. All search, chunk,
  arch-read, glossary-read, docs and telemetry-report tools.
- **`arch_record_component`, `arch_record_lesson`, `term_record`** — additive and idempotent:
  each is keyed by name and overwrites in place, so a repeat call leaves the store as it was.
- **`arch_record_decision`** — additive, but makes no idempotency claim: it mints a fresh id
  per call and guards duplicates behind a similarity threshold, which is not a guarantee.
- **`delete_project`, `arch_delete`, `term_delete`** — not read-only, idempotent (a second
  delete finds nothing left). `destructiveHint` is left at its default `true`.

`openWorldHint: false` throughout: every tool reaches only this server's own Qdrant collections
and SQLite stores — the spec's "memory tool", not its "web search". Classification follows the
handlers rather than the tool names: the seven non-read-only tools are exactly those reaching a
mutating store call (`deleteProjectChunks`/`deleteByProject`, `upsertComponent`,
`upsertDecision`, `upsertLesson`, `deletePoints`, `recordTerm`, `deleteTerm`). Telemetry
counters are not treated as state changes.

Titles live next to their descriptions in `prompts.json`; the repeated inline
`{ description: string }` in the `Prompts` interface is now a named `ToolPrompt`.

Seven tests drive a real `tools/list` over HTTP in both coding and support mode and assert the
annotations on the wire, including a guard that no tool ships without annotations or a title —
an unannotated tool would silently inherit the pessimistic defaults.

Note for Claude Code specifically: this does **not** suppress plan-mode permission prompts.
Claude Code evaluates MCP tools uniformly there and does not consult `readOnlyHint`
(anthropics/claude-code#12368, closed as not planned). Suppressing those prompts requires a
client-side `PreToolUse` hook. The annotations are correct protocol metadata that other MCP
clients act on.
