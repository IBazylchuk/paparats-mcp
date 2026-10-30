---
'@paparats/server': patch
'@paparats/indexer': patch
---

`change_impact` no longer lists the sibling subclasses of a changed override. When a base class method calls a method on self that a subclass overrides, a change to that override reaches the base method only for objects of that subclass; the walk took every call of the base method on self, from any subclass. Calls on objects of unknown class are still followed.
