---
'@paparats/server': patch
'@paparats/indexer': patch
---

`change_impact` counts steps by method call, so "3 steps away" means three calls from the change, calls between the methods of one file included:

- Each chunk records the calls between its own methods, and each edge the steps from its calling method to the other methods of its chunk that reach it. Methods of the changed chunk that call it are listed at their steps, and a dependent's other methods that reach the call are listed as "calls `x` in this file", one step further.
- `depth` limits steps: what lies further is counted, not listed. Before, it limited chunks, so dependents 4 to 6 calls away were listed under a three-step question.
- A method too long for one chunk is one dependent, shown on the line where it begins, and its callers are followed from there. Before, its callers were lost when the call sat in a later chunk.
- A Ruby method called by its bare name without arguments from another method of its class (`total: subtotal`) is a call. A `Foo.new` stored in a variable is no longer read as the class held as a value (which passed on any change to the class); its calls link one by one.
- When no indexed test reaches the change, the output says the index may leave tests out, not that the code is untested.

Checked offline on 8 targets drawn at random, against answer keys written from the source by reviewers who did not see the output: 71 of 73 dependents in the keys are listed (47 before). Nearly all of the gain, 22 of 24, comes from two Ruby targets whose callers sit in the same file and were not seen before; on the four TypeScript targets 18 of 19 are listed (16 before). 1 is listed at a step the key disagrees with (7 before), and 3 shown lines are wrong (13 before). Symbols are extracted again once on the next pass; no file is embedded again.
