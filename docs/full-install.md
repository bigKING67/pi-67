# pi-67 Full Install

pi-67 is a full-stack Pi workspace distribution. It is not a minimal starter.

Default installation deploys the complete configuration:

- `AGENTS.md` kernel
- `rules/`
- `prompts/`
- `shared-skills/` copied into `~/.agents/skills`
- `extensions/`
- `docs/`
- `templates/`
- `scripts/`
- `settings.json`
- local config templates for `models.json`, `mcp.json`, `auth.json`, and `image-gen.json`
- npm packages listed in `package.json`

Missing API keys, local MCP repositories, or optional binaries are expected on a fresh machine. The installer does not remove those capabilities. Instead, run `pi67-doctor.sh` to see which capabilities are ready and which need local setup.

## Install

### Windows fresh-machine bootstrap (recommended)

For a Windows computer without Windows Terminal, PowerShell 7, Notepad4, Git,
Node.js, upstream Pi, or pi-67, use the release bootstrap instead of asking the
user to assemble prerequisites by hand:

```powershell
$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" -OutFile $Bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap
```

The bootstrap runs on Windows PowerShell 5.1+, requests one Administrator/UAC
session, repairs a missing WinGet installation, installs and configures Windows
Terminal, PowerShell 7 and Notepad4, persists Git PATH, and installs fnm. It
then resolves `lts/krypton` to Node.js 24 LTS and verifies Node.js
`>=22.19.0` from fnm. Only after every workstation prerequisite passes does it
install the real upstream Pi package, followed by pi-67. The company
`xtalpi-pi-tools` key prompt is optional; leaving it blank does not block the
complete Windows acceptance gate. `pi` remains the daily entrypoint.

See [`windows-fresh-install.md`](windows-fresh-install.md) for checksum
verification, WinGet repair, Terminal `defaultProfile` / `elevate`, Notepad4
registry integration, Git PATH, fnm profile management, `-Minimal`,
`-NoXtalpiPrompt`, logs, and network troubleshooting.

### npm manager path for machines with Node/Git

For machines that already satisfy the Git and Node runtime contracts, install
the real upstream Pi runtime first, followed by the pi-67 manager. The manager
owns the cross-platform workspace UX; internal Bash/PowerShell scripts stay
available for CI, bootstrap, and advanced troubleshooting.

Windows PowerShell:

```powershell
npm install -g @earendil-works/pi-coding-agent
npm install -g @bigking67/pi-67
pi --version
pi-67 install --repair --yes
pi-67 update
pi-67 doctor
pi-67 smoke --quick
```

macOS/Linux:

```bash
npm install -g @earendil-works/pi-coding-agent
npm install -g @bigking67/pi-67
pi --version
pi-67 install --repair --yes
pi-67 update
pi-67 doctor
pi-67 smoke --quick
```

Start the upstream runtime even when no API key has been configured:

```text
pi
/login
/model
```

Upstream Pi owns `/login`, `/model`, authentication persistence, the selected
model, and restoration on the next `pi` launch. pi-67 does not rewrite or
automatically reconcile that state. Company users may optionally preconfigure
only the xtalpi key with `pi-67 xtalpi configure --verify`; it is not required
for Pi startup.

Update boundary:

- `pi update` / `pi update --extensions` belongs to the upstream Pi CLI.
- `pi-67 update` is the pi-67 distribution update path.
- If someone ran `pi update --extensions`, run `pi-67 update --repair` to
  restore the pi-67 managed state.

`pi-67 update` preserves local choices by default. It does not overwrite
existing `settings.json`, `models.json`, `auth.json`, `mcp.json`,
`image-gen.json`, user-added packages, user-added global skills, or the selected
theme value. A real update/repair first writes a repo-external lock and blocks
unsafe non-runtime dirty worktrees:

```text
~/.pi/pi67/locks/update.lock
```

Runtime config backup/restore is owned by the Bash or PowerShell updater and
only runs when an in-place checkout needs to temporarily clear dirty preserved
runtime files. The updater fetches first, compares incoming changed paths, and
creates a runtime snapshot only if the incoming update touches those dirty
preserved files:

