# @paparats/cli

CLI for [Paparats MCP](https://github.com/IBazylchuk/paparats-mcp) - semantic code search across repositories with AST-based chunking, symbol graph, and vector search. Designed for AI coding assistants (Claude Code, Cursor).

## Features

- **AST-based code chunking** via tree-sitter (10 languages) with regex fallback
- **Symbol graph** - cross-chunk call/reference relationships
- **Vector search** powered by Qdrant + Ollama (Jina Code Embeddings)
- **Git metadata** - commit history and ticket references per chunk
- **Dual MCP endpoints** - coding mode and support mode with different tool sets
- **Docker-based deployment** - one command setup with Qdrant, Ollama, and MCP server

## Install

```bash
npm install -g @paparats/cli
```

## Prerequisites

- **Docker** + **Docker Compose** - runs Qdrant, Ollama, and MCP server
- **Node.js** >= 18

## Quick Start

```bash
# 1. One-time setup: starts Docker containers, downloads embedding model (~1.6 GB)
paparats install

# 2. In your project directory
cd your-project
paparats init    # creates .paparats.yml config
paparats index   # index the codebase

# 3. Keep index in sync when files change
paparats watch

# 4. Connect your IDE (Cursor, Claude Code) to the MCP server
```

## Install Modes

```bash
# Developer mode (default) - Docker stack + local project indexing
paparats install --mode developer

# Server mode - full Docker stack with auto-indexer for multiple repos
paparats install --mode server --repos owner/repo1,owner/repo2

# Support mode - client-only setup, connects to existing server
paparats install --mode support --server http://your-server:9876
```

## Commands

| Command                   | Description                                      |
| ------------------------- | ------------------------------------------------ |
| `paparats install`        | Set up Docker containers and configure IDE       |
| `paparats init`           | Create `.paparats.yml` config in current project |
| `paparats index`          | Index the codebase (or reindex after changes)    |
| `paparats watch`          | Watch for file changes and auto-reindex          |
| `paparats search <query>` | Search indexed code from terminal                |
| `paparats doctor`         | Check health of all services                     |
| `paparats status`         | Show indexing status for current project         |

## MCP Tools

Once connected, your AI assistant gets access to these tools:

**Coding mode** (`/mcp`): `search_code`, `get_chunk`, `find_usages`, `health_check`, `reindex`

**Support mode** (`/support/mcp`): all coding tools plus `get_chunk_meta`, `search_changes`, `explain_feature`, `recent_changes`, `impact_analysis`

## Configuration

Project config lives in `.paparats.yml`:

```yaml
project: my-project
group: my-group
language: [typescript]

indexing:
  paths: [src, lib]
  exclude: [node_modules, dist, '**/*.test.ts']

chunking:
  max_lines: 60
  overlap_lines: 5

metadata:
  service: my-service
  tags: [backend, api]
```

## Related Packages

| Package                                                                 | Description                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| [@paparats/shared](https://www.npmjs.com/package/@paparats/shared)      | Shared utilities (path validation, gitignore, excludes) |
| [ibaz/paparats-server](https://hub.docker.com/r/ibaz/paparats-server)   | MCP server Docker image                                 |
| [ibaz/paparats-indexer](https://hub.docker.com/r/ibaz/paparats-indexer) | Auto-indexer Docker image                               |
| [ibaz/paparats-ollama](https://hub.docker.com/r/ibaz/paparats-ollama)   | Ollama with pre-baked embedding model                   |

## Documentation

See the [full documentation](https://github.com/IBazylchuk/paparats-mcp#readme) for detailed setup guides, architecture overview, and configuration reference.

## License

MIT
