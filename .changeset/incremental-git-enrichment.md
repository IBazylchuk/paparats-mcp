---
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

fix(server): make git metadata enrichment incremental — only files actually reindexed in a cycle are re-enriched, instead of re-running `git log`/`git diff` and rewriting Qdrant payloads for every chunk of the project on every cron tick. Parsed git output is additionally cached in the metadata DB keyed by repo HEAD, so repeated enrichment without new commits skips git subprocesses entirely. Fixes constant `POST /points/payload` spam to Qdrant and high indexer CPU on near-no-op cycles.
