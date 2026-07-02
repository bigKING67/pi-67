# Changelog

All notable changes to pi-67 are documented here.

The format is based on Keep a Changelog, and this project uses semantic versioning for the pi-67 distribution itself. Pi package dependency versions are managed separately in `package.json`.

## [0.10.0] - 2026-07-02

### Added

- `extensions/xtalpi-pi-tools/` as the new xtalpi provider that keeps tool calling local to Pi and sends only plain chat messages to the company proxy.
- `scripts/pi67-xtalpi-pi-tools.sh` stable launcher for `xtalpi-pi-tools/deepseek-v4-pro`.
- `scripts/pi67-test-xtalpi-pi-tools.sh` protocol/unit coverage for parser, serializer, and no-native-tools payload invariants.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` live smoke coverage for no-tool, bash, read, and web/read tasks.
- `docs/xtalpi-pi-tools.md` documenting the local tool protocol, runtime knobs, migration, and validation flow.

### Changed

- Default provider is now `xtalpi-pi-tools` with `deepseek-v4-pro` and thinking off.
- `models.example.json` now keeps only one xtalpi provider template: `xtalpi-pi-tools`.
- `scripts/pi67-configure.sh` migrates old `xtalpi` / `xtalpi-tools` keys and baseUrl into `xtalpi-pi-tools`, then removes old xtalpi provider entries by default.
- `scripts/pi67-update.sh` now runs a no-prompt config migration step after updates, so existing installs converge to `xtalpi-pi-tools` without a separate manual command.
- Release and smoke checks now validate `xtalpi-pi-tools` artifacts and no-native-tools payload invariants.
- `xtalpi-pi-tools` now executes only the selected tools shown to the model and marks tool results as untrusted data to reduce prompt-injection and protocol-boundary confusion.
- `xtalpi-pi-tools` now repairs function-style pseudo tool calls such as `fetch_content({...})`, and live smoke checks require expected tool execution events instead of accepting any final text.
- `xtalpi-pi-tools` now validates tool arguments against a lightweight JSON Schema subset before execution and repairs obvious schema mismatches locally.

### Removed

- Removed old `xtalpi-tools` template path from the canonical configuration.
- Deprecated `xtalpi-compat`, `pi67-xtalpi-safe.sh`, and `xtalpi-tool-smoke.sh` in favor of `xtalpi-pi-tools`.

## [0.9.3] - 2026-07-02

### Added

- `scripts/pi67-xtalpi-safe.sh` as a conservative xtalpi launcher for machines where the company OpenAI-compatible proxy sometimes returns empty assistant content after tool use.
- `XTALPI_EMPTY_ASSISTANT_STRATEGY` with default `rescue_no_tools`, plus optional `hidden_recovery` and `fail_fast` modes.
- Troubleshooting and install documentation for xtalpi empty-assistant recovery and safe-mode startup.

### Changed

- `xtalpi-compat` now hardens recovery turns after an empty assistant response by removing tools, tool choice, reasoning parameters, and streaming options where supported.
- Default xtalpi tool filtering is more conservative: at most 12 tool definitions by default, and tool-result mirrors default to 12000 characters.
- xtalpi debug path expansion now resolves `$HOME` / `~` before writing debug JSONL.

## [0.9.2] - 2026-07-01

### Changed

- Install and update now keep existing different global shared skills in `~/.agents/skills` by default, warning instead of blocking. This prevents pi-67 from downgrading a machine's newer or more authoritative global skill copy.
- `scripts/pi67-doctor.sh` now reports shared-skill baseline differences as WARN by default and supports `--strict-shared-skills` for release/parity checks.

### Added

- `--strict-shared-skills` for `install.sh`, `scripts/pi67-update.sh`, and `scripts/pi67-doctor.sh` to restore blocking behavior when exact pi-67 bundled shared-skill parity is required.

## [0.9.1] - 2026-07-01

### Added

- `scripts/pi67-test-skill-governance.sh` as a dedicated fixture runner for skill migration and external skill sync JSON/schema/conflict coverage.
- `scripts/pi67-check-external-skills.sh` as an optional local dry-run integration check for real external skill repositories before applying syncs into `~/.agents/skills`.
- `scripts/pi67-release-artifact-smoke.sh` to validate a clean worktree/ref/tag artifact through install dry-run, release metadata check, and skill migration schema check.

### Changed

- `scripts/pi67-smoke.sh` now delegates skill governance fixture coverage to the dedicated runner and includes a release artifact smoke pass.
- `scripts/pi67-release-check.sh` now verifies the new governance/artifact check scripts and their documentation are present.

## [0.9.0] - 2026-07-01

### Added

- `scripts/pi67-migrate-skills.sh` for safe dry-run-first migration from legacy active Pi skill roots into the shared `~/.agents/skills` registry.
- `scripts/pi67-sync-external-skills.sh` for copying skills from external source repositories such as `design-craft` and `browser67` into `~/.agents/skills` without making those repositories active Pi package skill roots.
- `docs/skill-migration-schema.md` and `docs/external-skill-sync-schema.md` document the new migration/sync JSON output contracts.
- Smoke coverage for skill migration, external skill sync, and doctor detection of `pi skill list` duplicate/conflict warnings.

### Changed

- `~/.agents/skills` is now the canonical shared active skill registry for Pi and Codex; pi-67 bundled skill source lives in `shared-skills/` and installs into that global root.
- `~/.pi/agent/skills` is treated as a legacy duplicate root and is retired through backup/migration instead of being maintained as an active registry.
- `design-craft` / `browser67` skills are documented as global skill installs rather than active Pi package sources; browser67 MCP source paths stay outside active skill roots.
- Doctor now warns when `pi skill list` reports duplicate/conflict/skipped/`auto (user)` skill-selection messages.

## [0.8.0] - 2026-06-29

### Added

- `scripts/pi67-status.sh` for a read-only installed-state summary covering version, Git state, remote head, report freshness, latest doctor result, and next-command recommendations.
- `docs/doctor-schema.md` documents the stable doctor JSON schema contract.
- `docs/status.md` documents status output, result meanings, JSON schema, and status vs update check-only usage.

### Changed

- `scripts/pi67-doctor.sh --json` now emits schema v2 metadata (`pi67-doctor/v2`) with `generatedAt`, `generatedBy`, distribution version, and diagnostic mode fields while preserving legacy `result` / `counts` / `checks`.
- Smoke and release checks now validate doctor schema v2 and the status workflow documentation.

## [0.7.0] - 2026-06-29

### Added

- `scripts/pi67-update.sh --check-only` for a no-write update readiness preview, including remote head, dirty worktree, local config, npm sync, and report freshness status.
- `docs/report-schema.md` documents the stable `pi67-report.json` schema v2 contract for future UI or automation consumers.

### Changed

- `pi67-report.json` now uses schema v2 with `schemaId`, `generatedBy`, structured `pi67` metadata, and reporter `diagnostics` while keeping legacy `pi67Version` / `packageVersion` aliases.

## [0.6.1] - 2026-06-29

### Fixed

- `scripts/pi67-report.sh` now gives doctor JSON enough time on slower local Pi setups and records timeout diagnostics if doctor still cannot emit valid JSON.

## [0.6.0] - 2026-06-29

### Added

- `scripts/pi67-report.sh` writes `~/.pi/agent/pi67-report.json` after install/update with version, git state, agent file state, runtime versions, and optional doctor JSON.
- `scripts/pi67-release.sh` automates guarded release notes, tag creation, tag push, and GitHub Release creation from `VERSION` and `CHANGELOG.md`.
- Smoke coverage for install/update report generation and release automation dry-run.

### Changed

- Install and update now generate a single current-state report by default; it overwrites `pi67-report.json` instead of appending unbounded history.
- Release automation blocks duplicate same-version tag/release creation by default and only replaces the same current version with explicit `--replace-existing --yes`.

### Fixed

- Release notes temp-file generation now uses a portable temp directory so nested release dry-runs work on macOS.

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
