# paparats-ollama — Ollama with pre-baked Jina Code Embeddings model
# Published as ibaz/paparats-ollama:latest
#
# The model (~1.6 GB GGUF) is downloaded and registered at build time,
# so the container starts with the model immediately ready — no runtime downloads.

FROM ollama/ollama:latest

RUN ollama serve & \
    sleep 5 && \
    curl -L -o /tmp/jina.gguf \
      "https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF/resolve/main/jina-code-embeddings-1.5b-Q8_0.gguf" && \
    printf 'FROM /tmp/jina.gguf\nPARAMETER num_ctx 8192\n' > /tmp/Modelfile && \
    ollama create jina-code-embeddings -f /tmp/Modelfile && \
    rm /tmp/jina.gguf /tmp/Modelfile && \
    pkill ollama

EXPOSE 11434

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:11434/api/tags || exit 1

LABEL org.opencontainers.image.title="paparats-ollama"
LABEL org.opencontainers.image.description="Ollama with pre-baked Jina Code Embeddings 1.5B for Paparats MCP"
LABEL org.opencontainers.image.source="https://github.com/bkbhub/paparats-mcp"
