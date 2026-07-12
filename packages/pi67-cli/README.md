# @bigking67/pi-67

`@bigking67/pi-67` provides the `pi-67` command for installing, updating,
diagnosing, and repairing the pi-67 Pi workspace distribution. It does not
replace the upstream Pi runtime: users start Pi with `pi` and use `pi-67` to
manage the surrounding workspace, extensions, Skills, rules, and provider
configuration.

## Install and run

```bash
npm install -g @earendil-works/pi-coding-agent
npm install -g @bigking67/pi-67
pi-67 install --repair --yes
pi-67 xtalpi configure --verify
pi-67 update
pi-67 doctor
pi --version
pi
```

Windows PowerShell uses the same public commands:

For a completely fresh Windows computer, prefer the checksum-verifiable
single-file bootstrap published with each GitHub Release:

```powershell
$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" -OutFile $Bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap
```

It requests one Administrator/UAC session, repairs missing WinGet, installs and
configures Windows Terminal, PowerShell 7 and Notepad4, persists Git PATH,
installs fnm, and resolves `lts/krypton` to Node.js 24 LTS (minimum full-stack
runtime `>=22.19.0`). Only then does it install the real upstream Pi runtime,
this manager, and the team workspace before running the Windows acceptance
gate. See the
[Windows fresh-install guide](https://github.com/bigKING67/pi-67/blob/main/docs/windows-fresh-install.md).

For machines that already have Node.js and Git:

```powershell
git --version
# pi-67 0.10.19+ auto-detects common Git for Windows install paths when PATH
# is stale. install --repair --yes persists the Git directory into Windows
# User PATH and broadcasts the environment change for newly opened terminals.
# If Git is genuinely not installed:
# winget install --id Git.Git -e --source winget

npm install -g @earendil-works/pi-coding-agent
npm install -g @bigking67/pi-67
pi-67 install --repair --yes
pi-67 xtalpi configure --verify
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

## Configure the company provider

The managed workspace uses `xtalpi-pi-tools + deepseek-v4-pro`. Each user keeps
their own API key only in the ignored local `models.json`:

```bash
pi-67 xtalpi configure --verify
```

The command uses hidden TTY input, never accepts a plaintext `--api-key`
argument, preserves other providers and extra local models, repairs canonical
provider fields, normalizes supported Windows JSON encodings to UTF-8 without
BOM, and runs a real provider-health request with `--verify`.

For non-interactive secret injection, use one of these environment variables
instead of a command-line value:

```text
PI67_XTALPI_PI_TOOLS_API_KEY
PI67_XTALPI_TOOLS_API_KEY
PI67_XTALPI_API_KEY
```

## Important update boundary

`pi update --extensions` is the upstream Pi command. It is not the pi-67
distribution updater.

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
manager first, then rerun the distro repair:

```bash
npm install -g @bigking67/pi-67@latest
pi-67 update --repair --yes
```

For automation, `pi-67 update --check --json` includes explicit `actions`,
`blocked`, and `warnings` arrays. Each action lists planned writes and preserved
paths, so update previews stay auditable instead of relying on prose output.

Long or slow doctor runs can skip Pi's live skill listing while still checking
local metadata, config, provider/model, shared skill files, and endpoint
contracts:

```bash
pi-67 doctor --no-skill-list
```

If the local manager may be stale, run the latest npm package for one repair:

```bash
npx -y @bigking67/pi-67@latest update --repair
```

Use `npm install -g @bigking67/pi-67` for normal daily operation. Use `npx -y
@bigking67/pi-67@latest ...` when you want a zero-install, always-fresh one-shot
check or repair before trusting the globally installed manager.

The managed distribution includes the local `pi-vision-bridge` extension.
Screenshot/image/OCR tasks under `xtalpi-pi-tools` should route to
`vision_read` first, then optionally `image_review`; if neither tool is
available, Pi returns a local readiness error instead of asking the text-only
xtalpi provider to read PNG/JPG files.

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
pi-67 skills sync
pi-67 external list
```

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
