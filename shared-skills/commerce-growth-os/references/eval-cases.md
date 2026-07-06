# Commerce Growth OS Eval Cases

## Load when

Use this reference only when maintaining or validating this skill. Do not load it for normal commerce strategy answers.

## Evaluation rule

The expected output is not a fixed script. Validate whether an answer follows the skill contract:

- Calculate economics before recommending paid scale.
- Separate confirmed facts, assumptions, and recommendations when data is incomplete.
- Design assortment and price ladder before platform tactics.
- Explain channel job, decision metric, stop rule, scale rule, margin risk, price-channel risk, and asset/repurchase value.
- Verify or label current platform-sensitive claims.

For deterministic saved-answer smoke scoring, use `scripts/run_eval.sh <answer-dir>` with `eval/cases.json`. The scorer checks required rubric elements and forbidden phrases, then runs the answer linter for generic empty-advice/currentness/economics guardrails and output-mode gates; it does not replace human review.

The maintained golden-answer suite lives in `eval/golden-answers/`. Run it after changing SKILL.md, category packs, eval rubrics, `score_eval.py`, or `lint_answer.py`:

```bash
bash scripts/run_eval.sh eval/golden-answers
```

For direct linting, use:

```bash
python3 scripts/lint_answer.py --mode decision_memo --answer path/to/answer.txt --json
python3 scripts/lint_answer.py --answer-dir path/to/answers --cases eval/cases.json --json
```

## Case 1: Full brand diagnosis

Prompt:

```text
We are a premium scalp-care brand selling on Douyin and Tmall. AOV is 189, gross margin is about 62%, Douyin ROI is 1.4, refund is rising, and Tmall reviews are weak. Give us a 90-day growth plan.
```

Checklist:

- Identifies stage and bottleneck.
- Builds or requests economics: AOV, margin, fees, fulfillment, gifts, refund, ad spend.
- Includes assortment roles and price ladder.
- Assigns Xiaohongshu, Douyin, Tmall, self-live, talent-live, search/shelf, and member jobs.
- Includes refund/fulfillment watchlist and review cadence.
- Adds claim/compliance risk because this is beauty/personal care.

## Case 2: Add Qianchuan budget

Prompt:

```text
Our hero SKU GMV was 300000 last month. Qianchuan spend was 150000, ROI 2.0, gross margin 55%, gifts and fulfillment are about 12% of GMV, refund loss is 6%. Should we double the budget?
```

Checklist:

- Does not recommend budget increase before break-even economics.
- Computes or requests gross-profit ROI / break-even ROI.
- Mentions marginal ROI risk after scale.
- Gives add-budget, cap-budget, and stop rules.
- Notes price-channel and inventory/refund risks.

## Case 3: Talent livestream booking

Prompt:

```text
A mid-tier creator asks for 50000 pit fee plus 25% commission. Expected GMV is 400000. Product cost is 32%, platform fee is 5%, gift/sample cost is 8%, fulfillment is 4%, refund loss is 7%. Should we book?
```

Checklist:

- Calculates channel net profit or uses `scripts/unit_economics.py`.
- Computes maximum commission or shows why 25% is too high/acceptable.
- Separates profit channel from acquisition/seeding budget.
- Defines payback if first-order loss is allowed.
- Checks inventory, claim, creator fit, and review base.

## Case 4: Xiaohongshu seeding

Prompt:

```text
We want to do Xiaohongshu for a premium pet supplement brand. What should the seeding plan look like?
```

Checklist:

- Routes to premium pet logic.
- Uses trust/search mindshare, not lowest-price selling.
- Includes keyword matrix, creator brief, safe claim boundaries, and landing path.
- Connects Xiaohongshu content to Tmall/Douyin search and product detail conversion.
- Includes metrics beyond exposure: save/comment quality, search lift, store/detail visits, repurchase asset value.

## Case 5: Tmall conversion diagnosis

Prompt:

```text
Douyin and Xiaohongshu are driving brand searches, but our Tmall flagship store conversion is poor. What should we inspect first?
```

Checklist:

- Prioritizes Tmall title, main image CTR, price consistency, review base, Q&A, buyer show, detail proof, SKU structure, store score, and fulfillment.
- Maps seeding keywords into Tmall title/search/detail modules.
- Does not solve only with Wanxiangtai spend.
- Mentions member/repurchase path if the category supports repeat purchase.

## Case 6: Incomplete profitability decision

Prompt:

```text
We sell a premium food gift box at 299 and want to push livestream. I only know gross margin is around 50%. Is this worth doing?
```

Checklist:

- Routes to premium food/beverage logic.
- Separates confirmed facts, assumptions, and recommendations.
- Requests or assumes platform fee, gift/sample, fulfillment, refund loss, commission, pit fee, and target profit.
- Gives a conditional decision instead of a fabricated conclusion.
- Mentions shelf life, breakage, gifting seasonality, and review/trust landing.

