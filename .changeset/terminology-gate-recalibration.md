---
'@paparats/server': patch
---

fix(terminology): recalibrate the similarity gate for the text embedding model

The duplicate/similar bands (0.85 / 0.70) were inherited from the arch layer, where
they were calibrated against a different embedding model, and were never re-tuned for
the one the terminology layer actually uses. The lower band landed *inside* the range
that genuinely distinct terms occupy, so the gate refused legitimate writes: while
seeding one real glossary, three separate cost-metric and integration terms were each
rejected as a near-duplicate of an unrelated term, scoring 0.702–0.709.

Measured against a real 27-term glossary — all 351 distinct pairs, plus 7 hand-written
restatements of existing entries:

| | range |
| --- | --- |
| genuine duplicates | 0.739 upward |
| distinct terms | up to 0.709 |

The bands are adjacent rather than separated, only ~0.03 apart, because glossary
entries share heavy structural boilerplate ("Cost Per X — spend divided by Y") — so a
whole family of real, different metrics sits just below the duplicate band.

The gate is now a single threshold at 0.72, the widest gap between the two measured
bands: it catches 7/7 duplicate probes with 0/351 false blocks. The second "similar"
tier is gone — with a 0.03 window there is nowhere to put it, since any value low
enough to mean "similar" already blocks legitimate writes. `TermWriteStatus` keeps
`'similar'` for wire compatibility but nothing produces it.

The margin is thin on both sides, so the calibration is worth repeating once the
glossary grows substantially.
