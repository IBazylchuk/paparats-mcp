---
'@paparats/server': patch
---

`module_map`: a used module now names, in brackets, the file it is mostly reached through when that file belongs to another package or app than the folder the module is named after (`Uses: 4. extensions/tracker/src/lib (src/components/RouteError.tsx)`). A module is named after the folder most of its files sit in, but it can also hold files of another app. On a private TS codebase, a module named after a browser extension also held 53 site files the extension imports. 82% of the calls from site modules into it landed on those site files, and agents read the link as "the site calls the extension". All 5 such links there now name a site file. The output grows by 3% on that codebase and 5% on the paparats repository.
