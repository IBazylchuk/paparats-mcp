---
'@paparats/server': patch
---

A Ruby call on `connection` (`connection.select_rows(...)`, `Model.connection.execute(...)`) is a call on ActiveRecord's database adapter, so it no longer links to a project method of the same name. On a private Ruby codebase this removed 3,171 edges and added none; over 300 targets, 36 direct callers were no longer listed, and none of them was real in a blind check against the code. Symbols are extracted again once on the next pass.