```text
~/.pi/pi67/backups/pre-update-runtime-*
```

Use the public backup commands to inspect, recover, prune, or archive those
snapshots. A real restore writes another pre-restore backup first and only
restores preserved runtime files. Already-up-to-date updates and
non-overlapping incoming updates do not create a backup; unchanged preserved
runtime files reuse the latest equivalent backup instead of creating a
duplicate timestamped directory when a backup is actually needed.

```bash
pi-67 backups list
pi-67 backups list --include-legacy
pi-67 backups inspect <backup-id-or-path>
pi-67 backups inspect <pre-update-id> --legacy
pi-67 backups restore --from <backup-id-or-path> --dry-run
pi-67 backups restore --from <backup-id-or-path> --yes
```

`~/.pi/agent-backups/pre-update-*` is the legacy PowerShell known-conflict
snapshot location from older updaters. Current updates no longer write it. It
is read-only diagnostic state; runtime restore uses `~/.pi/pi67/backups/`.

Theme changes are explicit:

```bash
pi-67 themes current
pi-67 themes list
pi-67 themes set gruvbox-dark
```

The manager writes lightweight state outside the checkout at
`~/.pi/pi67/state.json`. It records versions, paths, theme, provider/model, and
commit information. It also stores runtime-only UI markers such as
`settings.json.lastChangelogVersion` after migrating them out of tracked config.
It never stores API keys.

`pi-67 update --check` also checks whether the npm manager package is outdated
unless `--no-remote` is used. Manager self-updates are explicit:

```bash
pi-67 self-update
```

`0.10.25+` blocks real `pi-67 update` / `pi-67 update --repair` runs when the
active npm manager is older than npm latest or older than the local distro
version. This avoids running stale repair logic after the distro has already
moved forward. Update the manager first:

```bash
npm install -g @bigking67/pi-67@latest
pi-67 update --repair --yes
```

To bypass a stale local manager for one run:

```bash
npx -y @bigking67/pi-67@latest update --repair
```

### Windows PowerShell first path

On Windows, use PowerShell as the primary entrypoint. Do not assume an extra
Unix-like shell is available. On a completely fresh machine, use
`scripts/pi67-bootstrap.ps1` through the stable GitHub Release asset described
above. The manual sequence below is for machines that already have a supported
Node.js and Git installation.

```powershell
npm install -g @earendil-works/pi-coding-agent
git --version
# pi-67 0.10.19+ can auto-detect common Git for Windows install paths when
# PowerShell PATH is stale. install --repair --yes also persists the discovered
# Git directory into Windows User PATH and broadcasts the environment change.
# If Git is genuinely not installed:
# winget install --id Git.Git -e --source winget

npm install -g @bigking67/pi-67@latest
pi-67 install --repair --yes
pi-67 doctor
pi --version
pi-67 smoke
```

`pi-67 install --repair --yes` is safe for first install and for the common
case where bare `pi` or a manual setup already created
`$env:USERPROFILE\.pi\agent` as a plain non-Git folder. In that case pi-67 moves
the existing folder into
`$env:USERPROFILE\.pi\pi67\backups\<timestamp>-non-git-agent-dir\agent`, then
clones the managed Git checkout. From `0.10.19`, pi-67 also checks common Git
for Windows install paths, repairs PATH for the current install process, and
with explicit `--repair --yes` persists the discovered Git directory into
Windows User PATH. It also broadcasts the Windows environment change so newly
opened terminals can pick up the updated User PATH. Close and reopen
PowerShell after the repair if an already-open window still cannot run the
plain `git --version` command.

Before the first `pi` run on a fresh Windows machine, complete the
repair/doctor step and reopen PowerShell so the new terminal inherits the
repaired Git User PATH. Upstream Pi installs git-based packages such as
`git:github.com/justhil/pi-image-gen`; if the current PowerShell cannot find
`git.exe`, `pi` exits with `spawn git ENOENT`. Daily use still starts with
`pi`. `pi-67 launch` is only an optional compatibility helper when an
already-open terminal cannot be restarted immediately; it repairs PATH for
that child process and is not the standard Pi entrypoint.

