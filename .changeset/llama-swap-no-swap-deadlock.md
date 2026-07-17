---
'@paparats/cli': patch
---

Prevent llama-swap deadlock under concurrent load: generated llama-swap configs now keep both embedding models in a `swap: false` group so they never swap each other out. The native (macOS) config also drops per-model `ttl` — both models stay resident (~2.2 GB total). llama-swap's swap/unload state machine can wedge permanently when a client abort lands mid-swap; the proxy keeps answering `/v1/models` but never spawns an upstream again, so every embedding request hangs until restart. The Docker template keeps the `EMBED_TTL` idle-unload knob (set `EMBED_TTL=0` to remove the unload path entirely).
