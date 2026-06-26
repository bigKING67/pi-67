---
description: Architecture planning, boundaries, interfaces, migration, compatibility, and observability.
triggers: architecture, design plan, API shape, migration, module boundary, compatibility
---

# Architecture Quality Rule

Use this rule for architecture proposals, API/interface changes, migrations, cross-module changes, and high-impact refactors.

## Decision process

1. Ground the proposal in current runtime truth, not only source comments.
2. Define the user-visible goal, success criteria, in-scope and out-of-scope work.
3. Identify owners and boundaries: caller, callee, storage, network, queue, UI, and operational surfaces.
4. Choose the smallest design that satisfies current requirements and keeps future extension points obvious.
5. Document compatibility and migration implications before implementation.

## Interface quality

- APIs should have clear inputs, outputs, errors, and idempotency expectations.
- Make failure modes observable. Avoid ambiguous booleans, swallowed errors, and generic catch-all responses.
- Prefer explicit schemas/types at boundaries.
- Do not introduce hidden global state when dependency injection or explicit parameters are cleaner.
- Preserve existing public contracts unless the user explicitly accepts a breaking change.

## Data and migration

- Separate schema changes, backfills, code changes, and rollout sequencing.
- Define how old and new data coexist during transition.
- For destructive data changes, require explicit user confirmation and rollback notes.
- For derived data or metrics, record source-of-truth tables and aggregation rules.

## Operational quality

- Add logging/metrics where they help diagnose user-visible failures.
- Ensure timeouts, retries, and cancellation semantics are explicit.
- Make rollout reversible when feasible.
- For long-running or async work, define ownership of retries, dedupe, and dead-letter handling.
