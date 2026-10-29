---
'@paparats/server': patch
'@paparats/indexer': patch
'@paparats/cli': patch
---

An optional API key for the server and the indexer. Unset, as before, they answer anyone who reaches their ports, which suits localhost and a server reached over a VPN. With `PAPARATS_API_KEY` set (one key, or several separated by commas, each at least 16 characters), every route asks for `Authorization: Bearer <key>`: the MCP endpoints, `/api/*`, `/metrics` and the indexer's `/trigger`. `/health` stays open for health checks and shows only the status to a caller without the key; `/knowledge/mcp` keeps its own tokens. The `/ui` pages take the key as a basic-auth password, unless `PAPARATS_UI_BASIC_AUTH` guards them. A key the server cannot use stops it from starting.

The CLI reads the key from `~/.paparats/.env` or its environment and sends it. `paparats install` passes it to Cursor and Claude Code as a header, and `paparats install --mode support --api-key <key>` does the same for a server elsewhere. The generated compose passes `PAPARATS_API_KEY` from `.env` to both services.

The key does not cover Qdrant, which holds the indexed code, or the embed server, and neither has auth of its own in the generated stack. Their ports are now published on `127.0.0.1` only; the server and the indexer reach them over the compose network, as before. `QDRANT_BIND=0.0.0.0` or `EMBED_BIND=0.0.0.0` in `.env` publishes one to the network again. New `SECURITY.md`: how to report a vulnerability and how a deployment is exposed.
