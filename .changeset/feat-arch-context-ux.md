---
'@paparats/server': minor
---

feat(arch): richer `arch_context` output and safer `arch_delete` docs

- **Lesson rendering**: `arch_context` now includes `why:` and `when:` continuation bullets under each lesson rule. The incident context behind a rule is often more load-bearing than the rule itself — the agent needs to see when the rule applies, not just the rule.
- **Stale marker**: any card whose `updatedAt` is older than 90 days is now prefixed with `⚠ stale` in the rendered output. The 90-day threshold was already documented as a "treat as hypothesis" boundary, but had no visible signal — easy to skip past. New marker makes it impossible to miss.
- **`arch_delete` safety**: tool description now tells the caller to re-fetch ids via `arch_context` immediately before deleting. Re-upserts allocate fresh UUIDs, so ids cached from earlier in a conversation can silently miss the intended card — and in the worst case, wipe a now-current one if the id was reassigned.

Tool output format change: lessons now span up to three lines per card (rule, `why:`, `when:`) instead of one. Update any downstream consumer that parsed `arch_context` line-by-line.
