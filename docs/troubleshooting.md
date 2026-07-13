# pi-67 Troubleshooting

Use `scripts/pi67-doctor.sh` first. It separates blocking failures from normal readiness warnings.

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh
```

For shorter output or automation:

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh --quiet
bash ~/.pi/agent/scripts/pi67-doctor.sh --json
```

The latest install/update report is:

```text
~/.pi/agent/pi67-report.json
```

This file is overwritten on each install/update. It is not a history log and should not grow without bound.

For a quick read-only summary before deciding what to run next:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
```

If status says the report is stale, regenerate it:

```bash
bash ~/.pi/agent/scripts/pi67-report.sh --operation manual
```

For MCP startup/tool-list validation:

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp
bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp --mcp-timeout-ms 5000
```

## Windows fresh-machine bootstrap failed

The supported fresh Windows entrypoint is the GitHub Release asset
`pi67-bootstrap.ps1`, documented in
[`windows-fresh-install.md`](windows-fresh-install.md):

```powershell
$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" -OutFile $Bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap
```

Each run writes a summary and bounded stage logs under:

```text
%USERPROFILE%\.pi\pi67\logs\bootstrap-<timestamp>-<pid>\
```

Start with `bootstrap-summary.json`. Its `failedStage` distinguishes
Administrator/UAC, WinGet repair, Windows Terminal, PowerShell 7, Notepad4
integration, Git PATH, fnm/profile, Node.js, npm runtime, pi-67 workspace,
optional xtalpi configuration, and full Windows acceptance failures. Do not send
`models.json` or any API key when reporting a problem.

Offline contract checks:

```powershell
.\scripts\pi67-bootstrap.ps1 -SelfTest
.\scripts\pi67-bootstrap.ps1 -DryRun
.\scripts\pi67-bootstrap.ps1 -DryRun -Minimal
```

No provider key is required for bootstrap success. With `-NoXtalpiPrompt`, or
when the hidden xtalpi prompt is left blank, Windows acceptance must still end
with:

```text
RESULT: PASS
```

After installation, start upstream Pi and configure any provider through its
native flow:

```powershell
pi
```

Inside Pi, use `/login`, then `/model`. Upstream Pi owns authentication and
selected-model persistence. pi-67 does not switch the provider based on which
key happens to exist.

### `failedStage = winget`

Run the same repair contract manually from an Administrator Windows PowerShell
only when diagnosing the bootstrap stage:

```powershell
$progressPreference = 'silentlyContinue'
Install-PackageProvider -Name NuGet -Force | Out-Null
Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery | Out-Null
Import-Module Microsoft.WinGet.Client -Force
Repair-WinGetPackageManager -AllUsers
winget --version
```

If PowerShell Gallery is blocked by company policy, this is an IT/package-source
problem. Do not continue to Terminal/Git/fnm stages without a working
`winget --version`.

### `failedStage = terminal-windows-powershell` or `terminal-powershell-7`

The bootstrap backs up Windows Terminal `settings.json` before changing it.
Check the summary fields `paths.windowsTerminalSettings` and
`workstation.terminalSettingsBackups`. The final full-mode contract is:

```text
defaultProfile = {574e775e-4f2a-5b96-ac1e-a2962a402336}
Windows PowerShell elevate = true
PowerShell 7 elevate       = true
```

When `-NoTerminalAdmin` was explicitly used, both expected values are `false`.
Do not delete the whole settings file; restore the recorded backup or rerun the
idempotent bootstrap.

### `failedStage = notepad4-integration`

The integration stage writes only the documented Notepad4 context-menu and
`notepad.exe` IFEO keys. Its pre-change `.reg` backups are stored in the current
bootstrap log directory. Read-only checks:

```powershell
reg query "HKCR\*\shell\Notepad4" /s
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\notepad.exe" /s
```

### `failedStage = fnm-powershell-profile` or `node-lts-krypton`

Open a new PowerShell 7 window and run:

```powershell
fnm --version
fnm current
fnm list
node --version
npm --version
Get-Command node | Format-List Source
Get-Content $PROFILE -Raw
```

Expected Node is major 24, `>=22.19.0`, and its source path belongs to fnm. The
profile must contain exactly one official initialization line:

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

## `pi` command not found

Install Pi:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

Then rerun:

```bash
./install.sh
```

## `agent dir exists but is not a git checkout`

This means the target agent directory already exists, but it is a plain folder
instead of a Git checkout:

```text
~/.pi/agent
```

The most common cause is running Pi or creating files manually before running
`pi-67 install`. pi-67 blocks by default because it must not overwrite a user's
existing folder silently.

Preview the safe repair first:

```bash
pi-67 install --repair --yes --dry-run
```

If the preview shows the expected backup/reclone action, run:

```bash
pi-67 install --repair --yes
```

The existing folder is moved, not deleted:

```text
~/.pi/pi67/backups/<timestamp>-non-git-agent-dir/agent
```

Then pi-67 clones a fresh Git checkout into `~/.pi/agent` and continues the
normal installer/update flow.

## `failed to run git: spawnSync git ENOENT`

This means Windows cannot find `git.exe` in the current PowerShell session.
From `0.10.19`, `pi-67 install --repair --yes` first checks common Git for
Windows install locations, repairs PATH for the current install process, and
persists the discovered Git directory into Windows User PATH. It also
broadcasts the Windows environment change for newly opened terminals. If Git
is genuinely not installed, install Git for Windows, then retry:

```powershell
winget install --id Git.Git -e --source winget
pi-67 install --repair --yes
```

If `winget` says Git is already installed but `git --version` still fails, run
`pi-67 install --repair --yes` anyway. When Git exists in a standard Git for
Windows path, pi-67 will repair the install flow and User PATH. Close and
reopen Windows Terminal/PowerShell after the repair, then run:

```powershell
git --version
```

pi-67 writes only User PATH, not Machine PATH, and does not silently install
Git for Windows by itself. Already-open PowerShell windows can keep their old
process-local `$env:Path`; close and reopen PowerShell if `git --version`
still fails in the old window.

## Bare `pi` fails with `Error: spawn git ENOENT`

