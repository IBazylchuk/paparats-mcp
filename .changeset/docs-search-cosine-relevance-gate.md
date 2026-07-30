---
'@paparats/server': patch
---

fix(docs): filter docs search by a semantic relevance floor

`search_docs` answered questions the corpus does not cover with a confident,
unrelated page. Asked about a topic absent from the corpus, it returned an
unrelated page that merely shared one common word, at the maximum score of 1.000.

The cause is that the returned score is RRF (`1/(k+rank)`), a function of position
alone: whatever ranks first scores high, even when nothing relevant matched. Over
a 41-query set, topics deliberately absent from the corpus produced RRF scores of
0.500/0.700/1.000 — indistinguishable from real answers (0.500–1.000), so no
threshold on that score can exist.

The dense cosine does separate them: absent topics peaked at 0.410 while real
answers ran from 0.474 up. Hits below `minCosine` (default 0.45, in the empty band
between the two) are now dropped, while ranking stays on RRF — which measured
better on precision@1 than ranking by cosine (100% vs 94% on the first query set),
so it is kept as the ranker and the cosine is used only as a filter.

Exposed as `min_score` on the MCP tool; pass 0 to disable. The gate fails open on
a rescore error, since an empty result set is indistinguishable from "not
documented" — the very confusion this prevents.

Measured on the full 41-query set: absent-topic answers 3/3 → 0/3, with
precision@1 (87%) and recall@5 (97%) unchanged and no real answer lost.
