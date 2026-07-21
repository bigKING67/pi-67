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
- `settings.example.json` tracked as the distribution template; copied to an
  ignored machine-local `settings.json` only when missing
- local config templates for `models.json`, `mcp.json`, `auth.json`, and `image-gen.json`
- npm packages listed in `package.json`

Missing API keys, local MCP repositories, or optional binaries are expected on a fresh machine. The installer does not remove those capabilities. Instead, run `pi67-doctor.sh` to see which capabilities are ready and which need local setup.

## Install

### Windows fresh-machine manual prerequisites (recommended)

On a completely fresh Windows computer, start from the built-in Administrator
Windows PowerShell. Ensure WinGet is available, then install Windows Terminal:

```powershell
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe
}
winget --version
winget install --id Microsoft.WindowsTerminal -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id Microsoft.PowerShell -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id zufuliu.notepad4 -e --source winget --accept-package-agreements --accept-source-agreements
```

Run the App Installer registration command only when `winget` is missing. If
the package is absent or registration still fails, the canonical Windows guide
documents both the Microsoft Store App Installer path and the official
`Microsoft.WinGet.Client` / `Repair-WinGetPackageManager -AllUsers` PowerShell
Gallery fallback.

After Terminal installation, install PowerShell 7 and Notepad4. Run Notepad4 as
Administrator, open **Settings -> Advanced Settings -> System Integration**,
enable the Windows Explorer context-menu entry, and enable the registry-based
Windows Notepad replacement. The taskbar jump-list option is optional.
Install Git only after that integration is complete:

```powershell
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
```

Verify `where.exe git`, `git --version`, and that Git's `cmd` directory is in
the persistent User or Machine PATH; close and reopen Terminal and repeat the
Git checks before continuing.

Then set **Startup -> Default profile** to **PowerShell**. Enable **Profiles ->
PowerShell -> Advanced -> Automatically run as Administrator** as the profile
contract. Follow the canonical guide once to register the fixed
highest-privilege scheduled task and pin its
`Windows Terminal (Administrator)` shortcut. Daily launches through that entry
start PowerShell 7 with an Administrator token without repeated UAC. Launching
the original Terminal icon still requests UAC; UAC remains enabled for other
elevation requests.

Continue in a newly opened PowerShell 7 terminal and install fnm. Close every
existing Terminal window after WinGet finishes so the new shell inherits the
persistent PATH:

```powershell
winget install --id Schniz.fnm -e --source winget
$ProfileDir = Split-Path -Parent $PROFILE
New-Item -Path $ProfileDir -ItemType Directory -Force | Out-Null
New-Item -Path $PROFILE -ItemType File -Force | Out-Null
notepad $PROFILE
```

Save the following single initialization line in the PowerShell 7 profile:

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

Load the profile in the current shell, install and select Node.js 24 LTS, then
persist and verify the npm mirror:

```powershell
. $PROFILE
fnm install lts/krypton
fnm default lts/krypton
fnm use lts/krypton
node --version
npm --version
npm config set registry https://registry.npmmirror.com
npm config get registry
```

The final registry value must be `https://registry.npmmirror.com/`. If the
mirror temporarily lacks a package, use `https://registry.npmjs.org/` only for
that query or installation, then switch back to the required mirror and verify
it again. Manually install the real upstream Pi package after these checks;
only then run the release `pi67-bootstrap.ps1 -Mode Auto`. The bootstrap now manages only
the latest `@bigking67/pi-67` manager and the `~/.pi/agent` workspace. It does
not request UAC, install system/runtime prerequisites, edit Terminal or shell
profiles, configure provider credentials, or run full workstation acceptance.

For the optional segmented prompt shown in the Windows guide, install Oh My
Posh after the runtime prerequisites:

```powershell
winget install JanDeDobbeleer.OhMyPosh --source winget --scope user --force
notepad $PROFILE
```

