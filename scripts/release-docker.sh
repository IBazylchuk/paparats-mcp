#!/bin/bash
set -euo pipefail

# Build and optionally push the paparats-embed Docker image.
#
# NOTE: The primary path is CI — .github/workflows/docker-publish-embed.yml builds
# and pushes this image (multi-arch amd64+arm64) on every v* tag, and can be run
# manually via workflow_dispatch. This script is a local fallback for testing or
# for building from a non-proxy network by hand.
#
# Server and indexer images are built by docker-publish.yml.
#
# Usage: ./scripts/release-docker.sh [--push]
#
# Without --push: builds image locally (for testing)
# With --push: builds and pushes to Docker Hub (requires `docker login`)
#
# Note: the build downloads ~2.3 GB of GGUF models from Hugging Face. Run it from
# a network without a TLS-intercepting proxy (a corporate MITM proxy breaks the
# in-container curl). CI and a home network both work.

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

echo "Building paparats-embed for v${VERSION}..."
echo "  (downloads ~2.3 GB of GGUF models — may take a while)"
echo ""

docker build \
  -f "$ROOT_DIR/packages/embed/Dockerfile" \
  -t "ibaz/paparats-embed:${VERSION}" \
  -t "ibaz/paparats-embed:latest" \
  "$ROOT_DIR/packages/embed"

echo ""
echo "Built: ibaz/paparats-embed:${VERSION}"

if [ "$PUSH" = true ]; then
  echo ""
  echo "Pushing to Docker Hub..."

  docker push "ibaz/paparats-embed:${VERSION}"
  docker push "ibaz/paparats-embed:latest"

  echo ""
  echo "Pushed ibaz/paparats-embed:${VERSION} and :latest"
else
  echo ""
  echo "To push: ./scripts/release-docker.sh --push"
fi
