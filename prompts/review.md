---
description: Review recent changes for bugs, security, performance, structure, and maintainability
argument-hint: "[focus]"
---

Review the recent code changes.

Before reviewing, read the minimum relevant rules:

- Always read `quality.md`.
- Read `performance.md` for hot paths, rendering, IO, database, cache, batching, or large data.
- Read `project-structure.md` for new files/directories, module boundaries, or shared helpers.
- Read `frontend.md` for UI/component/style changes.
- Read `browser.md` for browser/login/download/upload/js-reverse behavior.

Review dimensions:

1. Bugs and logic errors: edge cases, null/undefined handling, races, stale state.
2. Security: injection risks, hardcoded secrets, missing validation, unsafe browser/data actions.
3. Performance: N+1 queries, unnecessary re-renders, repeated hot-path work, unbounded data.
4. Structure: misplaced files, weak boundaries, duplicate abstractions, generic helpers.
5. Error handling: swallowed errors, silent fallbacks, fake success paths.

Output format:

- Critical: must fix.
- Warning: should fix.
- Suggestion: optional improvement.
- Already solid: what is good.

Focus: $ARGUMENTS
