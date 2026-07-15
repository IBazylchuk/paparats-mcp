---
'@paparats/server': patch
'@paparats/indexer': patch
'@paparats/cli': patch
'@paparats/shared': patch
---

fix(metadata): drop pre-cap symbol_edges instead of DELETE; never crash startup

The one-time pre-cap edge purge used `DELETE FROM symbol_edges`, which logs
every row to the WAL. On the multi-gigabyte tables the fan-out bug produced,
this inflated the WAL past the table's own size (14 GB observed), never
committed, and crashed server startup with `SQLITE_BUSY` in a restart loop —
the server never came up.

- The purge now uses `DROP TABLE IF EXISTS symbol_edges`, which deallocates
  pages in bulk instead of logging each row. The table is immediately recreated
  empty by the existing `CREATE TABLE IF NOT EXISTS`, and the indexer's reindex
  epoch rebuilds edges with the fan-out cap applied.
- The purge is wrapped in try/catch and is no longer a startup precondition: on
  any failure (e.g. a lost lock race) `user_version` is left at 0 so the purge
  retries on the next open, and startup proceeds regardless.
