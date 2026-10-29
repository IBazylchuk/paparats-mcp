---
'@paparats/server': patch
---

`module_map` keeps each package or app in modules of its own. A module holding the files of another app it imports read as the app using itself, or the other app using it; such a module is now split along packages and apps, and a part of fewer than 3 files joins the module of its own app it links to most. On the paparats repository, files sitting in a module of another package went from 11 to 5, and the output did not grow.
