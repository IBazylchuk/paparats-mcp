---
'@paparats/server': minor
'@paparats/shared': minor
'@paparats/cli': minor
'@paparats/indexer': minor
---

Docs search now applies a separate relevance floor to markdown that ships inside code repositories, and reports how old a document is.

Overview-style files (README, CLAUDE.md, design notes) mention many topics in passing, so they score deceptively well against questions they do not answer. A single floor could not separate them: measured over 102 answerable and 30 absent-topic queries, one floor either let half the absent topics through or cost 11 points of precision@1. Per-kind floors (prose 0.45, code 0.60) blocked 29/30 absent topics without losing a single real answer. Classification is automatic — a repo with no detected code languages is prose — and overridable via `docs.kind` in `.paparats.yml`. `search_docs` gains `min_score_code`.

Results also carry a `Last updated ... ago` line for documents untouched for over a year, so a stale page can be discounted instead of quoted as current. Age is disclosed only, never used for ranking.
