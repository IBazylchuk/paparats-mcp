---
'@paparats/cli': minor
'@paparats/shared': minor
'@paparats/server': minor
'@paparats/indexer': minor
---

`paparats add <local-path>` now auto-detects the project language from marker files (Gemfile, package.json, Cargo.toml, go.mod, …) and writes a commented `exclude_extra:` starter block beside the entry, listing the language defaults already applied by the server. The `projects.yml` header now documents every supported per-entry field. Existing entries are left untouched.
