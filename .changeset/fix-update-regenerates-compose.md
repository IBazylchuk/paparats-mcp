---
'@paparats/cli': patch
---

`paparats update` now regenerates `docker-compose.yml` from `install.json` + `projects.yml` before pulling images and runs `docker compose up -d --remove-orphans`. Previously, when a new CLI version shipped new service fields, the on-disk compose stayed stale and `up -d` could fail with a container-name conflict (e.g. `paparats-mcp already in use`). The previous compose is preserved at `docker-compose.yml.bak` whenever the contents actually change.
