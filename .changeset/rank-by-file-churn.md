---
'@paparats/server': minor
---

`search_code` ranks files that change often slightly higher. After a project is indexed, each file's number of commits is turned into its percentile within the project and stored on its chunks as `file_churn`; the rank key grows by up to 5% with it. Projects without git history rank as before, and a file indexed on its own between project passes counts as unchanged until the next pass. Only the order changes: the similarity percentage stays the cosine similarity.

The effect is small: on the retrieval bench it put the right file first for one more query of a hold-out set over a private Ruby codebase (58% instead of 55%) and changed nothing on the other query sets.