This is the same root cause, but it happens inside upstream
`@earendil-works/pi-coding-agent` instead of inside pi-67. A typical stack
mentions a git package clone such as:

```text
Error: spawn git ENOENT
spawnargs: [
  'clone',
  'https://github.com/justhil/pi-image-gen',
  'C:\\Users\\...\\.pi\\agent\\git\\github.com\\justhil\\pi-image-gen'
]
```

Upstream Pi is trying to install `git:github.com/justhil/pi-image-gen`, but the
current PowerShell process cannot find `git.exe`. Repair the workspace and User
PATH with pi-67 first:

```powershell
npm install -g @bigking67/pi-67@latest
pi-67 install --repair --yes
pi-67 doctor
```

Close and reopen PowerShell after the repair, then verify the real runtime and
use its standard entrypoint:

```powershell
git --version
pi --version
pi
```

If the already-open window cannot be restarted immediately, `pi-67 launch` is
available as an optional one-process compatibility helper. It cannot rewrite
its parent PowerShell `$env:Path`, so it is not a replacement for reopening the
terminal or for daily `pi` usage.

## Bare `pi` works but `pi-67 launch` says Pi is not installed

If `pi --version` succeeds in PowerShell but `pi-67 launch -- --version`
reports `upstream pi command was not found`, upstream Pi is already installed
and working. There is no need to use `pi-67 launch` for normal work; continue
to run `pi` directly.
PowerShell normally selected the npm-generated `pi.ps1` wrapper, while the
Node-based manager had to execute `pi.cmd`. pi-67 `0.10.26` and `0.10.27`
could stop on the Windows `EINVAL` result from that batch wrapper before
reaching the safe `cmd.exe /d /s /c pi.cmd` fallback.

If you specifically need to diagnose that optional compatibility helper,
update the manager and retry it:

```powershell
npm install -g @bigking67/pi-67@latest
pi-67 launch -- --version
```

pi-67 `0.10.28` and newer retry `npm`, `npx`, and `pi` npm shims through
`cmd.exe` after `EINVAL` / `ENOEXEC`. They also check command existence before
showing installation guidance, so an unrelated child-process failure is no
longer mislabeled as a missing Pi installation. From `0.10.29`, the Windows
one-command acceptance gate validates `pi --version` directly and no longer
uses this optional helper as the Pi runtime health check.

## `node` or `npm` command not found

The current upstream Pi runtime requires Node.js `>=22.19.0`; the pi-67 fresh
Windows contract uses fnm and requires Node.js 24 LTS through `lts/krypton`.
It does not install a second unmanaged MSI Node through `OpenJS.NodeJS.LTS`.

On a fresh Windows machine, rerun the bootstrap so it can repair fnm, the
PowerShell profile, the default version, and the active Node.js source:

```powershell
$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest `
  -UseBasicParsing `
  -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" `
  -OutFile $Bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap
```

On macOS/Linux, install a supported Node first, then rerun:

```bash
./install.sh
```

If you only want to link assets and install npm dependencies later:

```bash
./install.sh --no-npm
```

## npm works but GitHub or xtalpi still fails

These are separate network paths. A successful npm install does not prove that
GitHub clone traffic or the company API is reachable:

1. npm registry: upstream Pi and `@bigking67/pi-67` packages;
2. GitHub: bootstrap asset, pi-67 checkout, and Git URL packages;
3. xtalpi endpoint: provider health and daily model requests;
4. company proxy/VPN: may allow only part of the above.

Run narrow checks instead of permanently changing every network setting:

```powershell
npm view @earendil-works/pi-coding-agent version
npm view @bigking67/pi-67 version
git ls-remote https://github.com/bigKING67/pi-67.git HEAD
pi-67 xtalpi health
```

The bootstrap does not change npm registry by default, write a system proxy,
disable TLS verification, or permanently change PowerShell ExecutionPolicy.
Only explicit `-UseNpmMirror` runs
`npm config set registry https://registry.npmmirror.com`. If the company
network requires a proxy/VPN, apply the IT-managed configuration to the
failing path only.

## Placeholder warnings in config files

Doctor may report placeholders in:

```text
~/.pi/agent/models.json
~/.pi/agent/auth.json
~/.pi/agent/image-gen.json
```

This is expected after a fresh install. Placeholders affect only the related
provider or feature request; they must not prevent `pi` from entering its
interactive interface.

For normal provider authentication and model selection, run `pi`, then use:

```text
/login
/model
```

Upstream Pi saves both states and restores the selected model on the next
launch. Do not manually edit `settings.json` or `auth.json` merely to satisfy a
pi-67 readiness check.

For company-provider-specific repair and diagnostics, the dedicated command
remains available:

```bash
pi-67 xtalpi configure --verify
```

It preserves unrelated providers, repairs the canonical `xtalpi-pi-tools`
public fields, and performs a real provider-health request without putting the
key in shell history.

For advanced local MCP/image/provider-template setup outside the normal Pi
login/model flow:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets
```

For automation, pass secrets through environment variables instead of CLI flags:

```bash
PI67_XTALPI_API_KEY="..." \
PI67_CODEX_API_KEY="..." \
PI67_IMAGE_GEN_API_KEY="..." \
bash ~/.pi/agent/scripts/pi67-configure.sh --no-prompt
```

## `models.json: Unexpected token` on Windows startup

If Pi fails before any provider request with an error similar to:

```text
models.json: Unexpected token '', "{ "p"... is not valid JSON
```

the failure is usually local file encoding or invisible leading bytes, not the
xtalpi API endpoint. Common causes are `models.json` or another local config
being saved as UTF-16, UTF-8 with BOM, or with leading NUL bytes. The Windows
updater now handles this without printing or deleting keys:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
powershell -ExecutionPolicy Bypass -File .\scripts\pi67-update.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\pi67-doctor.ps1
```

For parseable JSON, the updater writes a backup such as
`models.json.bak-YYYYMMDD-HHMMSS-encoding`, then rewrites the local file as
UTF-8 without BOM. If the JSON syntax itself is broken, doctor reports the file,
detected encoding, and first bytes only; it does not print API keys.

## `defaultProvider` or `defaultModel` fails

