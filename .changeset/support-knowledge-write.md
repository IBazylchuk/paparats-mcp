---
'@paparats/server': minor
---

Give support mode write access to the knowledge layers, and document the docs and glossary layers in both modes' server instructions.

`search_docs`, `term_search` and `term_record` were registered as tools but never mentioned in either instruction set, so an MCP client without our plugin hooks received them with no guidance on when to call them. Both modes now document what each layer holds, how to read the `exact match` vs `similar` label, and that documentation hits are excerpts rather than whole pages.

Support mode gains `arch_record_component`, `arch_record_decision`, `arch_record_lesson`, `arch_list`, `arch_suggest_components` and `term_record`. Support is usually first to learn a non-obvious constraint — from an incident, an escalation, or customer vocabulary — and previously could not record it. The boundary is now reversibility rather than role: additive writes pass a similarity gate, while the destructive tools (`arch_delete`, `term_delete`, `delete_project`) remain coding-only.

Both modes are also told that coverage differs per layer: only code is densely indexed, so a miss on docs, glossary or arch memory means "not recorded yet" rather than "does not exist".
