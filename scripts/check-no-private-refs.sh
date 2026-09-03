#!/usr/bin/env bash
#
# Fails when a change introduces something that identifies the organisation this
# was developed in, or a person. See the "This is a public repository" section of
# CLAUDE.md for the rule; this script is the enforcement.
#
# Scans the working tree, and — when a base ref is available — the commit
# messages a branch adds, since a leak in a commit message is as public as one in
# a file and is far easier to miss in review.
#
# Usage:
#   scripts/check-no-private-refs.sh            # tree + commits vs origin/main
#   BASE_REF=origin/master scripts/check-...sh  # different base
set -uo pipefail

# No patterns are hard-coded. Anything organisation-specific belongs in the
# ignored file below: a checked-in list of names that must never appear is itself
# a list of those names, in the very repository it is meant to keep clean.
#
# A generic ticket-id shape ('[A-Z]{2,6}-[0-9]{3,}') was tried and removed: it
# matches SHA-256, HTTP-500 and the PROJ-123 placeholders in this project's own
# docs and tests. A check that cries wolf on its own repository gets disabled,
# so real tracker prefixes go in the local file instead.
PATTERNS=()

# Optional local additions, one extended-regex pattern per line, '#' for
# comments. Git-ignored, so each clone can carry the names it must screen for
# without publishing them. Absent by default, in which case the e-mail check
# below is what still runs in CI.
LOCAL_PATTERNS_FILE="${PRIVATE_REFS_PATTERNS:-.private-refs-patterns}"
if [ -f "$LOCAL_PATTERNS_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in '' | '#'*) continue ;; esac
    PATTERNS+=("$line")
  done < "$LOCAL_PATTERNS_FILE"
fi

# Paths that legitimately contain a matching string, or that we cannot rewrite.
EXCLUDE_PATHS=(
  ':(exclude)scripts/check-no-private-refs.sh'
  ':(exclude)CLAUDE.md'
  ':(exclude)yarn.lock'
  ':(exclude).yarn'
)

fail=0

report() {
  if [ "$fail" -eq 0 ]; then
    echo "✖ Private references found. These must not reach a public repository."
    echo "  See the 'This is a public repository' section of CLAUDE.md."
    echo
  fi
  fail=1
}

# ── Files ───────────────────────────────────────────────────────────────────
# --untracked matters: a newly added fixture is the most likely place for a leak
# and is not yet in the index, so a default git grep would not see it.
for pat in "${PATTERNS[@]}"; do
  # -I skips binaries; -E for the ticket-id alternation; -n for line numbers.
  if hits=$(git grep --untracked -nIE -i -e "$pat" -- . "${EXCLUDE_PATHS[@]}" 2>/dev/null); then
    report
    echo "  pattern: $pat"
    printf '%s\n' "$hits" | sed 's/^/    /' | head -20
    echo
  fi
done

# ── Commit messages this branch adds ────────────────────────────────────────
# Skipped when the base is unknown (a shallow clone, or a fresh repository).
BASE_REF="${BASE_REF:-origin/main}"
if git rev-parse --verify --quiet "$BASE_REF" > /dev/null; then
  range="$BASE_REF..HEAD"
  for pat in "${PATTERNS[@]}"; do
    if hits=$(git log "$range" --format='%h %s%n%b' 2>/dev/null | grep -nIE -i -e "$pat"); then
      report
      echo "  pattern in commit messages: $pat"
      printf '%s\n' "$hits" | sed 's/^/    /' | head -10
      echo
    fi
  done
  # Any e-mail in a message that is not a recognised no-reply address.
  if hits=$(git log "$range" --format='%b' 2>/dev/null \
    | grep -oIE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' \
    | grep -viE '@(users\.)?noreply\.(github|anthropic)\.com|^noreply@|support@github\.com'); then
    report
    echo "  e-mail address in a commit message:"
    printf '%s\n' "$hits" | sort -u | sed 's/^/    /' | head -10
    echo
  fi
else
  echo "note: $BASE_REF not available — checked files only, not commit messages."
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "✔ No private references found."