For diagnosis, the relevant upstream Pi state is stored under:

```bash
~/.pi/agent/settings.json
~/.pi/agent/models.json
~/.pi/agent/auth.json
```

Do not start by editing these files. First run:

```text
pi
/login
/model
```

If `pi` enters the interface, choose the intended provider/model with `/model`;
upstream Pi persists it. Custom providers such as `xtalpi-pi-tools` must still
have their public model definition in `models.json`, but a missing key is not a
startup error. Pi built-in providers such as DeepSeek must not be duplicated in
`models.json`; authenticate them with `/login` or their upstream-supported
environment variable.

### `pi` fails when only a DeepSeek official key is configured

The old startup failure was not caused by DeepSeek itself. `xtalpi-pi-tools`
registered its models with an empty provider-level `apiKey`, so upstream Pi
failed provider schema validation before the interactive interface appeared:

```text
Provider xtalpi-pi-tools: "apiKey" or "oauth" is required when defining models.
```

Current `xtalpi-pi-tools` registration uses a deferred environment reference,
so missing company credentials no longer block Pi startup. Verify the fixed
startup path first:

```powershell
pi
```

Upstream Pi 0.80.6 may print `No models available` for
`pi --list-models xtalpi-pi-tools` until xtalpi has a credential. That output is
model-discovery filtering, not proof that Pi cannot start. Maintainers can run
the isolated contract that checks fixture-key registration and zero-key
`session_start` separately:

```powershell
.\scripts\pi67-zero-key-startup-smoke.ps1
```

Then, inside Pi:

```text
/login
/model
```

Choose DeepSeek or any other provider there. Exit and run `pi` again to verify
that upstream Pi restores the selection. pi-67 intentionally does not switch
`settings.json` or rewrite `auth.json` for this flow.

Run doctor only as an additional workspace check:

```powershell
pi-67 doctor
```

## xtalpi-pi-tools still returns empty or gets stuck

`xtalpi-pi-tools` is designed to avoid the old OpenAI-compatible tool continuation issue. It does not send native `tools`, `tool_choice`, `parallel_tool_calls`, `role=tool`, `thinking`, or `reasoning_effort` to xtalpi.

Runtime requests are retried locally for transient provider/transport failures.
Defaults are:

```bash
XTALPI_PI_TOOLS_REQUEST_ATTEMPTS=3
XTALPI_PI_TOOLS_RETRY_DELAY_MS=1000
XTALPI_PI_TOOLS_RETRY_MAX_DELAY_MS=8000
XTALPI_PI_TOOLS_RETRY_JITTER_MS=250
```

Timeouts, network errors, HTTP 408/5xx, non-JSON responses, and malformed
responses are retried within that budget. HTTP 429 is classified as rate-limit
and `retryable=true`, but immediate retry is suppressed to avoid burning more
requests during a rate-limit window. If all attempts fail, inspect debug
telemetry for `attempt_count`, `retry_count`, `retry_suppressed_reason`, and
the structured `errorCode` / `errorCategory`.

The local provider also owns the final-answer protocol boundary. If xtalpi returns
tool-call-like content as ordinary assistant text, Pi must not accept it as a
successful final answer. The guard covers JSON action objects, bare
`id/name/arguments` objects, JSON arrays, OpenAI-style `tool_calls`,
`function_call`, `pi_tool_...` ids, `until_done_*` tools, and dynamic tools from
the current selected-tool set. These are repaired into one canonical local JSON
action before any tool can run. Ordinary business JSON is allowed unless it
matches the current tool registry or an explicit tool protocol wrapper.

If xtalpi returns a malformed JSON-action final envelope because the natural
language text contains unescaped quotes, for example
`{"kind":"final","text":"..."洗护发"..."}`, the provider recovers only the
`final.text` string and then runs the normal final-answer guard. This is safe
for user-visible text and prevents Plan mode from stopping on an invalid-JSON
repair error. The same loose recovery is intentionally not applied to malformed
`tool_call` envelopes; those still fail closed before any tool can execute.

Targeted smoke also has a final-compliance repair path for a narrower case:
tools already executed correctly, arguments and telemetry passed local checks,
but the final answer is missing required marker text. The runner performs one
`--no-tools` final-answer repair so it does not repeat side-effecting tools.
Tool absence, bad arguments, runtime errors, raw protocol leaks, and timeouts do
not use this repair path; they remain failures.

First run the local protocol test:

```bash
bash ~/.pi/agent/scripts/pi67-test-xtalpi-pi-tools.sh
```

Then start Pi through the stable launcher:

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools.sh
```

The launcher sets:

```bash
XTALPI_PI_TOOLS_MAX_TOOLS=24
XTALPI_PI_TOOLS_MAX_TOOL_RESULT_CHARS=20000
XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES=2
XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES=2
XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES=4
```

If you upgraded from old `xtalpi-tools` and explicitly want the legacy provider
entries migrated, run the advanced helper once:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets
```

This copies any existing `xtalpi` / `xtalpi-tools` key into `xtalpi-pi-tools` and removes the old provider entries by default.
It is not part of install/update and does not replace selecting the model with
upstream Pi's `/model` command.

For a live smoke test:

```bash
bash ./scripts/pi67-xtalpi-pi-tools-smoke.sh
```

On Windows PowerShell, run the low-risk targeted smoke instead:

```powershell
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "read-package,read-enoent-recovery,plan-mode-contract,plan-mode-accepted-continuation,until-done-continuation,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found"
```

Use `.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -ListCases` to inspect the current
PowerShell-native targeted case set before narrowing a slow or provider-flaky run.

If the question is whether xtalpi supports native JSON / tools at all, run the
capability probe instead of guessing from a normal chat success:

```bash
node ./scripts/pi67-xtalpi-provider-capability-probe.mjs
node ./scripts/pi67-xtalpi-provider-capability-probe.mjs --json-action-runs 5
```

PowerShell:

```powershell
node .\scripts\pi67-xtalpi-provider-capability-probe.mjs
node .\scripts\pi67-xtalpi-provider-capability-probe.mjs --json-action-runs 5
```

Interpretation:

