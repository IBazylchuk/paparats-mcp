# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue: on GitHub, open the repository's
**Security** tab and choose **Report a vulnerability**. Say what is affected, how to
reproduce it and which version you ran. A fix ships in a patch release, and the advisory
is published once it is out.

## Supported versions

Fixes go into the latest release only. Update with `paparats update` (or pull the latest
`ibaz/paparats-*` images).

## How a deployment is exposed

- **Open by default.** The server (`:9876`) and the indexer (`:9877`) answer anyone who
  reaches their ports. That suits localhost and a server reached only over a VPN. For
  anything wider, set `PAPARATS_API_KEY`: every route but `/health` then wants
  `Authorization: Bearer <key>` ([configuration.md](docs/configuration.md#api-key-optional)).
  The key travels as is, so use HTTPS or a VPN between hosts.
- **Write tools.** The coding endpoint (`/mcp`) can delete projects and write
  architectural memory and the glossary; the support endpoint (`/support/mcp`) is
  read-only. Give support people and bots the support endpoint.
- **Knowledge endpoint.** `/knowledge/mcp` is the one route meant for callers outside
  the trust boundary: off unless configured, with its own bearer tokens, a small body
  limit and an audience ceiling
  ([documentation-search.md](docs/documentation-search.md#knowledge-endpoint-knowledgemcp)).
- **Browsers.** Requests from other sites are refused (`403` for a foreign `Origin`)
  unless listed in `PAPARATS_CORS_ORIGINS`.
- **Qdrant and the embed server** have no auth of their own in the generated stack, and
  the API key does not cover them. Their ports are published on `127.0.0.1` only
  (`QDRANT_BIND` / `EMBED_BIND` change that); the services reach them over the compose
  network. `QDRANT_API_KEY` covers an external Qdrant. The native embed server
  listens on every interface, so containers can reach it: it holds no code, but keep its
  port (`18434`) off untrusted networks.
- **Data.** Indexed code, the embedding cache and the analytics database stay on the
  machine running the stack, except where `PRIVACY.md` lists an opt-in exception (a cloud
  embedding provider, tracing).
