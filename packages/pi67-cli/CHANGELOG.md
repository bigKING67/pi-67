# Changelog

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
