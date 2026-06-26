---
description: Debug-first engineering quality, root-cause repair, validation, and delivery discipline.
triggers: code changes, bugfix, refactor, tests, delivery review
---

# Quality Rule

Use this rule for non-trivial implementation, bugfix, refactor, or delivery review.

## Workflow

1. State the target and acceptance criteria before editing.
2. Inspect real files, configs, runtime state, tests, and logs before guessing.
3. Prefer the smallest root-cause fix over surface patches.
4. Change only files directly related to the task.
5. Validate with the closest useful command first, then expand only when risk requires it.
6. Re-read the final diff and status before delivery.

## Code quality bar

- Code should express business intent through clear names and simple control flow.
- Keep functions focused. Extract helpers only when repeated behavior or complexity justifies it.
- Avoid speculative abstraction, broad rewrites, and hidden coupling.
- Validate external input at boundaries: API responses, files, CLI args, forms, and user input.
- Do not swallow errors or return fake success.
- Do not add unobservable silent fallback. If fallback is necessary, make it visible, traceable, and removable.
- Never hardcode secrets, tokens, cookies, private keys, or production credentials.

## Debug-first

- Reproduce or narrowly characterize the failure.
- Identify the earliest uncertain stage and prove it with evidence.
- If evidence conflicts, trust live runtime behavior over checked-in source comments.
- After three failed attempts on the same path, stop repeating and change the hypothesis, tool, or validation route.

## Testing and delivery

- Run the smallest relevant verification command for the changed surface.
- If existing unrelated failures appear, report them without broadening scope.
- If local verification is impossible, state exactly why and give the command that should be run.
- Delivery must include: changed behavior, affected files/areas, verification result, risks, and uncovered cases.
