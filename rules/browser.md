---
description: browser67 automation, managed tabs, js-reverse, Chrome privacy boundaries, and evidence handling.
triggers: browser, Chrome, tab, login, download, upload, js-reverse, signature, network, CDP
---

# Browser Rule

Use this rule for browser-visible behavior, logged-in sessions, current tabs, downloads/uploads, page API discovery, JS reverse engineering, and CDP evidence.

## Tool routing

- Use browser67 for real Chrome/Edge state, logged-in pages, managed tabs, downloads/uploads, file chooser, clipboard wrappers, CDP batch checks, and browser smoke. The current MCP tool key remains `tmwd_browser`; `tmwd` is only a transport/protocol term.
- Use `js-reverse` for API discovery, request initiator tracing, signing chains, script search, network/WS sampling, Hook injection, evidence export, and local environment reproduction.
- Use the current live `web_search` / `fetch_content` Tools, or an explicitly equivalent first-party capability, for ordinary search, official-source verification, and known public URLs. Do not assume `pi-web-access`, `pi-smart-fetch`, or any other optional Package is installed or loaded.
- Provider-native Search is a separate route: use it only when the selected model, Provider, and protocol explicitly declare it and the native request is actually sent. Never silently switch or retry through another model, Provider, protocol, Extension, MCP service, search path, or runtime.
- For a known public URL, try the current fetch Tool first. Escalate logged-in or dynamic DOM work to browser67 and signing/obfuscated JavaScript work to `js-reverse`; after repeated failure, change the hypothesis or report the blocker instead of cycling routes.
- Use in-app/browser preview only for localhost or file previews without user login state.

## Managed tab lifecycle

- Treat each Chrome/Edge Profile as a distinct Browser Instance. Before multi-instance work, call `browser_instance_ops list`; every subsequent browser67 operation must carry the intended `browser_instance_id`.
- `AMBIGUOUS_TARGET` and `BROWSER_INSTANCE_UNAVAILABLE` must fail closed. Do not guess a Profile, reuse another instance, or fall back to remote CDP.
- Active browser operations should use a stable `workspace_key` and, where available, `task_id` within that Browser Instance.
- Prefer browser67-owned managed tabs. Do not navigate, type into, close, or claim user unmanaged tabs unless the user explicitly points to that tab for the current task.
- To operate an existing user tab, first inspect adoption and require explicit current authorization before `adopt_existing`; adopted tabs remain user-owned for cleanup and must not be closed automatically.
- At task end, run scoped `finalize_task` only for the current `browser_instance_id` plus `workspace_key` or `task_id`, unless the user asked to keep pages open.
- Only close same-instance `keep:false` browser67-owned tabs; preserve `keep:true`, adopted, and unmanaged tabs. Cross-instance cleanup, `scope=all`, or workspace-wide cleanup requires separate explicit confirmation.
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
