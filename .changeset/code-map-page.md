---
'@paparats/server': minor
---

The console's map page (`/ui/map`) is now a code map you walk folder by folder, replacing the single cloud of unlabelled module circles.

- **Levels.** A group opens at its repositories and a repository at its top folders. Click a folder to go into it; a folder holding only one folder opens that one. Each level shows at most 24 folders and files, the most called first, and the rest are listed from one "more" circle.
- **What it shows.** Every circle is labelled and sized by its files. Arrows point from caller to called. Dashed circles around the edge are the folders elsewhere that this one calls or is called from.
- **Files.** Click a file to see what it calls and what calls it, with links to each.
- **Modules.** The side panel lists the modules with files in the folder. A module opens as its own view: its files, and the modules around it.
- **Links and navigation.** Every view has its own URL, so back, forward, reload and "open in a new tab" work, and breadcrumbs plus an "up" link lead back. Zoom with the buttons, the wheel or `+`/`-`. A search box finds files anywhere in the group. Group names in the console's corpus table link to their map.
- **New endpoints.** `GET /api/module-map/tree`, `/module`, `/file` and `/search`, behind the same optional basic auth.

The module map itself is now built per project. Before, in a group of several repositories, the thresholds for splitting a module and for shared files came from the whole group, so a small repository next to a large one stayed one undivided module. How specific a name is is now also judged within its own repository. This changes `module_map` output for groups with more than one project.
