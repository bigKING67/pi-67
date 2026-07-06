#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATOR="${HOME}/.codex/skills/.system/skill-creator/scripts/quick_validate.py"

python3 "$VALIDATOR" "$ROOT"

if grep -R -nE 'TODO|TBD|FIXME|utm_source=chatgpt.com' "$ROOT" --exclude-dir=.git --exclude=validate.sh; then
  echo "Validation failed: unresolved placeholder or chatgpt UTM source found." >&2
  exit 1
fi

test -f "$ROOT/agents/openai.yaml"
test -f "$ROOT/references/business-model-and-profit.md"
test -f "$ROOT/references/assortment-pricing-channel-control.md"
test -f "$ROOT/references/channel-portfolio-matrix.md"
test -f "$ROOT/references/douyin-playbook.md"
test -f "$ROOT/references/tmall-playbook.md"
test -f "$ROOT/references/xiaohongshu-playbook.md"
test -f "$ROOT/references/jd-playbook.md"
test -f "$ROOT/references/wechat-video-and-private-domain.md"
test -f "$ROOT/references/pinduoduo-channel-control.md"
test -f "$ROOT/references/kuaishou-playbook.md"
test -f "$ROOT/references/promotion-fulfillment-data.md"
test -f "$ROOT/references/data-review-metrics.md"
test -f "$ROOT/references/answer-quality-rubric.md"
test -f "$ROOT/references/category-pack-intake.md"
test -f "$ROOT/references/platform-currentness.md"
test -f "$ROOT/references/currentness-source-map.md"
test -f "$ROOT/references/currentness-official-sources.md"
test -f "$ROOT/references/eval-cases.md"
test -d "$ROOT/eval/golden-answers"
test -f "$ROOT/references/category-packs/beauty-personal-care.md"
test -f "$ROOT/references/category-packs/premium-mother-and-baby.md"
test -f "$ROOT/references/category-packs/premium-pet.md"
test -f "$ROOT/references/category-packs/premium-food-and-beverage.md"
test -f "$ROOT/references/category-packs/premium-home-fragrance-and-care.md"
test -f "$ROOT/references/category-packs/silver-lifestyle-wellness.md"
test -f "$ROOT/references/category-packs/premium-apparel-and-accessories.md"
test -f "$ROOT/references/category-packs/nutrition-and-functional-food.md"
test -f "$ROOT/references/category-packs/consumer-electronics-and-smart-hardware.md"
test -f "$ROOT/references/category-packs/home-paper-and-daily-necessities.md"
test -f "$ROOT/eval/cases.json"
test -f "$ROOT/scripts/unit_economics.py"
test -f "$ROOT/scripts/test_unit_economics.py"
test -f "$ROOT/scripts/score_eval.py"
test -f "$ROOT/scripts/lint_answer.py"
test -f "$ROOT/scripts/check_source_registry.py"
test -f "$ROOT/scripts/run_eval.sh"
test -f "$ROOT/scripts/smoke_eval.sh"

bash "$ROOT/scripts/smoke_eval.sh"

echo "commerce-growth-os validation passed."
