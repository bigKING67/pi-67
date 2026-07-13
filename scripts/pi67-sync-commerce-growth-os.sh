#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint retained for existing maintainer runbooks.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/pi67-sync-commerce-skill-pack.sh" "$@"
