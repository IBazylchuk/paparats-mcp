---
'@paparats/server': patch
'@paparats/indexer': patch
'@paparats/cli': patch
'@paparats/shared': patch
---

fix(symbol-graph): cap AMBIGUOUS fan-out and stop blocking the event loop

Large repos with symbols re-declared across hundreds of chunks (namespace roots,
lifecycle hooks, shared base-class names) produced a quadratic `uses × defines`
edge explosion — millions of AMBIGUOUS edges for a single symbol — that inserted
in one giant SQLite transaction and blocked the Node event loop long enough to
trip the indexer's health probe.

- `buildSymbolEdges` now skips any symbol defined in more than
  `MAX_DEFINITION_FANOUT` (50) chunks and reports the count of edges avoided.
  These edges carried no navigational value.
- `upsertSymbolEdges` commits in bounded batches, yielding between them so the
  synchronous SQLite work no longer monopolises the event loop.
- The dashboard's indexer health probe timeout is raised 5s → 15s so a busy but
  healthy index cycle isn't reported as unreachable.

Auto-heals existing installs after upgrade — no manual DB surgery:

- Opening `metadata.db` purges pre-cap symbol edges once (gated on
  `user_version`), clearing the stale high-fanout rows.
- The indexer's state store bumps a reindex epoch on first boot after upgrade,
  clearing all repo fingerprints so the next cron cycle re-indexes every repo
  and rebuilds its symbol graph with the cap applied.
