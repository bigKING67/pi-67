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

## `defaultProvider` or `defaultModel` fails

Check:

```bash
~/.pi/agent/settings.json
~/.pi/agent/models.json
```

The pair in `settings.json` must exist inside `models.json`:

```json
{
  "defaultProvider": "xtalpi-tools",
  "defaultModel": "deepseek-v4-pro"
}
```

If you do not use xtalpi, change both fields to a provider/model that exists in `models.json`.

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

`pi67-update.sh` defaults to safe fast-forward updates. If the pi-67 checkout has local edits, it stops before pulling:

```text
repo has local changes
```

Recommended fix:

```bash
cd /path/to/pi-67
git status --short
git diff --stat
```

Then either commit or stash your local edits. If you intentionally want to proceed with a dirty checkout:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --allow-dirty
```

To inspect update readiness without pulling or writing files:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --check-only
```

This reports remote head status, dirty worktree state, missing local config templates, npm sync status, and whether `~/.pi/agent/pi67-report.json` is stale.

For a machine that has not received the updater yet:

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
