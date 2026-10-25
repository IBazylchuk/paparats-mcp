---
'@paparats/server': patch
---

Glossary and architecture tools no longer lose or misreport writes:

- **A Qdrant failure is reported as a failure.** Before, `arch_list`, `arch_context` and the lookups behind `arch_record_*` read any error as "nothing there". An outage could then look like an empty memory, which invites the agent to record everything again. A failed name lookup also wrote a second copy of a component, and a failed similarity search let a duplicate decision or lesson through. Now only a missing collection counts as empty.
- **A group-wide `term_record` no longer overwrites a project term of the same name.** Before, it also matched project-scoped terms, so the project term was replaced and lost its project.
- **An exact glossary lookup finds terms past the first 200.**
- **`arch_record_decision` with `supersedes` checks the id first.** It must belong to a decision in the group. Before, an unknown id failed only after the new decision was written, so retrying the "failed" call wrote it twice.
- **`term_delete` says when the id does not exist.** It used to report every id as deleted. `term_list` and `term_search` now show each term's id, so there is an id to pass.
- **A server scoped with `PAPARATS_PROJECTS` keeps arch and glossary writes and deletes to its projects.** `arch_list`, `arch_context` and `arch_delete` hide cards of other projects; group-wide cards stay visible.
- **Startup re-embedding (`reindexArch`, `reindexTerms`) no longer drops a collection whose vector size it could not read.**
