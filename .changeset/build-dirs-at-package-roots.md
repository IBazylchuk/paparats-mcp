---
'@paparats/shared': patch
'@paparats/server': patch
'@paparats/indexer': patch
---

The default excludes no longer drop source folders named like build output. `build`, `dist`, `out`, `coverage`, `tmp`, `log`, `storage`, `bin`, `target` and a few more were excluded at any depth, so a Next.js route `src/app/build/page.tsx` or a Ruby `lib/storage/` never reached the index. They are now excluded only at the project root and at each package root (a folder with a `package.json`, `Gemfile`, `go.mod`, `Cargo.toml` or another manifest), where build tools write them. Dependency folders such as `node_modules` stay excluded at any depth, and an `exclude` written in `.paparats.yml` is used as before. On the paparats repository the indexed files are the same; a project gains only the source files in such folders and loses none.
