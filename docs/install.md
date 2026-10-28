# Installing Paparats

Four ways to run it:

- [plain `docker compose`](#plain-docker-compose): two files and one command, the easiest;
- [`paparats install`](#paparats-install): the CLI, which also mounts local folders and on
  macOS runs the models natively with Metal;
- [GitHub Codespaces](#github-codespaces): try it without installing anything locally;
- [support mode](#support-mode-connect-to-an-existing-server): connect clients to a
  server someone already runs.

You need **Docker with Compose v2** for the first two, and **Node.js 24+** for the CLI.

## Plain `docker compose`

The easiest way: no Node, no CLI. [`examples/docker-compose/`](../examples/docker-compose/)
holds the files `paparats install` would generate.

```bash
mkdir paparats && cd paparats
base=https://raw.githubusercontent.com/IBazylchuk/paparats-mcp/main/examples/docker-compose
curl -fsSLO $base/docker-compose.yml        # local models
curl -fsSLO $base/projects.yml
curl -fsSL  $base/.env.example -o .env      # optional: keys, ports, INDEX_DOCS
docker compose up -d
```

For Voyage AI instead of local models, take `docker-compose.voyage.yml`, set
`VOYAGE_API_KEY` in `.env` and run `docker compose -f docker-compose.voyage.yml up -d`.

`projects.yml` indexes this repository from GitHub; replace it with yours. It is reloaded
on save; `docker compose logs -f paparats-indexer` shows the progress. A local
folder needs an entry with its host path and a name (`path: /abs/path/app`, `name: app`)
and a matching mount in the `paparats-indexer` service (`- /abs/path/app:/projects/app:ro`);
the comments in `projects.yml` show both. Then connect a client to
`http://localhost:9876/mcp` ([clients.md](clients.md)).

On macOS the models run in Docker on the CPU only; the CLI below runs them natively with
Metal, which is much faster.

## `paparats install`

```bash
npm install -g @paparats/cli

# macOS only: the embedding server runs natively, with Metal. In Docker on macOS it
# cannot use the GPU and is much slower. Skip this with --embeddings voyage|openai.
brew install llama.cpp mostlygeek/llama-swap/llama-swap

paparats install
paparats add ~/code/my-app        # a local folder, `.` works too
paparats add acme/widgets         # a GitHub repository, cloned by the indexer
paparats list                     # indexing progress
```

`paparats install` creates `~/.paparats/`, starts the Docker stack, waits until every
service answers and connects Cursor and Claude Code to `http://localhost:9876/mcp`. When a
service does not come up, it names it and prints the `docker compose ... logs` command to
look at it. Re-run it any time to reconfigure: it shows what changes in the compose file
and asks before overwriting hand edits.

```
~/.paparats/
├── docker-compose.yml          generated; hand-editable; install asks before overwriting
├── projects.yml                the project list (the CLI rewrites it)
├── install.json                install flags, so add/remove can regenerate the compose; chmod 600
├── .env                        keys, ports and overrides; chmod 600
├── models/                     GGUF model files (native embed mode)
└── llama-swap.yaml, llama-swap.log   native embed server config and log (native embed mode)
```

Indexed data lives in Docker volumes, not in this folder: `qdrant_data` (vectors),
`paparats_data` (metadata, call graph, embedding cache, analytics, the indexer's state)
and `indexer_repos` (cloned repositories). `~/.paparats` is mounted read-only into the
indexer at `/config`, which is how it reads `projects.yml`.

The stack:

| Service            | Image                          | Host port | Role                                                    |
| ------------------ | ------------------------------ | --------- | ------------------------------------------------------- |
| `paparats`         | `ibaz/paparats-server:latest`  | 9876      | MCP endpoints, search, HTTP API, `/ui` console          |
| `paparats-indexer` | `ibaz/paparats-indexer:latest` | 9877      | Indexing on a schedule and on demand, reloads `projects.yml` |
| `qdrant`           | `qdrant/qdrant:latest`         | 6333      | Vector database (left out with `--qdrant-url`)          |
| `embed`            | `ibaz/paparats-embed:latest`   | 18434     | Local embedding models (Docker embed mode only)         |

Change host ports with `PAPARATS_PORT`, `INDEXER_PORT`, `QDRANT_PORT` and `EMBED_PORT` in
`~/.paparats/.env`; every CLI command reads them from there. The embed port is 18434, not
Ollama's 11434, so the two can run side by side.

`projects.yml` is reloaded on save. Changing a project's group, language or indexing
settings reindexes it in place (a new group drops its data in the old one); removing an
entry deletes its chunks, metadata and docs. Adding or removing a local folder needs a
container restart for the new mount, which `paparats add` and `paparats remove` do for you.

### Variants

```bash
paparats install                                   # macOS: native embed server; Linux: Docker
paparats install --embeddings voyage --embedding-api-key pa-...   # no local models
paparats install --embeddings openai --embedding-api-key sk-...
paparats install --qdrant-url https://qdrant.example.com          # your own Qdrant; asks for its key
paparats install --embed-url http://10.0.0.5:18434                # your own embed server
paparats install --embed-mode docker               # Docker embed server on macOS (no Metal)
paparats install --non-interactive --force         # scripts and CI: no prompts
```

- **Cloud embeddings** (`--embeddings voyage|openai`): code, queries, docs and
  architectural memory are embedded by that provider, so they are sent to it (see
  [PRIVACY.md](../PRIVACY.md)). No local models are downloaded. Pick the provider's model
  with `EMBEDDING_MODEL` in `~/.paparats/.env`, for example `voyage-code-4`; a new model
  means indexing everything again. Details in [embeddings.md](embeddings.md).
- **Your own Qdrant** (`--qdrant-url`): the Qdrant container is left out; the API key goes
  to `~/.paparats/.env` as `QDRANT_API_KEY`.
- **Your own embed server** (`--embed-url`): no native or Docker embed server here. The
  remote one must serve `bge-code-v1` and `qwen3-embedding-0.6b` over an OpenAI-style
  `/v1/embeddings` API. The simplest is the same image on that host:
  `docker run -d -p 18434:8080 ibaz/paparats-embed:latest`.

### Hardware

With local models: about 2.3 GB of disk for the two GGUF files in native mode, or a 2.5 GB
download for the embed image in Docker mode. The embed container reserves 2 GB of RAM and
may use up to 6 GB (`EMBED_MEMORY`); `EMBED_CPUS` caps its CPUs (no cap by default). CPU
only works; on macOS the native build with Metal is much faster. With a cloud provider the
stack is the server, the indexer and Qdrant.

### Migrating from a per-project install (before 0.4.0)

`paparats install` recognises the old per-project compose (no `paparats-indexer` service),
explains what will change and asks before replacing it. Qdrant collections, SQLite
metadata, cloned repositories and the `.paparats.yml` files in your repos are kept; the
old `docker-compose.yml` and `.env` are regenerated. Nothing is reindexed: add the
projects again with `paparats add` and they show their existing chunks. An old
`paparats-indexer.yml` is renamed to `projects.yml` on the first run. `--force` skips the
prompt.

## GitHub Codespaces

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/IBazylchuk/paparats-mcp)

The dev container starts the stack in your own Codespace (it is not a hosted service) and
registers this repository. With only the CPU embedding server, just `packages/shared/src`
is indexed, since the whole repository would take a long time. Add `VOYAGE_API_KEY` or
`OPENAI_API_KEY` as a Codespaces secret and the whole repository is indexed. Then:

```bash
paparats list
paparats search -g demo 'gitignore filter'
```

For an MCP client outside the Codespace, use the address the Ports panel shows for port
9876, with `/mcp` at the end.

## Support mode: connect to an existing server

For people and bots who use a server that runs elsewhere: no Docker, no models.

```bash
paparats install --mode support                                     # local server
paparats install --mode support --server http://paparats.example.com:9876
```

It checks that the server answers, then connects Cursor and Claude Code to its
`/support/mcp` endpoint. When the `claude` CLI is not on the PATH, it prints the command to
run. The support endpoint is read-only; its tools are in [tools.md](tools.md#support-endpoint-supportmcp).
