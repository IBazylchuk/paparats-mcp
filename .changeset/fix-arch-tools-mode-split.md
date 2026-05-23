---
'@paparats/server': patch
---

Fix architectural-memory tool exposure per MCP mode. Coding mode now exposes the full arch toolkit (`arch_context` plus all three `arch_record_*` writers and the `init_arch_memory` / `record_lesson_from_correction` workflows), and support mode is strictly read-only (`arch_context` and the `audit_architecture` workflow). Previously the writers were wired into support and missing from coding, which is the opposite of how the modes are used: agents author memory while making changes (coding), while support consumers only read it.
