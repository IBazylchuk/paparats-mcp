---
'@paparats/server': patch
---

`search_code` no longer expands the query into abbreviation, case and plural variants. On the retrieval bench the variants added no quality there (file MRR unchanged, chunk R@10 +0.003) while costing up to three embedding calls and three Qdrant queries per search; `search_code` now answers in about half the time (bench p50 90 → 48 ms). The support-mode `explain_feature` and `impact_analysis` keep query expansion, since their natural-language questions were not measured.
