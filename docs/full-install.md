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

Missing API keys, local MCP repositories, or optional binaries are expected on a fresh machine. The installer does not remove those capabilities. Instead, run `pi67-doctor.sh` to see which capabilities are ready and which need local setup.

## Install

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

Install into a custom Pi agent directory:

```bash
./install.sh --agent-dir /path/to/.pi/agent
```

## What the installer does

1. Checks that `pi` exists.
2. Creates `~/.pi/agent` if needed.
3. Backs up overwritten files/directories into `~/.pi/agent/backup-YYYYmmdd-HHMMSS`.
4. Symlinks the full pi-67 asset set into `~/.pi/agent`.
5. Copies `.example` config files only when local config files do not already exist.
6. Installs npm packages into `~/.pi/agent/npm`.
7. Runs `scripts/pi67-doctor.sh`.

The installer is intentionally full-by-default. It does not ask users to choose a minimal profile.

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
| tmwd_browser MCP | Yes | local `tmwd-browser-mcp` path exists |
| js-reverse MCP | Yes | local `tmwd-browser-mcp` path and bridge settings are valid |
| agent_memory MCP | Yes | `agent-memory-mcp` binary exists |
| image generation | Yes | `image-gen.json` has a usable key/base URL |

Run:

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh
```

Doctor warnings are normal on a new machine. They show what needs local setup.

## Updating

Because most assets are symlinked:

```bash
cd /path/to/pi-67
git pull
```

If `package.json` changed:

```bash
cd ~/.pi/agent/npm
npm install --ignore-scripts
```

Then rerun:

```bash
bash ~/.pi/agent/scripts/pi67-doctor.sh
```

## Recovery

Every overwritten non-symlink target is moved into the backup directory printed by the installer.

To manually restore a file:

```bash
cp ~/.pi/agent/backup-YYYYmmdd-HHMMSS/models.json ~/.pi/agent/models.json
```

To restore a directory, remove the current symlink and move the backup back:

```bash
rm ~/.pi/agent/skills
mv ~/.pi/agent/backup-YYYYmmdd-HHMMSS/skills ~/.pi/agent/skills
```

Do not delete backup directories until doctor passes and Pi works as expected.
