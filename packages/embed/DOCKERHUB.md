# paparats-embed

**Fast, zero-config embedding server for [Paparats MCP](https://github.com/ibaz/paparats-mcp) — code and text embeddings on CPU, no GPU required.**

`ibaz/paparats-embed` bundles [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server` behind [llama-swap](https://github.com/mostlygeek/llama-swap) with two embedding models **pre-baked and ready on first request**. Drop it in, point Paparats at it, and index code and docs — nothing to download, register, or warm up.

## Why

Paparats used to embed with Ollama, then briefly with CC-BY-NC jina models. This image ships two **permissively licensed (Apache-2.0)** embedders on `llama-server`, ~5-9x faster than Ollama on CPU:

- **Permissive licenses.** `bge-code-v1` and `Qwen3-Embedding-0.6B` are both Apache-2.0 — safe for commercial/enterprise use (the previous jina models were CC-BY-NC).
- **~5-9x faster than Ollama on the same hardware.** The win is bigger on weak servers, where Ollama's per-request overhead dominates.
- **Correct pooling.** Both models are decoder-based (`--pooling last`), baked in and cosine-verified. Wrong pooling silently corrupts the vector space.
- **Lazy load + idle unload.** Models load on first request and unload after `EMBED_TTL` seconds idle. A code-only user never spins up the text model; RAM is freed when nobody's searching.
- **Zero-config, CPU-only.** No CUDA, no model registry, no Modelfile. Both GGUFs are baked in.

## Models

| Model | Use | Dims | Pooling | License |
| --- | --- | --- | --- | --- |
| `bge-code-v1` | code search | 1536 | last | Apache-2.0 |
| `qwen3-embedding-0.6b` | arch/docs text | 1024 | last | Apache-2.0 |

Both are served on a single OpenAI-compatible endpoint; route by model name.

## Run

    docker run -d --name paparats-embed \
      -p 11434:8080 \
      -e EMBED_TTL=300 \
      ibaz/paparats-embed:latest

Embed code via the OpenAI-style API:

    curl http://localhost:11434/v1/embeddings \
      -H 'Content-Type: application/json' \
      -d '{"model":"bge-code-v1","input":"def add(a, b): return a + b"}'

Embed arch/docs prose by routing to the text model:

    curl http://localhost:11434/v1/embeddings \
      -H 'Content-Type: application/json' \
      -d '{"model":"qwen3-embedding-0.6b","input":"How the indexer maps commits to chunks"}'

## Configuration

| Env | Default | What it does |
| --- | --- | --- |
| `EMBED_TTL` | `300` | Seconds a model stays resident after its last request before unloading. Short on a laptop to save RAM; long (or `0` = never) on a busy server to avoid cold starts. |

Cold start (first request after idle/unload) is a few seconds while the model loads; every request after that is hot until `EMBED_TTL` elapses.

## Ports

llama-swap listens on `8080` inside the container. The examples map it to host `11434` for a painless migration from Ollama (same host port), but any host port works.

---

Built for [Paparats MCP](https://github.com/ibaz/paparats-mcp) — semantic code search over your repositories.

embeddings, embedding-server, llama-cpp, llama-server, llama-swap, mcp,
semantic-search, code-search, vector-search, bge-code-v1, qwen3-embedding, bge,
gguf, cpu, ollama-alternative, qdrant, apache-2.0
