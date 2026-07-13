# Changelog

## Unreleased

## [0.11.2]

- Adds structured upstream Pi runtime compatibility metadata to `version` and
  `status`, including installed version, release-tested version, npm latest
  lookup, compatibility state, and an explicit update recommendation.
- Makes POSIX and PowerShell doctor report a warning when the installed Pi is
  behind the release-tested runtime instead of passing solely because
  `pi --version` exits successfully.
- Replaces the removed `pi skill list` doctor probe with bounded
  `pi list --no-approve`. Upstream Pi 0.80.6 otherwise interprets `skill list`
  as an interactive user prompt and can accidentally start a real agent turn.
- Adds `external setup browser67` for the complete explicit opt-in integration
  flow and `external doctor browser67 --deep` for deterministic plus live
  readiness diagnostics. Existing MCP files are merged with a backup instead
  of being overwritten.

## [0.11.1]

- Keeps upstream Pi in full control of `/login`, `/model`, authentication
  persistence, selected-model persistence, and next-launch restoration.
- Makes `pi-67 xtalpi configure` optional: blank input or non-interactive use
  without a key exits successfully without writing provider, model, or auth
  state.
- Stops install and update flows from auto-selecting or rewriting the active
  upstream provider/model based on whichever API key happens to be present.
- Allows the managed `xtalpi-pi-tools` provider to register when no API key is
  configured, so bare `pi` can still enter its interactive interface; missing
  credentials affect only requests to that provider.
- Separates Windows Pi startup readiness from optional provider request
  readiness and skips credentialed live checks unless the selected provider
  already has usable credentials.
- Separates credential-gated `--list-models` discovery from a real zero-key
  `session_start` probe for upstream Pi 0.80.6 compatibility on Windows Node
  22 and 24.

## [0.11.0]

- Adds `pi-67 xtalpi configure` with hidden interactive key input, secret
  environment variables, `--dry-run`, `--no-prompt`, `--json`, and `--verify`.
- Repairs the canonical `xtalpi-pi-tools + deepseek-v4-pro` public provider
  contract while preserving unrelated providers, extra local models, and the
  user's existing key.
- Normalizes parseable UTF-16/UTF-8-BOM Windows `models.json` files to UTF-8
  without BOM after creating an encoding backup, and fails closed on malformed
  JSON, non-object roots, and non-string existing API keys.
- Uses rollback-safe replacement when Windows does not allow rename-over an
  existing target, with contract tests that ensure keys never appear in CLI
  stdout or stderr.
- Keeps hidden interactive prompts on stderr so `--json` stdout remains a
  machine-readable document.
- Documents and supports the new Windows fresh-machine bootstrap while
  preserving upstream `pi` as the only standard daily runtime entrypoint.
- Expands that bootstrap into a full workstation contract: missing WinGet
  repair, Windows Terminal/PowerShell 7 default elevated profiles, Notepad4
  system integration, Git persistent PATH, fnm `lts/krypton`, and workstation
  acceptance all complete before upstream Pi and the manager are installed.

## [0.10.29]

- Restores the runtime/manager boundary: daily work starts with upstream `pi`;
  `pi-67` manages the team workspace, configuration, updates, diagnostics, and
  acceptance flow.
- Changes Windows one-command acceptance to validate `pi --version` directly
  instead of using the optional `pi-67 launch` compatibility wrapper as a
  runtime health check.
- Repositions `pi-67 launch` in CLI help and package documentation as an
  optional helper for an already-open Windows terminal with stale PATH state.
- Adds contract tests and Windows Node 22/24 CI coverage against the actual
  upstream Pi npm installation, while retaining a separate compatibility
  check for the launch helper.
- Documents the pi-67 name, 67's maintainer role, and the project's curated
  Windows/macOS team-workspace purpose.

## [0.10.28]

- Fixes Windows `pi-67 launch` for npm/Scoop installations where PowerShell
  invokes `pi.ps1` but Node must fall back from `pi` / `pi.cmd` spawn errors to
  `cmd.exe /d /s /c pi.cmd`.
- Applies the same `EINVAL` / `ENOEXEC` shim fallback contract to `npm`, `npx`,
  and `pi`, while preserving real upstream nonzero exit codes.
- Stops reporting every guarded-launch spawn failure as a missing upstream Pi
  installation and adds a real Windows `pi.cmd` launch integration test.

## [0.10.27]

- Adds the documented Windows one-command acceptance flow, which starts with
  `pi-67 self-update` for the global npm manager and then runs
  `pi-67 update --repair --yes` for the local distribution.
- Adds offline/CI contract coverage for the Windows acceptance entrypoint and
  release gates that keep its manager-update, distribution-update, launch, and
  xtalpi validation sequence synchronized.
