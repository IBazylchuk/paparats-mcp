---
'@paparats/server': patch
---

Raise the metadata SQLite `busy_timeout` from 5s to 30s to avoid "database is
locked" errors.

The server and indexer processes open the same `metadata.db` (shared volume) and
both write to it — the indexer during indexing, the server on-demand for git
history. WAL lets readers run during a write, but two writers still serialise,
and with a 5s timeout a contended write (notably the startup `symbol_edges`
migration racing an active indexer) failed immediately with `SqliteError:
database is locked`, crashing server startup. Waiting up to 30s comfortably
covers a full-table migration or a batch upsert, so the writers queue instead of
erroring.
