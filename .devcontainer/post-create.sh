#!/usr/bin/env bash
# Runs once after container creation. Installs the CLI globally so demos use
# the published version, not a workspace build.
set -euo pipefail

echo "== Installing @paparats/cli =="
npm install -g @paparats/cli

echo
echo "== Done. Run 'paparats status' to verify the stack. =="
