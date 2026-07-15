---
'@paparats/cli': patch
---

Fix `paparats update` skipping native embed setup on hosts that upgraded from the Ollama era. Those developer installs have a `docker-compose.yml` (Qdrant + server) but run embeddings natively and never wrote `install.json`, so the old detection ("macOS without docker-compose.yml") never fired and the host was left with no embed backend after the Ollama→llama-server migration. Detection now inspects the compose file: if it exists WITHOUT an `embed` service, the embed is native and gets refreshed. A truthy `install.json` with an unset `embedMode` also falls through to detection instead of silently skipping.