Append `oh-my-posh init pwsh | Invoke-Expression` exactly once as the last
profile line and reload with `. $PROFILE`. The primary team font is
`Maple Mono NF CN`, which combines Nerd Font glyphs with CJK coverage and 2:1
terminal alignment. The canonical Windows guide downloads
`MapleMono-NF-CN.zip` and `MapleMono-NF-CN.sha256` from the official latest
release, verifies SHA-256, installs the local archive through Oh My Posh, and
selects `Maple Mono NF CN` in Terminal. Meslo is only the download-failure
fallback. Use
`oh-my-posh init pwsh --eval | Invoke-Expression` only as the documented
ExecutionPolicy fallback because it initializes more slowly. Theme previews
are available at <https://ohmyposh.dev/docs/themes>; Maple Mono documentation
is at <https://github.com/subframe7536/maple-font/blob/variable/README_CN.md>.
This appearance layer is optional and is intentionally excluded from bootstrap
and workstation acceptance.

See [`windows-fresh-install.md`](windows-fresh-install.md) for the complete
zero-to-ready command sequence, App Installer fallback, SHA-256 verification,
fnm profile setup, Auto/Install/Update modes, logs, and troubleshooting.

### npm manager path for machines with Node/Git

For machines that already satisfy the Git and Node runtime contracts, install
the real upstream Pi runtime first, followed by the pi-67 manager. The manager
owns the cross-platform workspace UX; internal Bash/PowerShell scripts stay
available for CI, bootstrap, and advanced troubleshooting.

Windows PowerShell:

```powershell
npm install -g @earendil-works/pi-coding-agent@latest
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

### Optional per-user Hy-Memory

pi-67 `0.13.0+` deploys the package-owned `pi-hy-memory` extension, but does
not create credentials or memory data during install/update. Each system user
opts in once after configuring upstream Pi provider `deepseek`:

```bash
pi-67 memory init
pi-67 memory doctor --deep
pi
```

Initialization requires `uv` or Python 3.11 plus a SiliconFlow API key entered
through hidden input. DeepSeek auth is read dynamically from upstream Pi
`auth.json`. The private runtime, key, Chroma/SQLite data, outbox, and logs live
under `~/.hy-memory/pi67`, shared across that user's projects but never copied
into the Git checkout. Local persistence is not offline inference: DeepSeek
handles memory extraction/reasoning and SiliconFlow `BAAI/bge-m3` handles
embeddings.

After a pi-67 release changes the pinned SDK or service wrapper, update the
workspace first and then upgrade the private runtime without replacing data:

```bash
pi-67 update
pi-67 memory upgrade --dry-run
pi-67 memory upgrade
pi-67 memory doctor --deep
```

See [`hy-memory.md`](hy-memory.md) for the model/dimensions contract, Pi hooks,
commands, security boundaries, coexistence with existing memory systems, and
maintainer release procedure.

Update boundary:

- `pi update` / `pi update --extensions` belongs to the upstream Pi CLI.
- `pi-67 update` is the pi-67 distribution update path.
- If someone ran `pi update --extensions`, run `pi-67 update --repair` to
  restore the pi-67 managed state.

`settings.json` is ignored machine-owned runtime state; the repository tracks
only `settings.example.json`. Fresh installation copies the template only when
local settings are missing. `pi-67 update` preserves local choices by default.
It does not overwrite existing `settings.json`, `models.json`, `auth.json`, `mcp.json`,
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
`settings.json.lastChangelogVersion` after migrating them out of local settings.
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
pi-67 update
```

To bypass a stale local manager for one run:

```bash
npx -y @bigking67/pi-67@latest update
```

### Windows PowerShell first path

On Windows, use PowerShell as the primary entrypoint. Do not assume an extra
Unix-like shell is available. On a completely fresh machine, first complete
the manual prerequisite sequence in `docs/windows-fresh-install.md`. The
manager bootstrap intentionally fails fast until Git, Node.js, npm, and
upstream `pi` are available.

