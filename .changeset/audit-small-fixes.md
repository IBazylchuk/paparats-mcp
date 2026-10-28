---
'@paparats/server': patch
'@paparats/cli': patch
---

Small fixes from the docs and code audit:

- **Server.** `health_check` reports the server version.
- **Server.** A pull request named in brackets, as a GitHub squash merge writes it (`feat: x (#123)`), is now read as a ticket.
- **Server.** `indexing.extensions` now selects the files to index within `indexing.paths`, in place of the language's patterns. Before, it was accepted and ignored.
- **CLI.** The native embed config allocates batch buffers of 2048 tokens instead of 8192, as the Docker image does. A chunk is a few hundred tokens, and the larger buffers cost gigabytes of memory.
- **CLI.** `paparats doctor` no longer fails without a `.paparats.yml`, which is optional, and it now checks the indexer.
- **CLI.** `paparats doctor` and `paparats status` find the embed server through `EMBED_URL` or `EMBED_PORT` in `~/.paparats/.env`, not a fixed `localhost:18434`.
- **CLI.** `paparats status` shows whether the indexer is running.
