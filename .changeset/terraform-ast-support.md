---
'@paparats/shared': minor
'@paparats/cli': minor
'@paparats/server': minor
'@paparats/indexer': minor
---

Add AST-based Terraform/HCL support: symbol extraction and find_usages for `.tf`/`.hcl` files via the tree-sitter terraform grammar, with regex chunking retained as fallback.

- Default excludes strictly skip secrets and state at any directory depth: `**/*.tfvars`, `**/*.tfvars.json`, `**/*.auto.tfvars`, `**/*.auto.tfvars.json`, `**/*.tfstate`, `**/*.tfstate.*`.
- `blockLabels` now resolves bare identifier block labels (`resource aws_instance web`), not just quoted string labels.
- Reference resolution walks consecutive `get_attr` siblings instead of scanning all of a variable expression's parent's children, so unrelated sibling expressions (e.g. `concat(var.x, local.y)`) no longer leak into the attribute chain.
- `readConfig`/`loadIndexerConfig` no longer crash on a malformed or comment-only config file — js-yaml 5 throws on empty-document input, now caught and surfaced as a clean `Invalid config at <path>` error.
