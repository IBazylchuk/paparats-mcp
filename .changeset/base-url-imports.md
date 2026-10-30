---
'@paparats/server': patch
'@paparats/indexer': patch
---

TS/JS: a bare import of a folder or file under the tsconfig's `baseUrl` (`import { useMe } from 'core/hooks'` under `baseUrl: "src"`, as Create React App projects write) is the project's own code, not an installed package. Such imports linked to nothing before, so `find_usages`, `change_impact` and `module_map` missed them.
