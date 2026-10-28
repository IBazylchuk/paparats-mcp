---
'@paparats/server': patch
---

TypeScript and JavaScript imports through a tsconfig path alias (`~/lib/dates`, `@/components/x`) now link only to the file they name, as relative imports already did. The alias is read from the nearest `tsconfig.json` / `jsconfig.json` above the file, following `extends`, `baseUrl` and a solution config's `references`. Before, such an import linked by name to every definition of it in the project. On a private TS codebase of 2,655 files that uses `~/` for most imports, 11,215 edges become EXTRACTED, and 464 AMBIGUOUS edges to same-named definitions in other files are dropped (a sample of 20 were all wrong). The paparats repository, which imports relatively, is unchanged. The aliases are resolved when the graph is built, from the symbols already stored. Each project's graph is built again once on its next pass, and no file is extracted or embedded again.
