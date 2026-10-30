---
'@paparats/server': patch
'@paparats/indexer': patch
---

`change_impact` no longer lists code that holds a Ruby class as a value (passes it, keeps it in a hash or array) as depending on every method of that class. Such code depends on the class: it is listed when the class itself is the change, and for a change to one method only when it calls that method. The methods a framework, a job queue or a serializer declaration calls on the class are not in the code, and most of these dependents were not reached through project code at all.
