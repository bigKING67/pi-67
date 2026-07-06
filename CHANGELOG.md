# Changelog

All notable changes to pi-67 are documented here.

The format is based on Keep a Changelog, and this project uses semantic versioning for the pi-67 distribution itself. Pi package dependency versions are managed separately in `package.json`.

## [Unreleased]

### Added

- `shared-skills/commerce-growth-os/` as the vendored Pi distribution copy of `https://github.com/bigKING67/commerce-growth-os`, so Pi/Codex can share the commerce growth skill through `~/.agents/skills`.
- `rules/commerce-growth.md` plus Pi rules-loader routing for commerce growth, marketplace operation, assortment, pricing, channel control, ROI/profit, and platform-currentness tasks.
- `scripts/pi67-sync-commerce-growth-os.sh` as a dry-run-first maintainer helper for refreshing the vendored `shared-skills/commerce-growth-os` copy from the standalone upstream checkout.

### Changed

- Pi AGENTS/rules documentation now routes commerce growth work to `commerce-growth-os` without adding local absolute paths or duplicate active package roots.
- External skill sync now supports both root-level `repo/SKILL.md` skill repositories and legacy `repo/skills/*/SKILL.md` layouts, with fixture coverage for root-level discovery, apply, and read-only checks.

## [0.10.0] - 2026-07-02

### Added

- `extensions/xtalpi-pi-tools/` as the new xtalpi provider that keeps tool calling local to Pi and sends only plain chat messages to the company proxy.
- `scripts/pi67-xtalpi-pi-tools.sh` stable launcher for `xtalpi-pi-tools/deepseek-v4-pro`.
- `scripts/pi67-test-xtalpi-pi-tools.sh` protocol/unit coverage for parser, serializer, and no-native-tools payload invariants.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` live smoke coverage for no-tool, bash, read, and web/read tasks.
- `scripts/pi67-smoke.ps1` as a PowerShell-native Windows smoke entrypoint for repo metadata, JSON, Node helper, xtalpi endpoint-contract, documentation, and portability checks.
- `scripts/pi67-update.ps1` as a PowerShell-native Windows updater that preserves local config, syncs npm/shared skills, runs PowerShell smoke, writes `pi67-report.json`, and auto-backs up narrow known xtalpi migration conflicts before pulling.
- `scripts/pi67-doctor.ps1` as a PowerShell-native Windows readiness doctor for local config, npm sync, shared skills, Node engine warnings, and the xtalpi `/chat/completions` endpoint contract.
- `scripts/pi67-report.ps1` as a PowerShell-native report writer that emits `pi67-report/v2` and embeds the PowerShell doctor by default.
- `scripts/pi67-json-utils.cjs` and `scripts/pi67-json-utils.ps1` as shared JSON compatibility helpers for UTF-8 BOM, UTF-16, and leading NUL byte recovery.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh` for summarizing live smoke debug telemetry and recovery events.
- `scripts/pi67-validate-xtalpi-provider-error-contract.mjs` for standalone provider error contract validation.
- `extensions/xtalpi-pi-tools/fixtures/replay-cases.json` for parser/provider replay regression cases.
- `extensions/xtalpi-pi-tools/provider-error-contract.json` as the shared provider error classification and health-retry contract.
- `docs/xtalpi-pi-tools.md` documenting the local tool protocol, runtime knobs, migration, and validation flow.

### Changed