- `plain_chat=true` only means the endpoint can chat.
- `json_object=true` on the generic prompt means JSON syntax can be used as a hint, not as a schema guarantee.
- `json_action_N` is the targeted runtime probe; if it passes repeatedly, prefer
  `local_json_action_protocol` even when the generic `json_object` prompt is flaky.
- `json_schema_strict=false` means `response_format=json_schema` must not be trusted for
  tool/action schema correctness.
- native `tools` / strict tools / `role=tool=false` means xtalpi must not be treated as a
  full OpenAI tool runtime.
- `recommendedMode=local_json_action_protocol` is the `xtalpi-pi-tools` canonical default:
  Pi owns tool selection, action/schema validation, repair, execution, and error classification locally.
- `recommendedMode=unsupported_json_action` means even targeted JSON action is unstable; the
  provider does not satisfy the `xtalpi-pi-tools` runtime contract.

Test the default local JSON action runtime instead of enabling native OpenAI tools:

```bash
bash ./scripts/pi67-test-xtalpi-pi-tools.sh
bash ./scripts/pi67-xtalpi-pi-tools-smoke.sh --case read
```

PowerShell:

```powershell
.\scripts\pi67-smoke.ps1 -Ci
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Profile quick
```

The default JSON action mode sends `response_format: {"type":"json_object"}` only as a syntax hint.
Pi still validates the local action envelope, selected-tool allowlist, arguments,
shell semantics, bounded repair, and smoke/debug gates locally.
Old `<pi_tool_call>` text is treated only as provider drift or historical artifact leakage;
it is rejected and repaired back to JSON action rather than exposed as a runtime protocol switch.
The explicit local boundary for this is
`extensions/xtalpi-pi-tools/json-action-protocol.ts`; do not replace it with
OpenAI native `tools` / `tool_choice` unless the capability probe proves those
contracts are stable.

If the task is time-critical and xtalpi continues returning empty content, temporarily switch to another configured provider:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --provider codex --model gpt-5.4 --prompt-secrets
```

## xtalpi-pi-tools says it cannot see a screenshot or tries to `read` a PNG

Expected current behavior: image/screenshot/OCR tasks should not be sent directly
to the xtalpi text-only model and should not call `read` for `.png`, `.jpg`,
`.webp`, clipboard screenshots, or inline image blocks.

The local routing contract is:

1. `xtalpi-pi-tools` detects image paths, `pi-clipboard-*.png`,
   `codex-clipboard-*.png`, inline image blocks, and “截图 / 看图 / OCR /
   image analysis” intent.
2. It selects `vision_read` first when available. `vision_read` is registered by
   `extensions/pi-vision-bridge` and uses a local multimodal provider, normally
   `models.json.providers.codex`, to convert the image into text evidence.
3. If `vision_read` is not available but `image_review` is available, it can fall
   back to user-assisted review.
4. If neither tool is selected, Pi returns a local readiness error before calling
   xtalpi. This is intentional fail-closed behavior.

If you see a message like:

```text
检测到图片/截图理解任务，但 Pi 本地 vision bridge 当前未 ready
```

run:

```bash
cd ~/.pi/agent
pi-67 update --repair
bash scripts/pi67-doctor.sh
bash scripts/pi67-test-xtalpi-pi-tools.sh
bash scripts/pi67-xtalpi-tool-coverage-audit.sh --include pi-vision-bridge --json
```

Windows PowerShell:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
pi-67 update --repair
.\scripts\pi67-doctor.ps1
.\scripts\pi67-smoke.ps1 -Ci
node .\scripts\pi67-xtalpi-smoke-plan.mjs --json
```

Check these fields:

- `extensions/pi-vision-bridge/index.ts` exists.
- coverage audit contains `local:extensions/pi-vision-bridge`.
- `modelCallableTools` contains `vision_read`.
- `models.json.providers.codex` has a usable `baseUrl`, `apiKey`, and an image
  input model; or set `PI67_VISION_PROVIDER`, `PI67_VISION_MODEL`,
  `PI67_VISION_BASE_URL`, `PI67_VISION_API_KEY`.

If a screenshot task still calls `read`, treat it as a regression and run:

```bash
bash scripts/pi67-test-xtalpi-pi-tools.sh
```

That offline test includes a guard for `XTALPI_PI_TOOLS_MAX_TOOLS=1`: image
paths must select `vision_read` / `image_review`, and `read` must be omitted with
an `image_path_read_penalty` reason code.

## xtalpi-pi-tools says `mcp` is unavailable for a browser67 / Chrome task

Symptom:

```text
xtalpi-pi-tools 请求了不可用工具：mcp。本轮可用工具：...
```

For browser work, `browser67` is the skill/runtime name; the executable Pi tool
is normally `mcp` from `pi-mcp-adapter`, or a direct browser tool such as
`browser_tab_lifecycle`, `browser_wait`, `browser_execute_js`, or
`browser_screenshot_ops`. If `mcp` is not in the selected-tool allowlist for the
current turn, `xtalpi-pi-tools` must reject the call instead of executing a tool
the model was not shown.

Expected current behavior: prompts that mention browser67, Chrome, Edge, current
tab, login state, clicking, typing, uploads, downloads, screenshots, DevTools,
console, DOM, or network inspection should select `mcp` when it is available.
Chinese prompts where the browser name appears before the action, such as
`用chrome打开蝉妈妈首页`, or prompts with punctuation between intent and runtime,
such as `打开浏览器～browser67`, are browser tasks too. Retry follow-ups such as
`再试一下` reuse recent user context for tool selection, so the second attempt
should not lose the original browser intent.
Prompts that only ask to summarize a public URL should still select
`web_fetch` / `web_search` instead of opening a real browser.

If Pi opens Safari or the macOS default browser, inspect the session log for a
`bash` tool call such as:

```json
{"command":"open https://..."}
{"command":"open -a \"Google Chrome\" \"https://...\""}
{"command":"open -a \"Google Chrome\""}
```

That is a browser-route failure: `bash open` talks to the OS default browser (or
a regular Chrome app launch), not browser67's managed `tmwd_browser` MCP
surface. Current `xtalpi-pi-tools` blocks this path and either repairs toward
`mcp({"connect":"tmwd_browser"})` or returns a readiness final if no browser MCP
tool is selected.

