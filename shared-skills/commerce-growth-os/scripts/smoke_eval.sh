#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_file() {
  test -f "$ROOT/$1" || {
    echo "Missing required file: $1" >&2
    exit 1
  }
}

require_text() {
  local file="$1"
  local text="$2"
  if ! grep -Fq -- "$text" "$ROOT/$file"; then
    echo "Missing expected text in $file: $text" >&2
    exit 1
  fi
}

require_file "SKILL.md"
require_file "references/channel-portfolio-matrix.md"
require_file "references/answer-quality-rubric.md"
require_file "references/platform-currentness.md"
require_file "references/currentness-official-sources.md"
require_file "references/eval-cases.md"
require_file "references/category-packs/premium-mother-and-baby.md"
require_file "references/category-packs/premium-pet.md"
require_file "references/category-packs/premium-food-and-beverage.md"
require_file "references/category-packs/premium-home-fragrance-and-care.md"
require_file "references/category-packs/silver-lifestyle-wellness.md"
require_file "references/category-packs/premium-apparel-and-accessories.md"
require_file "references/category-packs/nutrition-and-functional-food.md"
require_file "references/category-packs/consumer-electronics-and-smart-hardware.md"
require_file "references/category-packs/home-paper-and-daily-necessities.md"
require_file "references/jd-playbook.md"
require_file "references/wechat-video-and-private-domain.md"
require_file "references/pinduoduo-channel-control.md"
require_file "references/kuaishou-playbook.md"
require_file "eval/cases.json"
require_file "eval/golden-answers/full_brand_diagnosis_scalp_care.txt"
require_file "eval/golden-answers/platform_current_juguang_search.txt"
require_file "eval/golden-answers/channel_portfolio_budget_allocation.txt"
require_file "scripts/unit_economics.py"
require_file "scripts/test_unit_economics.py"
require_file "scripts/score_eval.py"
require_file "scripts/lint_answer.py"
require_file "scripts/check_source_registry.py"
require_file "scripts/run_eval.sh"

require_text "SKILL.md" "Quick diagnosis"
require_text "SKILL.md" "Decision memo"
require_text "SKILL.md" "Full operating plan"
require_text "SKILL.md" "Data review"
require_text "SKILL.md" "Minimum diagnosis intake"
require_text "SKILL.md" "Profit decision intake"
require_text "SKILL.md" "platform-currentness.md"
require_text "SKILL.md" "currentness-source-map.md"
require_text "SKILL.md" "data-review-metrics.md"
require_text "SKILL.md" "jd-playbook.md"
require_text "SKILL.md" "wechat-video-and-private-domain.md"
require_text "SKILL.md" "pinduoduo-channel-control.md"
require_text "SKILL.md" "kuaishou-playbook.md"
require_text "SKILL.md" "channel-portfolio-matrix.md"
require_text "SKILL.md" "premium-apparel-and-accessories.md"
require_text "SKILL.md" "nutrition-and-functional-food.md"
require_text "SKILL.md" "consumer-electronics-and-smart-hardware.md"
require_text "SKILL.md" "home-paper-and-daily-necessities.md"
require_text "SKILL.md" "currentness-official-sources.md"
require_text "SKILL.md" "answer-quality-rubric.md"
require_text "SKILL.md" "scripts/lint_answer.py"
require_text "SKILL.md" "scripts/check_source_registry.py"
require_text "SKILL.md" "scripts/unit_economics.py"
require_text "SKILL.md" "--strict"
require_text "SKILL.md" "--sensitivity"

require_text "references/category-pack-intake.md" "premium-mother-and-baby.md"
require_text "references/category-pack-intake.md" "premium-pet.md"
require_text "references/category-pack-intake.md" "premium-food-and-beverage.md"
require_text "references/category-pack-intake.md" "premium-home-fragrance-and-care.md"
require_text "references/category-pack-intake.md" "silver-lifestyle-wellness.md"
require_text "references/category-pack-intake.md" "premium-apparel-and-accessories.md"
require_text "references/category-pack-intake.md" "nutrition-and-functional-food.md"
require_text "references/category-pack-intake.md" "consumer-electronics-and-smart-hardware.md"
require_text "references/category-pack-intake.md" "home-paper-and-daily-necessities.md"