```powershell
npm install -g @earendil-works/pi-coding-agent
git --version
node --version
npm --version
pi --version

$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" -OutFile $Bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Mode Auto
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

The acceptance entrypoint runs `pi-67 self-update` first, then the smart default
`pi-67 update`, and finally validates manager/distro version
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

The canonical fresh-machine prerequisite sequence lives in
`docs/windows-fresh-install.md`. `scripts/pi67-bootstrap.ps1` begins only after
those prerequisites and owns the manager/workspace install-or-update stages.
Release checks must keep both contracts synchronized. Maintainers can test the
deterministic manager bootstrap without changing a computer:

```powershell
.\scripts\pi67-bootstrap.ps1 -SelfTest
.\scripts\pi67-bootstrap.ps1 -DryRun
.\scripts\pi67-bootstrap.ps1 -DryRun -Mode Install
.\scripts\pi67-bootstrap.ps1 -DryRun -Mode Update
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
identical already-installed skills, and refuses conflicts. Manifest-built
monorepos use their own Installer. For the Consumer Brand Commerce and
Marketing Pack:

```bash
bash /path/to/commerce-growth-os/scripts/install.sh \
  --install-root ~/.agents/skills \
  --dry-run

bash /path/to/commerce-growth-os/scripts/install.sh \
  --install-root ~/.agents/skills
```

It does not edit `~/.pi/agent/git/...`, `settings.json`, or `mcp.json`.

Maintainers refreshing pi-67's vendored eight-Skill Pack should use:

```bash
bash ~/.pi/agent/scripts/pi67-sync-commerce-skill-pack.sh \
  --source /path/to/commerce-growth-os \
  --dry-run

bash ~/.pi/agent/scripts/pi67-sync-commerce-skill-pack.sh \
  --source /path/to/commerce-growth-os \
  --apply --yes
```

The AI Berkshire Pack is generated from a clean `xbtlin/ai-berkshire`
checkout without executing upstream scripts. It contains the current 21 Codex
Skills plus only the Python tools they reference, adapted for shared Pi/Codex
use:

```bash
bash ~/.pi/agent/scripts/pi67-sync-ai-berkshire-skill-pack.sh \
  --source /path/to/ai-berkshire \
  --dry-run

bash ~/.pi/agent/scripts/pi67-sync-ai-berkshire-skill-pack.sh \
  --source /path/to/ai-berkshire \
  --apply --yes
```

Each pi-67 release pins one reproducible upstream commit. The scheduled
`ai-berkshire-refresh.yml` workflow checks `main` daily and opens a review PR
when it changes; it does not auto-merge or publish a release.

After a normal update, align an existing machine explicitly when Pack contents
differ:

```bash
pi-67 skills packs
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --dry-run
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --yes
pi-67 skills sync-pack ai-berkshire-investment-suite --dry-run
pi-67 skills sync-pack ai-berkshire-investment-suite --yes
```

A Pack sync treats the Git-tracked, provenance-locked source as canonical.
Changes are staged under a temporary `.pi67-skills-sync-*` transaction, current
targets move to its `previous/` directory only while the transaction is active,
and the whole directory is removed on success or failure. The manager does not
create persistent Skill content backups. Writing syncs share the state-scoped
`~/.pi/pi67/locks/skills-deploy.lock`, so an updater and an interactive
Pi/Codex session cannot mutate the same Active Skill Root concurrently. Dry-run
and read-only inspection remain lock-free.

To roll back, select or revert the desired Git commit/tag in the canonical
upstream source, regenerate the vendored Pack and provenance lock,
then run the same `skills sync-pack ... --yes` deployment. On an installed
machine, pin or reinstall the corresponding immutable pi-67 release before
syncing. `pi-67 backups` remains only for repo-external runtime configuration;
it does not store managed Skill history.

