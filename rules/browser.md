---
description: browser67 automation, managed tabs, js-reverse, Chrome privacy boundaries, and evidence handling.
triggers: browser, Chrome, tab, login, download, upload, js-reverse, signature, network, CDP
---

# Browser Rule

Use this rule for browser-visible behavior, logged-in sessions, current tabs, downloads/uploads, page API discovery, JS reverse engineering, and CDP evidence.

## Tool routing

- Use browser67 for real Chrome/Edge state, logged-in pages, managed tabs, downloads/uploads, file chooser, clipboard wrappers, CDP batch checks, and browser smoke. The current MCP tool key remains `tmwd_browser`; `tmwd` is only a transport/protocol term.
- Use `js-reverse` for API discovery, request initiator tracing, signing chains, script search, network/WS sampling, Hook injection, evidence export, and local environment reproduction.
- Use web search/fetch for ordinary facts, official docs, latest info, citations, and public source verification.
- Use in-app/browser preview only for localhost or file previews without user login state.

## Managed tab lifecycle

- Active browser operations should use a stable `workspace_key`.
- Prefer browser67-owned managed tabs. Do not navigate, type into, close, or claim user unmanaged tabs unless the user explicitly points to that tab for the current task.
- At task end, run `finalize_task` for the current `workspace_key` or `task_id` unless the user asked to keep pages open.
- Only close `keep:false` browser67-owned tabs; preserve `keep:true` and unmanaged tabs.
- If a tool returns `finalize_hint.required:true`, follow its suggested arguments before delivery.

## Browser readiness, waits, and jobs

- Use `browser_transport_health` as browser67 preflight when failures may come from hub, extension, content script injection, CDP bridge, or fallback capability.
- Use `browser_wait` for selector, text, function, URL/lifecycle, DOM-stable, network-idle, download-started, and file-chooser readiness where supported; do not treat fixed sleeps as proof.
- Use `browser_execute_js` with compact diagnostics and explicit output bounds for large DOM/network payloads.
- Use `browser_job_ops` for long-running browser-side work. Jobs are in-process only (`durable:false`), and cancel is best-effort; do not claim it preempts already-running page JS.

## Chrome privacy boundary

- Do not inspect cookies, password stores, unrelated history, unrelated accounts, or unrelated tabs.
- Do not submit forms, send messages/emails, purchase, delete, publish, upload local files, write clipboard, or change online settings without explicit user confirmation.
- Treat browser state as private runtime evidence, not a general data source.

## JS reverse frames and preload boundaries

- For iframe, microfrontend, CAPTCHA widget, login embed, shadow DOM, or sandboxed app shells, list frames first and record frame id/url/origin in evidence.
- Same-origin frames may be inspected and hooked frame-scoped; cross-origin frames must return explicit limitation/degraded evidence instead of guessed DOM.
- Treat microfrontend detection as evidence from frames, script sources, containers, shadow roots, and network/runtime markers; do not claim unsupported detector tools exist.
- Do not describe `inject_preload_script` as guaranteed true `document_start`. Distinguish current-document eval, next-navigation preload, extension-level content script, and remote CDP `Page.addScriptToEvaluateOnNewDocument`.

## Evidence

- Capture precise URL, DOM/computed state, request/response metadata, console errors, and screenshots only as needed.
- Store screenshots, run records, and evidence bundles outside the repo; report path/hash/dimensions/target and avoid base64 in agent output.
- Keep selector/clip/viewport/full-page screenshots distinct; full-page capture must be bounded by `max_pixels`.
- On failure, prefer compact DOM/geometry/transport diagnostics over large raw dumps.
- Prefer narrow CDP queries over broad dumps.
- When reporting browser findings, summarize decisive evidence instead of pasting large raw traces.
