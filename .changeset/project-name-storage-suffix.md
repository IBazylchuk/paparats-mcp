---
'@paparats/server': patch
'@paparats/indexer': patch
---

Add `PAPARATS_PROJECT_SUFFIX` to isolate two stands sharing one Qdrant.

When two paparats stands share a single Qdrant instance (isolated only by
group, e.g. `appcast-v2` / `appcast-v3`), `evictProjectFromOtherGroups` matches
projects by their stored `project` name across **all** groups — so with
identical names each stand deletes the other's chunks, a symmetric
delete-each-other war.

`PAPARATS_PROJECT_SUFFIX` (default `''` — upstream behavior unchanged) appends a
suffix to the project name in the **storage layer only** (Qdrant payload
`project`, `chunk_id`, and SQLite metadata rows), while the clean name is still
used at the MCP boundary: search filters map the clean name to the suffixed one
on the way in, and results/`list_projects` strip it on the way out. `chunk_id`
stays opaque/suffixed end-to-end so `get_chunk` / `find_usages` round-trip
correctly.

With a suffix set, the eviction scan looks for `<name><suffix>` in other groups
and finds nothing the other stand wrote — so the war stops from **both** sides,
including against an older stand whose eviction is hard-wired (it looks for the
un-suffixed name and misses the suffixed chunks). On the next upgrade only the
suffix value changes; no code edits.

To keep the suffix invisible to clients, `getChunkById` strips it from the
display `project` field it returns, so the `[project]` headers in `get_chunk`,
`get_chunk_meta`, `find_usages` (and its edge rows), and `arch_suggest_components`
show the clean name while the embedded `chunk_id` stays suffixed for round-trip
lookups. With the default empty suffix this is a no-op. `getChunkById` also
guards against a null Qdrant payload (returns `null` instead of throwing).

The suffix is applied at a single write chokepoint and callers always pass the
clean project name — including `evictProjectFromOtherGroups`, which resolves the
stored form locally for its probe and hands the clean name to
`deleteProjectChunks`. This means `applyProjectSuffix` simply appends, so a
project whose name coincides with the active suffix is no longer a special case.

Note: the architectural-memory layer (`_arch` collections) is intentionally not
suffixed — it does not participate in cross-group eviction.
