---
'@paparats/server': patch
---

Fixes in architectural memory and the glossary, from an audit of their write paths:

- `arch_record_decision` with `supersedes` replaces only a current decision of the same project (or a group-wide one by a group-wide one) that the server's project scope lets the caller see. Before, a decision of one project could retire another project's, also on a server scoped to other projects, and a decision already superseded could be replaced again. When marking the old decision fails, the new card is taken back out, so a retry does not leave two.
- Updating a glossary term without `aliases`, or a component without `files`, `neighbours` or `anchors`, keeps what the card had. Before, they were emptied, and the exact lookup by acronym depends on the aliases.
- `arch_list` no longer repeats the last card of a page on the next one: Qdrant's scroll offset includes the point it names, so with `limit: 1` and a project filter it returned the same card forever.
- Reindexing architectural memory or the glossary (`POST /api/arch/reindex`, and the heal at startup) reports a Qdrant failure instead of answering that there was nothing to reindex. After a change of dimension, a failed write is tried again, and the collection is not dropped while a card cannot be re-embedded.
- `arch_delete` reports a malformed id as not found instead of failing the whole call, finds an upper-case UUID, and no longer deletes the collection's metadata point. Empty `project` on the glossary tools, and empty `name`, `summary` or `supersedes` on the arch tools, are refused.
