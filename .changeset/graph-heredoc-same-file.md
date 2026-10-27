---
'@paparats/server': patch
---

The call graph reads Ruby code kept as a heredoc string (`SCRIPT = <<~'RUBY_SOURCE'` in a data migration, any tag containing `RUBY` or `RB`): grep saw the calls there, the parser saw text. Its calls join the chunks holding those lines; methods the heredoc defines stay inside it, and other heredocs (SQL, Markdown) are still text. A bare call next to a top-level definition of the name in the same file (a script's helper) now links to that one instead of to every same-named definition. On a private Ruby codebase, against grep, the callers found for class methods went from 23.6% to 26.6%, with 95.7% of found callers real (95.3% before); for one small class the five data migrations that call it are found now. Symbols are extracted again once on the next pass.

With this and the constant resolution above, links were checked against the code on the same private codebase: random samples from 300 targets at depth 2, each link read in full (the receiver's class, the constant's lookup) by a reviewer who did not know which group it came from. First-step links that were removed: 49 of 50 false. Links added: 25 of 30 real. Links kept: 24 of 30 real. At the second step, links set aside as "only through a name defined in several places": 1 of 40 real; links followed: 38 of 40 real. First-step dependents went from 2283 to 1782.
