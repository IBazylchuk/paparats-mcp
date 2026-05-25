---
'@paparats/server': minor
---

feat(arch): `arch_list` enumeration tool plus retrieval-ranking fixes for `arch_context`

Three coupled changes for the architectural memory layer, motivated by a real audit/dedupe session that surfaced ranking blind spots in `arch_context`.

- **`arch_list(group, project?, kinds?, include_history?, limit?, offset?)`**. Unranked, paginated enumeration. No vector, no similarity threshold. Use this when you need every card (audit, dedupe, migration) rather than the top-N most similar. `arch_context` is for relevance-ranked retrieval; `arch_list` is for ground truth. Coding mode only.
- **Per-kind limits in `arch_context`**. Previously a single top-20 was bucketed post-fetch, which let a verbose decision bucket starve components out of the result entirely. Each kind now has its own top-N budget (default 5 per kind, overridable via `limits: { component, decision, lesson }`, max 50; 0 suppresses the kind). Three small kind-scoped Qdrant searches in parallel; arch collections are tiny so the cost is negligible.
- **Project-scoped retrieval boost**. When `arch_context` is called with `project=X`, cards whose payload matches that project get a small additive rank boost (~one calibrated tier of bge-m3 score bands, currently `+0.05`). This breaks the short-text cosine bias that lets one-line global decisions outrank longer project-scoped components. Globals stay visible but no longer dominate. The similarity gate (`findNearest`, used by `arch_record_decision`/`arch_record_lesson` for dedupe) intentionally stays on raw cosine — boost is retrieval-only.

Tool-output and ranking change: callers that rely on a specific ordering of `arch_context` results when passing `project` will see project-scoped cards moved up. Use `arch_list` if you need a stable unranked view.
