---
'@paparats/cli': patch
'@paparats/server': patch
'@paparats/shared': patch
'@paparats/indexer': patch
---

Add six MCP workflow prompts (`find_implementation`, `trace_callers`,
`onboard_to_project`, `triage_incident`, `prepare_release_notes`,
`assess_change_impact`) and enforce mode isolation between `/mcp` and
`/support/mcp` so a coding session id cannot be replayed on the support
endpoint.
