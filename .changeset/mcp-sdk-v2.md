---
'@paparats/server': minor
---

MCP TypeScript SDK 2. The server keeps speaking protocol revision 2025-11-25 with sessions, because `search_code` hides what it already returned in a session and the 2026-07-28 revision has no session to remember that in; clients that try the new revision fall back, as they do today. Tools, their schemas and the SSE routes stay as they were. The workflow prompts are also served as skills (`skill://trace-callers/SKILL.md`), for clients that load skills from a server. `delete_project` asks the user through the client when the client can ask, and deletes nothing without a yes; a client with nobody to answer gets a refusal, and `paparats remove` still works. The support instructions are shorter, because Claude Code cuts server instructions at 4096 characters and the agent never saw how to read a miss in the docs or the glossary. `record_lesson_from_correction` no longer renders a broken placeholder for its optional project.