require_text "references/eval-cases.md" "Case 1: Full brand diagnosis"
require_text "references/eval-cases.md" "Case 2: Add Qianchuan budget"
require_text "references/eval-cases.md" "Case 3: Talent livestream booking"
require_text "references/eval-cases.md" "Case 4: Xiaohongshu seeding"
require_text "references/eval-cases.md" "Case 5: Tmall conversion diagnosis"
require_text "references/eval-cases.md" "Case 6: Incomplete profitability decision"
require_text "references/eval-cases.md" "Case 7: Platform-current tactic"
require_text "references/eval-cases.md" "Case 8: Weekly data review"
require_text "references/eval-cases.md" "Case 9: JD channel entry"
require_text "references/eval-cases.md" "Case 10: Pinduoduo premium price conflict"
require_text "references/eval-cases.md" "Case 11: Premium apparel return-risk control"
require_text "references/eval-cases.md" "Case 12: Consumer electronics JD launch"
require_text "references/eval-cases.md" "Case 13: Home paper Pinduoduo conflict"
require_text "references/eval-cases.md" "Case 14: Channel portfolio budget allocation"

python3 -B "$ROOT/scripts/score_eval.py" --self-test
python3 -B "$ROOT/scripts/score_eval.py" --list >/dev/null
python3 -B "$ROOT/scripts/lint_answer.py" --self-test
python3 -B "$ROOT/scripts/lint_answer.py" --mode decision_memo --answer "$ROOT/eval/golden-answers/qianchuan_budget_scale.txt" --json >/dev/null
python3 -B "$ROOT/scripts/check_source_registry.py" --self-test
python3 -B "$ROOT/scripts/check_source_registry.py" "$ROOT/references/currentness-official-sources.md" --json >/dev/null
bash "$ROOT/scripts/run_eval.sh" "$ROOT/eval/golden-answers" >/dev/null

OUT="$(python3 "$ROOT/scripts/unit_economics.py" \
  gmv=400000 \
  product_cost_rate=32 \
  platform_fee_rate=5 \
  creator_commission_rate=25 \
  pit_fee=50000 \
  gift_cost_rate=8 \
  fulfillment_cost_rate=4 \
  refund_loss_rate=7 \
  ad_spend=0 \
  orders=2000)"

python3 - "$OUT" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
metrics = payload["metrics"]
required = [
    "allowable_cac",
    "break_even_roi",
    "channel_net_profit",
    "max_creator_commission_rate",
    "repurchase_payback_required",
]
missing = [key for key in required if key not in metrics]
if missing:
    raise SystemExit(f"missing metrics: {missing}")
if metrics["channel_net_profit"] is None:
    raise SystemExit("channel_net_profit is null")
if not isinstance(payload.get("warnings"), list):
    raise SystemExit("warnings must be a list")
PY

python3 -B "$ROOT/scripts/test_unit_economics.py"

python3 "$ROOT/scripts/unit_economics.py" \
  --strict \
  --scenario talent \
  --sensitivity \
  gmv=400000 \
  product_cost_rate=32 \
  platform_fee_rate=5 \
  creator_commission_rate=25 \
  pit_fee=50000 \
  gift_cost_rate=8 \
  fulfillment_cost_rate=4 \
  refund_loss_rate=7 \
  ad_spend=0 \
  target_profit=0 \
  orders=2000 >/dev/null

if python3 "$ROOT/scripts/unit_economics.py" --strict gmv=100000 gross_margin_rate=50 >/dev/null 2>&1; then
  echo "Strict mode should reject incomplete economics input." >&2
  exit 1
fi

echo "commerce-growth-os smoke eval passed."
