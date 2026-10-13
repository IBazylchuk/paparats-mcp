# MCP Prompts

Tool descriptions and system instructions for the MCP server. Edit `prompts.json` to change:

- **codingInstructions** — System prompt for the coding endpoint (`/mcp`): search-first workflow, grep/file reading fallback
- **supportInstructions** — System prompt for the support endpoint (`/support/mcp`): decision tree for high-level tools, plain language answers, ticket references
- **knowledgeInstructions** — System prompt for the knowledge endpoint (`/knowledge/mcp`): written for an outside agent answering non-engineers — cite the source link, fetch the whole document when an excerpt is not enough, empty means "not documented", never a source of numbers or live data
- **tools.\*** — Tool descriptions shared by the coding and support modes (each tool is registered only in the modes that include it)
- **knowledgeTools.\*** — The knowledge endpoint's own descriptions of `search_docs` and `get_document`
- **resources.projectOverview** — Project overview resource template (shared)

The server exposes three MCP endpoints with different tool sets. The knowledge endpoint
serves `search_docs` and `get_document` only; the coding and support ones differ as
follows:

| Tool              | Coding (`/mcp`) | Support (`/support/mcp`) |
| ----------------- | :-------------: | :----------------------: |
| `search_code`     |       yes       |           yes            |
| `get_chunk`       |       yes       |           yes            |
| `find_usages`     |       yes       |           yes            |
| `health_check`    |       yes       |           yes            |
| `delete_project`  |       yes       |            —             |
| `get_chunk_meta`  |        —        |           yes            |
| `search_changes`  |        —        |           yes            |
| `explain_feature` |        —        |           yes            |
| `recent_changes`  |        —        |           yes            |
| `impact_analysis` |        —        |           yes            |
| `get_document`    |        —        |           yes            |

Changes apply after server restart. No rebuild needed for JSON edits (in dev with ts-node/watch).
