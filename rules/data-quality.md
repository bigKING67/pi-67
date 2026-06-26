---
description: Data quality, metric source-of-truth, mapping audits, ambiguity handling, and evidence-led data fixes.
triggers: data quality, mapping, metric, dashboard, ETL, missing, ambiguous, duplicate, DataHub
---

# Data Quality Rule

Use this rule for dashboards, ETL, data mapping, metric disputes, missing data, ambiguous joins, duplicate records, and source-of-truth questions.

## Audit before changing logic

1. Identify the true runtime source table/API/view used by the failing surface.
2. Compare expected records against actual records with counts, unique keys, duplicate groups, missing keys, and ambiguous keys.
3. Separate source absence from mapping failure, filter mismatch, date-bound issue, and presentation bug.
4. Produce a compact audit summary before proposing logic changes.

## Evidence categories

- `unique`: maps cleanly to exactly one target.
- `missing`: no matching candidate.
- `ambiguous`: multiple plausible candidates.
- `duplicate`: source or target key repeats unexpectedly.
- `filtered`: exists but excluded by date, status, scope, tenant, or visibility filters.

## Fix policy

- Do not silently coerce ambiguous mappings.
- Do not change metric definitions without naming the source-of-truth and affected dashboards/reports.
- Prefer deterministic mapping rules with explicit tie-breakers.
- Keep backfills idempotent and auditable.
- When data contains embedded newlines, use parser/SQL counts instead of shell line counts.

## Delivery

Report source-of-truth, audit counts, sample evidence, implemented rule, verification query/command, and remaining ambiguity.