- Clarifies that `pi-67 self-update` is the supported wrapper around
  `npm install -g @bigking67/pi-67@latest`, not a separate update channel.

## [0.10.26]

- Adds `pi-67 launch`, a guarded upstream Pi launcher that checks Git, patches a
  discovered Git for Windows directory into the child process PATH, and can
  persist that directory with `--persist-git-path` / global `--yes`.
- Adds Windows `.cmd` fallbacks for spawning `pi` and `npx`.
- Extends `pi-67 xtalpi capability` with `--json-action-runs`,
  `--skip-native-probes`, and `--output-file` forwarding.
- Adds the PowerShell-native `read-enoent-recovery` acceptance case, which
  requires the executed sequence `read,fffind,read`, deterministic
  `ENOENT` ledger evidence, and exactly one local repeated-read recovery.
- Ships the `xtalpi-pi-tools` compatibility protocol v2 runtime, bounded
  transport/recovery policies, tool execution ledger, repeat policy, receipt
  v2, and structured diagnostics/tests with the managed distribution.
- Documents why bare `pi` can fail with `spawn git ENOENT` before pi-67 repair:
  upstream Pi installs git-based packages such as
  `git:github.com/justhil/pi-image-gen`.

## [0.10.25]

- Blocks `pi-67 update` / `pi-67 update --repair` when the active npm manager
  is older than npm latest or older than the local distro version, forcing the
  safer `pi-67 self-update` / `npm install -g @bigking67/pi-67@latest` path
  before stale repair logic can run.
- Shows `registry skipped` managed-package counts in `update --check
  --no-remote`.
- Adds a human-readable manager preflight warning to `pi-67 doctor` while
  preserving JSON doctor output.

## [0.10.24]

- Reports managed npm package baseline drift in `pi-67 update --check` and
  `pi-67 extensions doctor`, so upstream Pi extension update prompts are
  classified before users reach for `pi update --extensions`.
- Updates the pi-67 managed `pi-subagents` baseline to `^0.34.0`.

## [0.10.23]

- Keeps browser67 custom MCP paths in the cleaner machine-local `cwd` plus
  relative `args` form when normalizing or configuring `mcp.json`.
- Clarifies that public templates stay portable, while local ignored
  `mcp.json` files can contain machine-specific paths.

## [0.10.22]

- Normalizes Pi `mcp.json` MCP runtime paths so browser67 / `tmwd_browser`
  stdio servers do not fail when old configs used shell-only `$HOME`
  placeholders in `command` or `args`.
- Adds doctor/smoke/release gates and an explicit `mcp-connect-tmwd-browser`
  targeted smoke for browser67 MCP startup verification.

## [0.10.21]

- Adds xtalpi browser/MCP selected-tool routing so browser67 / Chrome / Edge /
  login-state / screenshot tasks select the `mcp` gateway when it is available,
  while ordinary public-URL summarization still uses fetch/search tools.

## [0.10.20]

- Adds the bundled `pi-vision-bridge` local extension and xtalpi vision-task
  routing so screenshot, image, and OCR tasks are converted into local text
  evidence before reaching the text-only xtalpi provider.

## [0.10.19]

- Broadcasts the Windows environment change after `pi-67 install --repair --yes`
  persists a discovered Git for Windows directory into User PATH. This keeps
  the repair permanent for newly opened PowerShell windows while still avoiding
  Machine PATH writes.

## [0.10.18]

- Persists the discovered Git for Windows directory into Windows User PATH
  during `pi-67 install --repair --yes` when Git is installed but PowerShell
  cannot find `git`. The repair writes only User PATH under explicit `--yes`;
  it does not write Machine PATH or silently install Git.

## [0.10.17]

- Adds Windows Git for Windows auto-discovery. If `git.exe` is installed in a
  common location but PowerShell/npm did not inherit it in `PATH`, `pi-67`
  prepends the discovered Git directory for the current process before running
  clone/update/doctor/smoke flows.
- Shares the same Git path repair in PowerShell helper scripts, covering users
  who run `.\scripts\pi67-update.ps1` or `.\scripts\pi67-smoke.ps1` directly.

## [0.10.16]

- Checks for `git --version` before moving an existing non-Git agent directory
  during `pi-67 install --repair --yes`. Missing Git now fails early with
  install guidance, leaving the original folder untouched.

## [0.10.15]

- Adds a safe non-Git agent directory repair path for first installs:
  `pi-67 install --repair --yes` moves an existing plain `~/.pi/agent` folder
  into `~/.pi/pi67/backups/<timestamp>-non-git-agent-dir/agent`, then clones the
  managed pi-67 checkout. Plain `pi-67 install` still blocks, but now prints the
  exact preview and repair commands.