Run:

```bash
cd ~/.pi/agent
pi-67 update --repair
bash scripts/pi67-test-xtalpi-pi-tools.sh
bash scripts/pi67-doctor.sh
```

Windows PowerShell:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
pi-67 update --repair
.\scripts\pi67-smoke.ps1 -Ci
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Profile quick
```

If it still fails after updating, check whether the runtime exposes `mcp`:

- `settings.json` includes the package that provides `pi-mcp-adapter`.
- `mcp.json` contains the browser67 / `tmwd_browser` MCP server configuration.
- `pi-67 doctor` does not report MCP adapter or browser67 readiness errors.
- The selected tools in debug telemetry include `mcp` for browser tasks.

If `mcp` is absent from the runtime, this is an MCP registration/readiness
problem, not a provider parsing problem; fix `mcp.json`, the browser67 install,
or the MCP adapter first. If `mcp` is present in `context.tools` but omitted from
selected tools for a browser task, treat it as a `browser-bridge.ts` regression.

## xtalpi-pi-tools reports raw `previous_pi_tool_call` markup

If Pi stops with an error similar to:

```text
xtalpi-pi-tools 无法解析模型返回的工具调用，已停止自动修复。
解析错误：assistant final answer must not contain raw or internal Pi tool protocol markup
模型原始输出摘录：
收到，重新发起搜索。
[previous_pi_tool_call]
...
```

the upstream model is not just returning a normal final answer. It copied an
internal Pi tool-history record into the assistant final text. That record is
history, not a new tool call and not user-facing content.

Current pi-67 handles this in three layers:

1. Do not serialize prior assistant `toolCall` blocks into model-visible
   `previous_pi_tool_call` records during normal context construction.
2. Strip complete legacy `previous_pi_tool_call` history blocks from surrounding text
   before parser/final-answer guards run.
3. Treat the remaining text, for example "收到，重新发起搜索。", as a no-progress
   continuation and run the bounded local repair path so the next response must
   be either a real tool call or a useful final answer.

Update and verify:

```bash
cd ~/.pi/agent
bash scripts/pi67-update.sh
bash scripts/pi67-test-xtalpi-pi-tools.sh
node --no-warnings scripts/pi67-fuzz-xtalpi-parser.mjs
```

On Windows PowerShell:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-update.ps1
.\scripts\pi67-smoke.ps1 -Ci
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Profile extension-low-risk
```

If the same raw-markup error still appears after those commands, check that the
repo has the newest commit and that `extensions\xtalpi-pi-tools\parser.ts`
contains `PREVIOUS_TOOL_CALL_HISTORY_BLOCK_PATTERN`.

## `/until-done` stops with `Agent is already processing` or after `until_done_task_update`

These are `pi-until-done@0.2.2` runtime compatibility problems, not xtalpi
provider transport problems:

```text
Extension "<runtime>" error: Agent is already processing. Specify streamingBehavior ('steer' or 'followup') to queue the message.
```

Newer Pi runtime versions require extension calls to `pi.sendUserMessage(...)`
to include `streamingBehavior: "followup"` or `streamingBehavior: "steer"` when
the agent is already processing. `pi-until-done@0.2.2` still contains older call
sites, so pi-67 patches that installed package locally after npm sync.

There is a second failure mode where the UI shows a real
`until_done_task_update` tool execution, then the loop stops and only resumes
after the user types "continue". In `pi-until-done@0.2.2`, `until_done_*` tool
calls did not increment `progressSignalsThisTurn`; a turn containing only task
state updates could therefore be classified by the spin guard as "no progress"
and would not queue the next `followUp`. The same patcher also makes
`until_done_*` tools count as progress so state transitions can continue
autonomously within the turn budget.

Check or apply the patch manually:

```bash
cd ~/.pi/agent
bash scripts/pi67-patch-pi-until-done-runtime-queue.sh --check --agent-dir ~/.pi/agent
bash scripts/pi67-patch-pi-until-done-runtime-queue.sh --apply --agent-dir ~/.pi/agent
```

PowerShell:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-patch-pi-until-done-runtime-queue.ps1 -Check
.\scripts\pi67-patch-pi-until-done-runtime-queue.ps1 -Apply
```

`pi67-update.sh`, `pi67-update.ps1`, `install.sh`, doctor, smoke, and release
checks all include this queue/progress compatibility guard. If the installed
package version is not `0.2.2`, the patcher does not blindly edit it; it reports
`review_required` so the new upstream package can be inspected first.

## MCP path warnings

Warnings like these mean the full MCP config is installed, but the local dependency is not present yet:

```text
MCP tmwd_browser path missing or needs local edit
MCP js-reverse path missing or needs local edit
MCP agent_memory command is not available yet
```

Fix by installing the dependency or editing:

```text
~/.pi/agent/mcp.json
```

Common local dependencies:

```text
browser67 package clone or local browser67 checkout
agent-memory-mcp binary
local Codex proxy if using the codex provider
```

For a normal managed browser67 installation, do not stop after the low-level
clone command. Preview and run the complete setup, then use the deep doctor to
separate checkout/config readiness from the live Hub/extension connection:

```bash
pi-67 external setup browser67 --dry-run
pi-67 external setup browser67
pi-67 external doctor browser67 --deep
```

`pi-67 external doctor browser67` without `--deep` checks the repo,
dependencies, prepared extension files, active skills, and MCP paths. It does
not prove that Chrome/Edge loaded the unpacked extension. `--deep` additionally
runs browser67's live doctor. The setup output prints the unpacked extension
directory; load that directory in `chrome://extensions`, start the Hub if it
was not started with `--start-hub`, and restart Pi before retrying MCP.

Do not delete the MCP entries just because doctor warns. pi-67 intentionally installs the full best-practice configuration; doctor tells you which capabilities still need local setup.

If Pi shows this while Codex/browser67 works:

```text
Server "tmwd_browser" not available
Failed to connect to "tmwd_browser": MCP error -32000: Connection closed
```