## Case 7: Platform-current tactic

Prompt:

```text
Can we still use Juguang Search to intercept competitor terms for Xiaohongshu, and should we shift half of our seeding budget there this month?
```

Checklist:

- Separates stable operating principle from current platform capability.
- Labels unverified platform facts as needing current verification unless official/current backend evidence is supplied.
- Explains the decision impact if the entrance or policy has changed.
- Does not recommend a budget shift before checking search intent, landing conversion, brand-safety risk, and contribution profit.
- Gives a small test, stop rule, scale rule, and compliant competitor-term boundary.

## Case 8: Weekly data review

Prompt:

```text
This week Douyin GMV rose 35%, Qianchuan ROI fell from 2.4 to 1.7, refund loss rose from 5% to 9%, Tmall brand-word searches rose 28%, but Tmall payment CVR fell. What should we do next week?
```

Checklist:

- Does not celebrate GMV without profit and refund diagnosis.
- Separates traffic, conversion, profit, and asset layers.
- Identifies likely marginal traffic/refund deterioration on Douyin and landing trust/CVR issue on Tmall.
- Gives next-week channel decisions: cap/segment paid scale, inspect refund reasons, fix Tmall search/detail/review landing, and preserve brand-search assets.
- Provides stop/scale thresholds and next review window.

## Case 9: JD channel entry

Prompt:

```text
We are a premium smart home device brand with good Xiaohongshu seeding and Tmall reviews. Should we open JD next quarter?
```

Checklist:

- Assigns JD a clear search/trust/logistics/after-sale role, not just "another channel".
- Checks product-page trust, review base, service/warranty, and delivery promise.
- Requires unit economics and price-line separation before opening.
- Explains how Xiaohongshu/Tmall assets should land into JD search/shelf.
- Gives launch test, stop rule, scale rule, and channel conflict risk.

## Case 10: Pinduoduo premium price conflict

Prompt:

```text
A premium beauty brand has old inventory and wants to sell the same hero SKU cheaper on Pinduoduo. Should we do it?
```

Checklist:

- Does not approve selling the same hero SKU visibly cheaper by default.
- Recommends channel-exclusive spec, clearance SKU, old model, pack/gift separation, or explicit subsidy owner.
- Defines minimum profit price and forbidden floor price.
- Mentions unauthorized sellers, cross-channel complaints, review damage, and brand price memory.
- Separates clearance objective from long-term brand/profit strategy.

## Case 11: Premium apparel return-risk control

Prompt:

```text
We are launching a premium outdoor apparel line on Xiaohongshu, Douyin, Tmall, and JD. How should we plan assortment, content, and return-risk control?
```

Checklist:

- Routes to apparel/accessory logic.
- Includes style/occasion, fit, size chart, buyer show, try-on, material proof, and size-color inventory.
- Designs assortment roles and price ladder before channel tactics.
- Assigns Xiaohongshu, Douyin, Tmall, and JD jobs separately.
- Adds return/refund risk controls, CS scripts, review/Q&A landing, and seasonal markdown governance.

## Case 12: Consumer electronics JD launch

Prompt:

```text
We are a smart hardware brand with one hero model, good Xiaohongshu seeding, and Tmall reviews. Should JD, Douyin, and Tmall each do different jobs next quarter?
```

Checklist:

- Routes to consumer electronics/smart hardware logic.
- Assigns JD a trust/search/service/warranty/parameter role.
- Separates JD, Tmall, Douyin content/live, and Xiaohongshu asset jobs.
- Requires model/spec, warranty, after-sale, Q&A, reviews, and price ladder before scale.
- Uses unit economics and service/refund sensitivity before paid or talent expansion.

## Case 13: Home paper Pinduoduo conflict

Prompt:

```text
We sell tissue and home cleaning consumables. Pinduoduo wants a low-price family pack for volume. Is it worth doing?
```

Checklist:

- Routes to home paper/daily necessities logic.
- Calculates or requests freight, packaging, refund/replacement, subsidy, and channel net profit.
- Uses channel-exclusive pack/spec, minimum profit price, and forbidden floor price.
- Mentions Pinduoduo price conflict, Tmall/JD/Douyin comparison, and brand price memory.
- Includes repurchase, household stock-up, damage/leakage/missing-piece review risk, and stop/scale rules.

## Case 14: Channel portfolio budget allocation

Prompt:

```text
We have Douyin, Tmall, Xiaohongshu, JD, and private domain running at the same time. How should we split channel jobs and next-month budget?
```

Checklist:

- Uses channel job logic instead of platform popularity.
- Splits budget by proof/asset, test, scale, search/shelf, clearance, and retention buckets.
- Gives stop/scale rules and owners by channel.
- Mentions price conflict, search landing, review assets, and channel net profit.
- Preserves repurchase/private-domain role instead of treating every channel as new traffic.
