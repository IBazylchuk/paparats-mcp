# paparats-embed — llama.cpp (llama-server) + llama-swap with pre-baked embedding models
# Published as ibaz/paparats-embed:latest
#
# Replaces the old ibaz/paparats-ollama image. llama-server is ~6.6x faster than
# Ollama for embeddings on the same hardware and serves jina-code-embeddings,
# which Ollama 0.30+ rejects with HTTP 501. llama-swap fronts on-demand
# llama-server processes: one port, route by model name (like Ollama did), with
# per-model lazy loading + idle unload (EMBED_TTL).
#
# Multi-stage:
#   1. fetch the llama-swap static binary for the target arch
#   2. base on the official llama.cpp server image (has llama-server + libggml +
#      all CPU backends), add llama-swap + gettext (envsubst) + baked GGUFs
#
# Final image bakes both models so it's ready on first request:
#   jina-code-embeddings-1.5b Q8_0 (~1.65 GB, code, --pooling last)
#   bge-m3 Q8_0                     (~600 MB, arch/docs text, --pooling cls)

# Pin llama.cpp server image — bump deliberately (tags are date-stamped upstream).
ARG LLAMACPP_TAG=server
ARG LLAMASWAP_VERSION=239

# ── Stage 1: fetch llama-swap binary ──────────────────────────────────────
FROM alpine:3.20 AS swap-fetch
ARG LLAMASWAP_VERSION
ARG TARGETARCH
RUN apk add --no-cache curl tar && \
    case "$TARGETARCH" in \
      amd64) SWAP_ARCH=amd64 ;; \
      arm64) SWAP_ARCH=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" && exit 1 ;; \
    esac && \
    curl -fsSL -o /tmp/swap.tar.gz \
      "https://github.com/mostlygeek/llama-swap/releases/download/v${LLAMASWAP_VERSION}/llama-swap_${LLAMASWAP_VERSION}_linux_${SWAP_ARCH}.tar.gz" && \
    tar -xzf /tmp/swap.tar.gz -C /tmp && \
    install -m 0755 /tmp/llama-swap /usr/local/bin/llama-swap

# ── Stage 2: assemble the serving image ───────────────────────────────────
FROM ghcr.io/ggml-org/llama.cpp:${LLAMACPP_TAG}

# gettext-base provides envsubst for rendering the llama-swap config at start.
RUN apt-get update && \
    apt-get install -y --no-install-recommends gettext-base curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --from=swap-fetch /usr/local/bin/llama-swap /usr/local/bin/llama-swap

# llama-server lives in /app in the base image — make it resolvable by bare name
# from the llama-swap config's `cmd`.
ENV PATH="/app:${PATH}"

# Bake the models. Kept as separate layers so a model bump only re-pushes one.
RUN mkdir -p /models && \
    curl -fsSL -o /models/jina-code-embeddings-1.5b-Q8_0.gguf \
      "https://huggingface.co/jinaai/jina-code-embeddings-1.5b-GGUF/resolve/main/jina-code-embeddings-1.5b-Q8_0.gguf"
RUN curl -fsSL -o /models/bge-m3-Q8_0.gguf \
      "https://huggingface.co/KimChen/bge-m3-GGUF/resolve/main/bge-m3-q8_0.gguf"

COPY llama-swap.template.yaml /config/llama-swap.template.yaml
COPY entrypoint.sh /usr/local/bin/paparats-embed-entrypoint
RUN chmod +x /usr/local/bin/paparats-embed-entrypoint

# Idle seconds before a model is unloaded from RAM. Override per deployment:
# short on a laptop (save RAM), long on a server. 0 = never unload.
ENV EMBED_TTL=300

EXPOSE 8080

# llama-swap exposes an OpenAI-compatible surface; /health reports readiness.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:8080/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/paparats-embed-entrypoint"]

LABEL org.opencontainers.image.title="paparats-embed"
LABEL org.opencontainers.image.description="llama.cpp + llama-swap with pre-baked Jina Code Embeddings 1.5B and BGE-M3 for Paparats MCP"
LABEL org.opencontainers.image.source="https://github.com/ibaz/paparats-mcp"
