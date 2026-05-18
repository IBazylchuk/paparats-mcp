---
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

CLI: `paparats install --embeddings <ollama|openai|voyage>` chooses the embedding backend at install time. Cloud providers (`openai`, `voyage`) drop the bundled Ollama service from the generated `docker-compose.yml` and pass through `OPENAI_API_KEY` / `VOYAGE_API_KEY` so the server and indexer talk straight to the API — no 1.7 GB image, no GGUF download, no host Ollama. Interactive install prompts for the provider and (for cloud) the API key; `--non-interactive` requires `--embedding-api-key <key>` or the corresponding env var. The choice is persisted in `~/.paparats/install.json`, so later `paparats add | remove | edit projects` keep the same compose shape on regeneration.

Server: `Indexer.getGroupStats` and `Indexer.listGroups` now subtract the metadata sentinel point introduced in 0.8.0, so reported chunk counts reflect real chunks instead of being off by one.
