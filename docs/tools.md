# MCP tools

Paparats serves three endpoints, each with its own tools and its own instructions to the
agent:

- **coding** (`/mcp`): for the agent you write code with. Searches code, follows the call
  graph, keeps architectural memory and the glossary, manages projects.
- **support** (`/support/mcp`): for support people and bots. Read-only: it writes nothing
  to the index, the glossary or architectural memory. Adds git history, tickets and
  plain-language summaries.
- **knowledge** (`/knowledge/mcp`): documentation only, for a service outside your
  network. Off unless configured; see
  [documentation-search.md](documentation-search.md#knowledge-endpoint-knowledgemcp).

## Coding endpoint (`/mcp`)

| Tool                      | What it does                                                                                                                  |
| :------------------------ | :---------------------------------------------------------------------------------------------------------------------------- |
| `search_code`             | Search by meaning across the indexed projects. Returns chunks with file, lines, symbols and a confidence score.               |
| `get_chunk`               | One chunk by id, optionally with the lines around it.                                                                         |
| `find_usages`             | Follow the call graph from a chunk: `incoming` (who calls or references it), `outgoing` (what it calls) or `both`.            |
| `change_impact`           | What depends on a chunk you are about to change: callers, their callers (up to 3 steps) and the tests that reach it. Callers linked only through a name defined in several places, or only through a common method name (`add`, `get`, `close`), are listed apart as probably unrelated. `symbol` narrows it to one name, `whole_file` takes the whole file. |
| `module_map`              | The modules of a codebase from the call graph: files that call each other much more than the rest, named by folder, with main files, which modules each one uses and is used by, its tests and the shared code. Ends with a Mermaid diagram. |
| `list_projects`           | Indexed projects with chunk counts and languages.                                                                             |
| `delete_project`          | Delete a project's chunks and metadata (`paparats remove` does the same over HTTP).                                           |
| `health_check`            | Indexing status, chunks per group, running jobs.                                                                              |
| `search_docs`             | Search the indexed markdown documentation (needs `INDEX_DOCS=true`).                                                          |
| `arch_context`            | Read architectural memory: components, decisions and lessons for a question, each with an "updated N ago" stamp; `min_score` cuts weak matches. |
| `arch_list`               | Every card in a group, unranked, for audits.                                                                                  |
| `arch_record_component`   | Record a component (`Does / Owns / Does not / Touched when`). One per (group, project, name).                                 |
| `arch_record_decision`    | Record a decision (`context / decision / alternatives_rejected / consequences`). Duplicates are refused, near matches shown; `supersedes` replaces an older one. |
| `arch_record_lesson`      | Record a lesson (`rule / why / when`). A duplicate refreshes the existing one.                                                |
| `arch_suggest_components` | The most-called files that no component card covers yet.                                                                      |
| `arch_delete`             | Delete cards by id. No undo.                                                                                                  |
| `term_search`             | Look up a term, abbreviation or domain concept in the group's glossary.                                                       |
| `term_list`               | The glossary of a group.                                                                                                      |
| `term_record`             | Add a term (name, definition, aliases); near-identical terms are refused.                                                     |
| `term_delete`             | Delete a term by id. No undo.                                                                                                 |

## Support endpoint (`/support/mcp`)

| Tool                   | What it does                                                                            |
| :--------------------- | :-------------------------------------------------------------------------------------- |
| `search_code`, `get_chunk`, `find_usages`, `list_projects`, `health_check`, `module_map`, `search_docs` | As on the coding endpoint. |
| `get_chunk_meta`       | Git history and tickets of a chunk: commits, authors, dates. No code.                   |
| `search_changes`       | Search filtered by last-commit date; each result shows when it last changed.            |
| `explain_feature`      | Where a feature lives and how it changed recently, for a question in plain words.        |
| `recent_changes`       | A timeline of commits, tickets and files, grouped by date, with a `since` filter.        |
| `impact_analysis`      | What depends on the code a question points at: 1–2 steps over the call graph (`max_hops`), grouped by service. No code. |
| `get_document`         | A whole documentation page found by `search_docs`, section by section, in parts of about 40k characters. |
| `term_search`, `term_list` | As on the coding endpoint.                                                          |
| `token_savings_report` | Estimated token savings: whole files vs search results vs what was actually opened.      |
| `top_queries`          | The most frequent queries by user, session or project.                                  |
| `slowest_searches`     | The slowest searches with timing and chunk counts.                                      |
| `cross_project_share`  | Share of results from other projects than the one asked about, per user.               |
| `retry_rate`           | How often a user repeats a tool call: a sign of unhelpful results.                     |
| `failed_chunks`        | Files that failed to parse, fell back to regex, gave no chunks or were skipped as binary. |

The analytics tools and how they are counted: [observability.md](observability.md).

## Workflow prompts

MCP prompts are ready-made tasks the client can start by name.

| Endpoint      | Prompts                                                                                                                  |
| :------------ | :----------------------------------------------------------------------------------------------------------------------- |
| coding        | `find_implementation`, `trace_callers`, `onboard_to_project`, `init_arch_memory`, `audit_architecture`, `record_lesson_from_correction` |
| support       | `triage_incident`, `prepare_release_notes`, `assess_change_impact`, `onboard_to_project`                                 |
| knowledge     | none                                                                                                                     |

## Resources

On the coding and support endpoints:

- `context://project-overview`: indexed groups and projects with chunk counts;
- `arch://schema`: the card format of architectural memory and its duplicate thresholds;
- `arch://stats/{group}`: card counts by kind and status, oldest and newest update.

## Typical flows

**Before changing code (coding):**

```
1. search_code "where do we retry failed payments"   → the chunks, with file and lines
2. change_impact {chunk_id}                          → callers up to 3 steps out, and their tests
3. get_chunk <chunk_id> --radius_lines 50            → more of the code around a hit
```

**Getting to know a codebase (coding or support):**

```
1. module_map {project}                              → modules, main files, who uses whom
2. find_usages {chunk_id, direction: "incoming"}     → who calls a file's main function
```

**Answering a question about a feature (support):**

```
1. explain_feature "How does rate limiting work?"    → where it lives, recent changes
2. get_chunk_meta <chunk_id>                         → who changed it last, linked tickets
3. recent_changes "rate limit" --since 2026-01-01    → timeline with tickets
```

**Architectural memory (coding):**

```
1. arch_context "why is the prose layer a separate collection?"
                                                     → components, decisions, lessons, with age
2. arch_record_decision { title, context, decision, alternatives_rejected, consequences }
                                                     → created | duplicate | similar
3. arch_record_lesson   { rule, why, when }          → created | updated
```

Architectural memory and the glossary are described in
[architectural-memory.md](architectural-memory.md).
