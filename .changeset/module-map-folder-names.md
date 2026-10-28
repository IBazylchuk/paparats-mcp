---
'@paparats/server': patch
---

`module_map` names a module after the folder that best matches it, holding much of the module and little else of the project (or two folders joined by `+` when they match better), instead of the folder with the most of its files, which often held a small part of the module. Its main files are the most called files of that folder, so a widely called file of another folder the module holds no longer heads them. On the paparats repository, the median F1 of a module against the folder it is named after went from 0.71 to 0.76.
