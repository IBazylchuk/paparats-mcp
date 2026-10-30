---
'@paparats/server': patch
---

A call inside a Ruby method defined in a block (`class_methods do`, `included do`) is recorded as made from that method, so `change_impact` passes a change on to that method's callers only, not to every caller of the module around it. Ruby files are extracted again on the next index run.