- Allows empty pre-created agent directories as clone targets.

## [0.10.14]

- Refreshes the Git index stat cache for `settings.json` during
  `update --repair` when Git reports `M settings.json` but `git diff` has no
  real content changes, clearing the remaining Windows false-dirty state after
  line-ending/runtime-state cleanup.

## [0.10.13]

- Normalizes `settings.json` BOM/CRLF line endings during `update --repair`
  even when the runtime `lastChangelogVersion` marker is already absent,
  clearing Windows Git EOL false-dirty states without changing provider,
  model, theme, or other JSON content.

## [0.10.12]

- Pins `settings.json` to LF line endings in `.gitattributes` while preserving
  the runtime clean filter, preventing Windows CRLF false-dirty status after
  update cleanup.

## [0.10.11]

- Runs final settings runtime-marker normalization from the Bash and PowerShell
  updater scripts, covering older global managers that invoke a newer local
  distro updater and any update-time report/smoke side effects.

## [0.10.10]

- Extends the update preflight runtime-marker regression to include the
  PowerShell updater entrypoint used on Windows.

## [0.10.9]

- Runs settings runtime-marker migration before the local distro updater script
  as well as after it, so latest npm manager repair can clean `M settings.json`
  even when the local checkout still contains an older updater script.

## [0.10.8]

- Adds actionable `pi-67 version` recommendations when the npm manager has
  been updated but the local distro checkout is still old or `settings.json`
  still has runtime-marker dirty state.

## [0.10.7]

- Migrates `settings.json.lastChangelogVersion` into ignored manager state at
  `~/.pi/pi67/state.json`, normalizes the runtime-only marker out of
  `settings.json`, and installs a local Git clean filter so future marker
  writes cannot be carried into normal diffs or commits.
- Renames shared-skill drift in human-facing output from "conflicts" to
  "preserved user-modified" while keeping the JSON `conflicts` compatibility
  field.

## [0.10.6]

- Adds runtime request retry to the canonical `xtalpi-pi-tools` provider path,
  including attempt/retry/suppression telemetry in debug JSONL output.
- Adds final-answer compliance repair to Bash and PowerShell xtalpi smoke:
  validated tool runs that only miss required final text get one `--no-tools`
  repair pass instead of rerunning tools.
- Accepts `pi-67 doctor --no-skill-list` and raises doctor skill-list timeout
  defaults to 60 seconds.
- Supports command-level `pi-67 report --json`, emitting either a dry-run JSON
  object or the generated report JSON.
- Runs full `scripts/pi67-smoke.sh --ci` in the npm publish workflow before
  pack/publish.

## [0.10.5]

- Uses `git fetch` plus `git merge --ff-only FETCH_HEAD` in Bash and
  PowerShell updaters, allowing the updater to inspect incoming changed paths
  before deciding whether dirty preserved runtime files need temporary cleanup.
- Keeps dirty runtime config in place without creating a backup when the remote
  is already current or incoming changed paths do not touch those files.
- Reports `preserve-in-place-no-backup` from `pi-67 update --check` when a
  dirty runtime marker is harmless and the remote already matches local HEAD.
- Updates docs to separate current `~/.pi/pi67/backups/` runtime backups from
  legacy read-only `~/.pi/agent-backups/` conflict snapshots.
- Tightens release/smoke gates by checking README version drift, rejecting
  simulated placeholder final answers, and requiring package metadata smoke
  cases to include the real package version.
- Adds `pi-67 xtalpi run` and a Windows PowerShell xtalpi launcher. The stable
  launcher defaults `PI_OBSERVATIONAL_MEMORY_PASSIVE=true` to keep post-final
  observational-memory background writes from holding the main task lifecycle
  open.
- Bounds `pi skill list` in doctor with POSIX
  `--skill-list-timeout-seconds` and PowerShell `-SkillListTimeoutSeconds`.
- Removes legacy `xtalpi-compat` runtime path examples from bootstrap docs.

## [0.10.4]

- Makes all command-level `--help` paths side-effect free, including
  `pi-67 update --help`, with self-tests proving help output does not create
  runtime backup directories.
- Blocks unsafe dirty update plans before the update lifecycle starts, so a
  blocked `pi-67 update` does not first write a runtime backup.
- Adds `pi-67 backups prune` and `pi-67 backups archive` for dry-run-first
  backup retention, with per-kind `--keep-last` semantics.
- Adds `pi-67 skills plan` and `pi-67 skills diff <name>` for explicit
  shared-skill drift review without overwriting existing global skills.
- Adds `pi-67 xtalpi trend`, `pi-67 xtalpi drift`, and `pi-67 xtalpi stress
  --until-done`; drift defaults to full-suite artifacts to avoid targeted smoke
  noise.
