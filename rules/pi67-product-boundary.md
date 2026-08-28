---
description: Pi runtime ownership, pi-67 CLI and Pi-67 Desktop boundaries, provider state, installation, bootstrap, and release contracts.
triggers: pi-67, Pi-67 Desktop, install, update, repair, release, provider, model, bootstrap, acceptance, harness
---

# pi-67 Product Boundary Rule

Use this rule when changing pi-67 CLI behavior, Pi-67 Desktop's Pi harness,
installation, update, repair, provider integration, bootstrap, acceptance,
documentation, or release flows.

## Product ownership

- Upstream `@earendil-works/pi-coding-agent` / `pi` is the only Pi runtime. It
  owns the agent loop, model connections, resource/Extension loading, Tool
  execution semantics, and Pi Session lifecycle.
- pi-67 is the Windows/macOS team workstation distribution and configuration
  manager for `~/.pi/agent`, shared Skills, extensions, rules, prompts,
  templates, diagnostics, and release assets.
- Pi-67 Desktop is a first-party Electron client and Pi harness. It runs the
  supported Pi SDK inside its Agent Host utility process while Desktop owns the
  secure process boundary, exact Tool exposure/authorization, lifecycle, and
  truthful UI projection. It must not implement a second agent loop, prompt
  composer, model router, Tool orchestrator, or Session truth.
- Users may enter through the upstream `pi` TUI or Pi-67 Desktop. Both preserve
  Pi resource precedence and may share the canonical `agentDir` and Pi JSONL
  Sessions; one Session must be handed over sequentially rather than written by
  both entrypoints concurrently.
- pi-67 CLI must not become a parallel chat runtime, upstream fork, mandatory
  launcher, or the sole judge of whether Pi can run.
- `pi-67 launch`, if retained, is only an optional Windows PATH-refresh
  compatibility helper and must not become the standard launch path.

## Desktop harness ownership

- Renderer code must not import Electron, Node, the Pi SDK, or filesystem APIs.
  Production assets use the app-owned scheme and never an internal HTTP server,
  localhost listener, or business WebSocket.
- Desktop-added system context stays bounded, purpose-specific, reviewable, and
  injected only through supported Pi seams. Project/user `SYSTEM.md`,
  `APPEND_SYSTEM.md`, `AGENTS.md`, Skills, Prompts, and resource precedence remain
  user-owned.
- Pi chooses when and how to request an exposed Tool. Desktop owns exact Tool
  identity/schema, authorization, execution/cancellation/recovery, and truthful
  Tool Result projection; PLAN and safety modes constrain capability rather than
  creating a second workflow planner.
- The selected model, Provider, and protocol stay explicit and stable for a Turn.
  No silent switch or retry through another model, Provider, protocol, Extension,
  MCP service, Search path, or runtime is allowed without a narrower visible
  product contract.

## Provider and user-state ownership

- `/login`, `/model`, authentication persistence, model selection, and restart
  restoration belong to upstream Pi.
- Install, update, and repair must preserve user-owned provider, model, theme,
  authentication, MCP, and local runtime state unless an explicit user command
  requests a change.
- `xtalpi-pi-tools` is optional. DeepSeek, Anthropic, OpenAI, Google, and other
  providers continue to use upstream Pi flows.
- `pi-67 xtalpi configure` is an optional convenience for company xtalpi
  credentials, never a prerequisite for starting `pi`.
- Missing provider credentials may block the corresponding model request, but
  must not prevent zero-credential Pi TUI or Desktop startup.
- Real credentials are machine-owned and must never enter source, release
  assets, logs, fixtures, or memory.

## Acceptance and release

- CLI acceptance must use the real `pi` binary and real configuration loading;
  Desktop acceptance must use the real packaged Electron/Agent Host/Pi SDK path.
  Wrappers, mocks, browser previews, and temporary launch shims prove only their
  narrow compatibility surface.
- Upstream Pi installation and version management are completely outside
  pi-67. User-facing pi-67 commands must not compare installed/tested/latest
  Pi versions, recommend a Pi upgrade, or mutate the Pi runtime.
- Diagnostics may check only that the `pi` command exists and that the active
  CLI configuration/Extensions load through a real Pi startup or list probe.
  Desktop diagnostics use its supported Pi SDK and packaged runtime path and do
  not make the external `pi` binary a product dependency.
- New or upgraded extensions, Skills, rules, prompts, and MCP templates must
  improve the team Pi workflow without taking over upstream runtime duties.
- Before changing CLI positioning, install/update ownership, launch behavior,
  or acceptance contracts, read the matching README product section. Update
  documentation and tests with the implementation.
