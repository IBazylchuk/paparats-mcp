---
'@paparats/cli': patch
---

Fix `paparats update` leaving the Dockerised server/indexer unable to reach the embed server (`llama-server failed after 3 retries: fetch failed`) on installs that predate `install.json`. Those Ollama-era compose files were generated before the `EMBED_URL` env existed, so the containers fell back to `127.0.0.1:11434` — themselves — instead of `host.docker.internal`. Update previously *skipped* compose regeneration whenever `install.json` was missing, so the stale file was never repaired. Now update derives the embed/qdrant config from the existing compose (`deriveRegenerateOptsFromCompose`), regenerates the file so `EMBED_URL: http://host.docker.internal:11434` is written, and records a fresh `install.json` for subsequent runs. `paparats edit` reuses the same derivation helper.
