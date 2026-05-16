---
'@paparats/indexer': minor
'@paparats/cli': minor
'@paparats/server': minor
'@paparats/shared': minor
---

Add change-detection to the indexer. Two cron schedules now run side by side: a fast `CRON_FAST` tick (default `*/10 * * * *`) that fingerprints each repo and only re-indexes when it changed, and a slow `CRON` safety-net (default `0 */3 * * *`, was `0 */6 * * *`) that still does a full pass. Remote repos use `git ls-remote HEAD`; bind-mounted local repos use a file mtime/size hash. State persists in `STATE_DB_PATH` (default `/data/indexer-state.db`). Set `CHANGE_DETECTION=false` to opt out.
