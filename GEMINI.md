# Paparats

This extension connects to a Paparats server at `http://localhost:9876/mcp`. The
server runs on your machine and must be installed and started first — see
`llms-install.md` or the README. If the `paparats` tools are missing, run
`paparats status` to check that the stack is up.

The server sends its own usage instructions when it connects. Two rules worth
keeping in mind on top of them:

- `search_code` returns the top matches by meaning, not every match. For
  questions that need a complete list ("every caller of X", "all places that
  read this env var"), use the results to find the right names, then confirm the
  full set with `find_usages` or a text search such as `git grep -n`.
- For an exact identifier, error string or file name you already know, a text
  search is often faster; `search_code` pays off for "where is the code that
  does X" questions.
