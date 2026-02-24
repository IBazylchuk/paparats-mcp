#!/bin/bash
set -euo pipefail

# Build and optionally push the paparats-ollama Docker image.
# Server and indexer images are built by CI (docker-publish.yml).
#
# Usage: ./scripts/release-docker.sh [--push]
#
# Without --push: builds image locally (for testing)
# With --push: builds and pushes to Docker Hub (requires `docker login`)

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

echo "Building paparats-ollama for v${VERSION}..."
echo "  (downloads ~1.6 GB GGUF model — may take a while)"
echo ""

docker build \
  -f "$ROOT_DIR/packages/ollama/Dockerfile" \
  -t "ibaz/paparats-ollama:${VERSION}" \
  -t "ibaz/paparats-ollama:latest" \
  "$ROOT_DIR/packages/ollama"

echo ""
echo "Built: ibaz/paparats-ollama:${VERSION}"

if [ "$PUSH" = true ]; then
  echo ""
  echo "Pushing to Docker Hub..."

  docker push "ibaz/paparats-ollama:${VERSION}"
  docker push "ibaz/paparats-ollama:latest"

  echo ""
  echo "Pushed ibaz/paparats-ollama:${VERSION} and :latest"
else
  echo ""
  echo "To push: ./scripts/release-docker.sh --push"
fi
