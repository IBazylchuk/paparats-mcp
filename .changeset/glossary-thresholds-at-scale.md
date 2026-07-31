---
'@paparats/server': patch
---

fix(terminology): recalibrate both glossary thresholds against a populated glossary

Both similarity floors in the glossary path were calibrated when the store held a
handful of terms. Neither survived a real vocabulary, and each failed in the
direction that costs the caller something.

**The write gate refused legitimate terms.** Importing a 53-entry glossary into a
store that already held 26 terms, the 0.72 floor rejected 19 of the 53 as
near-duplicates. Only 3 were genuine — a canonical name colliding with an existing
alias, which name idempotency already handles. The other 16 (84%) were distinct
concepts, spread across 0.724–0.889: among them a campaign-strategy template blocked
against a publisher-side bidding mode, a volume metric against a scoring subsystem,
and two separate cost metrics from the same family.

The cause is structural, not a bad number: glossary entries share their phrasing and
their domain, so cosine between rendered entries tracks the *genre* of the text more
than which term it defines — and it gets worse as the glossary grows, because more
legitimate neighbours crowd the top of the range. The floor is now 0.95, catching
only near-verbatim restatements. Detecting reworded duplicates is given up on
deliberately: losing a real term is worse than admitting a near-duplicate an author
can merge.

**The sidecar floor attached definitions to almost everything.** `GLOSSARY_MIN_SCORE`
is applied per candidate term, so the chance that *some* entry clears it rises with
vocabulary size. At 0.55 — calibrated when the store held one term — it attached to
5/102 answerable queries then, and to 85/102 plus 5/30 absent-topic queries once the
glossary reached 75 terms.

Re-measured at 75 terms over 102 answerable queries, 30 verified absent-topic ones,
and 10 probes phrased directly about a term:

| floor | term shown for a probe | answerable | absent-topic |
| --- | --- | --- | --- |
| 0.55 | 10/10 | 85/102 | 5/30 |
| 0.60 | 8/10 | 67/102 | 2/30 |
| 0.65 | 8/10 | 43/102 | 0/30 |
| 0.70 | 6/10 | 27/102 | 0/30 |

0.65 is the lowest floor that never fires on an absent topic (those topped out at
0.645) while still surfacing the term for 8 of 10 direct questions.

Retrieval quality is unaffected by glossary size either way — precision@1 held at
85–87% and recall@5 at 97% from 1 term to 78 — because matched terms are reported
beside the results rather than folded into the query.
