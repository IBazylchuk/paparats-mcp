---
'@paparats/server': patch
---

`change_impact`:

- A dependent is shown at the line where its calling method is defined, not at the first line of its chunk. Before, a method on line 63 of a class chunk starting at line 2 was shown as `:3`.
- Each dependent now lists the other methods of its chunk that call it, as "further in this chunk", with their lines. Before, those methods were followed but never named, so the steps they add were invisible. On the 20-item key of a "two and three steps out" question on a private Ruby codebase, 11 items were listed at the right step. Now 6 more appear among these methods, and 2 listed names are not in the key (both 4 steps out).
- Only a chunk called from many places stops the walk as `[hub]`. Before, a chunk that only calls a lot (a large class) stopped it too. On the same key this adds 1 item at the right step. Over 300 random seeds, the share of walks cut at the dependents limit goes from 6% to 7%.
