# Connecting MCP clients

Every client talks Streamable HTTP to one of the endpoints, with no API key unless the
server asks for one ([below](#a-server-with-an-api-key)):

- `http://localhost:9876/mcp`: coding, for the agent you write code with;
- `http://localhost:9876/support/mcp`: support, read-only, for support people and bots;
- `/knowledge/mcp`: docs only, opt-in, with a bearer token
  ([documentation-search.md](documentation-search.md#knowledge-endpoint-knowledgemcp)).

`paparats install` already connects Cursor and Claude Code to the coding endpoint, and
`paparats install --mode support` connects both to the support endpoint. The sections
below are for other clients, a server on another host, or both endpoints side by side.
The old SSE routes (`/sse`, `/support/sse`) remain for clients without Streamable HTTP.

## Claude Code

```bash
# --scope user: every project (~/.claude.json); leave it out for the current project only
claude mcp add --scope user --transport http paparats http://localhost:9876/mcp
claude mcp add --scope user --transport http paparats-support http://localhost:9876/support/mcp
```

Or in `.mcp.json` at the project root:

```json
{ "mcpServers": { "paparats": { "type": "http", "url": "http://localhost:9876/mcp" } } }
```

### Claude Code plugin

The repository is also a plugin marketplace. The plugin registers the coding endpoint and
adds a `paparats-search` skill that tells Claude when to search by meaning and when to grep:

```bash
/plugin marketplace add IBazylchuk/paparats-mcp
/plugin install paparats@paparats
```

Its `server_url` option (default `http://localhost:9876/mcp`) takes `/support/mcp` or a
shared server's address instead.

## Cursor

`~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "paparats": { "type": "http", "url": "http://localhost:9876/mcp" },
    "paparats-support": { "type": "http", "url": "http://localhost:9876/support/mcp" }
  }
}
```

Restart Cursor after the change. A Cursor plugin manifest is in `.cursor-plugin/`.

## Codex

`~/.codex/config.toml`, or a trusted project's `.codex/config.toml`; a `url` key means
Streamable HTTP:

```toml
[mcp_servers.paparats]
url = "http://localhost:9876/mcp"
```

## GitHub Copilot (VS Code)

`.vscode/mcp.json` in the workspace, or the user configuration (**MCP: Open User
Configuration**):

```json
{ "servers": { "paparats": { "type": "http", "url": "http://localhost:9876/mcp" } } }
```

## Windsurf

Cascade's MCP settings → **View raw config** (`mcp_config.json`). Windsurf takes the
address as `serverUrl`:

```json
{ "mcpServers": { "paparats": { "serverUrl": "http://localhost:9876/mcp" } } }
```

## Antigravity

The Antigravity CLI (`agy`) installs the repository as a plugin (`plugin.json` +
`mcp_config.json`):

```bash
agy plugin install https://github.com/IBazylchuk/paparats-mcp
```

By hand, in `~/.gemini/config/mcp_config.json`. Antigravity reads `serverUrl`, not the
older `url` / `httpUrl`:

```json
{ "mcpServers": { "paparats": { "serverUrl": "http://localhost:9876/mcp" } } }
```

## Gemini CLI

Installs the repository as an extension (`gemini-extension.json`, `httpUrl`):

```bash
gemini extensions install https://github.com/IBazylchuk/paparats-mcp
```

## Grok Build, Cline and others

`grok/` is a Grok Build plugin (the MCP server and the same skill).
[`llms-install.md`](../llms-install.md) is an install guide written for an agent: Cline, or
any agent, can follow it to install the CLI, start the stack, index a project and add the
server to its own config. Any client with Streamable HTTP works with the URL above.

## Clients that only start a process (stdio)

`--stdio` serves the coding endpoint over stdin and stdout. It still needs the running
stack for Qdrant and the embedding server:

```json
{
  "mcpServers": {
    "paparats": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "QDRANT_URL=http://host.docker.internal:6333",
        "-e", "EMBED_URL=http://host.docker.internal:18434",
        "ibaz/paparats-server", "node", "packages/server/dist/index.js", "--stdio"
      ]
    }
  }
}
```

On Linux add `"--add-host", "host.docker.internal:host-gateway"` to `args`.

## A server with an API key

When the server runs with `PAPARATS_API_KEY`
([configuration.md](configuration.md#api-key-optional)), each client sends it as a header:

```bash
claude mcp add --scope user --transport http paparats http://paparats.example.com:9876/mcp \
  --header "Authorization: Bearer <key>"
```

```json
{
  "mcpServers": {
    "paparats": {
      "type": "http",
      "url": "http://paparats.example.com:9876/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

The JSON is Cursor's and `.mcp.json`'s form; VS Code takes the same `headers` under
`servers`. Any client that can set a request header works the same way.
`paparats install` does this for Cursor and Claude Code when the key is in
`~/.paparats/.env`, and `paparats install --mode support --api-key <key>` for a server
elsewhere.

## Tell the agent when to use it

The server sends its instructions to every client, but a note in the repository stays in
the agent's context the whole session. `paparats instructions` writes one into the
repository's `CLAUDE.md` and `AGENTS.md` (whichever exist, or a new `AGENTS.md`):

```bash
paparats instructions /path/to/repo            # write or refresh the note
paparats instructions /path/to/repo --print    # show it, write nothing
paparats instructions /path/to/repo --remove   # take it out
```

The note says when `search_code` helps and when grep is better, and points to `get_chunk`,
`find_usages` and `change_impact`. It names the project as the server indexes it: its
`projects.yml` name when the path is registered there, the folder name otherwise, or
`--project <name>`. It sits between `<!-- paparats:begin -->` and `<!-- paparats:end -->`;
a rerun replaces only that part. `--file <name>` picks the file.

## Check it works

- `paparats status`: the stack is up;
- ask the client to list its tools and compare with [tools.md](tools.md);
- ask: _"Search this workspace for the auth middleware and show me what calls it."_
