---
'@paparats/indexer': patch
---

Fix cloning and change detection for private GitHub repositories in the indexer image since 2.12. The indexer put `GITHUB_TOKEN` into the clone URL. The libcurl in newer images sends URL credentials on the first request of a fetch but not on the next one, so git got a 401 and asked for a username. The token now goes to git as an `Authorization` header (`http.https://github.com/.extraHeader`, set through `GIT_CONFIG_*`), sent only to github.com. Clone URLs carry no credentials, and an existing clone whose remote URL still holds the token is rewritten on its next update.
