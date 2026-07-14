# paparats-embed

**Fast, zero-config embedding server for [Paparats MCP](https://github.com/ibaz/paparats-mcp) — code and text embeddings on CPU, no GPU required.**

`ibaz/paparats-embed` bundles [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` behind [llama-swap](https://github.com/mostlygeek/llama-swap) with two embedding models **pre-baked and ready on first request**. Drop it in, point Paparats at it, and index code and docs — nothing to download, register, or warm up.

## Why

Paparats used to embed with Ollama. Ollama 0.30+ **broke code embeddings** (rejects the jina-code model with HTTP 501), and even when it worked it was slow on CPU. This image replaces it:

- ⚡ **~5–9× faster than Ollama on the same hardware** (measured on an 8-CPU AWS Graviton box, batch=1: jina-code 5.4×, bge-m3 8.8×). The win is *bigger* on weak servers, where Ollama's per-request overhead dominates.
- ✅ **Serves the code model Ollama can't.** `jina-code-embeddings-1.5b` runs perfectly on `llama-server` — the exact model Ollama 0.30+ rejects.
- 🎯 **Correct pooling, drop-in compatible vectors.** Per-model pooling is baked in and cosine-verified against the old Ollama vectors — **no re-index required** when migrating.
- 💤 **Lazy load + idle unload.** Models load on first request and unload after `EMBED_TTL` seconds idle. A code-only user never spins up the text model; RAM is freed when nobody's searching.
- 🧊 **Zero-config, CPU-only.** No CUDA, no model registry, no Modelfile. Both GGUFs are baked in.

## Models

| Model | Use | Dims | Pooling |
| --- | --- | --- | --- |
| `jina-code-embeddings` | code search | 1536 | last |
| `bge-m3` | arch/docs text | 1024 | cls |

Both are served on a single OpenAI-compatible endpoint; route by model name.

## Run

```bash
docker run -d --name paparats-embed \
  -p 11434:8080 \
  -e EMBED_TTL=300 \
  ibaz/paparats-embed:latest
```

Then embed via the OpenAI-style API:

```bash
curl http://localhost:11434/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"jina-code-embeddings","input":"def add(a, b): return a + b"}'
```

## Configuration

| Env | Default | What it does |
| --- | --- | --- |
| `EMBED_TTL` | `300` | Seconds a model stays resident after its last request before unloading. Short on a laptop to save RAM; long (or `0` = never) on a busy server to avoid cold starts. |

Cold start (first request after idle/unload) is a few seconds while the model loads; every request after that is hot until `EMBED_TTL` elapses.

## Ports

llama-swap listens on `8080` inside the container. The examples map it to host `11434` for a painless migration from Ollama (same host port), but any host port works.

---

Built for [Paparats MCP](https://github.com/ibaz/paparats-mcp) — semantic code search over your repositories.
