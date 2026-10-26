---
'@paparats/server': minor
---

Add `module_map` to the coding and support endpoints: a map of a codebase's modules, built from the symbol graph. A module is a set of files that call each other much more than they call the rest. Each module shows:

- its folder name and size;
- its main files;
- which modules it uses and which use it;
- the tests attached to it.

Code called from most of the rest is listed apart as shared, migrations are left out, and oversized modules are split again. Links through names used from most files (`get`, `add`) count for little, so they do not glue unrelated files together. The answer ends with a Mermaid diagram of the modules and their dependencies (`diagram: false` turns it off).

The operator console gets a matching page, `/ui/map`:

- circles sized by file count, arrows to the modules each one uses;
- click a module for its files, tests and links;
- pick a group or project, or find which module a file sits in.

The page is served from `GET /api/module-map`, behind the same optional basic auth as the rest of the console. Both share one cache per group and project, rebuilt after edges change at most every five minutes.

The `onboard_to_project` workflow and both modes' instructions now start an unfamiliar codebase with the map. On this repository it finds 10 modules, with 70% of files sitting in their module's main folder.
