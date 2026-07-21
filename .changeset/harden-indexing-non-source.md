---
'@paparats/shared': minor
'@paparats/server': minor
'@paparats/indexer': patch
'@paparats/cli': patch
---

Harden indexing against non-source content and embed-server memory blow-ups.

- **Skip machine-generated / non-source content** — files with a source-file
  extension but no source structure (base64 asset blobs, minified bundles, e.g.
  `convex/export/pptx/assets/*.data.ts`) were being fed to the embedder as a
  single multi-hundred-KB token wall, driving `llama-server` into 502s, 240s
  timeouts, and OOM — indexing stalled at `0 chunks`. A new structural detector
  (`detectNonSource` in `@paparats/shared`) judges content by line length,
  whitespace ratio, and base64-alphabet dominance (name-independent). The indexer
  skips such files before chunking and drops individual non-source chunks before
  embedding, with telemetry. Known classes (`*.min.js`, `*.bundle.js`,
  `*.data.ts`, …) are also added to the default TypeScript/JavaScript excludes.
- **Embed server memory** — the `paparats-embed` image now sizes the per-model
  llama-server compute buffer via `LLAMA_BATCH` (default 2048, was a hardcoded
  8192 that caused cgroup OOM with two resident models) and exposes
  `LLAMA_THREADS`. The compose generator wires both through and sets an explicit
  memory/CPU limit on the embed service (`EMBED_MEMORY`/`EMBED_CPUS`).
