---
'@paparats/cli': patch
---

Docker embed image now keeps both embedding models resident by default: `EMBED_TTL` defaults to `0` (never unload) in the image, entrypoint, compose generator and devcontainer — matching the native macOS config. With the previous default of `300`, llama-swap's idle-unload path stayed active out of the box, leaving the abort-mid-unload deadlock reachable in Docker deployments. Idle unload remains opt-in by setting a positive `EMBED_TTL`.
