#!/bin/bash
set -euo pipefail

# Build and push all Docker images for the current version.
# Usage: ./scripts/release-docker.sh [--push]
#
# Without --push: builds images locally (for testing)
# With --push: builds and pushes to Docker Hub (requires `docker login`)
#
# Prerequisites:
#   - Docker with buildx
#   - Logged in to Docker Hub (for --push)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
PUSH=false

for arg in "$@"; do
  case $arg in
    --push) PUSH=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

echo "Building Docker images for v${VERSION}..."
echo ""

# ── Server ────────────────────────────────────────────────────────────────
echo "==> Building ibaz/paparats-server:${VERSION}"
docker build \
  -f "$ROOT_DIR/packages/server/Dockerfile" \
  -t "ibaz/paparats-server:${VERSION}" \
  -t "ibaz/paparats-server:latest" \
  "$ROOT_DIR"

# ── Indexer ───────────────────────────────────────────────────────────────
echo ""
echo "==> Building ibaz/paparats-indexer:${VERSION}"
docker build \
  -f "$ROOT_DIR/packages/indexer/Dockerfile" \
  -t "ibaz/paparats-indexer:${VERSION}" \
  -t "ibaz/paparats-indexer:latest" \
  "$ROOT_DIR"

# ── Ollama ────────────────────────────────────────────────────────────────
echo ""
echo "==> Building ibaz/paparats-ollama:${VERSION}"
echo "    (this downloads ~1.6 GB GGUF model — may take a while)"
docker build \
  -f "$ROOT_DIR/packages/ollama/Dockerfile" \
  -t "ibaz/paparats-ollama:${VERSION}" \
  -t "ibaz/paparats-ollama:latest" \
  "$ROOT_DIR/packages/ollama"

echo ""
echo "All images built:"
echo "  ibaz/paparats-server:${VERSION}"
echo "  ibaz/paparats-indexer:${VERSION}"
echo "  ibaz/paparats-ollama:${VERSION}"

if [ "$PUSH" = true ]; then
  echo ""
  echo "Pushing to Docker Hub..."

  docker push "ibaz/paparats-server:${VERSION}"
  docker push "ibaz/paparats-server:latest"

  docker push "ibaz/paparats-indexer:${VERSION}"
  docker push "ibaz/paparats-indexer:latest"

  docker push "ibaz/paparats-ollama:${VERSION}"
  docker push "ibaz/paparats-ollama:latest"

  echo ""
  echo "All images pushed to Docker Hub."
else
  echo ""
  echo "To push: ./scripts/release-docker.sh --push"
fi