`pi-67 smoke` dispatches to the PowerShell-native repository validation on
Windows. It does not call Bash and it does not write local Pi config.

For day-to-day updates on Windows, use the PowerShell-native updater:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-update.ps1
```

When `@bigking67/pi-67` is installed, prefer the public wrapper:

```powershell
pi-67 update
pi-67 update --check
pi-67 update --repair
```

For a single update-and-acceptance command, run:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\pi67-windows-acceptance.ps1
```

The acceptance entrypoint runs `pi-67 self-update` first, then
`pi-67 update --repair --yes`, and finally validates manager/distro version
parity, doctor, repository smoke, the real `pi --version` runtime entrypoint,
discovery-only `xtalpi-pi-tools` model registration, and a separate real
zero-credential Pi `session_start` probe. If the current
upstream Pi selection is an already authenticated `xtalpi-pi-tools` model, the
gate also runs provider health, JSON-action capability, and the targeted
`read-package,read-enoent-recovery` live tool chain. Otherwise those
provider-specific stages are `SKIP`; this does not fail Pi startup acceptance.
Long output is kept in a
repo-external temporary artifact directory. Successful runs keep the console
compact; failed runs print the
last 40 lines from the failed stage plus its full log and summary paths. Use
`-SkipUpdate` only to validate the currently installed version: the manager
and distro update stages will be labeled as explicitly skipped by that option.
Use `-SelfTest` for the offline acceptance-contract test.

It runs a safe fast-forward Git update, keeps existing local runtime config
files, creates missing config files from examples only when needed, normalizes
parseable Windows JSON encoding issues such as UTF-16, UTF-8 BOM, or leading
NUL bytes to UTF-8 without BOM after writing `*.bak-*-encoding` backups, syncs
npm dependencies, applies the local `pi-until-done` runtime queue/progress
compatibility patch when needed, runs the PowerShell smoke, and writes
`pi67-report.json`. For in-place checkouts, dirty user runtime config such as
`settings.json` is backed up only when incoming changed paths overlap it; then
it is temporarily cleared for fast-forward and restored after the merge.
Already-up-to-date or non-overlapping updates keep it in place without writing
a backup. Unrelated tracked edits still block.

The canonical fresh-machine orchestration lives in
`scripts/pi67-bootstrap.ps1`; `docs/windows-fresh-install.md` is the canonical
user-facing explanation of the same ordered stages. Release checks must keep
the implementation and documentation synchronized. Maintainers can test the
deterministic contract without changing a computer:

```powershell
.\scripts\pi67-bootstrap.ps1 -SelfTest
.\scripts\pi67-bootstrap.ps1 -DryRun
.\scripts\pi67-bootstrap.ps1 -DryRun -Minimal
```

This keeps Windows usage on native PowerShell and prevents the README,
full-install guide, CI, and actual bootstrap from drifting into different
manual command sequences. The Bash installer remains the macOS/Linux path and
the compatibility path for linked/symlink installs.

### macOS/Linux Bash path

Recommended in-place install:

```bash
git clone https://github.com/bigKING67/pi-67.git ~/.pi/agent
cd ~/.pi/agent
./install.sh --agent-dir "$PWD"
```

In this mode `~/.pi/agent` is the pi-67 Git checkout. The installer does not create symlinks or move tracked assets; it only verifies the tracked asset set and creates missing local config files.

Compatibility linked install:

```bash
git clone https://github.com/bigKING67/pi-67.git
cd pi-67
./install.sh
```

Automation-friendly install:

```bash
./install.sh --yes
```

Preview without writing:

```bash
./install.sh --dry-run --no-npm --no-doctor
```

Skip local report generation:

```bash
./install.sh --no-report
```

Install into a custom Pi agent directory:

```bash
./install.sh --agent-dir /path/to/.pi/agent
```

Install shared skills into a custom global skill root:

```bash
./install.sh --skills-dir /path/to/.agents/skills
```

`--dev-link-skills` is available for local skill development. Normal user
installation copies skills and does not create skill symlinks.

