---
'@paparats/cli': patch
---

The embedding server no longer grows its memory during long indexing runs. Two caches that never pay off for embeddings are now off, in both the native config written by `paparats install` / `paparats update` and the `ibaz/paparats-embed` image:

- llama-server's prompt cache (`--cache-ram 0`). It keeps up to 8 GiB per model of saved state for prompts that come back, and embedding inputs never repeat.
- llama-swap's request/response captures (`captureBuffer: 0`). They are a debugging aid and grow llama-swap's memory under a steady stream of embedding calls.

Native installs pick the change up with `paparats update`, which rewrites `~/.paparats/llama-swap.yaml`.
