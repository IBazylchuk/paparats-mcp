#!/bin/sh
# Render the llama-swap config from the template, substituting EMBED_TTL, then
# exec llama-swap. Keeping TTL out of the baked config lets a single image serve
# both a short-lived laptop deployment and a long-lived server via one env var.
set -eu

: "${EMBED_TTL:=0}"
# Per-model compute-buffer batch. 2048 covers any single embedding chunk while
# keeping RSS in check — 8192 was the cgroup-OOM culprit. See the template.
: "${LLAMA_BATCH:=2048}"
# CPU threads per model. Empty → llama-server auto-detects. Set to cap the two
# resident models from oversubscribing a shared host.
: "${LLAMA_THREADS:=-1}"
export EMBED_TTL LLAMA_BATCH LLAMA_THREADS

# Only our own tokens are substituted — llama-swap's ${PORT}/${macro} tokens must
# survive envsubst, so we scope the substitution to this explicit set.
envsubst '${EMBED_TTL} ${LLAMA_BATCH} ${LLAMA_THREADS}' \
  < /config/llama-swap.template.yaml \
  > /config/llama-swap.yaml

echo "[paparats-embed] EMBED_TTL=${EMBED_TTL}s LLAMA_BATCH=${LLAMA_BATCH} LLAMA_THREADS=${LLAMA_THREADS} — starting llama-swap on :8080"
exec llama-swap --config /config/llama-swap.yaml --listen 0.0.0.0:8080
