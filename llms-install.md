# Installing Paparats for an AI agent

Paparats MCP is a self-hosted MCP server for semantic code search across many
repositories. It runs as a small Docker stack (Qdrant, the MCP server, an indexer and an embedding server) and
serves MCP over Streamable HTTP at `http://localhost:9876/mcp`. It is not
started with `npx`; install the CLI and let it start the stack.

## Requirements

- Node.js 24 or newer
- Docker with Docker Compose v2, running
- macOS only: the native embedding server, which uses Metal and is much faster
  than the Docker image on Apple Silicon:
  `brew install llama.cpp mostlygeek/llama-swap/llama-swap`

## Steps

1. Install the CLI:

   ```bash
   npm install -g @paparats/cli
   ```

2. Bootstrap the stack. This writes `~/.paparats/`, starts the containers and
   downloads the embedding models (about 2.3 GB on first run):

   ```bash
   paparats install --non-interactive
   ```

   On macOS without the native embedding server this stops with an error;
   install it as above, or pass `--embed-mode docker` to run it in Docker
   instead.

3. Index the user's project. Ask the user which directory to index; use the
   current workspace if they do not say otherwise:

   ```bash
   paparats add /absolute/path/to/project
   ```

4. Check that the stack is up and the project is listed:

   ```bash
   paparats status
   paparats list
   ```

5. Add the server to the MCP client configuration:

   ```json
   {
     "mcpServers": {
       "paparats": {
         "type": "streamableHttp",
         "url": "http://localhost:9876/mcp"
       }
     }
   }
   ```

   The transport key differs between clients: Cline uses
   `"type": "streamableHttp"`, Cursor and Claude Code use `"type": "http"`,
   Antigravity uses `"serverUrl"`, Gemini CLI uses `"httpUrl"`. No API key
   is needed.

6. Optionally, ask the user whether to add a short note on when to use
   semantic search and when grep to the project's `CLAUDE.md` / `AGENTS.md`.
   It edits a file in their repository, so only run it if they agree:

   ```bash
   paparats instructions /absolute/path/to/project
   ```

## Verifying

Call the `health_check` tool, then `search_code` with a question about the
indexed project, for example "where is the HTTP server started". Indexing a
large repository on CPU takes several minutes; `health_check` shows progress.
After the first index, the indexer picks up code changes on its own within about
10 minutes; there is no file watcher, so do not expect edits to be searchable
within seconds.
