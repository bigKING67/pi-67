#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 -B "$ROOT/scripts/score_eval.py" --self-test
python3 -B "$ROOT/scripts/score_eval.py" --list >/dev/null

if [ "${1:-}" != "" ]; then
  python3 -B "$ROOT/scripts/score_eval.py" --answer-dir "$1" --pretty
  python3 -B "$ROOT/scripts/lint_answer.py" --answer-dir "$1" --cases "$ROOT/eval/cases.json" --json
else
  echo "Eval cases are valid. To score saved answers, run: scripts/run_eval.sh <answer-dir>"
fi
