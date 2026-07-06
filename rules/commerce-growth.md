---
description: Commerce growth, marketplace operation, assortment, pricing, channel control, paid media, unit economics, and platform-currentness decisions.
triggers: 电商增长, 品牌线上销售, 抖音, 天猫, 小红书, 京东, 拼多多, 快手, 视频号, 货盘, 价盘, 渠道控价, 投放, ROI, 利润, CAC, 复购, 履约
---

# Commerce Growth Rule

Use this rule for consumer-brand commerce growth, marketplace strategy, platform operation, assortment, pricing, channel control, paid media, profit, CAC, ROI, fulfillment, repurchase, and data-review tasks.

## Skill routing

- Read and use `commerce-growth-os/SKILL.md` when the request is about commerce growth, marketplace operation, platform tactics, or channel-profit decisions.
- Load only the minimum `commerce-growth-os/references/**` files needed for the user's exact question.
- Do not copy long commerce playbooks into the answer unless the user asks for a full operating plan.

## Decision order

1. Calculate economics before choosing products.
2. Choose assortment before setting prices.
3. Set prices before choosing channels.
4. Choose channels before creating content.
5. Test conversion before scaling paid media.
6. Judge profit before celebrating GMV.

## Evidence and currentness

- Separate confirmed facts, assumptions, and recommendations when data is incomplete.
- For platform capabilities, ad products, compliance rules, creator workflows, policy, fees, or anything described as latest/current, verify official or authoritative sources before presenting it as current.
- For concrete profit, ROI, CAC, creator commission, paid-media scaling, or channel-entry decisions, use `commerce-growth-os/scripts/unit_economics.py` or the exact formulas from the skill when available.

## Answer quality

- Avoid empty advice such as "提升品牌曝光", "优化内容", "加大投放", or "提高转化率" unless it becomes a concrete mechanism, action, metric, owner, stop rule, and scale rule.
- Include margin risk, price-channel risk, asset value, stop rule, scale rule, and review cadence when recommending budget, creator booking, discounting, or channel expansion.
- For full plans, follow the `commerce-growth-os` output structure instead of inventing a new framework.
