# pi-67 Troubleshooting

Use `scripts/pi67-doctor.sh` first. It separates blocking failures from normal readiness warnings.

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh
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
tmwd-browser-mcp repo
agent-memory-mcp binary
local Codex proxy if using the codex provider
```

Do not delete the MCP entries just because doctor warns. pi-67 intentionally installs the full best-practice configuration; doctor tells you which capabilities still need local setup.

Use the configure helper to set the common local paths:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh \
  --no-prompt \
  --tmwd-repo "$HOME/Documents/sixseven/codeproject/tmwd-browser-mcp" \
  --agent-memory-bin "$HOME/.local/bin/agent-memory-mcp"
```

Preview first if you are unsure:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --dry-run --no-prompt
```

## `pi skill list` fails

Run it manually for the detailed error:

```bash
pi skill list
```

Then check:

```text
~/.pi/agent/skills
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

## Repository smoke test

Before committing installer, doctor, docs, prompts, or rules changes:

```bash
bash scripts/pi67-smoke.sh
```

Smoke creates a temporary Pi agent directory and validates the full install flow without touching your real `~/.pi/agent`.

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
