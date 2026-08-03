---
'@paparats/server': patch
---

Instruct the glossary query vector and recalibrate both relevance floors.

Glossary vector search embedded the query without the model's retrieval instruction. qwen3 pools on the last token, so that instruction is part of its trained query interface — applying it moved top-1 accuracy on paraphrase lookups from 61% to 91%, and put the right term in the top 8 for every query tested. Stored entries are unprefixed, so no re-index is needed.

Both floors were re-swept against the new score distribution: the direct `term_search` floor drops to 0.55 (keeping 16 more correct answers at no cost in false positives) and the docs sidecar floor to 0.50 (answering every direct term question instead of 6 in 10).
