# MCP Prompts

Tool descriptions and system instructions for the MCP server. Edit `prompts.json` to change:

- **codingInstructions** — System prompt for the coding endpoint (`/mcp`): search-first workflow, grep/file reading fallback
- **supportInstructions** — System prompt for the support endpoint (`/support/mcp`): decision tree for high-level tools, plain language answers, ticket references
- **tools.\*** — Tool descriptions shared across both modes (each tool is registered only in the modes that include it)
- **resources.projectOverview** — Project overview resource template (shared)

The server exposes two MCP endpoints with different tool sets:

| Tool              | Coding (`/mcp`) | Support (`/support/mcp`) |
| ----------------- | :-------------: | :----------------------: |
| `search_code`     |       yes       |           yes            |
| `get_chunk`       |       yes       |           yes            |
| `find_usages`     |       yes       |           yes            |
| `health_check`    |       yes       |           yes            |
| `reindex`         |       yes       |            —             |
| `get_chunk_meta`  |        —        |           yes            |
| `search_changes`  |        —        |           yes            |
| `explain_feature` |        —        |           yes            |
| `recent_changes`  |        —        |           yes            |
| `impact_analysis` |        —        |           yes            |

Changes apply after server restart. No rebuild needed for JSON edits (in dev with ts-node/watch).
