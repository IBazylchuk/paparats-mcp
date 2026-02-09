# @paparats/cli

CLI for [Paparats MCP](https://github.com/IBazylchuk/paparats-mcp) — semantic code search across multiple repositories. MCP server powered by Qdrant vector search and Ollama embeddings, designed for AI coding assistants (Claude Code, Cursor).

## Install

```bash
npm install -g @paparats/cli
```

## Prerequisites

- **Docker** + **Docker Compose** — runs Qdrant and MCP server
- **Ollama** — local embedding model (on host)

## Quick start

```bash
# 1. Ensure Docker, Docker Compose, and Ollama are installed
docker --version && docker compose version && ollama --version

# 2. One-time setup: starts Qdrant + MCP server, downloads GGUF (~1.6 GB)
paparats install

# 3. In your project
cd your-project
paparats init   # creates .paparats.yml
paparats index  # index the codebase

# 4. Run watch to keep the index in sync when files change
paparats watch

# 5. Connect your IDE (Cursor, Claude Code) to the MCP server
```

See the [full documentation](https://github.com/IBazylchuk/paparats-mcp#readme) for MCP setup and configuration.
