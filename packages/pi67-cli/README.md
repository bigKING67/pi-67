# @bigking67/pi-67

`@bigking67/pi-67` provides the `pi-67` command for installing, updating,
diagnosing, and repairing the pi-67 Pi workspace distribution. It does not
replace the upstream Pi runtime: users start Pi with `pi` and use `pi-67` to
manage the surrounding workspace, extensions, Skills, rules, and provider
templates. Upstream Pi owns provider login, model selection, persistence, and
restoration on the next launch.

## Install upstream Pi

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi --version
```

## Install pi-67

```bash
npm install -g @bigking67/pi-67@latest
pi-67 install --repair --yes
pi-67 doctor
```

## Run Pi

```bash
pi
```

Windows PowerShell uses the same public commands. On a completely fresh
Windows computer, first use Administrator Windows PowerShell to ensure WinGet
is available, then install Windows Terminal, PowerShell 7, Notepad4, Git, fnm,
Node.js 24 LTS, npm, and upstream Pi as documented in the
[Windows fresh-install guide](https://github.com/bigKING67/pi-67/blob/main/docs/windows-fresh-install.md).

After installing Windows Terminal and PowerShell 7, the team workstation
contract installs Notepad4 and enables both its Windows Explorer context-menu
entry and registry-based Windows Notepad replacement. The taskbar jump-list
option remains optional. Install Git next and verify `where.exe git`,
`git --version`, and the persistent User/Machine PATH from a newly opened
Terminal. The Terminal contract then sets the PowerShell 7
profile as `defaultProfile` and enables that profile's `elevate` option. The
canonical guide then registers one
fixed highest-privilege scheduled task and creates a
`Windows Terminal (Administrator)` shortcut. Daily launches through that entry
run PowerShell 7 as Administrator without repeated UAC prompts while leaving
system UAC enabled for other applications. The original Terminal icon still
uses normal UAC elevation behavior.

Install fnm from a newly opened PowerShell 7 terminal, create `$PROFILE` when
it does not exist, and edit it with the Notepad4-backed `notepad` command:

```powershell
winget install --id Schniz.fnm -e --source winget
# Close every Terminal window, then reopen PowerShell 7.
$ProfileDir = Split-Path -Parent $PROFILE
New-Item -Path $ProfileDir -ItemType Directory -Force | Out-Null
New-Item -Path $PROFILE -ItemType File -Force | Out-Null
notepad $PROFILE
```

Save `fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression`
in that profile, then run:

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

The final registry value must be `https://registry.npmmirror.com/`. The
bootstrap does not create the PowerShell profile, initialize fnm, install Node,
or change this user-level npm setting.

Optional terminal polish remains a workstation choice rather than a manager
dependency:

```powershell
winget install JanDeDobbeleer.OhMyPosh --source winget --scope user --force
notepad $PROFILE
```

Add `oh-my-posh init pwsh | Invoke-Expression` once at the end of the profile,
reload it with `. $PROFILE`, and follow the canonical Windows guide to download
and SHA-256 verify the official `MapleMono-NF-CN.zip`. Set the Terminal font to
`Maple Mono NF CN`; Meslo remains only a compatibility fallback. Use the slower
`oh-my-posh init pwsh --eval | Invoke-Expression` only when ExecutionPolicy
blocks the default initialization. Themes are documented at
<https://ohmyposh.dev/docs/themes>; the font source is documented at
<https://github.com/subframe7536/maple-font/blob/variable/README_CN.md>.

After `git --version`, `node --version`, `npm --version`, and `pi --version`
all succeed, use the checksum-verifiable release bootstrap for only the pi-67
manager and workspace:

```powershell
$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" -OutFile $Bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Mode Auto
```

The bootstrap does not request UAC or install system/runtime prerequisites. It
installs the latest `@bigking67/pi-67`, selects workspace install/update from
the `~/.pi/agent` Git state, and validates `version --json` plus `doctor --json`.
The minimum Node.js contract remains `>=22.19.0`; Node.js 24 LTS is recommended.

For machines that already have Git, Node.js, npm, and upstream Pi:

```powershell
git --version
node --version
npm --version
pi --version
# pi-67 0.10.19+ auto-detects common Git for Windows install paths when PATH
# is stale. install --repair --yes persists the Git directory into Windows
# User PATH and broadcasts the environment change for newly opened terminals.
# If Git is genuinely not installed:
# winget install --id Git.Git -e --source winget

npm install -g @bigking67/pi-67
pi-67 install --repair --yes
pi-67 update
pi-67 doctor
pi --version
pi
```

On Windows, complete `pi-67 install --repair --yes`, then close and reopen
PowerShell before the first `pi` run so the terminal inherits the repaired Git
for Windows User PATH. Upstream Pi may install git-based packages such as
`git:github.com/justhil/pi-image-gen`; if the current PowerShell cannot find
`git.exe`, `pi` fails with `spawn git ENOENT`.