first check whether `~/.pi/agent/mcp.json` contains shell-only path placeholders
inside MCP `command` or `args`, for example:

```json
"args": ["$HOME/Documents/.../browser67/src/mcp/browser/server.mjs"]
```

`pi-mcp-adapter` does not run those fields through a shell. The literal
`$HOME/...` path is passed to `node`, the MCP server exits immediately, and Pi
reports `Connection closed`. Codex can still work at the same time because
Codex often uses a separate MCP config with absolute paths.

Fix it with the normalizer:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --workspace-only --no-doctor
bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp --mcp-timeout-ms 5000
```

Then verify the same path through xtalpi/Pi instead of only doctor:

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools-smoke.sh --case mcp-connect-tmwd-browser
```

On Windows PowerShell:

```powershell
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "mcp-connect-tmwd-browser"
```

This case performs `mcp({"connect":"tmwd_browser"})` only. It does not call
browser tools or open a website, but it proves Pi can start the browser67 MCP
server that Codex may already be able to start through a separate config.

Or explicitly point Pi at a browser67 checkout/package:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh \
  --no-prompt \
  --tmwd-repo "/path/to/browser67" \
  --agent-memory-bin "$HOME/.local/bin/agent-memory-mcp"
```

Healthy runtime `mcp.json` should use a machine-local absolute `cwd` plus
relative `args` for browser67 MCP servers. Absolute `command` / `args` also
work when needed, but `mcp.json` should not rely on `$HOME` in `command` /
`args`.

Use the configure helper to set the common local paths:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh \
  --no-prompt \
  --tmwd-repo "/path/to/browser67" \
  --agent-memory-bin "$HOME/.local/bin/agent-memory-mcp"
```

Preview first if you are unsure:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --dry-run --no-prompt
```

## Shared skill warnings

Warnings like these mean a skill exists in more than one active source:

```text
legacy ~/.pi/agent/skills duplicates shared skills
settings.json still declares active skill package source
package skill cache duplicates shared skills and should not be active
```

Canonical active skills live in:

```text
~/.agents/skills
```

Fix by installing/copying the desired skill into `~/.agents/skills` and removing
the duplicate active declaration or legacy directory. For pi-67-owned skills,
rerun:

```bash
bash ~/.pi/agent/install.sh --no-npm
```

On old linked installs, the installer moves legacy `~/.pi/agent/skills` into
the normal backup directory. For existing in-place installs or package-cache
duplicates, use the migration helper instead of manual deletion:

```bash
bash ~/.pi/agent/scripts/pi67-migrate-skills.sh --dry-run
bash ~/.pi/agent/scripts/pi67-migrate-skills.sh --apply --yes
```

It backs up migrated legacy roots and refuses to overwrite a different
canonical skill. If a maintained external repo contains the desired skill, sync
that repo into the global root:

```bash
bash ~/.pi/agent/scripts/pi67-sync-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67 \
  --dry-run
```

The Consumer Brand Commerce and Marketing repository is a Manifest-built
8-Skill Pack. Use its own Installer so shared resources are materialized:

```bash
bash /path/to/commerce-growth-os/scripts/install.sh \
  --install-root ~/.agents/skills \
  --dry-run

bash /path/to/commerce-growth-os/scripts/install.sh \
  --install-root ~/.agents/skills
```

Maintainers refreshing the vendored pi-67 distribution copy should use:

```bash
bash ~/.pi/agent/scripts/pi67-sync-commerce-skill-pack.sh \
  --source /path/to/commerce-growth-os \
  --dry-run

bash ~/.pi/agent/scripts/pi67-sync-commerce-skill-pack.sh \
  --source /path/to/commerce-growth-os \
  --apply --yes
```

If `pi-67 update` preserved an older active Pack, inspect and align it with a
backup before replacement:

```bash
pi-67 skills packs
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --dry-run
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --yes
```

The same mismatch is visible without writing through:

```bash
node ~/.pi/agent/scripts/pi67-shared-skill-packs-status.mjs --json
```

If `registry.valid` is `false`, fix the registry or vendored source contract
before attempting a Pack sync. If the registry is valid and
`summary.attention > 0`, inspect `missingSkills` / `conflictSkills`, then run the
reported `sync-pack ... --dry-run` preview. Do not jump directly to `--yes`.

For a read-only summary before applying a real repo sync, use:

```bash
bash ~/.pi/agent/scripts/pi67-check-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67
```

For browser67 MCP, keep the source checkout/cache outside active skill roots and
configure `mcp.json` with:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --tmwd-repo "/path/to/browser67" --no-prompt
```

## Deep MCP probe warnings

`--deep-mcp` starts each stdio MCP server briefly and checks whether it responds to JSON-RPC `initialize` and `tools/list`.

Common warning causes:

```text
deep probe skipped: command unavailable
deep probe skipped: missing path
deep probe blocked: args uses unsupported runtime placeholder
deep initialize did not complete
deep tools/list did not complete
deep tools/list returned no tools
```

Fix order:

1. Run the normal MCP path checks first:

   ```bash
   bash ~/.pi/agent/scripts/pi67-doctor.sh
   ```

2. Fix missing local paths in:

   ```text
   ~/.pi/agent/mcp.json
   ```

3. If the server starts slowly, increase the timeout:

   ```bash
   bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp --mcp-timeout-ms 5000
   ```

4. If only the deep probe warns but normal doctor is otherwise ready, run the MCP server command manually from `mcp.json` for local logs. Doctor intentionally does not print MCP stderr because those logs may include local private details.

## `pi list` fails or doctor reports package registry warnings

Run it manually for the detailed error:

```bash
pi list --no-approve
```

Then check:

```text
~/.pi/agent/skills
~/.agents/skills
~/.pi/agent/npm
~/.pi/agent/npm/node_modules
```

If npm dependencies were skipped or failed:

```bash
cd ~/.pi/agent/npm
npm install --ignore-scripts
```

Do not use the removed `pi skill list` form with upstream Pi 0.80.6. It is no
longer a package/skill listing command; Pi interprets `skill list` as an
interactive user prompt and may start a real model request. Skill source
conflicts are diagnosed through `pi-67 skills inventory` and doctor's direct
shared-skill checks.

