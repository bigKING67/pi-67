---
description: pi-67 product ownership, upstream Pi boundaries, provider state, installation, update, and release contracts.
triggers: pi-67, install, update, repair, release, provider, model, bootstrap, acceptance
---

# pi-67 Product Boundary Rule

Use this rule when changing pi-67 CLI behavior, installation, update, repair,
provider integration, bootstrap, acceptance, documentation, or release flows.

## Product ownership

- Upstream `@earendil-works/pi-coding-agent` / `pi` is the only Pi runtime. It
  owns the UI, model connections, extension loading, tool execution, and task
  lifecycle.
- pi-67 is the Windows/macOS team workstation distribution and configuration
  manager for `~/.pi/agent`, shared Skills, extensions, rules, prompts,
  templates, diagnostics, and release assets.
- The daily user entrypoint is always `pi`. pi-67 must not become a parallel
  chat runtime, upstream fork, mandatory launcher, or the sole judge of whether
  Pi can run.
- `pi-67 launch`, if retained, is only an optional Windows PATH-refresh
  compatibility helper and must not become the standard launch path.

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
  must not prevent zero-credential Pi startup.
- Real credentials are machine-owned and must never enter source, release
  assets, logs, fixtures, or memory.

## Acceptance and release

- Acceptance must use the real `pi` binary, real configuration loading, and a
  real tool or startup path. Wrappers, mocks, and temporary launch shims prove
  only their narrow compatibility surface.
- Keep upstream Pi installation/update as a separate explicit lifecycle.
  pi-67 may report installed/tested/latest compatibility but must not silently
  mutate the upstream runtime.
- New or upgraded extensions, Skills, rules, prompts, and MCP templates must
  improve the team Pi workflow without taking over upstream runtime duties.
- Before changing CLI positioning, install/update ownership, launch behavior,
  or acceptance contracts, read the matching README product section. Update
  documentation and tests with the implementation.
