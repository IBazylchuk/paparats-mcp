---
'@paparats/server': patch
---

`module_map`: a module's Uses and Used by are calls between the folders the modules are named after. A module also holds files of other folders, and those files used to link it too, so a link read as one between two folders often had no import between them. Now a file counts for the module whose folder holds it most closely, whichever module it was grouped into, and a file in no module's folder links nothing. Two modules named after the same folder are named after a folder below it each when those are apart, else after their most called file, which links now show too, so no two modules share a name. The note naming the file a used module is reached through is gone: a link's files are now always inside the folders it names.
