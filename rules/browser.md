---
description: Browser automation, TMWD managed tabs, js-reverse, Chrome privacy boundaries, and evidence handling.
triggers: browser, Chrome, tab, login, download, upload, js-reverse, signature, network, CDP
---

# Browser Rule

Use this rule for browser-visible behavior, logged-in sessions, current tabs, downloads/uploads, page API discovery, JS reverse engineering, and CDP evidence.

## Tool routing

- Use `tmwd_browser` for real Chrome/Edge state, logged-in pages, managed tabs, downloads/uploads, file chooser, clipboard wrappers, CDP batch checks, and browser smoke.
- Use `js-reverse` for API discovery, request initiator tracing, signing chains, script search, network/WS sampling, Hook injection, evidence export, and local environment reproduction.
- Use web search/fetch for ordinary facts, official docs, latest info, citations, and public source verification.
- Use in-app/browser preview only for localhost or file previews without user login state.

## Managed tab lifecycle

- Active browser operations should use a stable `workspace_key`.
- Prefer TMWD-owned managed tabs. Do not navigate, type into, close, or claim user unmanaged tabs unless the user explicitly points to that tab for the current task.
- At task end, run `finalize_task` for the current `workspace_key` or `task_id` unless the user asked to keep pages open.
- Only close `keep:false` TMWD-owned tabs; preserve `keep:true` and unmanaged tabs.
- If a tool returns `finalize_hint.required:true`, follow its suggested arguments before delivery.

## Chrome privacy boundary

- Do not inspect cookies, password stores, unrelated history, unrelated accounts, or unrelated tabs.
- Do not submit forms, send messages/emails, purchase, delete, publish, upload local files, write clipboard, or change online settings without explicit user confirmation.
- Treat browser state as private runtime evidence, not a general data source.

## Evidence

- Capture precise URL, DOM/computed state, request/response metadata, console errors, and screenshots only as needed.
- Prefer narrow CDP queries over broad dumps.
- When reporting browser findings, summarize decisive evidence instead of pasting large raw traces.
