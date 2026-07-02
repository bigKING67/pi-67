#!/usr/bin/env bash
set -euo pipefail

# Conservative xtalpi launcher for machines where the company proxy sometimes
# returns an empty assistant after tool use. It keeps normal Pi flags available:
# any explicit --provider/--model/--thinking passed by the caller wins.

PI_BIN="${PI_BIN:-pi}"
PROVIDER="${PROVIDER:-xtalpi-tools}"
MODEL="${MODEL:-deepseek-v4-pro}"

export XTALPI_EMPTY_ASSISTANT_STRATEGY="${XTALPI_EMPTY_ASSISTANT_STRATEGY:-rescue_no_tools}"
export XTALPI_TOOL_RESULT_MIRROR="${XTALPI_TOOL_RESULT_MIRROR:-always}"
export XTALPI_TOOL_FILTER="${XTALPI_TOOL_FILTER:-auto}"
export XTALPI_MAX_TOOLS="${XTALPI_MAX_TOOLS:-8}"
export XTALPI_MAX_MIRRORED_TOOL_RESULT_CHARS="${XTALPI_MAX_MIRRORED_TOOL_RESULT_CHARS:-8000}"

has_flag() {
  local flag="$1"
  shift
  local arg
  for arg in "$@"; do
    if [ "$arg" = "$flag" ] || [[ "$arg" == "$flag="* ]]; then
      return 0
    fi
  done
  return 1
}

args=()
if ! has_flag "--provider" "$@"; then
  args+=(--provider "$PROVIDER")
fi
if ! has_flag "--model" "$@"; then
  args+=(--model "$MODEL")
fi
if ! has_flag "--thinking" "$@"; then
  args+=(--thinking off)
fi

exec "$PI_BIN" "${args[@]}" "$@"
