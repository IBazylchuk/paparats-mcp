---
name: paparats-search
description: Use when answering a question about code in the user's indexed repositories — where something is implemented, how a flow works, who calls a function, or what a change would affect. Explains when to use Paparats semantic search and when a text search is the better tool.
---

# Searching code with Paparats

Paparats indexes the user's repositories into chunks (functions, classes, blocks)
with a symbol graph between them. Its tools find code by meaning, not by exact text.

## Which tool

- **"Where is the code that does X?" / "How does X work?"** — `search_code` with a
  plain-language question. Then `get_chunk` on the best hits instead of reading
  whole files.
- **"Who calls this?" / "What uses this?"** — `find_usages` on a chunk from a
  search result. It follows real symbol edges, not name matches.
- **An exact identifier, error string or file name you already know** — a text
  search (`git grep -n`, `rg`) is usually faster and complete.

## Results are a ranking, not a complete list

`search_code` returns the best matches, capped by `limit`. It never proves that
something does not exist, and it does not list every occurrence. For questions
that need a complete answer — "every place that reads this env var", "all
callers of X" — use the search to learn the right names, then confirm the full
set with `find_usages` or a text search.

## Reading the scores

Each result carries a relevance score. 30–60% is normal for a correct match,
and the score does not tell whether the first result is the right one, so read
the top few. Below 30% the index may have nothing close — rephrase once, then
fall back to a text search.

## Recent edits may not be indexed yet

The index is refreshed on a schedule (by default the indexer checks for changes
about every 10 minutes), not on every save. For code the user has just written
or changed, read the file or use a text search instead of relying on
`search_code`.

## When the tools are missing

The tools come from a Paparats server running on the user's machine (default
`http://localhost:9876/mcp`). If they are unavailable, tell the user to check
the stack with `paparats status` rather than guessing at the code.