- Aligns runtime backup ownership around script-level
  `pre-update-runtime-*` snapshots while the npm manager owns update planning,
  locking, and orchestration.
- Reuses equivalent runtime backups across both `manifest.json` and
  `backup-manifest.json` formats.
- Expands Windows CI coverage to Node 22 and Node 24 plus npm manager CLI
  contract smoke commands.

## [0.10.3]

- Deduplicates real update/repair runtime backups when preserved config files
  are unchanged from the latest same-operation backup.
- Deduplicates direct PowerShell `scripts/pi67-update.ps1` dirty runtime-config
  preservation backups under `~/.pi/pi67/backups/`.
- Removes the legacy PowerShell updater path that wrote new
  `~/.pi/agent-backups/pre-update-*` snapshots; runtime preservation now stays
  under `~/.pi/pi67/backups/`.
- Avoids writing a theme backup when `pi-67 themes set <name>` is already the
  active theme.

## [0.10.2]

- Reads `Manager latest` through the npm registry HTTP API instead of spawning
  local `npm` / `npm.cmd`, fixing Windows environments where command shims fail
  with `spawnSync npm.cmd EINVAL`.
- Adds a final Windows `cmd.exe /d /s /c npm.cmd ...` fallback for explicit npm
  operations such as `pi-67 self-update`.
- Adds read-only visibility for legacy PowerShell
  `~/.pi/agent-backups/pre-update-*` conflict snapshots through
  `pi-67 backups list --include-legacy` and
  `pi-67 backups inspect --legacy <pre-update-id>`.

## [0.10.1]

- Falls back from `npm` to `npm.cmd` on Windows when checking npm registry state
  or running `pi-67 self-update`, avoiding `spawnSync npm ENOENT` in PowerShell
  environments where only the command shim is directly spawnable.
- Clarifies that global install is the normal daily path and `npx @latest` is
  the always-fresh one-shot validation or recovery path.

## [0.10.0]

- Initial npm manager CLI for pi-67.
- Adds cross-platform `pi-67` and `pi67` commands.
- Preserves user configuration and theme choices by default.
- Provides safe update, doctor, smoke, xtalpi, themes, skills, external, status,
  report, extensions, backups, and version entrypoints.
- Reports npm manager update availability during `pi-67 update --check` and
  exposes explicit `pi-67 self-update`.
- Adds `pi-67 publish-check` for npm publish readiness and Trusted Publishing
  workflow validation.
- Adds `pi-67 manifest` for read-only package, extension, theme, shared skill,
  external repo, and preserved runtime config ownership reporting.
- Adds `pi-67 manifest --validate` for standalone extension-registry policy
  validation.
- Adds `pi-67 extensions list/doctor/inspect/plan` for registry-driven
  extension ownership diagnostics without a generic overwrite update path.
- Adds `pi-67 backups list`, `pi-67 backups inspect`, and
  `pi-67 backups restore` for repo-external runtime backup recovery.
- Adds `pi-67 update --strict-shared-skills` forwarding for Bash and Windows
  PowerShell parity checks without changing the default preserve-user-skills
  behavior.
- Adds explicit `actions`, `blocked`, and `warnings` fields to
  `pi-67 update --check --json`, including planned writes, preserved paths,
  strict shared-skill blockers, and dirty external-repo blockers.
- Adds `policy` metadata to `pi-67 update --check --json` and self-tests for
  preserve-first update decisions across dirty runtime config, unsafe dirty
  repo changes, theme assets, shared skills, external repos, and manager
  self-update actions.
- Adds an update lifecycle guard that writes `~/.pi/pi67/locks/update.lock` and
  snapshots preserved runtime files under `~/.pi/pi67/backups/` before real
  update/repair execution.
- Restores backups only through the preserved runtime file allowlist and writes
  a pre-restore backup before replacing current local config.
- Records missing preserved runtime slots in backup manifests, allowing restore
  to remove a preserved file that was absent when the backup was created.
- Makes explicit theme changes safer by backing up runtime config before
  `pi-67 themes set <name>` writes `settings.json`.
- Gates publish readiness on the ownership manifest so package, extension,
  theme, shared-skill, external-repo, and runtime-config policies cannot drift
  silently before npm publish.
- Centralizes extension-registry policy validation in a reusable library with
  self-tests for duplicate ids, missing smoke gates, forbidden behavior,
  unsupported patch modes, theme drift, shared-skill drift, dirty external-repo
  drift, and unregistered managed extensions.
- Gates real publish readiness on npm scope visibility, so a missing package
  namespace fails before the final `npm publish` step with a clear repair path.
