---
'@paparats/server': minor
---

Fix `find_usages` and the analytics UI hanging (504) during continuous indexing.

The per-group degree statistics behind `find_usages` were recomputed with two
full-table `LIKE 'group//%'` scans of `symbol_edges`, and the cache backing them
was **dropped** on every edge write. Under continuous indexing the cache was
therefore always cold, so each `find_usages` call blocked on a full-graph scan —
on a large index (hundreds of thousands of chunks / millions of edges) this
exceeded proxy timeouts and surfaced as 504s.

Three changes remove the stall:

- **Stale-while-revalidate:** reads never block on the full-graph scan. A stale
  or aged snapshot is served immediately and refreshed in the background
  (deduped per group). Only the very first computation for a group is
  synchronous.
- **Non-destructive invalidation:** edge writes mark the degree cache stale
  instead of deleting it, so a snapshot is always available to serve.
- **Indexed aggregation:** `symbol_edges` gains a denormalised `grp` column with
  composite indexes `(grp, to_chunk_id)` / `(grp, from_chunk_id)`, so degree
  stats aggregate via an index range scan instead of a full-table `LIKE` scan.
  Existing databases are migrated in place (column added + backfilled from
  `from_chunk_id`); new and reindexed edges populate it directly.
