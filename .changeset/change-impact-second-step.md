---
'@paparats/server': patch
---

`change_impact` no longer loses real dependents past the first step. Since 2.15.1 a caller passes a change on only through the method that makes the call, which cut three common shapes of code:

- **A private helper.** When a private method calls the change and only the class's own `call` and `preview` call that helper, nothing outside was followed. Each use is now also recorded for the methods of the same chunk that reach it through the chunk's own calls (`reach_symbols` on the edge), including Ruby calls without arguments written as a bare name (`log = receipt`). Labels still name only the method that makes the call.
- **A call on a new object.** `Rebuild.new(ids).call` in Ruby and `new Queue().flush()` link to that class's method, like `Rebuild.call` does. A bare `new(ids).call` inside a Ruby class is a call on that class. Service objects run this way had no link at all, since `call` is defined in too many classes to link by name.
- **A class used as a value.** A Ruby class passed as an argument, kept in a hash, an array or a variable, or `Foo.new` kept for later, is a `references` edge, and `change_impact` follows it whatever method of the class changed. Namespaces, `include`, `raise` and calls made on the class at once (`Invoice.overdue`) stay ordinary.

Past the first step, links only through a name that several classes define (AMBIGUOUS) are listed apart under "Further, only through a name defined in several places", not followed. At the first step they stay as `[maybe]`.

On a private Ruby codebase, the seven dependents a production check found missing at the second step for two targets are all listed again, and two false ones through a shared method name are set aside. Symbols are extracted again once on the next pass.
