---
'@paparats/server': patch
---

feat(docs): tell the caller when a docs hit is only an excerpt

A `search_docs` hit is the best-matching chunk plus its immediate neighbours, not
the whole document — but nothing said so. Measured over one corpus, a hit is a
median of 60% of its document and as little as 17% for the largest ones; only 25%
of documents fit entirely in one hit.

That gap is easy to misread. An agent can take an excerpt as the document's full
position and conclude it says nothing about a detail that lives in a section never
returned.

Hits now carry `docChunkCount` and `includedChunks`, and the MCP tool renders a
line naming what was left out:

```
Excerpt: sections 31-33 of 65 — read `docs/general/.../big.md` for the rest
(this passage may not be the document's full answer).
```

Silent when the excerpt IS the whole document, and silent when the count is
unknown — an invented "0 of 0" would be worse than saying nothing. The count is
best-effort: a failure leaves it unset rather than failing the search.

Also states in the result footer, and in the tool description, that the top hit is
not always the right one and the alternatives are worth scanning. On a 112-query
measured set the top hit is correct 89% of the time while the right document is in
the top 3 for 96% — so stopping at the first result loses answers that were
retrieved.