Preserved user-modified shared skills are non-destructive by default. If
`~/.agents/skills/<name>` already exists and differs from the pi-67 bundled
baseline, the installer keeps the existing global skill, prints a warning, and
continues. This is intentional: a target machine may already have a newer or
more authoritative global skill. Use strict mode only when you explicitly want
pi-67 bundled-skill parity:

```bash
./install.sh --strict-shared-skills
```

## What the installer does

1. Checks that `pi` exists.
2. Creates `~/.pi/agent` if needed.
3. Detects install mode:
   - `in-place`: repository root and agent dir are the same path.
   - `linked`: repository root is outside the agent dir.
4. In `in-place`, verifies tracked assets in the current checkout. In `linked`, backs up overwritten files/directories and symlinks Pi runtime assets into `~/.pi/agent`.
5. Copies missing `shared-skills/` into `~/.agents/skills`.
6. Preserves existing user-modified global skills by default and warns; `--strict-shared-skills` turns those preserved differences into blocking parity checks.
7. Retires legacy `~/.pi/agent/skills` in linked installs by moving it into the installer backup directory.
8. Copies `.example` config files only when local config files do not already exist.
9. Installs npm packages into `~/.pi/agent/npm`.
10. Applies the `pi-until-done@0.2.2` runtime queue/progress compatibility patch when
    that installed package still lacks `streamingBehavior` on
    `pi.sendUserMessage(...)`.
11. Runs `scripts/pi67-doctor.sh`.
12. Writes `~/.pi/agent/pi67-report.json`.

The installer is intentionally full-by-default. It does not ask users to choose a minimal profile.

## Shared skills

`~/.agents/skills` is the canonical active skill registry shared by Pi and
Codex. The repository stores pi-67-owned distributable skills in
`shared-skills/`; the installer copies them into `~/.agents/skills`.

Productized external skills such as `design-craft`, `frontend-craft`,
`tmwd-browser-mcp`, and `js-reverse` should also be installed into
`~/.agents/skills`:

```text
~/.agents/skills/design-craft
~/.agents/skills/frontend-craft
~/.agents/skills/tmwd-browser-mcp
~/.agents/skills/js-reverse
```

Do not declare those skill repositories as active Pi packages when their skills
are already installed globally; that creates duplicate skill names. If a repo
also provides MCP servers, keep the source checkout/package cache outside the
Pi active skill roots and point `mcp.json` at its server entrypoints.

If an old linked install left `~/.pi/agent/skills`, rerun the installer. It
will move that legacy active root into the normal backup directory after the
shared skills are installed. For in-place checkouts, remove legacy skill roots
manually after verifying `~/.agents/skills` contains the same skills.

For old installs or package-cache duplicates, use the migration helper instead
of deleting directories by hand. It defaults to a dry-run, copies missing skills
into the canonical root, and moves migrated legacy roots into a backup directory
only when `--apply --yes` is provided:

```bash
bash ~/.pi/agent/scripts/pi67-migrate-skills.sh --dry-run
bash ~/.pi/agent/scripts/pi67-migrate-skills.sh --apply --yes
```

The migration helper scans the legacy active roots that most commonly trigger
Pi duplicate warnings:

```text
~/.pi/agent/skills
~/.pi/agent/git/github.com/bigKING67/design-craft/skills
~/.pi/agent/git/github.com/bigKING67/browser67/skills
```

It never overwrites a different `~/.agents/skills/<name>` directory. If a
canonical skill differs from a legacy copy, the helper stops and leaves both
roots in place for manual review.

Use the external sync helper for maintained standalone skill repositories:

```bash
bash ~/.pi/agent/scripts/pi67-sync-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67 \
  --dry-run

bash ~/.pi/agent/scripts/pi67-sync-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67 \
  --apply --yes
```

That command copies `skills/*/SKILL.md` trees into `~/.agents/skills`, skips
identical already-installed skills, and refuses conflicts. It also supports
root-level skill repositories with `repo/SKILL.md`, such as
`commerce-growth-os`:

