---
'@paparats/server': patch
---

The symbol graph is updated for what changed instead of being rebuilt for the whole project.

- Every file written or removed is recorded with the names its old and new chunks define. The graph then works out again only the edges of those files and every use of those names, reading just the chunks involved, and replaces them in one transaction. A project pass (the indexer container) and single-file updates (`updateFile`, `POST /api/file-changed`, `POST /api/file-deleted`, CLI batches) both go this way. The changes are kept in the metadata database, so an update that did not happen (a crash, a failed write) is applied by the next one.
- The whole graph is still built when a project has none, or when more than 300 files changed at once.
- The edges of a file or a project are deleted by id range. The LIKE pattern used before scanned the whole table, once per removed file.

On a private Ruby codebase (6,092 files, 347,052 edges), one changed file updated the graph in 0.25 s (median over 102 files, slowest 1.9 s, the process never blocked for more than 0.07 s). The full rebuild it replaces took 20–25 s, stopped the process for about 4 s while deleting, and left tools with a partial graph for 11–15 s while writing. After the 102 updates the stored graph matched a full rebuild edge for edge.
