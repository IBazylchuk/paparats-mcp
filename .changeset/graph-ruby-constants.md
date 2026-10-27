---
'@paparats/server': patch
---

The call graph links fewer things by name alone, so `change_impact`, `find_usages` and `module_map` see fewer false dependencies:

- **Ruby constants resolve as Ruby looks them up.** `Base` inside `module Billing` is `Billing::Base` when that exists, otherwise the top-level `Base`. A constant defined nowhere in the project (a gem's `ActionController::Base`, `GraphQL::Dataloader::Source`) links to nothing, instead of to every project class with the same last name. The namespace part of a path (`Billing` in `Billing::Invoice`) is not a use; the class a value constant is read from (`Scanner` in `Scanner::SCOPE_KEY`) is.
- **Ruby class methods.** A call on an object (`record.batch`) no longer links to a `def self.batch`.
- **Reopened library classes.** `class Time` or `module ActiveSupport` in a project file adds methods to the library class and no longer counts as defining it, which had made such a file look used by every file.
- **File-local TypeScript and JavaScript.** A function or class that is not exported is reached only from its own file, and there it wins over same-named exports elsewhere.
- **Tests that are not indexed.** When no indexed test reaches the change, `change_impact` says so and lists where the tests would be by convention (`spec/models/invoice_spec.rb`, `src/queue.test.ts`): Ruby projects leave `spec/` and `test/` out of the index by default.

Checked by hand on a private Ruby codebase, on random samples of links from 300 targets at depth 2:

- First-step links that were removed: 48 of 50 were false; the other two, read through a value constant, are linked again.
- First-step links now listed without `[maybe]`: 33 of 35 are real. Those marked `[maybe]`: 5 of 25.
- Second-step links set aside as "only through a name defined in several places": 2 of 40 real. Second-step links followed: 38 of 40 real.

Per 300 targets, first-step dependents went from 2283 to 1682 and links set aside from 6589 to 1330. Against grep, class-method callers found are real for 95.3% instead of 86.4%, with the same recall (23.6%). In the module map no file shows as shared by the whole project any more (a reopened library class did), and 32.9% of modules have their main files in one folder (32.7% before). In a TypeScript repository the map's edges halved and that share went from 77.4% to 82.4%. Symbols are extracted again once on the next pass.