Doctor, Status, Update Plan, and `pi67-report.json` expose the same read-only
`pi67-shared-skill-packs-status/v1` parity block. To inspect it directly:

```bash
node ~/.pi/agent/scripts/pi67-shared-skill-packs-status.mjs --json
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

The default pi-67 install intentionally leaves browser67 absent. For the
managed checkout, use `external install` as the complete first-time opt-in
workflow:

```bash
pi-67 external install browser67 --dry-run
pi-67 external install browser67
pi-67 external doctor browser67 --deep
```

Install clones the repo, installs dependencies, prepares the unpacked extension,
synchronizes active skills, and writes adapter-compatible browser67 MCP entries.
It does not silently load a Chrome/Edge extension, grant OS permissions, or take
over an existing browser profile. Use
`scripts/pi67-configure.sh --tmwd-repo /path/to/browser67` only when MCP should
point at a separate local development checkout.

For later updates, one explicit command safely pulls the existing clean repo and
automatically reruns runtime setup only when the checkout changed or readiness
is incomplete:

```bash
pi-67 external update browser67
pi-67 external doctor browser67 --deep
```

Update fails when the repo is missing or dirty; it never silently installs,
resets, cleans, or overwrites an external checkout. Automated update setup also
preserves a valid alternate checkout when both MCP servers already point to it.
`pi-67 external setup browser67` is reserved for explicitly rebuilding an
already installed runtime and repointing MCP to the managed checkout.

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
~/.pi/agent/settings.json
~/.pi/agent/models.json
~/.pi/agent/mcp.json
~/.pi/agent/auth.json
~/.pi/agent/image-gen.json
```

On a fresh install they are copied from:

```text
settings.example.json
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
3. Updates and normalizes `tmwd_browser` and `js-reverse` MCP paths into
   adapter-runnable form.
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
  --tmwd-repo "/path/to/browser67"
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

In both in-place and linked installations, `settings.json` is a machine-local
file created from `settings.example.json` only when missing. Provider, model,
theme, package, and runtime marker changes therefore do not dirty the
distribution checkout and are never overwritten by later template changes.
The Pi changelog marker `lastChangelogVersion` is runtime-only: update/repair
migrates it into `~/.pi/pi67/state.json` and removes it from `settings.json`.
Upgrades from older tracked-settings releases also remove the obsolete local
Git clean filter after preserving the existing settings bytes.

## Readiness levels

pi-67 distinguishes between installed and ready:

| Capability | Installed by default | Ready when |
| --- | --- | --- |
| AGENTS kernel | Yes | `~/.pi/agent/AGENTS.md` points to the repo |
| Rules | Yes | 11 rule files exist, `pi-rules-loader` is installed, and its trigger-routing test passes |
| Prompts | Yes | Prompt files exist and do not use legacy double-brace placeholders |
| Skills | Yes | doctor shared-skill checks pass and `pi-67 skills inventory` reports no missing copies |
| Pi interactive startup | Yes | `pi` enters its interface even with no provider key |
| Active model request | Upstream Pi | The selected provider is authenticated through `/login` or its supported environment/config source |
| Model persistence | Upstream Pi | `/model` selection is restored on the next `pi` launch |
| xtalpi-pi-tools profile | Yes | Extension loads without a key; requests become ready after the user authenticates the company provider |
| vision bridge | Yes | `extensions/pi-vision-bridge` is installed and `vision_read` can use a configured image-input provider |
| Codex provider | Yes | local Codex proxy and API key are configured |
| tmwd_browser MCP | Yes | browser67 package clone or local browser67 checkout path exists |
| js-reverse MCP | Yes | browser67 package clone or local browser67 checkout path and bridge settings are valid |
| Hy-Memory extension | Yes | `pi-67 memory init` has completed and `pi-67 memory doctor --deep` passes |
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

The upstream Pi runtime and pi-67 have separate install/update lifecycles.

Update only upstream Pi:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi --version
```

Update the pi-67 workspace and managed capabilities:

```bash
pi-67 update --check
pi-67 update
pi-67 doctor
```

Normal update checks manager freshness and automatically resynchronizes missing
or stale managed npm packages. Run `pi-67 self-update` only when the manager is
reported outdated. Reserve `pi-67 update --repair` for forcing npm dependency
reinstall when the plan looks current but the installation is still damaged.

pi-67 never installs, updates, or repairs the upstream Pi runtime. Its doctor
and update-check paths may report Pi installed/tested/latest compatibility,
but that observation is read-only. The retired `--include-pi` and cross-owner
`--all` options fail closed with `unknown option`.

`pi update --extensions` is intentionally not the pi-67 update path. It only
updates upstream Pi extensions according to Pi's own semantics. Use
`pi-67 update --repair` after manual upstream extension updates when you want
pi-67 to re-run npm sync, known patch checks, shared skill checks, doctor,
smoke, report generation, and theme-preserving configuration checks.

If Pi shows `Package Updates Available`, run `pi-67 update --check` or
`pi-67 extensions doctor` first. pi-67 classifies whether the local
`npm/node_modules` install is stale, or whether the pi-67 release baseline has
not yet adopted a newer upstream package. Local stale installs are fixed by
`pi-67 update`; baseline drift should be handled by a new pi-67
release after smoke gates, not by asking every user to run the upstream
`pi update --extensions` path.

If `Manager latest` says `update available`, run `npm install -g
@bigking67/pi-67@latest` or `pi-67 self-update` before update. The manager owns
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

The updater does not guess that every checkout should pull `main`. It resolves
the target in this order: explicit `--branch` / `-Branch`, a configured
upstream on the selected remote, a matching remote branch, or the remote
default branch only when that branch has exactly the same commit as local
`HEAD`. Detached or divergent checkouts fail closed until a branch is supplied.

The PowerShell updater:

1. Runs `git pull --ff-only` in the pi-67 checkout.
2. Keeps local runtime config files.
3. Creates newly introduced local config files from `.example` templates only when missing.
4. Backs up and rewrites parseable local JSON files as UTF-8 without BOM when PowerShell/Windows saved them as UTF-16, UTF-8 BOM, or with leading NUL bytes.
5. Leaves upstream Pi authentication and provider/model selection unchanged.
6. Normalizes `mcp.json` so MCP `command` / `args` do not depend on shell-only
   `$HOME` expansion.
7. Copies tracked `package.json` and `package-lock.json`, then runs `npm ci`
   when either file differs from the ignored `npm/` runtime or dependencies are
   missing.
8. Applies the `pi-until-done` runtime queue/progress compatibility patch when needed.
9. Runs `scripts\pi67-smoke.ps1 -Ci` after the update.
10. Writes `~/.pi/agent/pi67-report.json` and embeds `scripts\pi67-doctor.ps1 -Json` unless `-NoDoctor` is used.

`npm sync` is skipped when the copied `npm/package.json` and
`npm/package-lock.json` already match the tracked pair and required dependencies
exist. When it does run, the updater uses deterministic `npm ci`, prefers npm's
local cache, and disables audit/fund checks. To skip npm for a known-good local
dependency set:

```powershell
.\scripts\pi67-update.ps1 -NoNpm
```

On macOS/Linux, or when you explicitly want the Bash update/status tooling:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh
```

The Bash updater also runs doctor and writes `~/.pi/agent/pi67-report.json`.
Both platform updaters print phase timings for Git, configuration, Skills, npm,
verification, and total runtime after a successful update.

Preserved user-modified global Skills are summarized in one line by default.
Use `pi-67 update --verbose` or Bash `--verbose` for per-Skill paths and hashes;
PowerShell uses `-SkillDriftDetails`. `--strict-shared-skills` /
`-StrictSharedSkills` remains fail-closed and includes the detailed mismatch.

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
$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" -OutFile $Bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Mode Auto
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
