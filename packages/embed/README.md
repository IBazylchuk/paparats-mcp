# paparats-embed

**Fast, zero-config embedding server for [Paparats MCP](https://github.com/ibaz/paparats-mcp) — code and text embeddings on CPU, no GPU required.**

`ibaz/paparats-embed` bundles [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` behind [llama-swap](https://github.com/mostlygeek/llama-swap) with two embedding models **pre-baked and ready on first request**. Drop it in, point Paparats at it, and index code and docs — nothing to download, register, or warm up.

## Why

Paparats used to embed with Ollama, then briefly with CC-BY-NC jina models. This image ships two **permissively licensed (Apache-2.0)** embedders on `llama-server`, ~5–9× faster than Ollama on CPU:

- ⚖️ **Permissive licenses.** `bge-code-v1` and `Qwen3-Embedding-0.6B` are both Apache-2.0 — safe for commercial/enterprise use (the previous jina models were CC-BY-NC).
- ⚡ **~5–9× faster than Ollama on the same hardware.** The win is *bigger* on weak servers, where Ollama's per-request overhead dominates.
- 🎯 **Correct pooling.** Both models are decoder-based → `--pooling last`, baked in and cosine-verified. Wrong pooling silently corrupts the vector space.
- 💤 **Lazy load, resident by default.** Models load on first request and stay resident (~2.2 GB total) — no idle unload, so llama-swap's unload path (which can deadlock under concurrent load) is never exercised. Opt into idle unload with `EMBED_TTL` to save RAM on a laptop.
- 🧊 **Zero-config, CPU-only.** No CUDA, no model registry, no Modelfile. Both GGUFs are baked in.

## Models

| Model | Use | Dims | Pooling | License |
| --- | --- | --- | --- | --- |
| `bge-code-v1` | code search | 1536 | last | Apache-2.0 |
| `qwen3-embedding-0.6b` | arch/docs text | 1024 | last | Apache-2.0 |

Both are served on a single OpenAI-compatible endpoint; route by model name.

Swapping in a different model? Follow [docs/replacing-embedding-models.md](../../docs/replacing-embedding-models.md).

## Run

```bash
docker run -d --name paparats-embed \
  -p 11434:8080 \
  ibaz/paparats-embed:latest
```

Then embed via the OpenAI-style API:

```bash
curl http://localhost:11434/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-code-v1","input":"def add(a, b): return a + b"}'
```

## Configuration

| Env | Default | What it does |
| --- | --- | --- |
| `EMBED_TTL` | `0` | Seconds a model stays resident after its last request before unloading. `0` (default) = never unload — safest under load, since llama-swap's unload/swap path can deadlock when a client abort lands mid-unload. Set e.g. `300` on a laptop to save RAM at the cost of cold starts and that risk. |
| `LLAMA_BATCH` | `2048` | Per-model `--batch-size`/`--ubatch-size`. Sizes the compute buffer llama-server allocates up front, **per resident model**, regardless of the real payload. Embedding chunks are short, so a large batch never fills but its buffers still cost gigabytes of RSS — `8192` (the old value) was the direct cause of the embed-container OOM. Raise only for genuinely long inputs. |
| `LLAMA_THREADS` | `-1` | CPU threads per model. `-1` = llama-server auto-detects. Set a positive cap to stop the two resident models oversubscribing a shared host. |

Cold start (first request, or first after an idle unload when `EMBED_TTL` > 0) is a few seconds while the model loads; every request after that is hot.

Memory footprint scales with `LLAMA_BATCH` × the two resident models. At the `2048` default both fit comfortably in ~6 GB; the compose generator sets an explicit `6G` limit on the embed service (override with `EMBED_MEMORY`/`EMBED_CPUS`).

## Ports

llama-swap listens on `8080` inside the container. The examples map it to host `11434` for a painless migration from Ollama (same host port), but any host port works.

---

Built for [Paparats MCP](https://github.com/ibaz/paparats-mcp) — semantic code search over your repositories.
