#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ROOT="${1:-${CODEX_HOME:-$HOME/.codex}/skills}"
DEST="${TARGET_ROOT%/}/commerce-growth-os"

mkdir -p "$DEST"
rsync -a --delete \
  --exclude '.git' \
  --exclude '.gitignore' \
  --exclude '.DS_Store' \
  "$ROOT/" "$DEST/"

echo "Installed commerce-growth-os to $DEST"
