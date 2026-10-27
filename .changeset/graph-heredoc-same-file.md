---
'@paparats/server': patch
---

The call graph reads Ruby code kept as a heredoc string (`SCRIPT = <<~'RUBY_SOURCE'` in a data migration, any tag containing `RUBY` or `RB`): grep saw the calls there, the parser saw text. Its calls join the chunks holding those lines; methods the heredoc defines stay inside it, and other heredocs (SQL, Markdown) are still text. A bare call next to a top-level definition of the name in the same file (a script's helper) now links to that one instead of to every same-named definition. On a private Ruby codebase, against grep, the callers found for class methods went from 23.6% to 26.6%, with 95.7% of found callers real (95.3% before); for one small class the five data migrations that call it are found now. Symbols are extracted again once on the next pass.
