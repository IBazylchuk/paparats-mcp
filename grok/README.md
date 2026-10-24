# Paparats — Grok Build plugin

Semantic code search over every repository you index, served by a Paparats
server running on your own machine.

## What it adds

- **MCP server `paparats`** at `http://localhost:9876/mcp` (Streamable HTTP).
- **Skill `paparats-search`** — when to use semantic search and when a text
  search is the better tool.

## Network endpoints and credentials

The plugin talks to one endpoint, `http://localhost:9876/mcp`, which is the
Paparats server you install and run yourself. It needs no API key or token and
reads no credentials from disk. Search questions and code chunks stay on your
machine.

## Requirements

Install and start Paparats first (Docker required): install `@paparats/cli`
from npm, run `paparats install`, then `paparats add <path>` for each
repository. Full steps: https://github.com/IBazylchuk/paparats-mcp
