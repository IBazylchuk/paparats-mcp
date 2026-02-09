# MCP Prompts

Tool descriptions and system instructions for the MCP server. Edit `prompts.json` to change:

- **serverInstructions** — System prompt telling the AI when to use search_code
- **tools.search_code** — When to use semantic search (e.g. "how many X", "what versions of X")
- **tools.health_check** / **tools.reindex** — Tool descriptions
- **resources.projectOverview** — Project overview resource template

Changes apply after server restart. No rebuild needed for JSON edits (in dev with ts-node/watch).