## Legacy prompt placeholder failure

Doctor checks for legacy double-brace placeholders in prompts and `AGENTS.md`.

Old style:

```text
double-brace task placeholder
```

Pi-compatible style:

```text
$1
$ARGUMENTS
${2:-default}
```

Update prompt files under:

```text
~/.pi/agent/prompts
```

## Existing files were replaced

The installer moves overwritten non-symlink files/directories into a backup directory:

```text
~/.pi/agent/backup-YYYYmmdd-HHMMSS
```

The path is printed at the end of installation.

Restore a file:

```bash
cp ~/.pi/agent/backup-YYYYmmdd-HHMMSS/AGENTS.md ~/.pi/agent/AGENTS.md
```

Restore a directory:

```bash
rm ~/.pi/agent/rules
mv ~/.pi/agent/backup-YYYYmmdd-HHMMSS/rules ~/.pi/agent/rules
```

## Installer preview

To verify what will happen without writing:

```bash
./install.sh --dry-run --no-npm --no-doctor
```

Use this before installing on a machine with important existing Pi configuration.

## Installer reports preserved user-modified shared skills

When `~/.agents/skills/<name>` already exists but differs from the pi-67
bundled copy, current installers keep the existing global skill by default:

```text
WARN preserved user-modified shared skill differs from pi-67 baseline: lark-approval
WARN preserved user-modified shared skill; keeping existing global skill: lark-approval
```

This is usually the right behavior. `~/.agents/skills` is the active global
registry shared by Pi and Codex, and a hash mismatch only means "different",
not "pi-67 is newer". If the existing skill came from a trusted update or a
maintained external repository, keep it.

Use strict mode only when you intentionally want the install/update to stop on
any bundled-skill mismatch:

```bash
bash install.sh --agent-dir "$PWD" --strict-shared-skills
bash ~/.pi/agent/scripts/pi67-update.sh --strict-shared-skills
```

If an existing global skill is old residue and you want to replace it with the
pi-67 baseline, move that one skill to a backup directory first; do not delete
it until Pi works after reinstalling.

## Update stops because the checkout is dirty

For normal users, prefer the npm manager:

```bash
pi-67 update --check
pi-67 update
pi-67 update --repair
pi-67 self-update
```

`pi update --extensions` is the upstream Pi extension updater, not the pi-67
distribution updater. If it was run manually, use `pi-67 update --repair` to
re-run the pi-67 npm sync, known patch checks, shared skill checks, smoke,
doctor, and report path.

If the prompt appears right after `pi-67 update --repair`, check the ownership
layer before running the upstream command:

```bash
pi-67 update --check
pi-67 extensions doctor
```

`installed stale` means the local `npm/node_modules` copy is behind the pi-67
baseline and `pi-67 update --repair` should sync it. `baseline drift` means a
new upstream npm package exists beyond the current pi-67 release baseline; the
clean fix is a new pi-67 release that bumps the managed package and passes
smoke/release gates.

`pi-67 update` preserves `settings.json` and the selected theme value; it may
update the installed theme package, but it will not change the selected theme.
Before a real update/repair, the npm manager writes
`~/.pi/pi67/locks/update.lock` and blocks unsafe non-runtime dirty worktrees.
Runtime config backup/restore is delegated to the Bash or PowerShell updater
only when an in-place checkout needs to temporarily clear dirty preserved
runtime files. The updater fetches first, compares incoming changed paths, and
creates `~/.pi/pi67/backups/pre-update-runtime-*` only when the incoming update
touches those dirty runtime files. Already-up-to-date updates and
non-overlapping incoming updates leave dirty runtime config in place without
creating a backup. Unrelated tracked edits still block. If preserved runtime
files are unchanged from an existing equivalent backup, the updater reuses the
snapshot instead of creating another timestamped backup directory. Inspect or
recover runtime snapshots with:

```bash
pi-67 backups list
pi-67 backups list --include-legacy
pi-67 backups inspect <backup-id-or-path>
pi-67 backups inspect <pre-update-id> --legacy
pi-67 backups restore --from <backup-id-or-path> --dry-run
pi-67 backups restore --from <backup-id-or-path> --yes
```

Real restore writes a pre-restore backup first and only restores preserved
runtime config files. Change theme only with:

```bash
pi-67 themes set gruvbox-dark
```

If `pi-67 update --check` says the npm manager is outdated, update it explicitly:

```bash
pi-67 self-update
```

Since `0.10.25`, real `pi-67 update` / `pi-67 update --repair` runs block when
the active npm manager is stale, including the case where the local distro is
newer than the global manager. This is intentional: update the manager first so
the next repair uses the latest safety gates.

```bash
npm install -g @bigking67/pi-67@latest
pi-67 version
pi-67 update --repair --yes
```

Since `0.10.2`, the `Manager latest` field is queried directly from the npm
registry HTTP API. It no longer spawns local `npm` / `npm.cmd`, so Windows
PowerShell errors such as `spawnSync npm ENOENT` or `spawnSync npm.cmd EINVAL`
should not appear in that field. If it still says `unknown`, treat it as a
network/registry reachability issue rather than a local npm shim issue.
Explicit npm operations such as `pi-67 self-update` also retry through
`cmd.exe /d /s /c npm.cmd ...` on Windows when direct npm shim spawning fails.

For a Windows machine that already has the current checkout, prefer the
one-command update and acceptance entrypoint instead of copying a long manual
command list:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\pi67-windows-acceptance.ps1
```

It updates the npm manager with `pi-67 self-update`, updates the distro with
`pi-67 update --repair --yes`, and then runs the Windows/xtalpi acceptance
contract. On failure, use the printed failed-stage output tail, `Recovery`,
full stage-log path, and `Summary` path. Full command output remains in the
adjacent stage logs. To diagnose the current install without changing it,
rerun with `-SkipUpdate`; both update stages will say that this option requested
the skip. Use `-SelfTest` only for the offline script contract.

If the installed manager is too old to trust, use the latest package for one run:

```bash
npx -y @bigking67/pi-67@latest update --repair
```

`pi67-update.ps1` / `pi67-update.sh` default to safe fast-forward updates.
On Windows, use the PowerShell-native updater first:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-update.ps1
```

