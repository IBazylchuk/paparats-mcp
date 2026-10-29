---
'@paparats/server': patch
'@paparats/indexer': patch
---

Call graph and `change_impact`:

- A call on self links to the overrides in the classes below too, found through the classes rather than by name, so `change_impact` follows a template method: a base class method calling the step its subclasses define now depends on each subclass's version. This also holds for a call between two methods of one chunk.
- A Ruby key without a value (`Report.new(total:)`) calls the method of its name, like a bare call.
- A Ruby `Foo.new` counts as holding the class only when it is passed or stored. A method that returns a new object (a factory) no longer counts as a dependent of every method of that class, so it is no longer listed a step too near.

Every Ruby and TypeScript file is extracted again, and every graph is built again, on the next index pass.
