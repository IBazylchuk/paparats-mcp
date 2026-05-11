#!/usr/bin/env bash
# Local release: publish to npm + push downstream `vX.Y.Z` tag.
#
# Run this on `main` after the changesets release PR has been merged.
# Prerequisites: `npm login` (or NPM_TOKEN in env) on this machine,
# git remote `origin` writable, working tree clean.
#
# Usage:
#   yarn release:local           # publish + tag
#   yarn release:local --dry-run # show what would happen, don't publish/push

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    eval "$@"
  fi
}

# 1. On main?
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "error: must be on main (currently on '$BRANCH')" >&2
  exit 1
fi

# 2. Working tree clean?
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

# 3. Up-to-date with origin/main?
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "error: local main ($LOCAL) is not in sync with origin/main ($REMOTE)" >&2
  echo "       pull or push first" >&2
  exit 1
fi

# 4. No pending changesets — release PR must already be merged.
PENDING=$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' | wc -l | tr -d ' ')
if [[ "$PENDING" != "0" ]]; then
  echo "error: $PENDING pending .changeset/*.md file(s) — merge the release PR first" >&2
  exit 1
fi

# 5. Read version from a workspace package (single source of truth post-bump).
VERSION=$(node -p "require('./packages/cli/package.json').version")
TAG="v${VERSION}"
echo "==> Releasing version: $VERSION  (tag: $TAG)"

# 6. Tag must not already exist.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists locally — was this version already released?" >&2
  exit 1
fi
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists on origin — was this version already released?" >&2
  exit 1
fi

# 7. Build + publish (changeset publish skips already-published versions).
echo "==> Building"
run "yarn build"
echo "==> Publishing to npm"
run "yarn changeset publish"

# 8. Push tag — this triggers docker-publish.yml and publish-mcp.yml.
echo "==> Tagging and pushing $TAG"
run "git tag '$TAG'"
run "git push origin '$TAG'"

echo "==> Done. $TAG pushed; downstream workflows (docker, MCP registry) will pick it up."
