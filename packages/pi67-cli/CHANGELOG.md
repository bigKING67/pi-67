# Changelog

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
