---
'@paparats/server': patch
---

A call on an object of a known class that several of its implementations or subclasses answer (a base class calling a hook its subclasses define, an interface with several implementations) is linked to each of them as `INFERRED` instead of `AMBIGUOUS`, so `change_impact` keeps those callers in its list rather than setting them aside with calls on objects of unknown class. A class name that may mean several classes, or a class reopened in several files, stays `AMBIGUOUS`. On a private Ruby codebase 98 edges changed label; in a blind check against the code, 24 of 24 sampled were real, and so were the 6 direct callers that came back over 300 targets.