```bash
bash ~/.pi/agent/scripts/pi67-check-external-skills.sh \
  --repo /path/to/commerce-growth-os

bash ~/.pi/agent/scripts/pi67-sync-external-skills.sh \
  --repo /path/to/commerce-growth-os \
  --dry-run
```

It does not edit `~/.pi/agent/git/...`, `settings.json`, or `mcp.json`.

Maintainers refreshing pi-67's vendored `shared-skills/commerce-growth-os`
copy from the standalone upstream repo should use:

```bash
bash ~/.pi/agent/scripts/pi67-sync-commerce-growth-os.sh \
  --source /path/to/commerce-growth-os \
  --dry-run

bash ~/.pi/agent/scripts/pi67-sync-commerce-growth-os.sh \
  --source /path/to/commerce-growth-os \
  --apply --yes
```

Before applying real repo syncs, use the optional read-only checker when you
want a concise local integration summary:

```bash
bash ~/.pi/agent/scripts/pi67-check-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67
```

```text
~/.agents/packages/browser67/src/mcp/browser/server.mjs
~/.agents/packages/browser67/src/mcp/js-reverse/server.mjs
```

Use `scripts/pi67-configure.sh --tmwd-repo /path/to/browser67` to point MCP at
a local browser67 checkout.

## Install/update report

Every install or update writes:

```text
~/.pi/agent/pi67-report.json
```

This is a single current-state file. It is overwritten atomically on each install/update and does not append historical entries, so normal usage does not create unbounded report files.

The report includes:

- pi-67 version and package version
- repository branch, commit, dirty state, and origin URL
- shared skill source/install/duplicate state
- agent directory file states
- runtime versions for Node/npm/Pi
- doctor JSON result, unless doctor was skipped

The machine-readable field contract is documented in `docs/report-schema.md`. Current reports use schema `pi67-report/v2`. Embedded doctor JSON is documented in `docs/doctor-schema.md`.

Use `--no-report` on Bash install/update or `-NoReport` on PowerShell update if
you do not want the update to write the report:

```powershell
.\scripts\pi67-update.ps1 -NoReport
```

To regenerate the current report manually on Windows:

```powershell
.\scripts\pi67-report.ps1 -Operation manual
```

## Local config files

The following files are local runtime configuration and are not committed:

```text
~/.pi/agent/models.json
~/.pi/agent/mcp.json
~/.pi/agent/auth.json
~/.pi/agent/image-gen.json
```

On a fresh install they are copied from:

```text
models.example.json
mcp.example.json
auth.example.json
image-gen.example.json
```

Existing local config files are preserved. For normal provider authentication
and model selection, do not hand-edit these files: run `pi`, then use `/login`
and `/model`. Custom workspace features such as MCP paths, image generation, or
the optional company xtalpi template may still require explicit local setup.

`mcp.json` must be runnable by `pi-mcp-adapter` directly. Do not put `$HOME`,
`${HOME}`, `%USERPROFILE%`, or `~` inside MCP `command` or `args`; those fields
are not shell-expanded by the adapter. pi-67 writes adapter-compatible config by
using either absolute paths or, preferably, a machine-local absolute `cwd` plus
relative `args`.

## Advanced local template and MCP setup

The normal model flow is always `pi` -> `/login` -> `/model`. Use
`pi67-configure.sh` only when you explicitly need to configure workspace-owned
templates such as MCP paths, image generation, Codex local-provider settings,
or the company xtalpi template:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets
```

The helper:

1. Creates missing local config files from repo examples.
2. Writes API keys through hidden prompts or env vars.
3. Updates and normalizes `tmwd_browser`, `js-reverse`, and `agent_memory` MCP
   paths into adapter-runnable form.
4. Supports an explicit legacy provider/model override for controlled local
   migrations; ordinary users should use Pi's `/model` instead.
5. Runs doctor after writing unless `--no-doctor` is passed.

Non-interactive example:

```bash
PI67_XTALPI_API_KEY="..." \
PI67_CODEX_API_KEY="..." \
PI67_IMAGE_GEN_API_KEY="..." \
bash ~/.pi/agent/scripts/pi67-configure.sh \
  --no-prompt \
  --tmwd-repo "/path/to/browser67" \
  --agent-memory-bin "$HOME/.local/bin/agent-memory-mcp"
