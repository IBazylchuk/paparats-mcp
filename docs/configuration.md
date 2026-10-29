# Configuration

Two files, both optional: `~/.paparats/projects.yml` lists what to index, and a
`.paparats.yml` in a repository tunes that repository (when present, it needs `group` and
`language`). Then the CLI and the environment
variables.

## `~/.paparats/projects.yml`: what to index

Lives outside your repositories. `paparats add` and `paparats remove` edit it, or open it
with `paparats edit projects`. Every entry has `path:` (a local folder, mounted read-only
into the indexer) or `url:` (a GitHub repository, cloned by the indexer), never both.

```yaml
defaults:
  cron: '0 */6 * * *' # full pass over every repo
  cron_fast: '*/10 * * * *' # change check
  group: workspace # group for entries that do not name one

repos:
  - path: /Users/alice/code/billing # a local folder
    group: dev
    language: typescript

  - url: org/widgets # a GitHub repository, owner/repo
    group: prod
    language: ruby

  - url: acme/billing-service
    name: billing # instead of the name taken from the repo
    group: prod
```

The indexer reloads the file on save; what happens then is in
[install.md](install.md#paparats-install). Remote entries are GitHub repositories;
`paparats add` refuses other hosts. Private ones need `GITHUB_TOKEN` in `~/.paparats/.env`.

## `.paparats.yml`: one repository

Committed with the repository. `group`, `docs` and `indexing` set for it in `projects.yml`
(directly or under `defaults`) are layered on top and win, and the indexer's
`PAPARATS_GROUP` overrides any group. The CLI never writes this file. Examples per language
are in [`examples/`](../examples/).

```yaml
group: my-app
language: typescript

indexing: # all optional
  paths: [src, packages] # only these folders
  exclude: [node_modules, dist, '**/*.test.ts']
  exclude_extra: ['**/__fixtures__/**'] # on top of the language defaults
  extensions: [.ts, .vue] # index files with these extensions instead of the language's patterns
  chunkSize: 1500 # characters per chunk, 128–8192 (default 1024)
  overlap: 100 # characters shared by neighbouring fixed-size chunks, files without a grammar (default 128)
  concurrency: 4 # files indexed in parallel (default 2)
  batchSize: 8 # points per Qdrant write (default 50); texts per embedding request are EMBED_BATCH_SIZE (5)

metadata:
  service: billing
  bounded_context: payments
  tags: [backend, critical]
  directory_tags:
    src/api: [public-api]
    src/internal: [internal]
  git: # history per chunk
    enabled: true
    maxCommitsPerFile: 50
    ticketPatterns:
      - '\b([A-Z]+-\d+)\b' # PROJ-123
      - '#(\d+)' # #123

docs: # documentation search, needs INDEX_DOCS=true
  kind: prose # prose | code; leave out to detect
  audience: client # default label for this repo's docs; leave out for internal
```

Exclude patterns follow `.gitignore` rules: a bare name (`dist`, `*.log`) matches at any
depth, a pattern with `/` (`spec/fixtures`, `/tmp`) is relative to the project root, and
either excludes everything under a matching folder. `indexing.paths` takes folders
relative to the project root (`*` allowed); other glob syntax, absolute paths, `..` and
symlinks that lead outside the project are refused, and symlinked files pointing outside
the project or into `.git` are never indexed.

## Groups

A **group** is one Qdrant collection (`paparats_<group>`), and one search covers every
project in it. A project without a group gets `defaults.group`, or `default` when that is
unset, so by default all your projects are searched together. Give projects different
groups to keep them apart.

## Git history per chunk

With `metadata.git.enabled` (the default), the indexer maps every chunk to the commits
that changed its lines and takes ticket references from the commit messages
(`ticketPatterns`; built in: `PROJ-123`, `#42`, `org/repo#99`). The support tools
`get_chunk_meta`, `search_changes`, `recent_changes` and `explain_feature` show it. A
project without git is indexed all the same.

## Keeping the index fresh

The indexer decides when to reindex; the server never watches your files.

- **Change check** (`cron_fast`, every 10 minutes by default). For each repository the
  indexer takes a fingerprint (`git ls-remote` for a remote one, the paths, times and sizes
  of the files for a local folder) and reindexes only when it changed. Unchanged files are
  skipped by content hash and never embedded again. The call graph is updated for the
  changed files only.
- **Full pass** (`cron`): every repository regardless of the fingerprint. The generated
  compose runs it every 6 hours; the indexer's own default is every 3.
- **On demand:** `paparats add` indexes the project it adds, saving
  `paparats edit projects` starts a cycle, and `POST http://localhost:9877/trigger` indexes
  one, some or all repositories:

```bash
curl -X POST http://localhost:9877/trigger -H 'Content-Type: application/json' \
  -d '{"repos": ["your-org/your-repo"]}'
```

Leave out `repos` (or send `[]`) for every project. `"force": true` drops the existing
chunks first; use it after changing the schema. After a change of embedding model it drops
the group's whole collection instead, since old and new vectors cannot be mixed, and
indexes every repository again once the cycle ends
([replacing-embedding-models.md](replacing-embedding-models.md)). A trigger that arrives while a
cycle runs is queued: the answer is `202` with `"status": "queued"`. From CI, the same
`curl` in a job on push to `main` makes a push searchable right away.

`CHANGE_DETECTION=false` turns the change check off. The server keeps search results for
up to 5 minutes, so a repeated query can show the previous answer until then.

## CLI

```text
paparats install [flags]                Set up or reconfigure the stack.
paparats add <path-or-repo> [flags]     Add a local folder or a GitHub repository.
paparats list [--json] [--group g]      Projects and their indexing status.
paparats remove <name> [--yes]          Remove a project and delete its data.

paparats start [--logs]                 Start the stack (--logs follows the logs).
paparats stop                           Stop it; the data volumes stay.
paparats restart                        Recreate the containers, picking up changes.
paparats edit compose|projects          Open the file in $EDITOR. For projects, on save:
                                          check it, regenerate the compose, restart,
                                          reindex. For compose, run `paparats restart`.

paparats search <query> [flags]         Search from the terminal.
paparats status                         Docker, embed server, server, indexer.
paparats groups [--json]                Groups and their projects.
paparats doctor                         Checks: Docker, embed server, ports, configs.
paparats update                         Update the CLI from npm and pull new images.
paparats instructions [dir] [flags]     Write the "paparats or grep" note into the repo's
                                          CLAUDE.md / AGENTS.md (--print, --remove, --file).
```

**`paparats install`**

- `--mode <developer|support>`: `developer` (default) runs the stack; `support` only
  connects clients to an existing server
- `--embeddings <llama|openai|voyage>`: embedding backend (default `llama`, local)
- `--embedding-api-key <key>`: the cloud provider's key (or `OPENAI_API_KEY` /
  `VOYAGE_API_KEY`)
