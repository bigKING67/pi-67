# Answer Quality Rubric

## Load when

Use this reference when polishing a final answer, validating saved eval answers, reviewing whether a commerce strategy answer is too generic, or maintaining this skill's eval scripts.

## Quality gates

A strong answer must pass these gates:

1. **Decision first**: answer the user's narrow question before expanding into a plan.
2. **Confirmed vs assumed**: separate confirmed facts, assumptions, and recommendations when data is incomplete.
3. **Economics before scale**: do not recommend budget, creator booking, discount, channel entry, or SKU expansion without unit economics or an explicit missing-data condition.
4. **Assortment and price before channel**: do not jump to platform tactics before SKU role, price ladder, and price-floor logic.
5. **Channel job clarity**: explain what each channel is supposed to do and which metric proves it is working.
6. **Stop and scale rules**: include both stop rule and scale rule for any paid, live, creator, channel-entry, or discount decision.
7. **Risk ownership**: name the margin, price-channel, fulfillment, refund, compliance, or service risk that can break the plan.
8. **Review cadence**: define next review window when the answer contains an operating plan or data review.
9. **Currentness label**: label platform-current claims as `Officially verified`, `Confirmed from user backend`, `Stable operating principle`, or `Needs current verification`.

## Anti-patterns

Reject or rewrite answers that use these phrases without a concrete mechanism, owner, metric, and stop/scale rule:

- "提升品牌曝光"
- "优化内容"
- "加强运营"
- "加大投放"
- "提高转化率"
- "找更多达人"
- "多做种草"
- "冲GMV"
- "做全域布局"

Replace them with:

```text
Action -> mechanism -> metric -> stop rule -> scale rule -> owner -> review window
```

## Mode-specific checks

### Quick diagnosis

Must include:

- Current judgment.
- Bottleneck.
- Missing data or assumptions.
- Next three actions.
- Main risk.

### Decision memo

Must include:

- Decision: yes/no/test/hold.
- Economics or missing economics.
- Assumptions.
- Stop rule.
- Scale rule.
- Main risk.

### Full operating plan

Must include:

- Business model and break-even logic.
- Assortment and price ladder.
- Channel jobs.
- Content and landing plan.
- Paid/live/creator guardrails.
- Fulfillment/after-sale risk.
- Review cadence.

### Data review

Must include:

- Metric movement.
- Likely cause.
- Decision.
- Owner/action.
- Stop/scale rule.
- Next review window.

## Currentness checks

For platform-current questions, split the answer into:

- Stable operating principle.
- Current platform claim and evidence label.
- Source or backend to verify.
- Decision impact if the platform entrance, product name, rule, or report field changed.

Do not turn an official URL into a current capability claim unless the relevant page/backend was checked in the current session.

## Maintainer lint commands

Use deterministic lint for saved answers:

```bash
python3 scripts/lint_answer.py --mode decision_memo --answer path/to/answer.txt --json
python3 scripts/lint_answer.py --answer-dir path/to/answers --cases eval/cases.json --json
```

Use the golden-answer suite after changing the skill contract, eval cases, or linter:

```bash
bash scripts/run_eval.sh eval/golden-answers
```

Use the source registry checker after editing currentness source references:

```bash
python3 scripts/check_source_registry.py references/currentness-official-sources.md --json
```
