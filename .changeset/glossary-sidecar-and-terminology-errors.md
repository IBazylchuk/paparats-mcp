---
'@paparats/server': patch
---

fix(docs): report glossary terms beside search results instead of inside the query

`search_docs` folded matched glossary definitions into the query text before
embedding it. That pastes corpus wording into the question and pulls the vector
toward whichever documents the terms came from, so results reflected the glossary
rather than the question.

Measured over 102 answerable and 30 verified absent-topic queries, with a glossary
containing a single term:

| | precision@1 | recall@5 | absent topics leaking |
| --- | --- | --- | --- |
| definition inside the query | 6.9% | 22.5% | 27/30 |
| definition beside the results | 86.3% | 97.1% | 5/30 |

Two narrower fixes were measured and rejected: judging the relevance floor against
the original question (14.7% precision@1) and requiring a minimum score before
expanding (48.0%). Both leave the enriched vector driving retrieval.

Matched terms now render as a labelled section above the excerpts — context rather
than an answer, since a term can match a question it does not resolve — and are
also returned when nothing matched, where they often explain the vocabulary
mismatch. `GLOSSARY_MIN_SCORE` (0.55) gates which terms appear: term search returns
the nearest entries regardless of distance, so ungated it attached a definition to
132/132 queries, none of them on-topic.

fix(terminology): stop reporting store failures as an empty glossary

Four read paths in `TerminologyStore` caught every error and returned an empty
result, making "no terms recorded" indistinguishable from "the store could not be
reached". Only a missing collection is genuinely empty.

- `search()` — query enrichment silently stopped matching terms
- `list()` — `term_list` reported an empty glossary, inviting an agent to
  re-record terms that already existed
- `findByTerm()` — `recordTerm` read the null as "no such term yet" and minted a
  fresh id, writing a duplicate and resetting the term's `createdAt`
- `findNearest()` — the duplicate/similar write gate silently stopped gating

A missing collection is now distinguished by status code and still reads as empty;
everything else propagates. `deleteTerm` is unchanged — its `false` return already
surfaces the failure.
