---
description: File and directory governance, module boundaries, naming, temporary artifacts, and shared abstractions.
triggers: new file, new directory, refactor, module move, shared helper, project structure
---

# Project Structure Rule

Use this rule before adding files/directories, moving modules, or creating shared abstractions.

## Before adding files

1. Inspect existing structure and naming conventions.
2. Prefer colocating code with its primary consumer.
3. Create shared code only when at least two independent callers need it or a boundary requires it.
4. Avoid generic buckets such as `utils`, `common`, `shared`, or `helpers` unless the project already uses them with clear ownership.
5. Put temporary investigation artifacts under `tmp/` or `temp/`, not under agent-specific or production directories.

## Boundaries

- Keep UI, data fetching, domain logic, persistence, and infrastructure responsibilities separate.
- Do not create parallel implementations of an existing module without a migration plan.
- Do not hide business logic in styling, routing, config, or test helpers.
- Do not introduce circular dependencies to avoid passing explicit data.

## Naming

- Names should describe domain behavior, not implementation trivia.
- Avoid vague names: `manager`, `helper`, `processor`, `data`, `thing`, `misc`.
- File names should match the dominant exported concept or route/component purpose.

## Cleanup

- Remove only files created by the current task unless the user explicitly approves broader cleanup.
- If deprecating old code, leave a clear migration path or remove all references in the same scoped change.
- Keep generated artifacts out of source unless the project already tracks them.
