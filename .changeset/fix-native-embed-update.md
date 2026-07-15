---
'@paparats/cli': patch
---

Fix native embed install and make `paparats update` refresh it

- Correct the llama-swap Homebrew formula: it lives at `mostlygeek/llama-swap/llama-swap` (tap repo `homebrew-llama-swap`), not the non-existent `mostlygeek/tap/llama-swap`. `brew install` of the old name failed with `Repository not found`, breaking native macOS installs.
- `brewInstall` now taps and trusts a third-party formula before installing it — recent Homebrew refuses to load formulae from untrusted taps (`Refusing to load formula ... from untrusted tap`).
- `paparats update` now also installs/refreshes/starts the native embed server (llama-server + llama-swap) for native installs, so a single `paparats update` brings the whole stack current. Previously it only touched the Docker services, leaving Ollama-era hosts without a running embed backend. Add `--skip-embed` to opt out.
- On macOS the native embed server now runs under a launchd LaunchAgent (`com.paparats.embed`) with `RunAtLoad` + `KeepAlive`, so it survives reboots and restarts on crash. Previously it was a detached process that died on reboot. llama-swap's Homebrew formula ships no `service` block, so `brew services` can't supervise it — this replaces that gap. Non-macOS still uses a detached spawn.
