# Business Model and Profit

## Load when

Use this reference for business diagnosis, profitability, ROI, budget, first-order loss, paid media scale, or review decisions.

## Stage diagnosis

| Stage | Primary job | Avoid |
| --- | --- | --- |
| Cold start | Test product, price, content, audience, creator, search terms, live conversion | Large paid-media or head-creator bets |
| Single-SKU lift | Find one stable converting SKU and build assets around it | Expanding SKU matrix too early |
| Hero-SKU scale | Scale proven content, creators, keywords, live rhythm, inventory | GMV growth without margin/refund control |
| Multi-SKU matrix | Add second hero, profit SKU, bundle, repurchase SKU, scene SKU | Same SKU/same price across all channels |
| Long-term brand operation | Grow brand words, category words, members, natural traffic, creator pool | Permanent low-price dependency |
| Profit/channel governance | Lower paid share, optimize commission, reduce refund, govern price | Treating all GMV as good GMV |

## Required model

For full plans, request or assume:

- AOV, product cost, gross margin, platform fee, fulfillment cost, gift cost.
- Refund rate and refund loss.
- Creator commission, pit fee, sample cost, service fee, content cost.
- Ad spend, ROI, gross-profit ROI, new-customer share.
- Repurchase cycle, repurchase rate, LTV, member/private-domain path.

## Core formulas

```text
GMV = exposure x CTR x CVR x AOV
ROI = transaction amount / ad spend
Gross-profit ROI = gross profit / ad spend
Break-even ROI = 1 / margin available for paid media

Channel net profit =
GMV
- product cost
- platform fee
- ad spend
- creator commission
- pit fee
- gift cost
- fulfillment cost
- refund loss
- sample cost
- service fee
- content cost

Allowable CAC =
AOV x comprehensive gross margin
- fulfillment cost
- platform fee
- gift cost
- target unit profit
```

## Missing-data handling

If data is missing, use a labeled assumption block:

```text
Assumption model:
- AOV: ...
- Comprehensive gross margin: ...
- Fulfillment + gift: ...
- Refund loss: ...
- Target unit profit: ...
Therefore allowable CAC is approximately ...
If actual refund or gift cost is higher, reduce ad budget or raise bundle AOV first.
```

Never convert assumed economics into confirmed conclusions.

## Budget decision rules

- Low CTR: test hook, cover, title, visual proof, and opening scene before changing the product.
- High click but low CVR: inspect price, review base, SKU structure, product page, live-room trust, and fulfillment promise.
- Fast spend with no orders: cap budget or pause; do not wait for "learning" without a conversion signal.
- Low ROI but high new-customer share: decide whether first-order loss is allowed and define payback cycle.
- High ROI but low volume: scale gradually; avoid abrupt budget jumps that break marginal ROI.
- Scale causes ROI drop: split audience, creative, bidding, SKU, and channel jobs.
- GMV up but net profit down: treat the action as brand/asset investment only if that budget owner is explicit.
