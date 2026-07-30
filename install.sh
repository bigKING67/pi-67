#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint. All writes are owned by the immutable pi-67 manager.

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

usage() {
  cat <<'USAGE'
install.sh - compatibility shim for the pi-67 immutable manager

Usage:
  ./install.sh [--agent-dir DIR] [--skills-dir DIR] [--dry-run] [--json]
               [--no-npm] [--repair] [-y|--yes]

This script no longer copies or links workspace files itself. It delegates to:

  pi-67 install

The source-checkout form uses packages/pi67-cli/bin/pi-67.mjs with this checkout
as --repo-root. Packaged distro copies require an installed `pi-67` manager.

Removed legacy options fail closed instead of silently changing backup, linking,
or conflict behavior. Use `pi-67 migrate --check` before migrating an existing
legacy Git checkout.
USAGE
}

fail() {
  printf 'ERROR %s\n' "$*" >&2
  exit 2
}

warn() {
  printf 'WARN %s\n' "$*" >&2
}

global_args=()
install_args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-dir|--skills-dir)
      [ "$#" -ge 2 ] || fail "$1 requires a path"
      global_args+=("$1" "$2")
      shift 2
      ;;
    --agent-dir=*|--skills-dir=*)
      global_args+=("$1")
      shift
      ;;
    --dry-run|--json|--yes)
      global_args+=("$1")
      shift
      ;;
    -y)
      global_args+=("--yes")
      shift
      ;;
    --no-npm|--repair)
      install_args+=("$1")
      shift
      ;;
    --no-doctor|--no-report)
      warn "$1 is obsolete: immutable manager install does not run that legacy post-install step"
      shift
      ;;
    --backup-dir|--backup-dir=*)
      fail "--backup-dir was removed; pi-67 now owns integrity-checked workspace backups under its state directory"
      ;;
    --dev-link-skills)
      fail "--dev-link-skills was removed; production Skills are deployed transactionally, not linked from a checkout"
      ;;
    --strict-shared-skills)
      fail "--strict-shared-skills was removed from install.sh; inspect and reconcile with `pi-67 skills plan`"
      ;;
    --verbose)
      fail "--verbose was removed from install.sh; use the manager's JSON/status commands for diagnostics"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

# Bash 3.2 treats an empty array expansion as unset under `set -u`.
set +u

if [ -f "$REPO_ROOT/packages/pi67-cli/bin/pi-67.mjs" ]; then
  command -v node >/dev/null 2>&1 || fail "Node.js is required to run the source-checkout pi-67 manager"
  exec node "$REPO_ROOT/packages/pi67-cli/bin/pi-67.mjs" \
    --repo-root "$REPO_ROOT" "${global_args[@]}" install "${install_args[@]}"
fi

if command -v pi-67 >/dev/null 2>&1; then
  exec pi-67 "${global_args[@]}" install "${install_args[@]}"
fi

fail "pi-67 manager is not installed; install @bigking67/pi-67, then run `pi-67 install`"
