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
#   bge-code-v1 Q8_0            (~1.5 GB, code, Apache-2.0, --pooling last)
#   Qwen3-Embedding-0.6B Q8_0   (~610 MB, arch/docs text, Apache-2.0, --pooling last)
# Both are permissively licensed (Apache-2.0). The previous jina-code (CC-BY-NC)
# and bge-m3 models were removed in the migration — rollback is via a previously
# published image tag, not by carrying legacy weights.

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
# Code embeddings — bge-code-v1 Q8_0 (~1.5 GB, Apache-2.0, --pooling last).
RUN mkdir -p /models && \
    curl -fsSL -o /models/bge-code-v1-Q8_0.gguf \
      "https://huggingface.co/taylor-jones/bge-code-v1-Q8_0-GGUF/resolve/main/bge-code-v1-q8_0.gguf"
# Arch/docs text embeddings — Qwen3-Embedding-0.6B Q8_0 (~610 MB, Apache-2.0,
# --pooling last).
RUN curl -fsSL -o /models/Qwen3-Embedding-0.6B-Q8_0.gguf \
      "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf"

COPY llama-swap.template.yaml /config/llama-swap.template.yaml
COPY entrypoint.sh /usr/local/bin/paparats-embed-entrypoint
RUN chmod +x /usr/local/bin/paparats-embed-entrypoint

# Idle seconds before a model is unloaded from RAM. 0 (default) = never
# unload: both models stay resident (~2.2 GB) and llama-swap's unload path —
# which can deadlock when a client abort lands mid-unload — is never
# exercised. Set a positive value (e.g. 300) to trade that safety for RAM
# on a laptop.
ENV EMBED_TTL=0

EXPOSE 8080

# llama-swap exposes an OpenAI-compatible surface; /health reports readiness.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:8080/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/paparats-embed-entrypoint"]

LABEL org.opencontainers.image.title="paparats-embed"
LABEL org.opencontainers.image.description="llama.cpp + llama-swap with pre-baked bge-code-v1 (code) and Qwen3-Embedding-0.6B (arch/docs text) — both Apache-2.0 — for Paparats MCP"
LABEL org.opencontainers.image.source="https://github.com/ibaz/paparats-mcp"
