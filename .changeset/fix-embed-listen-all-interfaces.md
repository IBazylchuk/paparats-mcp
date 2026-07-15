---
'@paparats/cli': patch
---

Fix native embed unreachable from the Dockerised MCP server and indexer (`llama-server failed after 3 retries: fetch failed`). llama-swap was started with `--listen 127.0.0.1:11434` (loopback only), but the containers reach the host embed via `host.docker.internal`, which arrives on the host-gateway interface — a loopback bind refuses those connections. Bind to `0.0.0.0:11434` instead (in the launchd plist and the non-macOS detached spawn), matching Ollama's default. `paparats update` on macOS rewrites the launchd plist every run, so a single update repoints an existing 127.0.0.1 install to 0.0.0.0.