```

Preview without writing:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --dry-run --no-prompt
```

To select or change the daily provider/model, do not use this workspace helper.
Run upstream Pi:

```text
pi
/login
/model
```

For xtalpi tasks, pi-67 now uses `xtalpi-pi-tools`: Pi owns the tool protocol
locally and sends only plain chat messages to the company proxy.
Image/screenshot/OCR tasks are routed locally through `vision_read` from
`extensions/pi-vision-bridge` before xtalpi sees text evidence, so the text-only
provider is not asked to read PNG/JPG files directly. Daily use still starts
with bare `pi`. For diagnosis or an explicit provider/model override, the
optional controlled launcher is:

```bash
pi-67 xtalpi run
```

Windows PowerShell:

```powershell
pi-67 xtalpi run
```

This launcher defaults `PI_OBSERVATIONAL_MEMORY_PASSIVE=true`, so background
`pi-observational-memory` writes cannot keep the main task lifecycle open after
the assistant final answer. Use `pi-67 xtalpi run --no-passive-observational-memory`
only when you explicitly want automatic post-final observational-memory writes.
It is not required for normal daily Pi usage.

Lower-level Bash launcher:

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools.sh
```

Lower-level Windows PowerShell launcher:

```powershell
.\scripts\pi67-xtalpi-pi-tools.ps1
```

Windows PowerShell users can run the low-risk targeted live smoke without Bash:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "read-package,read-enoent-recovery,plan-mode-contract,plan-mode-accepted-continuation,until-done-continuation,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found"
```

The PowerShell runner covers low-risk targeted cases for cwd-relative `read`,
deterministic `ENOENT` recovery without replaying the same missing read,
plan-mode contract, FFF search/grep, batch web fetch, sequential-thinking status, MCP gateway/status,
read-only subagent list, and sentinel recall-not-found. It uses temporary state
for FFF and sequential-thinking. Use the Bash runner for the full xtalpi suite on
macOS/Linux or an explicitly configured Bash-compatible Windows environment.

If browser67 / `tmwd_browser` shows `Connection closed`, verify the MCP startup
path explicitly after running configure/doctor:

```powershell
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "mcp-connect-tmwd-browser"
```

That case connects `tmwd_browser` through Pi's `mcp` tool and does not open any
website or call browser inner tools.

It keeps your existing xtalpi URL/API key and only sets stable local runtime variables for the current Pi process:

```bash
XTALPI_PI_TOOLS_MAX_TOOLS=24
XTALPI_PI_TOOLS_MAX_TOOL_RESULT_CHARS=20000
XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES=2
XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES=2
```

Static protocol test:

```bash
bash ~/.pi/agent/scripts/pi67-test-xtalpi-pi-tools.sh
```

In linked mode, `settings.json` is symlinked by default so updates from pi-67 continue to apply. If you request a provider/model change that differs from the repository default, the configure helper detaches `settings.json` into a local file before writing, so personal defaults do not dirty the repo. In in-place mode, `settings.json` is tracked by the current checkout; keep personal secrets and machine paths in the ignored local config files instead. The Pi changelog marker `lastChangelogVersion` is runtime-only: update/repair migrates it into `~/.pi/pi67/state.json`, removes it from `settings.json`, and installs a local Git clean filter so the marker cannot be accidentally carried into normal diffs or commits.

## Readiness levels

pi-67 distinguishes between installed and ready:

