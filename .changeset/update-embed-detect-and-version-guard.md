---
'@paparats/cli': patch
---

Make `paparats update` reliably install/refresh the native embed server, and fail loudly when the CLI didn't actually upgrade

Two ways `paparats update` could leave a host with no running embed backend after the Ollama→llama-server migration — both fixed:

- **No install.json → embed step silently skipped.** The native-embed refresh was gated on `install.json` reporting `embedMode: native`. Installs from before that file existed (or hand-rolled ones) have no install.json, so the step was skipped without a word. `update` now detects native usage when install.json is absent — llama-swap/llama-server on PATH, a `~/.paparats/llama-swap.yaml`, or a macOS host with no `docker-compose.yml` — and installs/refreshes/starts the embed server anyway. When it does skip, it now logs the reason instead of staying silent.

- **CLI upgrade silently didn't take.** `npm install -g @paparats/cli@latest` can exit 0 without actually upgrading (a `paparats` on PATH from a different node/nvm than the `npm` that ran, or missing global-write perms), leaving the process on old code — every later step then ran the old logic while reporting success. `update` now verifies the installed global version against npm latest after the install and aborts with an actionable error (which node/nvm to fix) instead of a false "Update complete". Skipped gracefully when the registry is unreachable.
