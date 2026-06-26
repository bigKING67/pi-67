---
description: Context budget, large-output handling, windowed reads, and compaction-safe summaries.
triggers: large file, log, json, diff, long conversation, context too large
---

# Context Budget Rule

Use this rule for large files, logs, JSON, diffs, search output, or long-running sessions.

## Read strategy

- Never paste large files, raw logs, huge JSON, or full diffs into context by default.
- First inspect size and structure with tools such as `wc -l -c`, `git diff --stat`, `git diff --name-only`, `jq 'keys'`, or targeted search.
- Use precise search terms, then read small windows around relevant lines.
- Summarize counts, hashes, paths, and decisive snippets instead of raw full output.

## Output limits

- Keep routine command output under roughly 200-300 lines.
- If full output must be preserved, write it to a task-local temp artifact and report the path, size, and key lines.
- For JSON arrays or tabular data, summarize length, key fields, and sample rows.

## Long conversations

- Capture durable decisions and assumptions in concise status updates.
- If compaction risk appears, produce a short handoff-style summary with cwd, git status, changed files, evidence, and next commands.
- Do not rely on memory or handoff text as runtime truth; verify current files and runtime when resuming.

## Evidence priority

When evidence conflicts, use this order:

1. live runtime behavior,
2. captured network/log/runtime output,
3. actively served assets,
4. current process configuration,
5. persisted challenge/project state,
6. generated artifacts,
7. checked-in source,
8. comments and dead code.