If execution policy blocks local scripts:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\pi67-update.ps1
```

Older PowerShell updaters from the `xtalpi-compat` -> `xtalpi-pi-tools`
migration wrote legacy known-conflict snapshots under:

```text
%USERPROFILE%\.pi\agent-backups\pre-update-*
```

Current `pi67-update.ps1` no longer writes that legacy directory. These legacy
conflict backups are read-only diagnostics, not the current runtime restore
path. The current restore path is `%USERPROFILE%\.pi\pi67\backups`.
Use this to see both kinds without deleting anything:

```powershell
pi-67 backups list --include-legacy
pi-67 backups inspect pre-update-20260707-235901 --legacy
```

Other tracked local edits still stop the update before pulling. The Bash updater
also stops on dirty checkouts by default:

```text
repo has local changes
```

Recommended fix:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
git status --short
git diff --stat
```

macOS/Linux:

```bash
cd /path/to/pi-67
git status --short
git diff --stat
```

Then either commit or stash your local edits. If you intentionally want to proceed with a dirty checkout:

```powershell
.\scripts\pi67-update.ps1 -AllowDirty
```

macOS/Linux:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --allow-dirty
```

To inspect update readiness without pulling or writing files:

```powershell
.\scripts\pi67-update.ps1 -CheckOnly
```

macOS/Linux:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --check-only
```

This reports remote head status, dirty worktree state, missing local config templates, npm sync status, and whether `~/.pi/agent/pi67-report.json` is stale.

Normal updates only perform deterministic workspace maintenance: create newly
introduced templates when missing, normalize supported JSON encodings on
Windows, and normalize MCP runtime paths. They do not consume provider-key
environment variables, write `auth.json`, or switch the provider/model selected
by upstream Pi:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh
```

Windows PowerShell:

```powershell
.\scripts\pi67-update.ps1
```

If the update spends most time in `--- npm sync ---`, it means the repo
`package.json` and `npm/package.json` differed or npm was explicitly forced.
After one successful sync, later updates should print `npm package.json already
synced` and skip npm. For a quick code-only update when dependencies are already
known-good:

```powershell
.\scripts\pi67-update.ps1 -NoNpm
```

The PowerShell updater writes `~/.pi/agent/pi67-report.json` after smoke and
embeds `scripts\pi67-doctor.ps1 -Json` by default. If report generation itself
fails, the update should continue with a warning; regenerate the report manually:

```powershell
.\scripts\pi67-report.ps1 -Operation manual
.\scripts\pi67-doctor.ps1
```

To skip report generation for one update:

```powershell
.\scripts\pi67-update.ps1 -NoReport
```

To write the report but skip embedded doctor collection:

```powershell
.\scripts\pi67-update.ps1 -NoDoctor
```

If you intentionally want to skip workspace template and normalization work in
that run:

```powershell
.\scripts\pi67-update.ps1 -NoConfigure
```

macOS/Linux:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --no-configure
```

For a Windows machine that has not received the PowerShell updater yet:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $env:USERPROFILE ".pi\pi67\backups\pre-update-bootstrap-$Stamp"
New-Item -ItemType Directory -Force $BackupDir | Out-Null
$KnownPaths = @("settings.json", "models.json", "auth.json", "mcp.json", "image-gen.json")
$RestorePaths = @()
foreach ($Path in $KnownPaths) {
  git ls-files --error-unmatch $Path *> $null
  if ($LASTEXITCODE -eq 0) { $RestorePaths += $Path }
}
if ($RestorePaths.Count -gt 0) {
  git diff -- $RestorePaths | Set-Content -Path (Join-Path $BackupDir "local.diff") -Encoding UTF8
  foreach ($Path in $RestorePaths) {
    Copy-Item $Path (Join-Path $BackupDir ($Path -replace "[\\/]", "__")) -ErrorAction SilentlyContinue
  }
  git restore -- $RestorePaths
}
git pull --ff-only
.\scripts\pi67-update.ps1
```

macOS/Linux machine that has not received the updater yet:

```bash
cd /path/to/pi-67
git pull --ff-only
bash scripts/pi67-update.sh
```

## Repository smoke test

Before committing installer, doctor, docs, prompts, or rules changes:

```bash
bash scripts/pi67-smoke.sh
```

Smoke creates a temporary Pi agent directory and validates the full install flow without touching your real `~/.pi/agent`.

For narrower checks:

```bash
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
```

## Release script says the tag already exists

`scripts/pi67-release.sh` intentionally blocks duplicate same-version releases:

```text
vX.Y.Z already exists
```

Normal fix:

```bash
# update VERSION, package.json, and CHANGELOG.md first
bash scripts/pi67-release.sh --dry-run
bash scripts/pi67-release.sh --yes
```

If a release attempt failed halfway and you need to redo the same current `VERSION`, explicitly replace only that same version:

```bash
bash scripts/pi67-release.sh --replace-existing --yes
```

Do not delete older release tags just to reduce clutter. Historical tags/releases are the release audit trail.

## Report file keeps changing after install/update

This is expected:

```text
~/.pi/agent/pi67-report.json
```

is a current-state report. It is overwritten on every install/update, so there is no cleanup needed for normal usage. If you do not want the file written:

```bash
./install.sh --no-report
bash ~/.pi/agent/scripts/pi67-update.sh --no-report
```

Windows PowerShell:

```powershell
.\scripts\pi67-update.ps1 -NoReport
```

Regenerate it manually:

```powershell
.\scripts\pi67-report.ps1 -Operation manual
```

The schema contract is documented in:

```text
docs/report-schema.md
```

## Safe uninstall

Uninstall removes only symlinks that point back to the pi-67 repository. It does not remove local config files, sessions, npm packages, caches, or unrelated files.

Preview:

```bash
bash ~/.pi/agent/scripts/pi67-uninstall.sh --dry-run
```

Apply:

```bash
bash ~/.pi/agent/scripts/pi67-uninstall.sh --yes
```

If a target is not a pi-67-owned symlink, uninstall preserves it and prints a warning.
