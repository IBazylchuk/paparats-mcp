---
'@paparats/cli': minor
---

Add `paparats instructions [dir]`: writes a short block into the repository's `CLAUDE.md` and `AGENTS.md` (whichever exist, a new `AGENTS.md` otherwise) telling agents when to use `search_code` and when grep is the better tool, and pointing to `get_chunk`, `find_usages` and `change_impact`. The block names the project the server indexes the repository as (the `projects.yml` name, else the directory name, or `--project`). It sits between `<!-- paparats:begin -->` / `<!-- paparats:end -->` markers, so reruns replace only that part. `--print` shows it without writing, `--remove` takes it out, `--file` picks the files. `paparats add` of a local path now mentions the command.
