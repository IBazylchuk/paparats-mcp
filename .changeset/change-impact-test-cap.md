---
'@paparats/server': patch
---

`change_impact`: tests have a `limit` of their own, apart from code. Before, the tests reaching a change took places in the same list as the code depending on it, so a change with many tests stopped listing code early; now up to `limit` code dependents and, apart from them, up to `limit` tests are listed.