| Capability | Installed by default | Ready when |
| --- | --- | --- |
| AGENTS kernel | Yes | `~/.pi/agent/AGENTS.md` points to the repo |
| Rules | Yes | 9 rule files exist and `pi-rules-loader` is installed |
| Prompts | Yes | Prompt files exist and do not use legacy double-brace placeholders |
| Skills | Yes | `pi skill list` succeeds |
| Pi interactive startup | Yes | `pi` enters its interface even with no provider key |
| Active model request | Upstream Pi | The selected provider is authenticated through `/login` or its supported environment/config source |
| Model persistence | Upstream Pi | `/model` selection is restored on the next `pi` launch |
| xtalpi-pi-tools profile | Yes | Extension loads without a key; requests become ready after the user authenticates the company provider |
| vision bridge | Yes | `extensions/pi-vision-bridge` is installed and `vision_read` can use a configured image-input provider |
| Codex provider | Yes | local Codex proxy and API key are configured |
| tmwd_browser MCP | Yes | browser67 package clone or local browser67 checkout path exists |
| js-reverse MCP | Yes | browser67 package clone or local browser67 checkout path and bridge settings are valid |
| agent_memory MCP | Yes | `agent-memory-mcp` binary exists |
| image generation | Yes | `image-gen.json` has a usable key/base URL |

Run:

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh
```

Windows PowerShell:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-doctor.ps1
```

Doctor warnings are normal on a new machine. They show what needs local setup.

Automation-friendly doctor modes:

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh --quiet
bash ~/.pi/agent/scripts/pi67-doctor.sh --json
```

Windows PowerShell:

```powershell
.\scripts\pi67-doctor.ps1 -Quiet
.\scripts\pi67-doctor.ps1 -Json
```

`--quiet` prints only the summary and final result. `--json` emits a stable machine-readable object with `result`, `counts`, and per-check `checks[]` entries.

The doctor JSON schema is documented in `docs/doctor-schema.md`. Current doctor JSON uses schema `pi67-doctor/v2`.

For a quick read-only summary of version, Git state, report freshness, and the latest doctor result:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
bash ~/.pi/agent/scripts/pi67-status.sh --json
```

Status details are documented in `docs/status.md`.

Optional deep MCP probe:

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp
bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp --mcp-timeout-ms 5000
```

The normal doctor only checks MCP commands and local paths. `--deep-mcp` briefly starts each stdio MCP server from `mcp.json`, sends JSON-RPC `initialize`, then calls `tools/list`. This is intentionally opt-in because it can start local MCP processes and may require machine-specific dependencies.

If Codex can use `tmwd_browser` but Pi reports `Connection closed`, run:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --workspace-only --no-doctor
bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp --mcp-timeout-ms 5000
```

This catches the common mismatch where a config worked in a shell or in Codex
but Pi's MCP adapter received a literal `$HOME/...` argument and could not start
the server process.

## Updating

Recommended cross-platform entrypoint:

```bash
pi-67 update
pi-67 update --check
pi-67 update --repair
```

`pi update --extensions` is intentionally not the pi-67 update path. It only
updates upstream Pi extensions according to Pi's own semantics. Use
`pi-67 update --repair` after manual upstream extension updates when you want
pi-67 to re-run npm sync, known patch checks, shared skill checks, doctor,
smoke, report generation, and theme-preserving configuration checks.

If Pi shows `Package Updates Available`, run `pi-67 update --check` or
`pi-67 extensions doctor` first. pi-67 classifies whether the local
`npm/node_modules` install is stale, or whether the pi-67 release baseline has
not yet adopted a newer upstream package. Local stale installs are fixed by
`pi-67 update --repair`; baseline drift should be handled by a new pi-67
release after smoke gates, not by asking every user to run the upstream
`pi update --extensions` path.

If `Manager latest` says `update available`, run `npm install -g
@bigking67/pi-67@latest` or `pi-67 self-update` before repair. The manager owns
the safety gate, so keeping it current comes before updating the distro.

If your installed pi-67 already includes the updater:

