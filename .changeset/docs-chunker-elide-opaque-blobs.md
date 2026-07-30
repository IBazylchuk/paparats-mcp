---
'@paparats/server': patch
---

fix(docs): elide embedded binary payloads before chunking markdown

Documentation often embeds base64 — an API example carrying a file upload, an
inline `data:` image, a certificate. Such a run has no natural language to match
a query, yet it dominated its chunk's embedding and crowded the page's real prose
out of the index.

It could not be fixed downstream either: a payload is typically a single line,
and the oversized-block fallback splits by lines, so it had nothing to cut. A
single 16,898-character line produced one ~4225-token chunk.

Long runs over the base64/base64url/hex alphabet are now replaced with a short
`[binary data elided, N chars]` placeholder before sectioning. The replacement
contains no newline, so reported chunk line numbers still match the source.

Also bounds the remaining case the by-line split could not handle: a single line
longer than `maxTokens` (a one-line table, a minified asset) is now split on
character count, preferring a whitespace boundary.

Measured over a markdown corpus: largest chunk 4225 → 706 tokens, chunks over
1024 tokens 1 → 0, with p50/p95 chunk size unchanged (405/1331 chars) — only the
degenerate chunk is affected.
