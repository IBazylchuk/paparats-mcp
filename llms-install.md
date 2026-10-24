# Installing Paparats for an AI agent

Paparats is a local MCP server for semantic code search. It runs as a small
Docker stack (Qdrant, the MCP server, an indexer and an embedding server) and
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
   downloads the embedding models (about 2 GB on first run):

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

## Verifying

Call the `health_check` tool, then `search_code` with a question about the
indexed project, for example "where is the HTTP server started". Indexing a
large repository on CPU takes several minutes; `health_check` shows progress.
