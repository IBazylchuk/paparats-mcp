---
'@paparats/cli': patch
---

`paparats edit compose` checks the edited file with `docker compose config` and restarts the stack, as `edit projects` already did. A file Compose cannot read is reported with its error, and the stack keeps running as it was. Before, it only printed a hint to run `paparats restart`.
