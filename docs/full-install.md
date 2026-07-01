# pi-67 Full Install

pi-67 is a full-stack Pi workspace distribution. It is not a minimal starter.

Default installation deploys the complete configuration:

- `AGENTS.md` kernel
- `rules/`
- `prompts/`
- `skills/`
- `extensions/`
- `docs/`
- `templates/`
- `scripts/`
- `settings.json`
- local config templates for `models.json`, `mcp.json`, `auth.json`, and `image-gen.json`
- npm packages listed in `package.json`
- pinned external Pi skill packages from `design-craft` and `browser67`

Missing API keys, local MCP repositories, or optional binaries are expected on a fresh machine. The installer does not remove those capabilities. Instead, run `pi67-doctor.sh` to see which capabilities are ready and which need local setup.

## Install

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

## What the installer does

1. Checks that `pi` exists.
2. Creates `~/.pi/agent` if needed.
3. Detects install mode:
   - `in-place`: repository root and agent dir are the same path.
   - `linked`: repository root is outside the agent dir.
4. In `in-place`, verifies tracked assets in the current checkout. In `linked`, backs up overwritten files/directories and symlinks the full pi-67 asset set into `~/.pi/agent`.
5. Copies `.example` config files only when local config files do not already exist.
6. Installs npm packages into `~/.pi/agent/npm`.
7. Runs `scripts/pi67-doctor.sh`.
8. Writes `~/.pi/agent/pi67-report.json`.

The installer is intentionally full-by-default. It does not ask users to choose a minimal profile.

## External skill packages

pi-67 keeps only pi-67-owned skills in `skills/`. Productized external skills are installed as Pi packages from their own source repositories:

```text
git:github.com/bigKING67/design-craft@ae3f27e79893bf8a63fcfb6431842b557be7b46a
git:github.com/bigKING67/browser67@e6b4c1071a6488d84f83db9984c0d986e3105f71
```

Expected package clone locations after Pi installs them:

```text
~/.pi/agent/git/github.com/bigKING67/design-craft
~/.pi/agent/git/github.com/bigKING67/browser67
```

`~/.pi/agent/git/` is ignored runtime state. Do not copy package-owned skills back into `pi-67/skills`; upgrade them by changing the pinned package source after the upstream repo is committed and pushed.

## Install/update report

Every install or update writes:

```text
~/.pi/agent/pi67-report.json
```

This is a single current-state file. It is overwritten atomically on each install/update and does not append historical entries, so normal usage does not create unbounded report files.

The report includes:

- pi-67 version and package version
- repository branch, commit, dirty state, and origin URL
- external Pi package declaration/install state
- agent directory file states
- runtime versions for Node/npm/Pi
- doctor JSON result, unless doctor was skipped

The machine-readable field contract is documented in `docs/report-schema.md`. Current reports use schema `pi67-report/v2`. Embedded doctor JSON is documented in `docs/doctor-schema.md`.

Use `--no-report` on install/update if you do not want the report file.

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

Fill API keys and local paths after installation. Existing local config files are preserved.

## Configure local readiness

Use `pi67-configure.sh` after installation to safely turn copied templates into usable local config:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets
```

The helper:

1. Creates missing local config files from repo examples.
2. Writes API keys through hidden prompts or env vars.
3. Updates `tmwd_browser`, `js-reverse`, and `agent_memory` MCP paths.
4. Optionally switches `settings.defaultProvider` / `settings.defaultModel`.
5. Runs doctor after writing unless `--no-doctor` is passed.

Non-interactive example:

```bash
PI67_XTALPI_API_KEY="..." \
PI67_CODEX_API_KEY="..." \
PI67_DEEPSEEK_API_KEY="..." \
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

To switch provider/model:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --provider codex --model gpt-5.4 --prompt-secrets
```

In linked mode, `settings.json` is symlinked by default so updates from pi-67 continue to apply. If you request a provider/model change that differs from the repository default, the configure helper detaches `settings.json` into a local file before writing, so personal defaults do not dirty the repo. In in-place mode, `settings.json` is tracked by the current checkout; keep personal secrets and machine paths in the ignored local config files instead.

## Readiness levels

pi-67 distinguishes between installed and ready:

| Capability | Installed by default | Ready when |
| --- | --- | --- |
| AGENTS kernel | Yes | `~/.pi/agent/AGENTS.md` points to the repo |
| Rules | Yes | 8 rule files exist and `pi-rules-loader` is installed |
| Prompts | Yes | Prompt files exist and do not use legacy double-brace placeholders |
| Skills | Yes | `pi skill list` succeeds |
| xtalpi provider | Yes | `models.json` has a real xtalpi API key |
| Codex provider | Yes | local Codex proxy and API key are configured |
| tmwd_browser MCP | Yes | browser67 package clone or local browser67 checkout path exists |
| js-reverse MCP | Yes | browser67 package clone or local browser67 checkout path and bridge settings are valid |
| agent_memory MCP | Yes | `agent-memory-mcp` binary exists |
| image generation | Yes | `image-gen.json` has a usable key/base URL |

Run:

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh
```

Doctor warnings are normal on a new machine. They show what needs local setup.

Automation-friendly doctor modes:

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh --quiet
bash ~/.pi/agent/scripts/pi67-doctor.sh --json
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

## Updating

If your installed pi-67 already includes the updater:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh
```

For an in-place checkout, this is equivalent to:

```bash
git -C ~/.pi/agent pull --ff-only
```

The updater:

1. Runs `git pull --ff-only` in the pi-67 checkout.
2. Keeps local runtime config files.
3. Creates newly introduced local config files from `.example` templates only when missing.
4. Syncs npm dependencies when `package.json` differs from `~/.pi/agent/npm/package.json`.
5. Runs doctor after the update.
6. Overwrites `~/.pi/agent/pi67-report.json`.

For an older install that does not have `pi67-update.sh` yet:

```bash
cd /path/to/pi-67
git pull --ff-only
bash scripts/pi67-update.sh
```

Preview without changing files:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --dry-run
```

Check update readiness without pulling, running doctor, or writing files:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --check-only
```

`--check-only` reports the local commit/version, remote branch head, dirty worktree state, local config template gaps, npm sync status, and whether `pi67-report.json` is stale.

For a shorter daily health summary, use:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
```

If the checkout has local edits, the updater stops by default. Commit or stash them first. If you intentionally want to proceed:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --allow-dirty
```

## Smoke test

For repository maintenance and CI:

```bash
bash scripts/pi67-smoke.sh
```

The smoke test does not touch the real `~/.pi/agent`. It creates a temporary agent directory, installs the full asset set there with a fake `pi` binary, and runs doctor against that temp install.

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
