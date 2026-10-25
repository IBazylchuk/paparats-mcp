# @paparats/cli

CLI for [Paparats MCP](https://github.com/IBazylchuk/paparats-mcp) — a self-hosted MCP
server for semantic code search across many repositories, for Claude Code, Cursor, Codex
and other MCP clients. The CLI installs and manages the whole stack on your machine:
Qdrant, a local llama.cpp embedding server, the MCP server and an indexer. Your code never
leaves your machine.

## Features

- **AST-based code chunking** via tree-sitter (11 languages, including Terraform/HCL) with a regex fallback for other file types
- **Symbol graph** - cross-chunk call/reference relationships (`find_usages`)
- **Vector search** powered by Qdrant + llama.cpp (`bge-code-v1` for code, `Qwen3-Embedding-0.6B` for docs)
- **Git metadata** - commit history and ticket references per chunk
- **Architectural memory** - agent-maintained components / decisions (ADRs) / lessons learned with server-side similarity-gate deduplication (see [main README](https://github.com/IBazylchuk/paparats-mcp#architectural-memory-agent-maintained-adrs-components-lessons))
- **Three MCP endpoints** - coding (`/mcp`), support (`/support/mcp`) and an opt-in docs-only knowledge endpoint, each with its own tool set
- **Automatic freshness** - the indexer checks every repo for changes every 10 minutes and runs a scheduled full pass; `POST /trigger` reindexes on demand
- **Docker-based deployment** - one command sets up Qdrant, the embed server, the MCP server and the indexer

## Install

```bash
npm install -g @paparats/cli
```

## Prerequisites

- **Docker** + **Docker Compose v2** - runs Qdrant, the embed server, the MCP server and the indexer
- **Node.js** >= 24
- **macOS only:** the native embed server (Metal-accelerated): `brew install llama.cpp mostlygeek/llama-swap/llama-swap`

## Quick Start

```bash
# 1. One-time setup: writes ~/.paparats/, starts the Docker stack,
#    downloads the embedding models (~2 GB), wires Cursor if it is installed
paparats install

# 2. Add the projects you want indexed (local path or GitHub repo)
paparats add ~/code/your-project
paparats add your-org/your-repo

# 3. Check the stack and the indexing status
paparats status
paparats list

# 4. Connect Claude Code (Cursor is wired by step 1)
claude mcp add --scope user --transport http paparats http://localhost:9876/mcp
```

Indexing runs in the indexer container: there is no separate `index` or `watch` step.
Changes are picked up by the indexer's change check (every 10 minutes by default).

## Install Modes

```bash
# Default - full Docker stack on this machine
paparats install

# With external Qdrant (skip Qdrant Docker container)
paparats install --qdrant-url https://qdrant.example.com

# With a cloud embedding provider instead of the local embed server
paparats install --embeddings openai --embedding-api-key sk-...

# Support mode - client-only setup, connects to an existing server
paparats install --mode support --server http://paparats.example.com:9876
```

## Commands

| Command                          | Description                                                   |
| -------------------------------- | ------------------------------------------------------------- |
| `paparats install`               | Set up the Docker stack, embedding server and MCP wiring      |
| `paparats add <path-or-repo>`    | Add a project (local path or GitHub URL / `owner/repo`)       |
| `paparats list`                  | Show indexed projects with status from the indexer            |
| `paparats remove <name>`         | Remove a project and delete its indexed data                  |
| `paparats start` / `stop` / `restart` | Manage the Docker stack                                  |
| `paparats edit compose\|projects` | Edit the compose file or project list, then apply it         |
| `paparats search <query>`        | Search indexed code from the terminal                         |
| `paparats status`                | Stack health: Docker, embed server, server, indexer           |
| `paparats groups`                | List groups and their projects                                |
| `paparats doctor`                | Diagnostic checks                                             |
| `paparats update`                | Update the CLI from npm and pull the latest Docker images     |
| `paparats instructions [dir]`    | Write a "when to use paparats, when grep" block into the repo's CLAUDE.md / AGENTS.md |

## MCP Tools

Once connected, your AI assistant gets access to these tools:

**Coding mode** (`/mcp`): `search_code`, `get_chunk`, `find_usages`, `change_impact`, `list_projects`, `delete_project`, `health_check`, `search_docs`, the architectural-memory tools (`arch_context`, `arch_list`, `arch_record_component`, `arch_record_decision`, `arch_record_lesson`, `arch_suggest_components`, `arch_delete`) and the glossary tools (`term_search`, `term_list`, `term_record`, `term_delete`)

**Support mode** (`/support/mcp`): `search_code`, `get_chunk`, `find_usages`, `list_projects`, `health_check`, `get_chunk_meta`, `search_changes`, `explain_feature`, `recent_changes`, `impact_analysis`, `search_docs`, `get_document`, `term_search`, `term_list` and six analytics tools

The full reference is in the [main README](https://github.com/IBazylchuk/paparats-mcp#mcp-tools-reference).

## Configuration

The project list lives in `~/.paparats/projects.yml` (edited by `paparats add` /
`remove` or `paparats edit projects`). A repo can also carry its own `.paparats.yml`:

```yaml
group: my-group
language: typescript

indexing:
  paths: [src, lib]
  exclude: [node_modules, dist, '**/*.test.ts']

metadata:
  service: my-service
  tags: [backend, api]
```

See the [configuration reference](https://github.com/IBazylchuk/paparats-mcp#configuration)
for every option and how `projects.yml` overrides are layered on top.

## Related Packages

| Package                                                                 | Description                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| [@paparats/shared](https://www.npmjs.com/package/@paparats/shared)      | Shared utilities (path validation, gitignore, excludes) |
| [ibaz/paparats-server](https://hub.docker.com/r/ibaz/paparats-server)   | MCP server Docker image                                 |
| [ibaz/paparats-indexer](https://hub.docker.com/r/ibaz/paparats-indexer) | Auto-indexer Docker image                               |
| [ibaz/paparats-embed](https://hub.docker.com/r/ibaz/paparats-embed)     | llama.cpp llama-server + llama-swap with pre-baked embedding models |

## Documentation

See the [full documentation](https://github.com/IBazylchuk/paparats-mcp#readme) for detailed setup guides, architecture overview, and configuration reference.

## License

MIT
