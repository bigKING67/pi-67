#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
MODE="--apply"
JSON=false
EXTRA_ARGS=()

usage() {
  cat <<'USAGE'
pi67-patch-pi-until-done-runtime-queue patches/checks pi-until-done queue and progress compatibility.

Usage:
  scripts/pi67-patch-pi-until-done-runtime-queue.sh [--check] [--apply] [--json] [--agent-dir DIR]

Default mode is --apply. The underlying patch is version-aware and only rewrites
known pi-until-done@0.2.2 sendUserMessage call sites and until_done_* progress
signal handling.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      MODE="--check"
      shift
      ;;
    --apply)
      MODE="--apply"
      shift
      ;;
    --json)
      JSON=true
      shift
      ;;
    --agent-dir)
      AGENT_DIR="${2:?--agent-dir requires a path}"
      shift 2
      ;;
    --self-test)
      EXTRA_ARGS+=("--self-test")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL node not found; cannot check pi-until-done runtime queue compatibility" >&2
  exit 1
fi

ARGS=("$REPO_ROOT/scripts/pi67-patch-pi-until-done-runtime-queue.mjs")
if [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then
  ARGS+=("${EXTRA_ARGS[@]}")
else
  ARGS+=("$MODE" "--agent-dir" "$AGENT_DIR")
  if [ "$JSON" = true ]; then
    ARGS+=("--json")
  fi
fi

node "${ARGS[@]}"
