---
description: AI Berkshire value-investing research routing, evidence, calculation, audit, team-truthfulness, and publishing gates.
triggers: 股票, 投资, 估值, 财报, 年报, 季报, 行业研究, 持仓, 组合, 股价异动, 收益投资, 管理层, 未上市公司
---

# Investment Research Rule

Use this rule for non-trivial stock opinions, company or industry research, earnings, valuation, portfolios, thesis tracking, price-move attribution, and investment publishing. Pure L0 facts may be verified and answered directly.

## Scope and Skill routing

- "值得买/股票怎么样" defaults to `investment-checklist`, then `investment-research` only if the checklist does not hard-reject it. Use `quality-screen` for metric-led exclusion and `investment-team` only for an explicitly authorized team workflow.
- Route earnings to `earnings-review` or, for an authorized multi-perspective team plus publishing workflow, `earnings-team`.
- Route an industry map to `industry-research`, market-to-three selection to `industry-funnel`, and physical supply bottlenecks to `bottleneck-hunter`.
- Route price moves or sudden events to `news-pulse`; management and capital allocation to `management-deep-dive`; private companies to `private-company-research`.
- Route portfolio review, ongoing thesis records, and version-to-version thesis changes to `portfolio-review`, `thesis-tracker`, and `thesis-drift` respectively.
- Route dividend, income, bond, REIT, and yield-oriented work to `income-investment`; Duan Yongping-style questions to `dyp-ask`.
- Route researched material for publication to `wechat-article` or `deep-company-series`. Publishing Skills never replace primary research.
- Use `financial-data` as the data-quality overlay for market, financial, and valuation inputs. Use `investment-memo-craft` as the writing overlay for decision-ready company, industry, earnings, fund, or portfolio reports.
- Read only the minimum relevant installed `SKILL.md` files. An explicit user-selected Skill or deliverable takes precedence unless it conflicts with evidence or safety gates.
- AI Berkshire covers fundamental and value-investing research. Intraday signals, chart patterns, automated trading, high-frequency trading, and technical-analysis execution are `OUTSIDE_AI_BERKSHIRE_SCOPE`; use a separate trading workflow.

## Evidence, calculation, and audit gates

- Run `date` before time-sensitive research. State the research date, market-data timestamp, reporting cutoff, currency, security/share class, and latest periodic filing used.
- Prefer filings, exchanges, regulators, and company IR. Cross-check decision-critical figures with at least two independent sources; preserve conflicts, unit differences, and unavailable fields instead of inventing precision.
- Use the selected Skill's bundled `scripts/financial_rigor.py` for market cap, multiples, cash flow, yield, cross-validation, and scenario arithmetic when present. Do not replace reproducible calculations with mental math.
- Markdown is the research source of truth. Before formal publication, run the selected Skill's bundled `scripts/report_audit.py` when present and manually check signs, units, currency, dates, and quoted prices. `AUDIT_FAILED` blocks publication.
- Separate observed facts, assumptions, scenarios, recommendations, and unknowns. A buy opinion must include valuation or margin-of-safety ranges, position sizing, staged entry conditions, add/stop conditions, and thesis-break risks.
- Route suggestions and candidate Skills are plans, not execution evidence. Report only Skills read, tools run, sources checked, and artifacts actually produced.

## Team truthfulness and delivery

- `investment-team`, `earnings-team`, and any Skill-requested team workflow require user/project/Skill delegation authorization plus live subagent support. Never claim parallel work that did not occur.
- If delegation is unavailable, complete the perspectives serially and label the result `degraded execution`; the main agent remains responsible for synthesis, audit, and the final judgment.
- Keep Markdown and audit output authoritative. A renderer or publishing step may change layout, not numbers, sources, assumptions, risks, or conclusions.
