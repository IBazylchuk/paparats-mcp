---
'@paparats/server': patch
'@paparats/cli': patch
---

`search_code` no longer tells the agent to fall back to grep for ordinary scores. With the default code model the top result's similarity rarely reaches 60% even when it is right, so over five query sets (218 queries) the old bands called 0–5% of answers high-confidence and 14–38% low-confidence, though the right file was in the top five for 50–96% of the "low" ones. Above 30% the score does not tell whether the first result is right (the right file was in the top five for 84–96% of queries per set and first for 59–84%, and no split of that range separated right from wrong on real agent queries), so there is one note now: below 30% the index may have nothing close. Every bench query has an answer, so that floor is not measured; it sits under the scores of answered queries (2 of 218 fall below). The instructions, the skill and the CLI's `CLAUDE.md` block say the same and ask to read the top few results.
