---
description: Performance guardrails for frontend, backend, ETL, database, IO, caching, and hot paths.
triggers: performance, slow, hot path, query, cache, batch, build size, rendering
---

# Performance Rule

Use this rule for performance-sensitive work or whenever touching hot paths, large data, network calls, rendering loops, ETL, or database queries.

## General defaults

- Avoid heavy dependencies unless they replace substantial complexity or proven bottlenecks.
- Avoid repeated work in hot paths: parsing, formatting, regex compilation, object cloning, sorting, and serialization.
- Avoid unbounded loops, unbounded concurrency, unbounded caches, and unbounded result sets.
- Prefer streaming, pagination, chunking, batching, or lazy loading for large data.
- Add timeouts to external calls and long-running operations.
- Parallelize independent IO when safe; avoid serial awaits in obvious fan-out flows.

## Database and data pipelines

- Watch for N+1 queries, missing filters, missing indexes, and accidental full scans.
- Use parameterized queries; never concatenate user input into SQL.
- Keep aggregation source-of-truth explicit.
- For ETL/backfill, estimate row counts, memory use, retry behavior, and idempotency.
- For CSV/JSON with embedded newlines or large fields, rely on parser counts, not shell line counts.

## Frontend

- Avoid unnecessary re-renders, global state churn, huge synchronous transforms, and layout thrash.
- Virtualize long lists or tables when row count can grow.
- Keep charts and derived datasets memoized with correct dependencies.
- Defer non-critical work and assets where it improves first interaction.
- Verify responsive behavior and browser performance for user-visible changes.

## Delivery

For performance-sensitive changes, report:

- the hot path,
- expected data scale,
- chosen caching/pagination/batching strategy,
- verification command or measurement,
- remaining performance risk.
