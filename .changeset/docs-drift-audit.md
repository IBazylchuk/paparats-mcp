---
'@paparats/cli': patch
'@paparats/server': patch
---

Descriptions and docs match the code again. Tool descriptions call the score a similarity, not a confidence, and drop the unmeasured "50-90% fewer tokens"; `impact_analysis` says it shows both what a feature depends on and what depends on it; support instructions format GitHub tickets as `#567`, as the extractor returns them. `server.json` points at `/mcp`. The CLI no longer suggests the removed `paparats init`. Docs: indexing steps in order (a file is parsed and chunked before the unchanged check), files without a grammar are cut into fixed-size runs of lines, `change_impact` follows 2 steps by default, `force` is not enough for a model change, the embed image's examples use port 18434, and smaller fixes.
