---
name: commerce-commercial-strategy
description: 消费品牌商业策略与商品经营 Skill。用于利润模型、ROI/CAC/LTV、货盘、SKU 角色、价盘、渠道专供、最低利润价、达人佣金与坑位、投放预算边界、渠道进入和渠道冲突决策。遇到“值不值得、最多花多少、能否放量、是否降价或进渠道”时使用。
---

# Commerce Commercial Strategy

## Role

Own commercial viability. Decide whether a SKU, price, channel, creator, promotion, or media plan can create acceptable profit and strategic value.

## Workflow

1. Separate confirmed facts and assumptions.
2. Classify the decision: assortment, price, budget, creator, channel, or scale.
3. Build the smallest sufficient economics model.
4. Define price floors, budget ceilings, and channel constraints.
5. Run downside sensitivity when refund, commission, traffic cost, or volume can change the conclusion.
6. Output decision, conditions, stop rule, scale rule, owner, and review window.

## Required economics

Use `scripts/unit_economics.py` for concrete ROI, CAC, creator, or profitability decisions. Use `--strict` when missing costs can reverse the recommendation, `--scenario paid|talent|general` for decision-specific gates, and `--sensitivity` for scale decisions.

Never recommend scale from platform ROI alone. Include product cost, platform fee, media, commission, pit fee, gifts, fulfillment, refunds, service, content, and target profit when material.

## Owned decisions

- Business model and unit economics.
- SKU roles, assortment, bundles, and channel exclusives.
- Daily price, campaign price, member price, minimum profit price, and forbidden floor price.
- Allowable CAC, break-even ROI, maximum commission, pit-fee tolerance, and paid-media budget bounds.
- Channel jobs, entry gates, price conflicts, and unauthorized low-price risks.
- First-order loss tolerance and repurchase payback conditions.

## References

- `references/business-model-and-profit.md`
- `references/assortment-pricing-channel-control.md`
- `references/channel-portfolio-matrix.md`
- `references/contracts/answer-quality-rubric.md`
- `references/category-overlays/` when category risk changes economics.

## Boundary

Marketing owns audience and communication. Operations owns execution. Analytics owns metric definitions. Supply chain will own sourcing, capacity, and upstream inventory plans. This skill owns the commercial constraints they must respect.

## Output contract

State the decision first, then confirmed facts, assumptions, economics, strategic value, price/channel risk, downside cases, stop rule, scale rule, owner, and next review.
