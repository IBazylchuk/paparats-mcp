---
'@paparats/server': patch
---

`module_map` lists the links of a module named after two folders per folder (`Uses, from src/pages: ...`), so the imports of one folder are not read as the other's; a link into such a module names the folder it reaches. A file in a folder two modules are named after counts for the one it is grouped into, else for the one named after that folder alone. A new `Top folders` section sums the imports between a project's top folders (`src/app`, `src/features`, `src/lib`, ...).
