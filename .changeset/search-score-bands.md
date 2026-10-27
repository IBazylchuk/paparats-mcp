---
'@paparats/server': patch
'@paparats/cli': patch
---

`search_code` confidence bands now match how the default code model scores. The top result's similarity rarely reaches 60% even when it is right, so over five query sets (218 queries) the old bands called 0–5% of answers high-confidence and 14–38% low-confidence, though the right file was in the top five for 50–96% of the "low" ones, and the agent was told to fall back to grep. The bands are now 45%+ strong, 33–44% partial, under 33% weak. At 45% and above the right file comes first for 76–96% of queries (29–79% in the partial band); the weak band fires for 0–10% of queries. The instructions, the skill and the CLI's `CLAUDE.md` block use the same numbers, and the partial-match note now says to read a few results instead of grepping.
