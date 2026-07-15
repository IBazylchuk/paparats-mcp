---
'@paparats/cli': patch
---

Migrate the legacy `ollamaMode` field in `install.json` to `embedMode`. Ollama-era installs wrote `{"ollamaMode": "native"}`; the field was renamed to `embedMode` but the reader never migrated it, so `readInstallState` returned a state with an undefined `embedMode`. `paparats update` then took the "state present" path and regenerated the compose with no `EMBED_URL`, leaving the Dockerised server/indexer unable to reach the host embed. `readInstallState` now reads `embedMode` or the legacy `ollamaMode`, drops the old key, and returns null when neither names a valid mode so callers re-derive from the compose.
