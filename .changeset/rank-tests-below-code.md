---
'@paparats/server': patch
---

`search_code` ranks test files below implementation code unless the query asks about tests. A test that names a symbol tends to mention it more often than the code that defines it, so identifier queries returned `symbol-graph.test.ts` above `symbol-graph.ts`. On the retrieval bench this moves file MRR 0.825 → 0.881 and file R@1 0.66 → 0.75 with no query worse. Only the order changes: the similarity percentage and the confidence guidance still use the cosine similarity, and the guidance now reads the best similarity in the results rather than the first one.