`pi-67 launch` remains available only as an optional compatibility helper for
an already-open Windows terminal whose PATH has not refreshed. It temporarily
adds the discovered Git directory to the upstream Pi child process and handles
npm/Scoop `pi.cmd` shims through `cmd.exe`. It is not the standard startup
command and is not used to decide whether the real Pi runtime is installed or
working.

## Log in and select a model

Start the real upstream runtime even when no API key is configured:

```text
pi
/login
/model
```

`/login`, `/model`, authentication persistence, selected-model persistence,
and next-launch restoration are upstream Pi contracts. pi-67 does not provide
a generic provider selector, does not write DeepSeek authentication, and does
not auto-switch provider/model state during install or update.

DeepSeek, Anthropic, OpenAI, Google, and other upstream providers all use the
native Pi flow above. Built-in providers must not be duplicated in
`models.json` merely to satisfy a pi-67 check.

### Company xtalpi provider

The managed workspace recommends `xtalpi-pi-tools + deepseek-v4-pro` for
company users. The optional helper below can preconfigure only that company
provider before the first Pi launch:

```bash
pi-67 xtalpi configure --verify
```

The command uses hidden TTY input, never accepts a plaintext `--api-key`
argument, preserves other providers and extra local models, repairs canonical
provider fields, normalizes supported Windows JSON encodings to UTF-8 without
BOM, and runs a real provider-health request with `--verify` after a key is
configured. Blank input, or `--no-prompt` without a key, succeeds without
writing provider/model state. The command is not required for `pi` startup and
does not replace `/login` or `/model`.

For non-interactive secret injection, use one of these environment variables
instead of a command-line value:

```text
PI67_XTALPI_PI_TOOLS_API_KEY
PI67_XTALPI_TOOLS_API_KEY
PI67_XTALPI_API_KEY
```

## Separate update lifecycles

