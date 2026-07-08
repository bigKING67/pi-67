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

## `node` or `npm` command not found

Pi and several extensions require Node/npm. Install Node first, then rerun:

```bash
./install.sh
```

If you only want to link assets and install npm dependencies later:

```bash
./install.sh --no-npm
```

## Placeholder warnings in config files

Doctor may report placeholders in:

```text
~/.pi/agent/models.json
~/.pi/agent/auth.json
~/.pi/agent/image-gen.json
```

This is expected after a fresh install. Replace `YOUR_...` placeholders with local keys before using the related provider or feature.

Recommended helper:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets
```

For automation, pass secrets through environment variables instead of CLI flags:

```bash
PI67_XTALPI_API_KEY="..." \
PI67_CODEX_API_KEY="..." \
PI67_DEEPSEEK_API_KEY="..." \
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

Check:

```bash
~/.pi/agent/settings.json
~/.pi/agent/models.json
```

The pair in `settings.json` must exist inside `models.json`:

```json
{
  "defaultProvider": "xtalpi-pi-tools",
  "defaultModel": "deepseek-v4-pro"
}
```

If you do not use xtalpi, change both fields to a provider/model that exists in `models.json`.

## xtalpi-pi-tools still returns empty or gets stuck

`xtalpi-pi-tools` is designed to avoid the old OpenAI-compatible tool continuation issue. It does not send native `tools`, `tool_choice`, `parallel_tool_calls`, `role=tool`, `thinking`, or `reasoning_effort` to xtalpi.

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

If you upgraded from old `xtalpi-tools`, migrate local config once:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --provider xtalpi-pi-tools --model deepseek-v4-pro --prompt-secrets
```

This copies any existing `xtalpi` / `xtalpi-tools` key into `xtalpi-pi-tools` and removes the old provider entries by default.

For a live smoke test:

```bash
bash ./scripts/pi67-xtalpi-pi-tools-smoke.sh
```

On Windows PowerShell, run the low-risk targeted smoke instead:

```powershell
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "read-package,plan-mode-contract,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found"
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

Do not delete the MCP entries just because doctor warns. pi-67 intentionally installs the full best-practice configuration; doctor tells you which capabilities still need local setup.

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

The same helper also supports root-level skill repos such as
`commerce-growth-os`:

```bash
bash ~/.pi/agent/scripts/pi67-check-external-skills.sh \
  --repo /path/to/commerce-growth-os

bash ~/.pi/agent/scripts/pi67-sync-external-skills.sh \
  --repo /path/to/commerce-growth-os \
  --dry-run
```

Maintainers refreshing the vendored pi-67 distribution copy should use:

```bash
bash ~/.pi/agent/scripts/pi67-sync-commerce-growth-os.sh \
  --source /path/to/commerce-growth-os \
  --dry-run

bash ~/.pi/agent/scripts/pi67-sync-commerce-growth-os.sh \
  --source /path/to/commerce-growth-os \
  --apply --yes
```

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

## `pi skill list` fails

Run it manually for the detailed error:

```bash
pi skill list
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

## Installer reports a shared skill conflict

When `~/.agents/skills/<name>` already exists but differs from the pi-67
bundled copy, current installers keep the existing global skill by default:

```text
WARN shared skill conflict: lark-approval
WARN shared skill differs from pi-67 baseline; keeping existing global skill: lark-approval
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

`pi-67 update` preserves `settings.json` and the selected theme value; it may
update the installed theme package, but it will not change the selected theme.
Before a real update/repair, the npm manager writes
`~/.pi/pi67/locks/update.lock` and blocks unsafe non-runtime dirty worktrees.
Runtime config backup/restore is delegated to the Bash or PowerShell updater
only when an in-place checkout needs to temporarily clear dirty preserved
runtime files for `git pull --ff-only`; those snapshots live under
`~/.pi/pi67/backups/pre-update-runtime-*`. Unrelated tracked edits still block.
If preserved runtime files are unchanged from an existing equivalent backup,
the updater reuses the snapshot instead of creating another timestamped backup
directory. Inspect or recover runtime snapshots with:

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

Since `0.10.2`, the `Manager latest` field is queried directly from the npm
registry HTTP API. It no longer spawns local `npm` / `npm.cmd`, so Windows
PowerShell errors such as `spawnSync npm ENOENT` or `spawnSync npm.cmd EINVAL`
should not appear in that field. If it still says `unknown`, treat it as a
network/registry reachability issue rather than a local npm shim issue.
Explicit npm operations such as `pi-67 self-update` also retry through
`cmd.exe /d /s /c npm.cmd ...` on Windows when direct npm shim spawning fails.

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

Normal updates also run a no-prompt local config migration step. This keeps existing secrets, but can migrate old `xtalpi` / `xtalpi-tools` entries into `xtalpi-pi-tools` after a release upgrade:

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

If you intentionally do not want local config migration in that run:

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
$BackupDir = Join-Path $env:USERPROFILE ".pi\agent-backups\pre-update-$Stamp"
New-Item -ItemType Directory -Force $BackupDir | Out-Null
$KnownPaths = @("settings.json", "extensions/xtalpi-compat/index.ts")
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
