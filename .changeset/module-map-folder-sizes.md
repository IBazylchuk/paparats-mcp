---
'@paparats/server': patch
---

`module_map` says in each module's heading how many of its files the folders it is named after hold, of all the code files there (`N of the M code files in <folder>/, K in other folders`), so a module's size is not read as its folder's. Each link shows its number of importing files, and `+N more` says when links were cut, so a short list no longer reads as everything the module uses.
