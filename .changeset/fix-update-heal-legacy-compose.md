---
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

Fix `paparats update` leaving the Dockerised server/indexer unable to reach the embed server (`llama-server failed after 3 retries: fetch failed`), and move the native embed off Ollama's port so the two can coexist.

- **Heal legacy compose on update.** Installs that predate `install.json` (Ollama-era) had compose files generated before the `EMBED_URL` env existed, so the containers fell back to `127.0.0.1` — themselves — instead of `host.docker.internal`. Update previously *skipped* compose regeneration when `install.json` was missing, so the stale file was never repaired. Update now derives the embed/qdrant config from the existing compose (`deriveRegenerateOptsFromCompose`, scoped to the `services:` block to avoid false positives from `volumes:`/`networks:`), regenerates so `EMBED_URL` is written, and records a fresh `install.json`. `paparats edit` reuses the same helper.
- **Dedicated embed port 18434 (was 11434).** llama-swap no longer squats Ollama's default port, so a host running Ollama for other tools is unaffected and an embed call can't silently hit Ollama (which rejects the jina-code model). The port is updated consistently across the compose generator, all `EMBED_URL` defaults (server, indexer, CLI), the launchd/spawn listen address, and the doctor/status health checks.
