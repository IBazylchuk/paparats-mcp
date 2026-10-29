---
'@paparats/indexer': patch
'@paparats/cli': patch
---

The indexer clones repositories from any host, not only github.com. A `url:` in `projects.yml` (and an entry of `REPOS`) is still `owner/repo` for GitHub, or now the `https://` URL of a repository elsewhere: GitHub Enterprise, GitLab with subgroups, Gitea. Tokens for private repositories on other hosts go in `GIT_TOKENS` as `host=token` pairs, each sent only to its own host, like `GITHUB_TOKEN` to github.com. SSH addresses and credentials inside the URL are refused with a message saying what to use instead. `paparats add` takes such URLs too, and the generated compose passes `GIT_TOKENS` to the indexer.