- `--embed-mode <native|docker>`: where the local models run (default: native on macOS,
  Docker on Linux)
- `--embed-url <url>`: an embed server elsewhere; no local one
- `--qdrant-url <url>`, `--qdrant-api-key <key>`: a Qdrant elsewhere; no container
- `--server <url>`: the server for support mode (default: the local one)
- `--force`: answer yes to overwrite and migration prompts
- `--non-interactive`: fail on any prompt instead of asking
- `-v, --verbose`: show Docker output

**`paparats add <path-or-repo>`**: a folder (`.`, `../app`, `~/code/app`, an absolute
path) or a GitHub repository (`owner/repo`, an https or ssh URL).

- `--name <name>`: instead of the folder or repo name
- `--group <group>`: instead of `defaults.group`
- `--language <lang>`: instead of detecting it
- `--no-restart`: no container restart after adding a folder (for scripts)
- `--no-reindex`: do not index it now
- `--force`: drop its existing chunks before indexing (the group's whole collection when another embedding model built it)
- `--non-interactive`: no prompts

**`paparats search <query>`**: `-n, --limit <n>` (default 5), `-p, --project <name>`,
`-g, --group <name>`, `--json`.

**`paparats update`**: `--skip-cli`, `--skip-docker`, `--skip-embed`.

`search`, `status`, `groups` and `doctor` take `--server <url>`.

## API key (optional)

The server and the indexer answer anyone who reaches their ports, which is fine on
localhost or on a server reached only over a VPN. To ask for a key, set
`PAPARATS_API_KEY` in `~/.paparats/.env` (or the `.env` next to a plain compose file) and
restart:

```bash
echo "PAPARATS_API_KEY=$(openssl rand -hex 32)" >> ~/.paparats/.env
paparats restart
```

- **What it guards.** Every route of the server (`/mcp`, `/support/mcp`, `/api/*`,
  `/metrics`) and of the indexer (`/trigger`, `/metrics`) then wants
  `Authorization: Bearer <key>`. `/health` stays open for health checks, but shows
  only the status to a caller without the key. `/knowledge/mcp` keeps its own tokens.
- **Browser pages.** `/ui` and the code map take the key as a basic-auth password, with
  any user name, unless `PAPARATS_UI_BASIC_AUTH` is set, which then guards them instead.
- **Clients.** The CLI reads the key from `~/.paparats/.env` or `PAPARATS_API_KEY` in its
  environment. `paparats install` passes it to Cursor and Claude Code (`--api-key` in
  support mode). Other clients are in [clients.md](clients.md#a-server-with-an-api-key).
- **Several keys.** List them comma-separated to change one without cutting off the
  clients of another. Each must be at least 16 characters; a key that is not stops the
  start rather than leaving the server open.
- **Plain HTTP.** The key goes over the network as is: on another host, put the server
  behind HTTPS or a VPN.
- **Qdrant and the embed server.** The key does not cover them, and they have no auth of
  their own in the generated stack. Their ports are published on `127.0.0.1` only: the
  server and the indexer reach them over the compose network. `QDRANT_BIND=0.0.0.0` (or
  `EMBED_BIND`) in `.env` publishes one to the network; Qdrant holds the indexed code,
  so give it a key first (`QDRANT__SERVICE__API_KEY` on the `qdrant` service, the same
  value as `QDRANT_API_KEY`).

## Environment variables

**CLI.** Every command finds the stack on the ports in `~/.paparats/.env`. These replace a
whole address:

| Var                    | Default                 | What                         |
| ---------------------- | ----------------------- | ---------------------------- |
| `PAPARATS_SERVER_URL`  | `http://localhost:9876` | The server                   |
| `PAPARATS_INDEXER_URL` | `http://localhost:9877` | The indexer                  |
| `QDRANT_URL`           | `http://localhost:6333` | Qdrant, for the checks in `install`, `update` and `doctor` |
| `PAPARATS_API_KEY`     | from `~/.paparats/.env` | The key sent to the server and the indexer, when they ask for one |

**`~/.paparats/.env`.** The generated compose reads these from it, so they survive
regeneration: the ports (`PAPARATS_PORT`, `INDEXER_PORT`, `QDRANT_PORT`, `EMBED_PORT`),
the addresses Qdrant and the embed server are published on (`QDRANT_BIND`, `EMBED_BIND`,
default `127.0.0.1`),
`CRON`, `INDEX_DOCS`, `GITHUB_TOKEN`, `PAPARATS_API_KEY`, `QDRANT_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`,
`EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `TEXT_EMBEDDING_MODEL`,
`TEXT_EMBEDDING_DIMENSIONS`, `EMBED_BATCH_SIZE`, `EMBED_TTL`, `LLAMA_BATCH`,
`LLAMA_THREADS`, `EMBED_CPUS`, `EMBED_MEMORY`. Run `paparats restart` after a change.

Anything else (`CRON_FAST`, `PAPARATS_METRICS`, `PAPARATS_PROJECTS`, ...) goes into the
service's `environment:` in `~/.paparats/docker-compose.yml` (`paparats edit compose`).
`paparats add`, `remove`, `edit projects` and `update` regenerate the compose when it
changes and keep the old one as `docker-compose.yml.bak`; re-apply such hand edits from
there. `cron` and `cron_fast` are better set in `projects.yml`, which is never regenerated.

**Indexer** (`paparats-indexer`)

| Var                       | Default                    | What                                                              |
| ------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `CRON`                    | `0 */3 * * *` (generated compose: `0 */6 * * *`) | Full pass; `defaults.cron` in `projects.yml` wins |
| `CRON_FAST`               | `*/10 * * * *`             | Change check; `defaults.cron_fast` wins                           |
| `CHANGE_DETECTION`        | `true`                     | `false` leaves only the full pass                                 |
| `INDEX_DOCS`              | `false`                    | `true` also indexes each repo's markdown                          |
| `STATE_DB_PATH`           | `/data/indexer-state.db` (generated compose: on the `paparats_data` volume) | The per-repo fingerprints |
| `CONFIG_DIR`              | `/config`                  | Folder with `projects.yml`                                        |
| `REPOS`                   | none                       | Comma-separated repos, only when there is no `projects.yml`       |
| `PAPARATS_GROUP`          | none                       | Put every repo into this group                                    |
| `PAPARATS_PROJECT_SUFFIX` | none                       | Suffix for project names, so two deployments can share a Qdrant   |
| `GITHUB_TOKEN`            | none                       | For private GitHub repositories                                   |
| `PAPARATS_API_KEY`        | none                       | Optional key for `/trigger` and `/metrics` ([API key](#api-key-optional)) |

**Server** (`paparats`). The full list is in
[packages/server/README.md](../packages/server/README.md#configuration-env-vars).

| Var                         | Default                    | What                                                      |
| --------------------------- | -------------------------- | --------------------------------------------------------- |
| `QDRANT_URL`                | `http://localhost:6333`    | Qdrant                                                    |
| `EMBED_URL`                 | `http://127.0.0.1:18434`   | The embed server                                          |
| `EMBEDDING_PROVIDER`        | `llama`                    | `llama`, `openai` or `voyage` for code                    |
| `TEXT_EMBEDDING_PROVIDER` / `_MODEL` / `_DIMENSIONS` | `llama` / `qwen3-embedding-0.6b` / `1024` | For architectural memory, docs and the glossary |
| `PAPARATS_PROJECTS`         | none                       | Only these projects are served                            |
| `PAPARATS_DOCS_AUDIENCE`    | none                       | Audience ceiling for docs on the coding and support endpoints |
| `PAPARATS_API_KEY`          | none                       | Optional key for every route but `/health` ([API key](#api-key-optional)) |

**Embed container** (`embed`, Docker embed mode)

| Var                           | Default      | What                                                      |
| ----------------------------- | ------------ | --------------------------------------------------------- |
| `EMBED_TTL`                   | `0`          | Idle seconds before a model unloads; `0` keeps them loaded |
| `LLAMA_BATCH`                 | `2048`       | Compute batch size per model                              |
| `LLAMA_THREADS`               | `-1` (auto)  | CPU threads per model                                     |
| `EMBED_CPUS` / `EMBED_MEMORY` | none / `6G`  | Container CPU and memory limits                           |

Monitoring variables are in [observability.md](observability.md#configuration-matrix).