- Default provider is now `xtalpi-pi-tools` with `deepseek-v4-pro` and thinking off.
- Update helpers now run npm sync with `--no-audit --no-fund --prefer-offline` and continue skipping npm entirely when `npm/package.json` already matches the repo `package.json`.
- PowerShell update `-CheckOnly` now reports `pi67-report.json` freshness, and `-NoReport` / `-NoDoctor` allow faster or lower-risk Windows update runs.
- Windows documentation now treats PowerShell as the primary path and stops presenting an extra Unix-like shell as the default Windows entrypoint.
- `models.example.json` now keeps only one xtalpi provider template: `xtalpi-pi-tools`.
- `scripts/pi67-configure.sh` migrates old `xtalpi` / `xtalpi-tools` keys and baseUrl into `xtalpi-pi-tools`, then removes old xtalpi provider entries by default.
- `scripts/pi67-update.sh` now runs a no-prompt config migration step after updates, so existing installs converge to `xtalpi-pi-tools` without a separate manual command.
- Release and smoke checks now validate `xtalpi-pi-tools` artifacts and no-native-tools payload invariants.
- `xtalpi-pi-tools` now executes only the selected tools shown to the model and marks tool results as untrusted data to reduce prompt-injection and protocol-boundary confusion.
- `xtalpi-pi-tools` now repairs function-style pseudo tool calls such as `fetch_content({...})`, and live smoke checks require expected tool execution events instead of accepting any final text.
- `xtalpi-pi-tools` now validates tool arguments against a lightweight JSON Schema subset before execution and repairs obvious schema mismatches locally.
- `xtalpi-pi-tools` debug output now emits a stable redacted JSONL schema, and the live smoke checks validate debug telemetry plus recovery-event summaries.
- Tool metadata, tool-call history, and repair prompts now neutralize local protocol markers before sending text to xtalpi, reducing injection risk from malformed tool descriptions or bad model output.
- `scripts/pi67-test-xtalpi-pi-tools.sh` now replays fixture-backed bad-output cases, so real parser/provider regressions are easier to extend without bloating test code.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` now includes a local bash/read multi-tool case and finishes with thresholded debug-summary gating for the latest smoke run.
- `xtalpi-pi-tools` now accepts the common `<pi_tool_call name="...">{"arg":...}</pi_tool_call>` variant as a local tool call, repairs raw Pi protocol markup leaked into final answers, and the live smoke rejects any remaining raw markup.
- `scripts/pi67-test-xtalpi-pi-tools.sh` now runs smoke/debug-summary self-tests, so tool-boundary and artifact-threshold gates have offline regression coverage.
- `xtalpi-pi-tools` now neutralizes attributed Pi protocol tags inside untrusted tool output, closing a prompt-injection gap around `<pi_tool_call name="...">` variants.
- `xtalpi-pi-tools` now treats incomplete Pi protocol tag fragments as raw markup, so malformed `<pi_tool_call name="...` leaks trigger repair and gate failures instead of passing as final text.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` now writes a stable per-run JSON summary artifact, and debug-summary can target an exact `--run-id` for trend-safe telemetry.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --history N` now reports the newest persisted smoke summary artifacts for trend-safe recovery/raw-markup/failure comparisons.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --compare BASE_RUN HEAD_RUN` now reports run-to-run telemetry deltas and stable case-level protocol differences.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --trend-gate N` now gates recent smoke summaries for hard failures, raw final-answer leaks, empty assistant ends, recovery thresholds, recovery increases, and repeated recovery cases.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --trend-gate N` now fails when fewer than N smoke summary artifacts are available, so a single clean run cannot masquerade as multi-run trend evidence.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --profile full-suite-strict` now applies the full 8-case strict trend-gate contract in one option, reducing operator error from manually repeating long case and threshold arguments.
- `scripts/pi67-release-check.sh` now runs the xtalpi debug-summary self-test, so the strict trend profile fixture gate is part of the release metadata check instead of only the standalone xtalpi test suite.
- Smoke summary artifacts now include `runKind` (`full-suite`, `targeted`, `preflight-failed`, or `empty`), and debug-summary history exposes the classification while backfilling it for older artifacts from case-set and provider-health data.
- `scripts/pi67-report.sh` and `scripts/pi67-status.sh` now expose compact `xtalpiSmoke` history and `full-suite-strict` trend status from local smoke artifacts without running live smoke.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh` now supports `--run-kind` filtering and `--require-run-kind`, and `full-suite-strict` filters to full-suite artifacts before selecting newest N so targeted diagnostic runs no longer pollute full-suite trend evidence.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --drift N` now summarizes provider/model, runKind, case-set, provider-health, quality-signal, runtime-bound, and runtime-fingerprint drift across persisted smoke artifacts; report/status include a compact full-suite drift block without running live smoke.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --trend-gate` now supports optional runtime stability gates via `--require-stable-runtime*` and the `full-suite-runtime-strict` profile.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --retention-report` now produces a read-only artifact hygiene report with keep/archive recommendations for full-suite, targeted, preflight-failed, empty, and quality-signal smoke runs, plus orphan/unknown artifact visibility and isolated `--keep-*` policy options.
- `xtalpi-pi-tools` now serializes prior assistant tool calls as neutral `[previous_pi_tool_call]` records, repairs `[previous_pi_tool_call]` final-answer leaks, and records sanitized raw-response excerpts on repair telemetry to reduce and diagnose protocol-markup recoveries.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` now keeps the web/read live case focused on `web_fetch` plus local `package.json` metadata, reducing large README tool-result latency while preserving cross-tool boundary coverage.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` now runs Pi child processes from `PI_AGENT_DIR`, uses cwd-relative `package.json` prompts, and fails package metadata cases unless `read.path` is exactly `package.json`, avoiding user-specific HOME paths and npm package physical paths in live smoke.
- `scripts/pi67-release-check.sh` now validates the xtalpi endpoint contract so `xtalpi-pi-tools` remains on the OpenAI-compatible `/chat/completions` path instead of drifting to `openai-responses` or `/responses`.
- PowerShell update now backs up and normalizes parseable local JSON config files such as `models.json` from UTF-16, UTF-8 BOM, or leading NUL bytes to UTF-8 without BOM before Pi startup.
- PowerShell doctor and smoke now use the same JSON compatibility path, so Windows encoding drift is reported without printing local API keys.
- `xtalpi-pi-tools` runtime config and provider-health checks now use tolerant JSON decoding for local provider config and contract files.
- Untrusted tool output, tool metadata, and repair excerpts now neutralize `[previous_pi_tool_call]` bracket markers before they are sent back to xtalpi, closing the remaining internal-history marker injection gap.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` now applies explicit smoke request/output bounds (`XTALPI_PI_TOOLS_SMOKE_REQUEST_TIMEOUT_MS`, default `180000`; `XTALPI_PI_TOOLS_SMOKE_MAX_OUTPUT_TOKENS`, default `1024`) and records them in summary artifacts, so provider stalls and over-generation are bounded independently of Pi's global runtime settings.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` now supports targeted live smoke runs with `--case`, `--list-cases`, and `XTALPI_PI_TOOLS_SMOKE_CASES`, while keeping debug-summary gates and summary artifacts scoped to the selected cases.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` now writes per-case lifecycle artifacts and reports `semanticFlowOk`, `processLifecycleOk`, `timedOutAfterAgentEnd`, and post-agent-end linger seconds, so live smoke failures distinguish protocol/semantic regressions from child-process exit or external-runtime stalls.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh` now computes request/response latency telemetry from debug JSONL timestamps, exposing max/avg/count latency and slow request counts in direct summaries plus persisted smoke summary artifacts, with opt-in `--max-request-latency-ms` / `--max-slow-requests` gates for performance-focused audits.
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --history/--trend-gate/--drift` now backfills request-latency telemetry from per-case debug JSONL when older persisted smoke summaries lack those fields.
- `scripts/pi67-report.sh` and `scripts/pi67-status.sh` now preserve compact xtalpi smoke request-latency and slow-request telemetry, so status/report output surfaces performance risk without running live smoke.
- xtalpi debug telemetry now records the protocol version, selected-tool fingerprint, effective runtime bounds, and recovery limits for each turn; debug summary JSON exposes the same fingerprint per case for drift diagnosis.
- xtalpi tool argument validation now covers common JSON Schema bounds for strings, numbers, arrays, and objects before Pi executes a requested tool, with replay coverage for invalid bounded arguments followed by model repair.
- xtalpi provider failures are now classified into structured telemetry codes such as `api_key_missing`, `request_timeout`, `network_error`, `http_401`, `http_429`, `http_5xx`, `non_json_response`, and `malformed_response`; debug summary gates fail on provider errors and report provider error code/category counts.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` now stops remaining cases after the first provider error by default, while still writing a scoped summary artifact; set `XTALPI_PI_TOOLS_SMOKE_STOP_ON_PROVIDER_ERROR=0` for exhaustive failure collection.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh` now runs a bounded provider-health preflight before live cases, writes `<stamp>-provider-health.json`, and records preflight failures in the normal summary/history schema so upstream network/auth/rate-limit failures are diagnosed before the slower Pi tool loop.
- Provider-health preflight now records per-attempt telemetry and retries bounded transient failures by default while suppressing immediate `http_429` retries to avoid burning rate-limit windows.
- Provider runtime and provider-health preflight now read the same provider error contract, so error codes, categories, retryability, and immediate retry policy cannot drift across TS runtime and `.mjs` health checks.
- Provider runtime now constructs local `XtalpiProviderError` instances through a contract-backed helper, removing remaining hardcoded category/retryability fields from chat error paths.
- Release/smoke gates now run standalone provider error contract validation, including error code coverage, category/retryability semantics, immediate retry policy, and HTTP status range ordering.
- The provider error contract validator now has a `--self-test` mode with known-bad contract samples, so release/smoke gates prove both the contract and the validator fail closed on drift.
- `provider-error-contract.json` now carries the required code/category/status/sample manifest, and runtime, provider-health preflight, validator, and TypeScript union tests all read or check that manifest instead of maintaining separate unchecked classification lists.
- Unknown-tool repair regression coverage now proves repair prompts expose only the selected tools shown in the current turn, not every tool present in Pi context.
- Live xtalpi smoke now includes a `tool-result-injection` case that reads hostile tool-output fixture data and gates against raw protocol leakage, missing canary confirmation, or unexpected tool execution.
- xtalpi smoke trend-gate now applies `--expect-cases` to every persisted summary it evaluates, so targeted/subset smoke runs cannot be mistaken for full-suite trend evidence.
- xtalpi smoke debug summary now supports `--expect-case-names` / `--expect-selected-cases`, allowing trend gates to require the exact full smoke case set instead of relying on case count alone.
- xtalpi smoke summaries now include a stable `caseSet` fingerprint, and history/compare output exposes case-set drift for long-running smoke trend audits.
- xtalpi debug telemetry now includes a bounded local-only selected-tool ranking/clipping summary, so low `XTALPI_PI_TOOLS_MAX_TOOLS` runs can explain which tools were omitted without logging tool descriptions, parameters, or prompt text.
- Live xtalpi smoke now includes a low-`maxTools` `tool-selection-clipping` case that puts `read,bash,web_fetch` in context, forces `XTALPI_PI_TOOLS_MAX_TOOLS=1`, requires only selected `read` to execute, and gates clipped/omitted telemetry end to end.
- xtalpi runtime and provider-health diagnostics now redact common credential fields beyond Authorization/API keys, including token, password, cookie/session, and x-api-key shapes.
- xtalpi runtime now short-circuits already-aborted caller signals without sending HTTP requests, classifies mid-flight caller cancellation as `request_aborted`, and keeps timeout coverage active through response body reads.
- xtalpi response body reads now race against the provider timeout controller, with offline regression coverage proving body stalls classify as `request_timeout` instead of hanging.
- xtalpi selected-tool ranking now carries recent user intent across continuation prompts such as "继续" / "continue", while still excluding untrusted tool results from the execution whitelist decision.
- xtalpi debug telemetry and debug summary now expose selected-tool prompt source/count metadata, so continuation-based ranking is diagnosable without logging raw prompt text.
- Live xtalpi smoke now includes a two-turn `tool-selection-continuation` case that uses a temporary session plus low `XTALPI_PI_TOOLS_MAX_TOOLS` to prove `继续` selects the prior user-intended `read` tool and emits `recent_user_continuation` telemetry.
- Live xtalpi smoke now passes the exact selected case names into its immediate debug-summary gate, so same-count case-set drift cannot pass the run-level smoke gate.
- Live xtalpi smoke now fails fast with a clear `PI_BIN` hint when the Pi executable is missing, instead of running provider preflight before an opaque process-launch failure.
- `scripts/pi67-xtalpi-pi-tools-smoke.sh --self-test` now exercises the main smoke runner offline with a fake `pi`, covering `PI_BIN` override, selected-case filtering, summary artifact writing, exact case-name debug-summary gates, and invalid-`PI_BIN` fail-fast behavior.
- Live xtalpi smoke now requires an executable debug-summary helper before running provider preflight or cases, with `XTALPI_PI_TOOLS_SMOKE_DEBUG_SUMMARY_BIN` available for explicit test/runtime overrides.
- Static xtalpi tests now prove future extension tools are discovered from dynamic `context.tools`, serialized into the selected-tool prompt, accepted by the local whitelist, and withheld from repair prompts when omitted.
- xtalpi provider-turn tests now include a dynamic MCP direct-tool shaped regression (`dyn_echo_ping`) proving newly registered runtime tools can be selected, exposed to xtalpi, and returned as local Pi tool calls without exposing the generic `mcp` proxy when clipped.
- xtalpi static tests now add a two-turn dynamic MCP direct-tool round-trip: the first turn returns a `dyn_echo_ping` Pi tool call, a fake Pi runtime returns `DYN_ECHO_PING_SENTINEL`, and the second turn verifies the untrusted tool result reaches the model without native OpenAI `tools` / `role=tool`.
- xtalpi tests now load real `pi-mcp-adapter` source against an isolated temporary `PI_CODING_AGENT_DIR` with fixture `mcp.json` / `mcp-cache.json`, proving an adapter-registered direct tool object can enter the xtalpi selected-tool and provider-turn path without touching user MCP config.
- Release and CI smoke checks now execute the xtalpi extension coverage audit with `pi-rules-loader` included, failing if installed package evidence or dynamic MCP gateway classification drifts.
- PowerShell xtalpi targeted live smoke now covers `read-package`, `fffind-package`, `ffgrep-package`, `batch-web-fetch-example`, and `seq-thinking-status` in addition to MCP/subagent/recall, with cwd-relative path checks and isolated FFF/sequential-thinking state.
- Live xtalpi targeted extension smoke now adds `mcp-status`, `subagent-list`, and `recall-not-found` for low-risk gateway/management/not-found tool paths without moving those tools into the default full-suite gate.
- xtalpi docs now present the Windows PowerShell repo/endpoint contract smoke before Bash-only live smoke commands, and use repo-relative script paths for portability.
- Windows users now have `scripts/pi67-xtalpi-pi-tools-smoke.ps1` for PowerShell-native low-risk xtalpi targeted live smoke without requiring Bash.
- Accidental native `assistant.tool_calls` returned by the upstream compatibility layer are now re-projected into the same local text protocol even when `content` is empty, and malformed native `function.arguments` fail into repair instead of silently executing `{}`.
- xtalpi response usage accounting and assistant-message normalization now live in `response-normalizer.ts`, giving the native tool-call compatibility path a smaller dedicated module with direct unit coverage.
- Repeated-tool detection and object-valued schema `enum` checks now use JSON deep equality that ignores object key order, so argument reordering cannot bypass loop protection or fail valid enum matches.
- Tool argument `pattern` validation now skips overlong or obviously unsafe regex cases, preventing untrusted tool schemas from stalling the local validator through pathological backtracking.
- Skipped or invalid tool argument `pattern` checks now emit bounded debug telemetry and debug-summary counts without recording raw pattern text or argument values.
- Invalid tool JSON repair prompts now list only the tools selected for the current turn, and the web/read live smoke now requires successful `Example Domain` content plus the local `pi-extensions` package name before passing.

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
