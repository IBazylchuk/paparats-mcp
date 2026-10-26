---
'@paparats/cli': patch
---

First-run fixes found by walking the install from scratch.

- `paparats install` no longer reports "Installation complete" when a service did not come up: it names the service, prints the `docker compose logs` command for it and exits with an error.
- `paparats install` connects Claude Code (`claude mcp add --scope user`) as well as Cursor.
- `paparats add` takes `.`, relative paths and `~/...`; `owner/repo` is still a GitHub repository unless such a folder exists where you run it.
- Ports changed in `~/.paparats/.env` (`PAPARATS_PORT`, `INDEXER_PORT`, `QDRANT_PORT`) are used by every command — health checks, client wiring, `search`, `status`, `doctor`, `list` — instead of the defaults.
- The embed service has no CPU limit by default. The old default of 6 CPUs made Docker refuse to start it on any machine with fewer cores; `EMBED_CPUS` still sets one.
- With Voyage or OpenAI embeddings, architectural memory and docs search now embed with the same provider (`voyage-4` / `text-embedding-3-small`, `TEXT_EMBEDDING_*` in `.env` to change). They were left on the local model, which such an install does not run. `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` in `.env` now reach the containers too.
- The indexer keeps its change-detection state on the shared data volume, so a recreated container no longer starts by rechecking every repository. `INDEX_DOCS` can be set in `.env` and survives `add` / `remove` / `edit`.
- New `examples/docker-compose/`: ready compose files (local models, or Voyage AI with no local models), `projects.yml` and `.env.example`, for running the stack with plain `docker compose up -d`. They are generated from the same code as `paparats install`.
- The Codespaces demo works again: Node 24 (the CLI needs it), the server reached by its service name instead of `localhost`, the workspace user's own `~/.paparats`, and the whole repository indexed when a Voyage or OpenAI key is set as a Codespaces secret.
- The README is now a short first-run guide. Everything else moved into pages under `docs/`: install options, clients, tools, configuration, how it works, architectural memory, documentation search, embedding models, comparison with alternatives; the FAQ stays in the README. Stale lines were fixed on the way: the symbol graph records methods with their class (not only top-level names), model and image sizes are given one way (2.3 GB of models, a 2.5 GB embed image), and `INDEX_DOCS` goes into `.env`.
