# Platform Currentness

## Load when

Use this reference when the user asks about latest/current platform capability, ad product functions, platform rules, compliance boundaries, creator cooperation rules, or whether a tactic "still works".

## Rule

Separate stable operating principles from current platform facts.

- Stable operating principles: unit economics, SKU-role design, price-channel separation, content-to-search landing, review quality, fulfillment risk, and repurchase logic.
- Current platform facts: product names, ad campaign types, targeting options, bidding modes, creator tools, traffic entrances, policy wording, eligibility thresholds, and compliance rules.

Do not present a current platform fact as confirmed unless it is verified from an authoritative source or from the user's current backend evidence.

## Sources to prefer

Use `currentness-source-map.md` to choose the verification surface, then use sources in this order:

1. User-provided current backend screenshots, exported reports, campaign settings, or platform notices.
2. Official help centers, official product documentation, official announcements, or official platform policy pages.
3. Official commercial account manager material supplied by the user.
4. Recent authoritative industry notes only as secondary context.

If sources conflict, trust live backend evidence first, then official documentation, then recent announcements, then third-party commentary.

## Required labels

Label platform-sensitive claims:

- Confirmed from user backend: user provided current backend evidence.
- Officially verified: checked from official/authoritative source in the current session.
- Stable operating principle: not dependent on a current platform feature.
- Needs current verification: likely to drift and not verified in the current session.

Never hide the verification status inside the prose. Put it near the claim or in a short "Currentness" note.

## What must be verified

Verify before making specific claims about:

- Douyin, Ocean Engine, Qianchuan, Xingtu, Douyin Mall, product card, search, and live-room ad capabilities.
- Tmall/Taobao, Wanxiangtai, search ads, audience promotion, member tools, campaign mechanics, and store operation rules.
- Xiaohongshu, Pugongying, Juguang Feed/Search, creator cooperation, search interception, and off-platform landing limits.
- Platform claim review, advertising law risk, creator disclosure rules, medical/health/beauty/mother-baby/pet claim restrictions.
- Fees, deposits, thresholds, campaign eligibility, creator commission structures, and current data field definitions.

## Response pattern

When currentness matters, use a compact note:

```text
Currentness:
- Stable principle: ...
- Officially verified / Confirmed from user backend / Needs current verification: ...
- Decision impact: ...
```

If the user asks for action before verification is possible, give the operating logic and make the platform-specific step conditional:

```text
If the current backend supports this entrance, use it for ...
If not, keep the same channel job and switch the execution surface to ...
```

## Avoid

- Do not say "currently" or "now" for unverified product capabilities.
- Do not quote old platform product names as if the interface still uses them.
- Do not rely on third-party playbooks for compliance or policy boundaries.
- Do not turn a platform workaround into a durable recommendation without verification.
