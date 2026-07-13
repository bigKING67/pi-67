# Currentness Source Map

## Load when

Use this reference with `platform-currentness.md` when a recommendation depends on a current platform capability, policy, fee, eligibility rule, or backend field.

## Rule

This file is a source map, not a fact cache. Use it to decide where to verify. Do not copy platform facts from old answers into a new answer without current evidence.

## Verification order by platform

| Platform area | First source | Second source | Common drift points |
| --- | --- | --- | --- |
| Douyin / Ocean Engine / Qianchuan | User's current ad backend, official Ocean Engine help or product docs | Official account-manager material supplied by user | Campaign types, bidding modes, audience options, attribution windows, data field names |
| Douyin shop / shelf / search / product card | User's shop backend, official Douyin e-commerce help or policy docs | Recent official platform notices | Traffic entrances, search ranking fields, product-card rules, shop eligibility, fee fields |
| Xingtu / creator cooperation | User's Xingtu backend, official Xingtu creator/business docs | Official creator service or agency material supplied by user | Cooperation formats, authorization fields, quotation rules, data visibility, disclosure requirements |
| Tmall / Taobao / Wanxiangtai | User's merchant backend, official Alimama/Taobao/Tmall help docs | Official campaign notices supplied by user | Product names, promotion types, member tools, keyword/audience modes, campaign eligibility |
| Xiaohongshu / Juguang / Pugongying | User's brand/backend screenshots, official Xiaohongshu business/help docs | Recent official policy notices | Feed/Search product split, creator cooperation rules, off-platform landing limits, report fields |
| Compliance / claims | User's legal/platform review notice, official platform policy pages, applicable law/regulator references | Category-specific official guidance supplied by user | Beauty efficacy, health/medical implication, mother-baby safety, pet health claims, food nutrition claims |

## Evidence labels

Use one of these labels near any platform-sensitive claim:

- `Confirmed from user backend`: the user supplied current screenshots, exports, settings, or notices.
- `Officially verified`: checked in the current session from official platform/help/policy material.
- `Stable operating principle`: independent of current product UI or policy wording.
- `Needs current verification`: likely to drift and not checked in the current session.

## Response pattern

```text
Currentness:
- Stable principle: ...
- Officially verified / Confirmed from user backend / Needs current verification: ...
- Decision impact: ...
```

## Do not cache as durable facts

Do not store these as permanent skill facts without a review date:

- Product entrance names.
- Bidding or targeting options.
- Attribution windows.
- Fee/commission/deposit thresholds.
- Campaign eligibility.
- Platform claim-review wording.
- Backend report field definitions.
