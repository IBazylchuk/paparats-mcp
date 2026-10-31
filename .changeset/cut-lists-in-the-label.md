---
'@paparats/server': patch
---

`module_map` says a list of links is cut in its label (`Uses (top 4 of 12):`) rather than at the end of the list, where it was read as all the module uses. The heading of `change_impact` names the `symbol` asked for, not the chunk's first name.
