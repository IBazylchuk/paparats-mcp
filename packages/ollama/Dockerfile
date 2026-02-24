# paparats-ollama — Minimal Ollama with pre-baked Jina Code Embeddings model
# Published as ibaz/paparats-ollama:latest
#
# Multi-stage build:
#   1. Uses official ollama/ollama to download and register the model
#   2. Copies model data into alpine/ollama (~70 MB, CPU-only)
#
# Final image: ~1.7 GB (70 MB base + 1.6 GB model) instead of ~5+ GB

# ── Stage 1: register model using official ollama ─────────────────────────
FROM ollama/ollama:latest AS builder

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

RUN ollama serve & \
    while ! curl -s -f http://localhost:11434/api/tags > /dev/null; do echo "Waiting for Ollama..."; sleep 1; done && \
    curl -L -o /tmp/jina.gguf \
      "https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF/resolve/main/jina-code-embeddings-1.5b-Q8_0.gguf" && \
    printf 'FROM /tmp/jina.gguf\nPARAMETER num_ctx 8192\n' > /tmp/Modelfile && \
    ollama create jina-code-embeddings -f /tmp/Modelfile && \
    rm /tmp/jina.gguf /tmp/Modelfile && \
    pkill ollama

# ── Stage 2: copy model into lightweight alpine/ollama ────────────────────
FROM alpine/ollama:latest

COPY --from=builder /root/.ollama /root/.ollama

EXPOSE 11434

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:11434/api/tags || exit 1

LABEL org.opencontainers.image.title="paparats-ollama"
LABEL org.opencontainers.image.description="Ollama with pre-baked Jina Code Embeddings 1.5B for Paparats MCP"
LABEL org.opencontainers.image.source="https://github.com/bkbhub/paparats-mcp"
