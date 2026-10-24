---
'@paparats/server': patch
---

The support endpoint (`/support/mcp`) is read-only again: `term_record` is no longer registered there. Support instructions now tell the agent to pass a new or corrected glossary definition to an engineer, who records it from the coding endpoint, and `term_search` stops suggesting `term_record` where it is unavailable. A test now fails if any support tool is not annotated read-only.