Windows PowerShell:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-update.ps1
```

For an in-place checkout, the Git update portion is equivalent to:

```bash
git -C ~/.pi/agent pull --ff-only
```

The PowerShell updater:

1. Runs `git pull --ff-only` in the pi-67 checkout.
2. Keeps local runtime config files.
3. Creates newly introduced local config files from `.example` templates only when missing.
4. Backs up and rewrites parseable local JSON files as UTF-8 without BOM when PowerShell/Windows saved them as UTF-16, UTF-8 BOM, or with leading NUL bytes.
5. Leaves upstream Pi authentication and provider/model selection unchanged.
6. Normalizes `mcp.json` so MCP `command` / `args` do not depend on shell-only
   `$HOME` expansion.
7. Syncs npm dependencies when `package.json` differs from `~/.pi/agent/npm/package.json`.
8. Applies the `pi-until-done` runtime queue/progress compatibility patch when needed.
9. Runs `scripts\pi67-smoke.ps1 -Ci` after the update.
10. Writes `~/.pi/agent/pi67-report.json` and embeds `scripts\pi67-doctor.ps1 -Json` unless `-NoDoctor` is used.

`npm sync` is skipped when the copied `npm/package.json` already matches the
repo `package.json`. When it does run, the updater uses npm's local cache first
and disables audit/fund checks for a faster day-to-day update. To skip npm for a
known-good local dependency set:

```powershell
.\scripts\pi67-update.ps1 -NoNpm
```

On macOS/Linux, or when you explicitly want the Bash update/status tooling:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh
```

The Bash updater also runs doctor and writes `~/.pi/agent/pi67-report.json`.

If you want the PowerShell updater to skip report generation:

```powershell
.\scripts\pi67-update.ps1 -NoReport
```

If you want the report but not the embedded doctor result:

```powershell
.\scripts\pi67-update.ps1 -NoDoctor
```

If you need to skip workspace template and normalization work for one update:

```powershell
.\scripts\pi67-update.ps1 -NoConfigure
```

macOS/Linux:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --no-configure
```

For an older install that does not have the updater yet:

Windows PowerShell, one-time bootstrap:

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

macOS/Linux:

```bash
cd /path/to/pi-67
git pull --ff-only
bash scripts/pi67-update.sh
```

Preview without changing files:

```powershell
.\scripts\pi67-update.ps1 -DryRun
```

macOS/Linux:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --dry-run
```

Check update readiness without pulling, running doctor, or writing files:

```powershell
.\scripts\pi67-update.ps1 -CheckOnly
```

macOS/Linux:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --check-only
```

`--check-only` reports the local commit/version, remote branch head, dirty worktree state, local config template gaps, npm sync status, and whether `pi67-report.json` is stale.

For a shorter daily health summary, use:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
```

If the checkout has local edits, the updater stops by default. Commit or stash them first. If you intentionally want to proceed:

```powershell
.\scripts\pi67-update.ps1 -AllowDirty
```

macOS/Linux:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --allow-dirty
```

## Smoke test

Windows PowerShell:

```powershell
.\scripts\pi67-smoke.ps1 -Ci
```

This checks release metadata, JSON, Node helper syntax/self-tests, the xtalpi
`/chat/completions` endpoint contract, documentation coverage, Git portability,
and tracked/staged release files without invoking Bash.

For repository maintenance and CI:

```bash
bash scripts/pi67-smoke.sh
```

The smoke test does not touch the real `~/.pi/agent`. It creates a temporary agent directory, installs the full asset set there with a fake `pi` binary, and runs doctor against that temp install.

Skill governance and artifact-level checks are also available as focused
runners:

```bash
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
```

## Recovery

Every overwritten non-symlink target is moved into the backup directory printed by the installer.

Preview a restore:

```bash
bash ~/.pi/agent/scripts/pi67-restore.sh --backup-dir ~/.pi/agent/backup-YYYYmmdd-HHMMSS --dry-run
```

Restore from backup:

```bash
bash ~/.pi/agent/scripts/pi67-restore.sh --backup-dir ~/.pi/agent/backup-YYYYmmdd-HHMMSS --yes
```

Do not delete backup directories until doctor passes and Pi works as expected.

## Uninstall

Uninstall only removes symlinks owned by pi-67. It preserves local runtime configuration, keys, sessions, npm packages, and unrelated files.

Preview:

```bash
bash ~/.pi/agent/scripts/pi67-uninstall.sh --dry-run
```

Remove pi-67 symlinks:

```bash
bash ~/.pi/agent/scripts/pi67-uninstall.sh --yes
```
