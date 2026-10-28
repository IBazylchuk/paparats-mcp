# Paparats — Claude Code plugin

Paparats gives Claude semantic search over every repository you index: find code
by what it does, follow callers through a symbol graph, and read the exact chunk
instead of whole files. Indexing and search run on your machine with a local
embedding model and Qdrant, so your code never leaves it.

![Paparats](icon.png)

## What it adds

- **MCP server `paparats`** — connects to the Paparats server you run locally,
  by default at `http://localhost:9876/mcp`. The address is the `server_url`
  option, so you can point it at the support endpoint (`/support/mcp`) or at a
  shared server instead.
- **Skill `paparats-search`** — tells Claude when to use semantic search, when a
  plain text search is the better tool, and that search results are a ranking
  rather than a complete list.

## Requirements

The plugin does not start the server. Install and start Paparats first (Docker
is required): install the CLI from npm as `@paparats/cli`, run its `install`
command, then add the repositories you want indexed with its `add` command.
Full steps are in the main repository README.

## What it runs, sends and fetches

The plugin runs nothing on its own. Claude sends your search questions to the
Paparats server at the configured URL and reads back code chunks from your own
index. With the default URL and local models, your code and queries stay on your machine (see [PRIVACY.md](../PRIVACY.md)).

## Install

```
/plugin marketplace add IBazylchuk/paparats-mcp
/plugin install paparats@paparats
```

## Links

- Source and docs: https://github.com/IBazylchuk/paparats-mcp
- Issues: https://github.com/IBazylchuk/paparats-mcp/issues
