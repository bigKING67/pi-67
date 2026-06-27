# Changelog

All notable changes to pi-67 are documented here.

The format is based on Keep a Changelog, and this project uses semantic versioning for the pi-67 distribution itself. Pi package dependency versions are managed separately in `package.json`.

## [0.5.0] - 2026-06-28

### Added

- `scripts/pi67-doctor.sh --deep-mcp` for optional MCP server startup probing via JSON-RPC `initialize` and `tools/list`.
- `scripts/pi67-doctor.sh --mcp-timeout-ms` to tune per-server deep probe timeouts.
- Smoke coverage for a fake stdio MCP server deep probe.

## [0.4.0] - 2026-06-28

### Added

- `scripts/pi67-doctor.sh --json` for machine-readable readiness output with counts, final result, and individual checks.
- `scripts/pi67-doctor.sh --quiet` for summary-only human output.
- Smoke coverage for doctor quiet and JSON output modes.

## [0.3.0] - 2026-06-27

### Added

- `scripts/pi67-update.sh` for safe existing-install updates: fast-forward pull, local config template sync, npm dependency sync, and doctor verification.
- Documented first update path for older installs and the one-command update path once the updater is installed.
- Smoke coverage for updater dry-run and no-op update flows.

### Changed

- Release metadata and package version now identify pi-67 distribution version `0.3.0`.

## [0.2.0] - 2026-06-27

### Added

- Full installer workflow with backup, symlink install, local config template creation, optional npm install, and post-install doctor.
- `scripts/pi67-doctor.sh` readiness diagnostics for full assets, rules, prompts, JSON config, provider/model consistency, MCP paths, Pi runtime, and repo hygiene.
- `scripts/pi67-configure.sh` local configuration helper for provider keys, MCP paths, image generation config, and optional provider/model override.
- `scripts/pi67-smoke.sh` repository smoke test covering temporary full install, doctor, configure, restore, and uninstall lifecycle without touching the real `~/.pi/agent`.
- `scripts/pi67-restore.sh` and `scripts/pi67-uninstall.sh` for safe recovery and removal of pi-67-owned symlinks.
- GitHub Actions CI workflow for smoke checks on push and pull request.
- Externalized Pi rules and `pi-rules-loader` integration.

### Changed

- Default distribution philosophy is now explicit: full install by default, with doctor-driven readiness warnings instead of feature pruning.
- Prompt templates use Pi-native `$1`, `$ARGUMENTS`, and `${...}` placeholders instead of legacy double-brace syntax.
- Documentation now covers full install, configuration, troubleshooting, lifecycle operations, and release maintenance.
- GitHub Actions workflow now uses current action majors to avoid deprecated Node runtime warnings.

### Fixed

- Doctor secret scan now works without `rg` by falling back to `grep`.
- Doctor accepts local `settings.json` when `pi67-configure.sh` detaches it for a user-specific provider/model override.

## [0.1.0] - 2026-06-26

### Added

- Initial public pi-67 configuration repository.
- Core Pi config templates, `AGENTS.md`, extensions, skills, docs, prompts, scripts, and scraper templates.
