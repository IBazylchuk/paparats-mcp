#!/bin/sh
# Render the llama-swap config from the template, substituting EMBED_TTL, then
# exec llama-swap. Keeping TTL out of the baked config lets a single image serve
# both a short-lived laptop deployment and a long-lived server via one env var.
set -eu

: "${EMBED_TTL:=0}"
export EMBED_TTL

# Only EMBED_TTL is substituted — llama-swap's own ${PORT}/${macro} tokens must
# survive envsubst, so we scope the substitution to that single variable.
envsubst '${EMBED_TTL}' \
  < /config/llama-swap.template.yaml \
  > /config/llama-swap.yaml

echo "[paparats-embed] EMBED_TTL=${EMBED_TTL}s — starting llama-swap on :8080"
exec llama-swap --config /config/llama-swap.yaml --listen 0.0.0.0:8080
