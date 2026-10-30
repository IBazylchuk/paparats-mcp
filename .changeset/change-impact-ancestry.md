---
'@paparats/server': patch
---

`change_impact` tells a subclass's own code from a sibling's by the class's full ancestry: a call on self from a class above the changed override's class (its parents at any depth and the modules mixed into them) or below it is followed, only a class unrelated to it is not, and each calling method of a link is judged on its own. A method of the changed chunk that reaches the change through other code (calling a base class method that calls the changed one on self) is now listed and followed like any other dependent.
