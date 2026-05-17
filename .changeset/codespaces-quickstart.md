---
'@paparats/shared': minor
'@paparats/cli': minor
'@paparats/server': minor
'@paparats/indexer': minor
---

Add GitHub Codespaces quickstart and fix three rough edges surfaced while
building it:

- `.devcontainer/` spins up the full Qdrant + Ollama + paparats stack on
  pre-built images and auto-indexes a small slice of the repo on first
  start, so users can try semantic search in the browser without installing
  anything.
- `paparats add` no longer fails with a noisy `Indexer returned 404` when
  the indexer's config-watcher hasn't yet picked up the new `projects.yml`
  entry — the CLI retries briefly to ride out the debounce window.
- `OllamaProvider.embedBatch` adaptively splits batches by total character
  size (default 16k chars per request, override via `OLLAMA_BATCH_CHARS`).
  Previously, 5 large chunks could exceed the 240s CPU embed budget and
  fail the whole batch.
- `paparats search` without `--group` and without a local `.paparats.yml`
  now infers the group when the server has exactly one — keeps the demo
  flow (and ad-hoc explorers) usable without setup.
