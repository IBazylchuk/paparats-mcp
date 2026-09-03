---
'@paparats/shared': minor
'@paparats/server': minor
'@paparats/indexer': minor
'@paparats/cli': minor
---

Rebuild the analytics dashboard around usage, and fix the docs source links

The dashboard could not answer whether paparats was being used or for what. It now
opens with a plain-language summary — questions answered, people asking, typical
answer time, how much came from documentation, and what is searchable — stated
without reference to chunks, collections or groups. Below it, per-tool usage shows
which tools people reach for, with code search visible separately from documentation
search. Collection sizes per group move to a collapsed section at the bottom and cap
the row count, so an install with hundreds of projects does not render a list nobody
scrolls.

Fixes the data those tiles need, none of which was being recorded:

- **`tool_calls` was never written.** The telemetry wrapper is installed by patching
  the tool-registration method, and registration had moved to `registerTool`, which
  was not patched. Both methods are patched now, and a test drives a real
  `tools/call` to assert the event is recorded.
- **`search_events.tool` held Searcher method names**, so `search_code`,
  `explain_feature` and `impact_analysis` collapsed into one `expandedSearch`
  bucket. Search calls now carry the originating MCP tool name.
- **The indexer container ran without telemetry**, leaving the `files` table empty.
  It now shares the server's analytics DB (already the same mounted volume).

Token savings no longer reports a constant 80%. The baseline substituted
`chunk_lines * 5` for an unknown file size, which reduces to `1 - 1/5` regardless
of the data. Savings are now computed only over results whose file size is known,
and the response reports that coverage so a partially-measured window is visible
instead of implied.

Documentation search results were missing their source link. Markdown frontmatter
was not parsed at all, so `source_url` was stored as `null` for every chunk, the
title fell back to the filename, and the modification date fell back to the file's
mtime — which in a mirrored repo is the clone time. Frontmatter is now parsed for
the link, title and date, and stripped from the content, so a document's YAML block
is no longer embedded as prose. Existing documents pick this up on re-index.

The project count in the overview is now taken from the registered project map
rather than approximated from the indexer's repo list.
