---
'@paparats/server': patch
---

When no indexed test reaches a change, `change_impact` names the project's test files that are named after the changed file and its direct callers, instead of guessing paths: each project pass records the project's test files by name (`*_spec.rb`, `*_test.rb`, `*.test.ts` / `.spec.*`, `test_*.py`, `*_test.go`), also those left out of the index such as Ruby specs, and of several namesakes the one sharing most folders with the file is shown. The convention guess remains for content sent without a project directory. Over every tenth source file of a private Ruby codebase (specs under `spec/app/...`), the paths shown that exist went from 4.3% to 100%, and files with a namesake test that get one shown from 15.3% to 94.5%; on a private TypeScript codebase and on this repository both went from 0% to 100%.