Update only the upstream Pi runtime:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
pi --version
```

Update the pi-67 workspace and managed capabilities:

```bash
pi-67 update
pi-67 doctor
```

Normal update checks manager freshness first and automatically resynchronizes
missing or stale managed npm packages. Run `pi-67 self-update` only when update
reports that the global manager is outdated. Use `pi-67 update --repair` only
to force npm dependency reinstall when the plan appears current but the local
installation is still damaged.

`pi-67 update` never installs or updates upstream Pi. It may report the
installed, release-tested, and registry-latest Pi versions and compatibility,
but those checks are read-only. The retired `--include-pi` and cross-owner
`--all` update options fail closed with `unknown option`.

`pi update --extensions` is the upstream Pi command. It is not the pi-67
distribution updater and applies only to user-managed upstream Pi extensions.
pi-67-managed extensions use `pi-67 update`.

Use this command for pi-67:

```bash
pi-67 update
```

If `pi update --extensions` was run manually, repair the pi-67 managed state:

```bash
pi-67 update --repair
```

`pi-67 update --check` reports whether the npm manager is outdated and whether
pi-67 managed npm package baselines are current. Updating the manager itself is
explicit. The latest-version checks read the npm registry HTTP API directly and
do not depend on spawning local `npm` / `npm.cmd`. Explicit npm operations such
as `self-update` still use npm, with Windows fallback through
`cmd.exe /d /s /c npm.cmd ...`:

```bash
pi-67 self-update
```

`pi-67 update` and `pi-67 update --repair` block when the active npm manager is
older than npm latest or older than the local distro version. Update the
manager first, then rerun the normal distro update:

```bash
npm install -g @bigking67/pi-67@latest
pi-67 update
```

For automation, `pi-67 update --check --json` includes explicit `actions`,
`blocked`, and `warnings` arrays. Each action lists planned writes and preserved
paths, so update previews stay auditable instead of relying on prose output.

Long or slow doctor runs can skip Pi's non-interactive package registry probe while still checking
local metadata, config, provider/model, shared skill files, and endpoint
contracts:

```bash
pi-67 doctor --no-pi-list
```

`--no-skill-list` remains a deprecated compatibility alias.

If the local manager may be stale, run the latest npm package for one normal
update without changing the global install:

```bash
npx -y @bigking67/pi-67@latest update
```

Use `npm install -g @bigking67/pi-67` for normal daily operation. Use `npx -y
@bigking67/pi-67@latest ...` when you want a zero-install, always-fresh one-shot
check or repair before trusting the globally installed manager.

The managed distribution includes the local `pi-vision-bridge` extension.
Screenshot/image/OCR tasks under `xtalpi-pi-tools` should route to
`vision_read` first, then optionally `image_review`; if neither tool is
available, Pi returns a local readiness error instead of asking the text-only
xtalpi provider to read PNG/JPG files.

## Optional browser67 lifecycle

browser67 is intentionally excluded from the default pi-67 install. The
first-time user entrypoint is `external install browser67`; it clones the
managed checkout and completes the runnable integration in one lifecycle:

```bash
pi-67 external install browser67 --dry-run
pi-67 external install browser67
pi-67 external doctor browser67 --deep
```

Install prepares Node dependencies and the unpacked extension, synchronizes the
`browser67` and `js-reverse` skills into the configured shared skill root, and
merges the `tmwd_browser` / `js-reverse` entries into `mcp.json` after backing
up an existing file. Add `--start-hub` only when the user wants install to start
the local Hub. Loading the extension in Chrome/Edge, granting OS/browser
permissions, and restarting Pi remain explicit manual steps.

Daily update is also a complete high-level lifecycle:

```bash
pi-67 external update browser67
pi-67 external doctor browser67 --deep
```

Update requires an existing clean checkout, uses `git pull --ff-only`, and
reruns runtime setup only when the checkout changed or deterministic readiness
is incomplete. Automated update setup preserves a valid alternate checkout when
both browser67 MCP servers already point to it. Update never silently installs a
missing repo. Use `pi-67 external setup browser67` only to explicitly rebuild an
already installed runtime and repoint MCP to the managed checkout.

## Safety defaults

`pi-67 update` preserves local runtime choices:

- existing `settings.json`
- existing `models.json`, `auth.json`, `mcp.json`, and `image-gen.json`
- the `theme` value inside `settings.json`
- user-added Pi packages
- user-added global skills
- dirty external repos such as browser67 or design-craft

Before a real `update` or `repair`, the npm manager builds the update plan,
blocks unsafe non-runtime dirty worktrees, and acquires
`~/.pi/pi67/locks/update.lock`. Runtime config backup/restore is delegated to
the Bash or PowerShell updater script only when an in-place checkout needs to
temporarily clear dirty preserved runtime files. The updater fetches first,
compares incoming `HEAD..FETCH_HEAD` changed paths, and creates a runtime
snapshot only when the incoming update touches those dirty preserved files.
Those script-level snapshots live under
`~/.pi/pi67/backups/pre-update-runtime-*`.
This keeps `--help`, blocked update plans, already-up-to-date updates,
non-overlapping incoming updates, and the public `npx -y
@bigking67/pi-67@latest update --repair` orchestration path free of duplicate
manager-owned runtime backups. If a backup is actually needed and an identical
runtime snapshot already exists, the script-level updater reuses it instead of
writing another timestamped directory.

Runtime backups are first-class CLI state:

```bash
pi-67 backups list
pi-67 backups list --include-legacy
pi-67 backups inspect <backup-id-or-path>
pi-67 backups inspect <pre-update-id> --legacy
pi-67 backups restore --from <backup-id-or-path> --dry-run
pi-67 backups restore --from <backup-id-or-path> --yes
pi-67 backups prune --keep-last 10 --dry-run
pi-67 backups archive --keep-last 10 --older-than 30d --dry-run
```

The restore command only restores preserved runtime files and writes a
pre-restore backup before overwriting current local config.

Legacy PowerShell `~/.pi/agent-backups/pre-update-*` directories are read-only
known-conflict snapshots from older migration paths; the normal updater no
longer writes new ones. They are listed only with `--include-legacy` and are
intentionally separate from restorable runtime backups under
`~/.pi/pi67/backups/`.

Theme changes are explicit only:

```bash
pi-67 themes set gruvbox-dark
```

The explicit theme setter also writes a runtime backup before changing
`settings.json`; normal update never changes the selected theme.

The manager writes lightweight state outside the repo at `~/.pi/pi67/state.json`.
It records versions, paths, theme, provider/model, commit information, and
runtime-only UI markers such as `settings.json.lastChangelogVersion` after
migrating them out of tracked config; it does not store API keys.

## Main commands

```bash
pi-67 install
pi-67 update
pi-67 update --check
pi-67 update --repair
pi-67 self-update
pi-67 publish-check
pi-67 manifest
pi-67 manifest --validate
pi-67 extensions doctor
pi-67 extensions inspect xtalpi-pi-tools
pi-67 backups list
pi-67 backups inspect <backup-id-or-path>
pi-67 doctor
pi-67 smoke --quick
pi-67 status
pi-67 report
pi-67 report --json
pi-67 version
pi-67 xtalpi configure --verify
pi-67 xtalpi health
pi-67 xtalpi smoke --quick
pi-67 themes current
pi-67 themes list
pi-67 skills inventory
pi-67 skills packs
pi-67 skills sync
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --dry-run
pi-67 skills sync-pack consumer-brand-commerce-marketing-suite --yes
pi-67 external list
```

`skills packs` reports version, source Commit, vendored integrity, and active
consistency for registered multi-Skill suites. `shared-skill-packs.json`
declares Pack ownership while `shared-skill-packs.lock.json` pins the upstream
Commit and SHA-256 fingerprints used by the distribution.
Normal update preserves different active Skills; `skills sync-pack ... --yes`
is the explicit transactional operation for aligning every Skill in a
registered Pack to the Git-tracked, provenance-locked distribution source.
`staged/previous` directories exist only for one deployment and are removed on
success or failure; no persistent Skill content backup is created. Writing
syncs share `~/.pi/pi67/locks/skills-deploy.lock`, preventing concurrent
mutation of the active root. Dry-runs stay lock-free and dead-process locks
recover automatically. Rollback selects or reverts the desired upstream Git
commit/tag, regenerates the Pack lock, and runs `sync-pack` again; Active Skills
remain reproducible deployment output rather than an independent history store.
`pi-67 status` and `pi-67 update --check --json` include the same compact
`pi67-shared-skill-packs-status/v1` block used by Bash/PowerShell Doctor and
Report. Inconsistent Packs recommend inspection and `sync-pack ... --dry-run`;
the manager never recommends the writing `--yes` form automatically.

`pi-67 version` and `pi-67 status` distinguish the upstream Pi runtime from
the pi-67 manager and distro. Their JSON includes the installed Pi version,
the runtime version tested by the current release, npm `latest` when remote
checks are enabled, and a compatibility classification. `pi-67 doctor` uses
the same tested baseline without a registry request and warns when the local Pi
is older, while preserving upstream Pi as the sole owner of runtime updates,
authentication, and model selection.

If `pi-67 install` reports `agent dir exists but is not a git checkout`, the
target `~/.pi/agent` already exists as a plain folder, usually because Pi or a
manual install created it before pi-67 was installed. pi-67 does not overwrite
that folder silently. Preview the safe takeover:

```bash
pi-67 install --repair --yes --dry-run
```

Then run the repair if the preview is correct:

```bash
pi-67 install --repair --yes
```

The repair moves the existing folder into
`~/.pi/pi67/backups/<timestamp>-non-git-agent-dir/agent` and then clones the
pi-67 Git checkout into `~/.pi/agent`.

## Ownership manifest

`pi-67 manifest` prints the distribution ownership boundary for npm packages,
runtime packages, local extensions, themes, shared skills, external repos, and
local runtime config files. It is read-only and documents what `pi-67 update`
may manage versus what it must only report.

```bash
pi-67 manifest
pi-67 manifest --json
pi-67 manifest --validate
```

`pi-67 update` preserves existing different global skills by default. Use
`pi-67 update --strict-shared-skills` only in CI/release parity checks when a
difference from the bundled `shared-skills/` baseline must block the update.

The manifest also embeds the extension registry from
`src/data/extension-registry.json`. New local providers, theme packages,
shared-skill packs, runtime packages, or external repos must declare owner,
install/update/repair strategy, config patch mode, and smoke gates there before
release. This keeps extension behavior explicit instead of scattering preserve
rules across scripts. Required local extensions currently include
`xtalpi-pi-tools`, `pi-rules-loader`, and `pi-vision-bridge`.
`pi-67 extensions doctor` is the user-facing registry
diagnostic, and `pi-67 extensions inspect <id>` shows the exact owner/update
policy for one entry. `pi-67 manifest --validate`, `pi-67 publish-check`, and
release gates reuse the same registry validator so duplicate ids, missing smoke
gates, unsupported config patch modes, theme-selection drift, shared-skill
overwrite drift, and dirty external-repo update drift fail consistently.

## Publish readiness

`pi-67 publish-check` validates package metadata, npm namespace visibility,
first-publish confirmation, Trusted Publishing workflow drift,
`npm pack --dry-run`, and the ownership manifest release policy. Manifest
checks gate preserved runtime config files, required local extensions,
user-managed baseline packages, theme preservation, shared-skill preservation,
dirty external-repo blocking policy, and extension-registry policy.

Maintainers can verify the npm publish path before using GitHub Actions:

```bash
pi-67 publish-check
pi-67 publish-check --json
```

The check validates version consistency, package metadata, npm scope readiness,
npm pack dry-run, and the Trusted Publishing workflow. Local `npm whoami` is
reported but is not required when publishing through GitHub Actions OIDC.
If it reports that `@bigking67` is missing, create or claim that npm user/org
scope first, or rename the package to a scope/name controlled by the maintainer.
For a package that has never been published, `publish-check --strict` blocks
until the maintainer explicitly passes `--allow-first-publish` after npm scope
and Trusted Publisher setup are complete. The GitHub workflow exposes this as
the `first_publish_confirm` input, which must equal `@bigking67/pi-67`.
