---
'@paparats/server': patch
'@paparats/shared': patch
'@paparats/cli': patch
'@paparats/indexer': patch
---

`projects.yml` now accepts a per-repo `docs.kind` override for the docs relevance floor.

Auto-detection classifies a repo's markdown by whether the repo contains code, which misreads a documentation repository that also ships its own tooling: the tooling makes it look like `code`, so long-form prose gets held to the stricter floor intended for READMEs. `.paparats.yml` already accepted `docs.kind`, but the indexer configures repos through `projects.yml`, leaving the escape hatch unreachable for exactly the deployments that need it.

```yaml
repos:
  - url: org/handbook
    docs:
      kind: prose
```

Works in the `defaults` block as well as per repo.
