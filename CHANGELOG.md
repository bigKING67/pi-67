# Changelog

All notable changes to pi-67 are documented here.

The format is based on Keep a Changelog, and this project uses semantic versioning for the pi-67 distribution itself. Pi package dependency versions are managed separately in `package.json`.

## [Unreleased]

## [0.11.4] - 2026-07-14

### Added

- Added a state-scoped `pi67.skill-deploy-lock.v1` guard so concurrent writers
  cannot mutate the same Active Skill root. Dry-runs remain lock-free;
  dead-process locks recover automatically and release verifies an owner token.
- Changed managed Skill deployment to treat the Git-tracked Pack as the only
  content source of truth. Sync uses transient staged/previous transaction
  directories, removes stale transaction residue, and creates no persistent
  Skill content backups; rollback is Git commit/tag selection followed by sync.
- Added versioned shared Skill Pack governance for the eight-Skill Consumer
  Brand Commerce and Marketing suite, including `pi-67 skills packs` and
  explicit transactional `pi-67 skills sync-pack <pack> --yes` deployments.
- Added a shared `pi67-shared-skill-packs-status/v1` diagnostic contract across
  status, update plans, Bash/PowerShell Doctor, and Report, with non-writing
  remediation previews and strict-mode Pack parity gates.
- Added `shared-skill-packs.lock.json` provenance governance with a clean-source
  Git requirement, locked upstream Commit, Manifest and Pack SHA-256 values,
  per-Skill fingerprints, and blocking vendored-integrity diagnostics.

### Fixed

- Fixed release artifact smoke checkout detection so linked Git Worktrees are
  accepted instead of being rejected because their `.git` marker is a file.
- Isolated the updater smoke fixture behind its own temporary branch and bare
  remote so release checks remain deterministic from detached Worktrees.
- Materialized linked runtime state before the DeepSeek smoke mutation so test
  writes cannot follow symlinks back into the source checkout.

## [0.11.3] - 2026-07-13

### Fixed

- Made the published npm manager artifact self-contained by removing the
  browser67 runtime dependency on a repository-root script that is not shipped
  inside `@bigking67/pi-67`.
- Added a packed-artifact regression gate that installs the generated tarball
  in an isolated directory and executes `pi-67 external --help`, preventing
  source-worktree checks from masking missing npm package files.

## [0.11.2] - 2026-07-13

### Added

- Added a release-tested upstream Pi runtime baseline to the distro manifest.
  `pi-67 version`, `pi-67 status`, and both doctor implementations now report
  installed, tested, and available runtime version state instead of treating
  any successful `pi --version` response as fully current.
- Added `pi-67 external setup browser67`, which turns the optional browser67
  companion checkout into a runnable integration by installing dependencies,
  preparing the unpacked extension, synchronizing active skills, and safely
  merging MCP paths. `--start-hub` remains explicit.
- Added `pi-67 external doctor browser67 --deep` with separate deterministic
  checkout/config checks and a live Hub/extension readiness probe.

### Fixed

- Doctor now warns when the installed upstream Pi runtime is older than the
  version exercised by the current pi-67 release, preventing a stale runtime
  from producing an otherwise false-green readiness result.
- Replaced the obsolete `pi skill list` doctor probe with the non-interactive
  `pi list --no-approve` package registry command required by upstream Pi
  0.80.6, preventing doctor from accidentally starting an interactive model
  request.
- Isolated smoke logs per process and moved filename extensions before the
  trailing `mktemp` template, so concurrent macOS smoke/release checks no
  longer race on shared files or fail with spurious `ENOENT` errors.

## [0.11.1] - 2026-07-12

### Changed

- Restored upstream Pi ownership of `/login`, `/model`, authentication
  persistence, selected-model persistence, and next-launch restoration.
- Windows acceptance now reports Pi startup readiness separately from optional
  model-request readiness. Provider-specific live checks run only when the
  currently selected provider already has usable credentials.
- Windows Node 22/24 CI now verifies `xtalpi-pi-tools` model registration with
  a non-secret discovery-only fixture, then independently proves that real Pi
  reaches `session_start` with no provider credentials. This matches upstream
  Pi 0.80.6, which hides credential-gated models from `--list-models`.
- `pi-67 xtalpi configure --verify` remains an optional company-provider
  convenience. Blank input or `--no-prompt` without a key succeeds without
  writing provider/model state.
- Install and update flows no longer auto-select, reconcile, or rewrite the
  upstream Pi provider/model selection based on available keys.

### Fixed

- Fixed `xtalpi-pi-tools` provider registration so upstream Pi can enter its
  interactive interface without any configured API key.
- Missing credentials now affect only the corresponding model request; they no
  longer fail bootstrap, doctor, smoke, or Windows startup acceptance gates.

## [0.11.0] - 2026-07-12

### Added

- Added `scripts/pi67-bootstrap.ps1`, a Windows PowerShell 5.1+-compatible
  fresh-machine bootstrap that repairs missing WinGet, installs/configures
  Windows Terminal, PowerShell 7 and Notepad4, persists Git PATH, provisions
  fnm + Node.js 24 LTS, and only then installs the real upstream Pi runtime,
  the pi-67 manager, the managed workspace, the company provider, and the
  complete Windows acceptance flow from one downloaded file.
- Added `pi-67 xtalpi configure` with hidden key input, environment-secret
  injection, dry-run/JSON modes, canonical provider repair, Windows JSON
  encoding normalization, idempotent writes, and optional live provider-health
  verification.
- Added `docs/windows-fresh-install.md` with the supported beginner flow,
  checksum verification, Node-manager policy, result semantics, logs, and
  separated npm/GitHub/xtalpi/proxy troubleshooting.
- GitHub Releases now upload `pi67-bootstrap.ps1` and
  `pi67-bootstrap.ps1.sha256` so the documented `releases/latest/download/...`
  URL remains stable and auditable.

### Changed

- New Windows installations use `Schniz.fnm` with `lts/krypton`, persist the
  official PowerShell initialization block, set the fnm default, and enforce
  both Node.js major 24 and the complete upstream runtime minimum of
  `>=22.19.0`.
- Full-mode Windows bootstrap now treats Windows Terminal, PowerShell 7 and
  Notepad4 as explicit workstation stages: Terminal defaults to PowerShell 7,
  both PowerShell profiles use `elevate=true` by default, and Notepad4 receives
  verified Explorer/notepad.exe registry integration. `-Minimal` remains the
  explicit opt-out for these desktop stages.
- A normal bootstrap now performs one UAC Administrator relaunch, while
  `-SelfTest` and `-DryRun` remain non-elevating and offline/read-only.
- Windows Node 22/24 CI, PowerShell smoke, release-check, and release artifact
  smoke now cover the bootstrap self-test and a fresh isolated
  `xtalpi configure --dry-run --no-prompt --json` contract.
- Fresh-install documentation now leads with the one-file bootstrap while
  keeping `pi` as the only standard daily runtime entrypoint.
- Windows download snippets use `Invoke-WebRequest -UseBasicParsing` for
  Windows PowerShell 5.1 compatibility, and the GitHub Release command now
  requires the exact npm manager version and the npm `latest` dist-tag to agree
  before exposing the bootstrap asset. Actual release notes and bootstrap
  assets are sourced from committed `HEAD`, even when unrelated dirty runtime
  state is explicitly allowed.

### Fixed

- Provider configuration now preserves unrelated providers and extra local
  models while repairing drifted public `xtalpi-pi-tools` fields from the
  canonical template instead of directing users to a repair path that might
  leave the drift unchanged.
- Safe `models.json` replacement now handles Windows rename-over-existing
  behavior with a rollback file, restores the previous target on failure, and
  never deletes the old config before the replacement is ready.
- Bootstrap completion no longer claims a full pass when the personal xtalpi
  key was intentionally skipped; it reports `READY_WITHOUT_XTALPI` until the
  provider is configured and verified.
- `xtalpi configure` now rejects valid JSON with a non-object root or a
  non-string existing API key without rewriting the file, and hidden prompts
  use stderr so interactive `--json` keeps stdout machine-readable.
- Common `xtalpi configure` failures now return concise CLI errors instead of a
  Node stack trace, and secret-bearing atomic temp/rollback files are ignored if
  a process is interrupted before cleanup.
- Fresh-machine setup no longer installs standalone `OpenJS.NodeJS.LTS`, no
  longer treats missing WinGet as a manual-only blocker, and no longer reports
  Terminal/PowerShell installation failures as optional warnings in full mode.

## [0.10.29] - 2026-07-10

### Changed

- Restored the product boundary between upstream Pi and pi-67: `pi` is the
  standard runtime and daily entrypoint, while `pi-67` installs, configures,
  updates, diagnoses, and validates the surrounding team workspace.
- Windows one-command acceptance now uses the real `pi --version` command as
  its runtime hard gate. The optional `pi-67 launch` compatibility helper is
  no longer treated as proof that upstream Pi is installed or usable.
- Repositioned `pi-67 launch` in CLI help and installation/troubleshooting
  documentation as a temporary PATH helper for an already-open Windows
  terminal, not as the normal startup path.
- Documented why the project is named pi-67, how it grew from 67's long-term
  Pi usage and company Agent tooling responsibilities, and why it remains a
  curated Windows/macOS team distribution rather than a generic starter.

### Fixed

- Windows Node 22/24 CI now installs the real upstream Pi npm package and runs
  bare `pi --version`. The separate launch-helper compatibility check also
  targets that installed runtime instead of a temporary fake `pi.cmd`.
- Release gates now reject a Windows acceptance contract that substitutes
  `pi-67 launch` for the real Pi runtime check.

## [0.10.28] - 2026-07-10

### Fixed

- Fixed Windows guarded launch when upstream Pi is installed through npm or
  Scoop and PowerShell resolves `pi.ps1`, but Node must execute `pi.cmd`.
  `npm`, `npx`, and `pi` now continue through the `cmd.exe /d /s /c *.cmd`
  fallback after Windows `EINVAL` / `ENOEXEC` spawn failures.
- `pi-67 launch` now checks whether upstream Pi exists before launching it and
  no longer converts every child-process spawn failure into the misleading
  `upstream pi command was not found` error.

### Changed

- Windows one-command acceptance now explains that update stages were skipped
  because `-SkipUpdate` was requested, prints a bounded failed-stage output
  tail alongside the full log path, and gives launch recovery guidance that
  distinguishes a working bare `pi` from a manager-launch defect.
- Windows CI now executes `pi-67 launch` against a real temporary `pi.cmd`
  shim instead of checking only the fallback candidate list.

## [0.10.27] - 2026-07-10

### Added

- Added `scripts/pi67-windows-acceptance.ps1`, a single Windows update-and-
  acceptance entrypoint that updates the npm manager and local distribution,
  then validates version/configuration, doctor, repository smoke, guarded
  launch, xtalpi health/capability, and the targeted `read-package` /
  `read-enoent-recovery` live tool chain.
- Added `-SkipUpdate` for validating the current installation without network
  updates and `-SelfTest` for deterministic offline Windows/CI contract
  validation.

### Changed

- Added the Windows acceptance self-test to GitHub Actions and the release
  gates so the one-command path cannot drift without detection.
- Updated installation, release, and troubleshooting documentation to
  distinguish npm manager self-update, local distribution update, upstream Pi
  package update, and guarded launch.

## [0.10.26] - 2026-07-10

### Added

- Added `pi-67 launch`, a guarded upstream Pi launcher that checks Git before
  starting `pi`, patches a discovered Git for Windows directory into the child
  process PATH, and can persist that directory into Windows User PATH with
  `--persist-git-path` / global `--yes`.
- Added the `xtalpi-pi-tools` compatibility protocol v2 runtime with explicit
  `legacy` / `shadow` / `v2` engines, reliability-oriented policy profiles,
  canonical SHA-256 tool-call fingerprints, strictly paired call/result
  receipts, and bounded recovery budgets.
- Added focused `config/`, `protocol/`, `tools/`, `transport/`, and `turn/`
  modules plus unit, transport, state-machine, integration, and replay tests so
  the provider no longer concentrates protocol behavior in one parser file.
- Added Windows PowerShell `read-enoent-recovery` live coverage and capability
  CLI forwarding for `--json-action-runs`, `--skip-native-probes`, and
  `--output-file`.

### Fixed

- Windows first-run docs now avoid launching bare `pi` before
  `pi-67 install --repair --yes`; upstream Pi installs git-based packages such
  as `git:github.com/justhil/pi-image-gen`, so a stale PowerShell PATH could
  otherwise crash with `spawn git ENOENT`.
- The pi-67 command runner now has Windows `.cmd` fallbacks for `pi` and `npx`,
  matching the existing npm fallback behavior.
- A deterministic tool failure such as `read` returning `ENOENT` no longer
  permits the same fingerprint to execute again. The local runtime emits one
  bounded `recovery.repeated_tool`, promotes path-discovery tools such as
  `fffind`, and continues to a final answer instead of abandoning the task.
- HTTP attempts, response-body reads, retry delays, and recovery loops now share
  explicit per-attempt and total request deadlines, preventing the previous
  `attempts x full timeout` worst-case latency path.
- Tool selection now incorporates recent failure context while keeping
  transient replay limited to explicitly read-only idempotent tools; shell,
  edit, write, and unknown-side-effect calls are never automatically replayed.

## [0.10.25] - 2026-07-09

### Changed

- `pi-67 update` / `pi-67 update --repair` now block when the active npm
  manager is older than npm latest or older than the local distro version, so
  users update the manager before running stale update/repair logic.
- `pi-67 update --check --no-remote` now reports registry-skipped managed
  packages explicitly instead of showing an ambiguous zero-current summary.
- `pi-67 doctor` now emits a human-readable manager preflight warning when the
  active npm manager is stale, without changing JSON doctor output.

### Fixed

- Hardened `xtalpi-pi-tools` browser67 routing for Chinese prompts such as
  "打开浏览器～browser67" and "用 Chrome 打开..." where the browser marker may use
  Chinese punctuation or appear before the action verb, so the `mcp` gateway is
  selected instead of `bash` / `web_fetch`.
- Browser67 / `tmwd_browser` tasks now fail closed or repair when the model
  tries to use `bash` with macOS `open`, `open -a "Google Chrome"`, `xdg-open`,
  `start`, `python -m webbrowser`, normal browser-app launches, or local
  `browser67` CLI probes as a
  substitute for Pi's MCP gateway.
- Retry-style follow-ups such as "再试一下" now reuse recent user context for
  tool selection, preventing a second browser attempt from losing the original
  Chrome/browser67 intent.

## [0.10.24] - 2026-07-09

### Changed

- Updated the managed `pi-subagents` baseline to `^0.34.0`, matching the
  current npm release so Pi no longer keeps asking users to run the upstream
  `pi update --extensions` path after a normal `pi-67 update --repair`.

### Added

- Added managed npm package baseline auditing to `pi-67 update --check` and
  `pi-67 extensions doctor`, distinguishing local install drift from
  pi-67-release baseline drift before users see a generic Pi package-update
  prompt.

## [0.10.23] - 2026-07-09

### Changed

- `pi67-configure.sh` and the MCP config normalizer now write browser67 custom
  checkout paths as machine-local `cwd` plus relative `args` instead of copying
  the full browser67 path into each MCP entrypoint argument.
- Clarified MCP path documentation so public templates stay portable while
  local ignored `mcp.json` files may contain machine-specific paths.

## [0.10.22] - 2026-07-09

### Added

- Added `scripts/pi67-mcp-config-utils.cjs` to normalize and inspect Pi
  `mcp.json` runtime paths using the same no-shell-expansion rules as
  `pi-mcp-adapter`.
- Added a targeted `mcp-connect-tmwd-browser` smoke case for verifying that Pi
  can start the browser67 `tmwd_browser` MCP server, not just inspect gateway
  status.

### Fixed

- Fixed browser67 / `tmwd_browser` MCP startup failures when Pi `mcp.json`
  used shell-only `$HOME` / home placeholders inside stdio `command` or `args`;
  install, configure, update, doctor, smoke, and release gates now normalize or
  report adapter-incompatible paths.
- `pi67-doctor.sh --deep-mcp` now matches `pi-mcp-adapter` runtime behavior
  instead of expanding `$HOME` itself, so bad MCP args fail the diagnostic
  instead of producing a false pass.
- Fresh installs and Windows PowerShell updates now run MCP path normalization
  for local config, while preserving user-owned runtime files.

## [0.10.21] - 2026-07-09

### Added

- Added `xtalpi-pi-tools` browser/MCP selected-tool routing so browser67,
  Chrome, Edge, current-tab, login-state, click/type, upload/download,
  screenshot, DevTools, DOM, and network-inspection tasks select the `mcp`
  gateway when available, even with a low `XTALPI_PI_TOOLS_MAX_TOOLS`.
- Added documentation and release/smoke tracked-file gates for the new
  browser bridge.

### Fixed

- Browser tasks no longer fail with `xtalpi-pi-tools 请求了不可用工具：mcp`
  when `mcp` exists in the runtime tool list but was previously omitted from
  the selected-tool allowlist.
- Ordinary public-URL summarization remains routed to `web_fetch` /
  `web_search`, avoiding unnecessary browser67 activation.

## [0.10.20] - 2026-07-09

### Added

- Added the bundled `pi-vision-bridge` local extension and `vision_read` tool
  so screenshot, image, and OCR tasks are routed through a local multimodal
  bridge before `xtalpi-pi-tools` hands ordinary text evidence to xtalpi.
- Added xtalpi vision-task detection, image-path `read` de-prioritization,
  vision bridge readiness fail-closed behavior, model-output repair prompts,
  doctor checks, smoke-plan metadata, coverage audit rules, and release gates
  for `vision_read`.

### Fixed

- `xtalpi-pi-tools` no longer treats Pi's accepted Plan mode continuation
  wrapper (`Plan mode is now disabled... Implement this proposed plan now`) as
  active Plan mode, and smoke gates now cover that continuation path.

## [0.10.19] - 2026-07-09

### Fixed

- Windows Git PATH repair now broadcasts the Windows environment change after
  `pi-67 install --repair --yes` writes the discovered Git directory into User
  PATH, improving the "new terminal can run git" behavior while preserving the
  safe User-PATH-only boundary.

## [0.10.18] - 2026-07-09

### Fixed

- `pi-67 install --repair --yes` now persists a discovered Git for Windows
  directory into Windows User PATH when Git is installed but the current
  PowerShell session cannot find `git`. The installer still patches the current
  process PATH first, writes only User PATH under explicit `--yes`, and does
  not silently modify Machine PATH or install Git.

## [0.10.17] - 2026-07-09

### Fixed

- Windows Git discovery is now self-healing for common Git for Windows
  installs. If `git.exe` exists in standard install locations but PowerShell
  has not picked it up in `PATH`, `pi-67` prepends that Git directory for the
  current process before clone/update/doctor/smoke commands run.
- PowerShell helper scripts now use the same Git discovery path, so direct
  `.\scripts\pi67-update.ps1`, `doctor`, `smoke`, and report flows no longer
  fail just because Git is installed but missing from the current shell PATH.

## [0.10.16] - 2026-07-09

### Fixed

- `pi-67 install --repair --yes` now checks that `git` is available before
  moving an existing non-Git `~/.pi/agent` directory into the repair backup.
  Missing Git now fails early with actionable install guidance instead of doing
  a backup/restore round trip and surfacing `spawnSync git ENOENT`.

## [0.10.15] - 2026-07-09

### Fixed

- `pi-67 install --repair --yes` now safely handles an existing non-Git
  `~/.pi/agent` directory by moving it to
  `~/.pi/pi67/backups/<timestamp>-non-git-agent-dir/agent` before cloning the
  managed pi-67 checkout. The default `pi-67 install` path still blocks instead
  of silently overwriting a plain folder, but now prints the exact dry-run and
  repair commands.
- Empty pre-created agent directories are now accepted as clone targets instead
  of being rejected as non-Git folders.

## [0.10.14] - 2026-07-08

### Fixed

- `pi-67 update --repair` now refreshes the Git index stat cache for
  `settings.json` when Git reports `M settings.json` but `git diff` has no
  real content changes. This clears the Windows false-dirty state that can
  remain after line-ending/runtime-state cleanup.

## [0.10.13] - 2026-07-08

### Fixed

- `pi-67 update --repair` now normalizes `settings.json` BOM/CRLF line endings
  even when `lastChangelogVersion` is already absent. This clears Windows
  Git false-dirty states where `git diff -- settings.json` only reports the
  `LF will be replaced by CRLF` warning and has no real content diff.

## [0.10.12] - 2026-07-08

### Fixed

- `settings.json` is now explicitly tracked as `text eol=lf` alongside the
  runtime clean filter. This removes the Windows Git `LF will be replaced by
  CRLF` false-dirty warning after updates when there is no real settings
  content diff.

## [0.10.11] - 2026-07-08

### Fixed

- Bash and PowerShell distro updaters now run settings runtime-marker
  normalization again as the final update step, after smoke/report side
  effects. This keeps `settings.json.lastChangelogVersion` out of Git status
  even when an older global manager invokes a newer local updater script.

## [0.10.10] - 2026-07-08

### Fixed

- The update preflight runtime-marker regression test now covers both Bash and
  PowerShell distro updater entrypoints, matching the real cross-platform
  manager dispatch path.

## [0.10.9] - 2026-07-08

### Fixed

- `pi-67 update --repair` now migrates and normalizes the
  `settings.json.lastChangelogVersion` runtime marker before invoking the
  local distro updater script. This lets a freshly installed latest npm manager
  clean the common `M settings.json` state even when the checked-out distro is
  still older than the runtime-marker migration scripts.

## [0.10.8] - 2026-07-08

### Changed

- `pi-67 version` now prints a clear next-step recommendation when the global
  npm manager is newer than the local `~/.pi/agent` distro checkout, or when
  `settings.json` is dirty from the migrated Pi runtime changelog marker.
  This makes the supported flow explicit: `npm install -g` updates only the
  manager, then `pi-67 update --repair` updates and normalizes the local distro.

## [0.10.7] - 2026-07-08

### Changed

- `settings.json` no longer carries the Pi runtime-only
  `lastChangelogVersion` marker in the tracked baseline. Install/update now
  migrates that marker into ignored manager state at `~/.pi/pi67/state.json`,
  normalizes the runtime field out of `settings.json`, and installs a local Git
  clean filter so future Pi changelog marker writes cannot be carried into
  normal diffs or commits.
- Shared-skill drift wording now describes existing different global skills as
  "preserved user-modified" skills instead of user-facing "conflicts", while
  keeping the existing non-destructive policy and JSON compatibility fields.

### Fixed

- `pi-67 update --check`, `pi-67 status`, `pi-67 skills inventory`, doctor, and
  updater logs now use preserved-user-modified wording so beginners do not
  mistake safe user-owned global skills for broken pi-67 state.

## [0.10.6] - 2026-07-08

### Changed

- `xtalpi-pi-tools` now retries retryable runtime chat-completion transport
  failures by default, with bounded backoff and debug telemetry for request
  attempts, retry delays, and retry suppression reasons. This moves the
  provider-health retry behavior into the normal live provider path.
- Bash and PowerShell targeted xtalpi smoke now treat final-answer compliance as
  a local repairable condition: when tool choice, arguments, debug telemetry,
  and execution are already valid but the final answer misses required smoke
  text, the runner performs one no-tool final-answer repair instead of rerunning
  tools or reporting a protocol failure.
- Doctor skill-list probes now default to a 60 second timeout, and the npm
  manager accepts `pi-67 doctor --no-skill-list` for the POSIX doctor path.
- `pi-67 report --json` now works as a command-level JSON option. Dry runs emit
  a machine-readable dry-run object; real runs emit the generated report JSON to
  stdout after writing the report file.
- The npm publish workflow now installs extension dependencies and runs the
  full `scripts/pi67-smoke.sh --ci` gate before packing or publishing.

### Fixed

- Bash xtalpi smoke self-tests now simulate real tool-selection telemetry, so
  continuation/final-repair regressions fail the local gate instead of being
  hidden by simplified fake-Pi fixtures.
- PowerShell targeted smoke retries `missing_final_text:*` final-answer-only
  failures and self-tests the final compliance repair eligibility path.

## [0.10.5] - 2026-07-08

### Changed

- Bash and PowerShell updaters now use `git fetch` followed by
  `git merge --ff-only FETCH_HEAD` so they can inspect incoming changed paths
  before deciding whether dirty preserved runtime files need temporary
  cleanup.
- Dirty user runtime config now stays in place without creating a backup when
  the remote is already current or the incoming update does not touch those
  runtime files. Runtime backups are created only when incoming changed paths
  overlap dirty preserved runtime config, and equivalent snapshots are still
  reused.
- `pi-67 update --check` now reports benign/current dirty runtime config as
  `preserve-in-place-no-backup` when the remote already matches local HEAD,
  instead of presenting every dirty runtime marker as a planned backup.
- Release/smoke gates now check the README version badge against `VERSION`,
  reject obvious simulated placeholder final answers in xtalpi smoke, and
  require package metadata smoke cases to report the actual package version.
- Added `pi-67 xtalpi run` plus a Windows PowerShell launcher for the stable
  xtalpi-pi-tools runtime path. The launchers default
  `PI_OBSERVATIONAL_MEMORY_PASSIVE=true` so post-final observational-memory
  writes cannot hold the main task lifecycle open.
- Doctor now bounds `pi skill list` with `--skill-list-timeout-seconds` /
  `-SkillListTimeoutSeconds` and reports a warning instead of hanging when the
  Pi skill registry is slow.

### Fixed

- Documentation now consistently distinguishes current first-class runtime
  backups under `~/.pi/pi67/backups/` from legacy read-only
  `~/.pi/agent-backups/` conflict snapshots.
- Bootstrap snippets no longer recommend preserving the removed
  `extensions/xtalpi-compat/index.ts` runtime path; they focus on current local
  runtime config files instead.

## [0.10.4] - 2026-07-08

### Fixed

- Command-level `--help` is now side-effect free across the npm manager CLI:
  `pi-67 update --help` and other command help paths print usage without
  entering update/repair logic, acquiring update backups, or writing runtime
  state.
- Real `pi-67 update` now checks the update plan before starting the update
  lifecycle, so blocked non-runtime dirty worktrees fail closed without first
  creating a runtime backup.
- `pi-67 xtalpi drift` now defaults to full-suite artifacts, preventing
  targeted one-off smoke runs from creating expected case-set or runtime
  fingerprint drift noise.
- Bash and PowerShell runtime preservation dedupe now recognize both
  `manifest.json` and manager-style `backup-manifest.json` snapshots under
  `~/.pi/pi67/backups/`, reducing duplicate backup directories across older
  and newer backup formats.

### Added

- `pi-67 backups prune` and `pi-67 backups archive` for dry-run-first runtime
  backup retention, with `--keep-last` applied per backup kind and legacy
  snapshots included only when explicitly requested.
- `pi-67 skills plan` and `pi-67 skills diff <name>` for read-only shared-skill
  drift review before choosing whether to preserve, sync, or manually merge
  global skills.
- `pi-67 xtalpi trend`, `pi-67 xtalpi drift`, and `pi-67 xtalpi stress
  --until-done` as user-facing wrappers around the local xtalpi smoke artifact
  quality gates.
- CLI contract self-tests covering command-level help parsing and the guarantee
  that help commands do not create runtime backups.
- Windows CI now exercises Node 22 and Node 24 and runs npm manager CLI contract
  smoke commands in addition to the PowerShell repository smoke.

### Changed

- Runtime config backup ownership is now documented as script-level updater
  behavior: the npm manager owns planning, locking, blocked-plan classification,
  and orchestration, while Bash/PowerShell updaters create
  `pre-update-runtime-*` snapshots only when dirty preserved runtime files must
  be temporarily cleared for `git pull --ff-only`.
- Unknown shared-skill names now fail with concise CLI errors instead of stack
  traces.

## [0.10.3] - 2026-07-08

### Changed

- Real `pi-67 update` / `pi-67 update --repair` lifecycle backups are now
  deduplicated: if the preserved runtime files are byte-for-byte identical to
  the latest backup for the same operation, the manager reuses the existing
  snapshot instead of creating another timestamped directory.
- Direct PowerShell `scripts/pi67-update.ps1` runs also deduplicate identical
  dirty runtime-config preservation snapshots under `~/.pi/pi67/backups/`.
- The Windows PowerShell updater no longer contains the legacy
  `~/.pi/agent-backups/pre-update-*` writer. Runtime config preservation is
  handled only through the first-class `~/.pi/pi67/backups/` path.
- `pi-67 themes set <name>` now exits without writing a backup when the
  requested theme is already selected.

## [0.10.2] - 2026-07-08

### Fixed

- `pi-67 update --check` now reads the latest `@bigking67/pi-67` manager
  version directly from the npm registry HTTP API instead of spawning local
  `npm` / `npm.cmd`, eliminating the Windows PowerShell `spawnSync npm.cmd
  EINVAL` failure class for `Manager latest`.
- Windows npm execution now has a final `cmd.exe /d /s /c npm.cmd ...`
  fallback for explicit npm operations such as `pi-67 self-update` or
  maintainer publish checks, covering environments where direct `npm.cmd`
  spawning fails even though PowerShell `npm install -g ...` works.

### Added

- `pi-67 backups list --include-legacy` and `pi-67 backups inspect --legacy
  <pre-update-id>` now expose the older PowerShell `~/.pi/agent-backups/pre-update-*`
  conflict snapshots as read-only diagnostics, so users can distinguish them
  from first-class runtime backups under `~/.pi/pi67/backups/`.

## [0.10.1] - 2026-07-07

### Fixed

- Windows npm manager commands now fall back to `npm.cmd` when plain `npm`
  cannot be spawned directly, so `pi-67 update --check` can report
  `Manager latest` instead of `unknown (spawnSync npm ENOENT)`.

### Changed

- Clarified the public install/update path: `npm install -g @bigking67/pi-67`
  is the recommended daily manager install, while `npx -y
  @bigking67/pi-67@latest ...` remains the always-fresh one-shot recovery and
  verification path.

### Added

- `packages/pi67-cli/` as the publishable `@bigking67/pi-67` npm manager package, exposing `pi-67` / `pi67` for install, update, doctor, smoke, status, report, xtalpi, themes, skills, extensions, external, backups, and version workflows.
- `pi-67 self-update` plus npm latest-version hints in `pi-67 update --check`, so stale global managers are visible and users can run a single explicit manager update without changing Pi's upstream `pi` command.
- `pi-67 publish-check` as a maintainer readiness gate for version consistency, Trusted Publishing workflow drift, npm registry state, local npm auth visibility, and `npm pack --dry-run`.
- `pi-67 manifest` as a read-only ownership contract for pi-67 managed packages, runtime packages, local extensions, themes, shared skills, external repos, and preserved runtime config files.
- `pi-67 manifest --validate` as a standalone extension-registry policy gate, sharing the same validator with `publish-check` and release checks.
- `pi-67 extensions list`, `pi-67 extensions doctor`, `pi-67 extensions inspect <id>`, and `pi-67 extensions plan` as the user-facing extension ownership and policy diagnostics.
- `pi-67 backups list`, `pi-67 backups inspect`, and `pi-67 backups restore` as the supported recovery path for repo-external update/repair/theme-set runtime snapshots.
- `shared-skills/commerce-growth-os/` as the vendored Pi distribution copy of `https://github.com/bigKING67/commerce-growth-os`, so Pi/Codex can share the commerce growth skill through `~/.agents/skills`.
- `rules/commerce-growth.md` plus Pi rules-loader routing for commerce growth, marketplace operation, assortment, pricing, channel control, ROI/profit, and platform-currentness tasks.
- `scripts/pi67-sync-commerce-growth-os.sh` as a dry-run-first maintainer helper for refreshing the vendored `shared-skills/commerce-growth-os` copy from the standalone upstream checkout.
- `scripts/pi67-shared-skills-inventory.sh` as a read-only inventory for explaining `shared-skills/` versus `~/.agents/skills` drift without overwriting global skills.
- `scripts/pi67-fuzz-xtalpi-parser.mjs` as an offline parser matrix gate for xtalpi tool-call alias/wrapper compatibility and fail-closed cases.
- `scripts/pi67-patch-pi-until-done-runtime-queue.{mjs,sh,ps1}` to check and patch `pi-until-done@0.2.2` for the newer Pi runtime queue contract that requires `streamingBehavior` on `pi.sendUserMessage(...)`.
- `scripts/pi67-xtalpi-provider-capability-probe.mjs` to live-probe xtalpi support for plain chat, `json_object`, `json_schema strict`, native tools, strict tools, `role=tool` continuation, and local JSON action envelopes without printing API keys.

### Changed

- User-facing update docs now make `pi-67 update` the recommended pi-67 distribution update path, while keeping `pi update --extensions` scoped to upstream Pi extension updates.
- `pi-67 update` documentation now explicitly preserves existing local config files, user packages, global skills, external repos, and `settings.json.theme`; theme changes require `pi-67 themes set <name>`.
- `pi-67 update --check --json` now emits explicit `actions`, `blocked`, and `warnings` arrays so users can see planned writes, preserved paths, strict shared-skill blockers, and dirty external-repo blockers before running an update.
- `pi-67 update` / `pi-67 update --repair` now acquire a repo-external update lock and snapshot preserved runtime files under `~/.pi/pi67/backups/` before dispatching Bash or PowerShell update scripts.
- Bash and PowerShell updaters now preserve dirty user runtime config in in-place checkouts by backing it up, temporarily clearing it for `git pull --ff-only`, and restoring it after the pull; unrelated tracked edits still block by default.
- Backup restore is preserve-scoped: it only writes known runtime config files and creates a pre-restore backup before replacing the current local runtime state.
- Backup manifests now record both present and missing preserved runtime slots, so restore can also remove a preserved config file that did not exist when the backup was created.
- `pi-67 themes set <name>` now writes a runtime backup before explicitly changing the selected theme, while normal update remains forbidden from changing theme selection.
- Update-plan self-tests now cover clean repo, runtime-config dirty preservation, unsafe dirty blockers, missing managed extension repair, missing theme assets, shared-skill default/strict behavior, dirty external repos, and manager self-update actions.
- `pi-67 update --strict-shared-skills` now forwards strict shared-skill parity checks through both Bash and Windows PowerShell update paths, while the default still preserves existing different global skills.
- `pi-67 publish-check` now gates the distro ownership manifest, including preserved runtime config policy, required local extensions, user-managed baseline packages, theme preservation, shared-skill preservation, and dirty external-repo blocking policy.
- Extension-registry policy checks are now centralized in `packages/pi67-cli/src/lib/extension-registry.mjs`, with self-tests for duplicate ids, missing smoke gates, forbidden update behavior, unsafe config patches, theme drift, shared-skill drift, dirty external-repo drift, and unregistered managed extensions.
- `pi-67 publish-check` now checks npm scope visibility during remote publish readiness, so missing npm namespaces fail before the final publish step with an actionable message.
- Pi AGENTS/rules documentation now routes commerce growth work to `commerce-growth-os` without adding local absolute paths or duplicate active package roots.
- External skill sync now supports both root-level `repo/SKILL.md` skill repositories and legacy `repo/skills/*/SKILL.md` layouts, with fixture coverage for root-level discovery, apply, and read-only checks.
- `scripts/pi67-status.sh` now classifies benign `settings.json` runtime-marker dirty state separately and reports recent xtalpi provider-health retry/failure trend from local smoke artifacts.
- `scripts/pi67-doctor.sh` now points shared-skill drift warnings to the new inventory helper instead of leaving operators with only a long skill-name list.
- `docs/xtalpi-pi-tools.md` now documents the root-cause boundary for xtalpi empty replies, missing replies, and missed tool calls: the company proxy is treated as plain Chat Completions only, while Pi owns tool selection, protocol parsing, validation, repair, diagnostics, and smoke gates locally.
- `xtalpi-pi-tools` now guards premature final answers: Plan mode instruction echoes, missing `<proposed_plan>` blocks, continuation no-progress replies, intent-to-tool promises without tool calls, and weak acknowledgements trigger a bounded local repair turn instead of silently ending the agent turn.
- `xtalpi-pi-tools` now fails closed for stubborn Plan mode contract misses by synthesizing a local `<proposed_plan>` fallback after the bounded repair budget is exhausted, so users do not get stranded on a raw provider-format error.
- `xtalpi-pi-tools` now blocks obvious shell mismatches before execution when the model sends raw PowerShell cmdlets or unquoted Windows backslash script paths to the `bash` tool, then asks the model to repair with bash-compatible commands or an explicit `powershell.exe` / `pwsh` invocation.
- `xtalpi-pi-tools` now accepts legacy Pi-style tool envelopes that use `id=...`, `name="..."`, and `arguments_json: {...}` inside `<pi_tool_call>`, preventing that provider drift from surfacing as an invalid JSON stop.
- `xtalpi-pi-tools` now normalizes broader high-probability text tool-call drift locally, including `tool` / `tool_name` / `function_name` name aliases, `args` / `input` / `parameters` / `arguments_json` argument aliases, JSON-string arguments, text-native `function_call` / `tool_calls[0].function` shapes, generic `<tool_call>` tags, uppercase tool tags, and nested attributed envelopes, while still failing closed on multiple calls, unknown fields, empty argument strings, and mismatched attributed names.
- `xtalpi-pi-tools` now strips mixed `previous_pi_tool_call` history blocks from otherwise valid final answers or tool envelopes before final-answer guards run, so model responses such as "收到，重新发起搜索。" plus copied history are repaired as no-progress continuations instead of surfacing raw internal protocol text to users.
- `xtalpi-pi-tools` no longer serializes prior assistant `toolCall` blocks into model-visible `previous_pi_tool_call` history records; the model sees the subsequent tool-result wrapper as evidence, while legacy history markers remain supported only as cleanup/repair inputs.
- `xtalpi-pi-tools` final-answer guards now reject echoed protocol/tool-result wrapper instructions such as `Tool protocol rules:` or `content_is_untrusted: true` as internal context leaks.
- `xtalpi-pi-tools` fallback error summaries now sanitize raw-response excerpts before displaying them, avoiding a second leak of internal Pi protocol markers when repair is exhausted.
- `xtalpi-pi-tools` parser now accepts local JSON action envelopes (`{"kind":"tool_call",...}` and `{"kind":"final",...}`) for providers where targeted JSON action works but native JSON schema / OpenAI tools do not; unknown fields and invalid action kinds still fail closed.
- `xtalpi-pi-tools` now uses local JSON action as the only runtime protocol through `json-action-protocol.ts`: it sends only plain Chat Completions plus `response_format={"type":"json_object"}` as a syntax hint, while keeping action schema validation, selected-tool allowlist, argument validation, shell guard, repair prompts, execution, and debug/smoke gates local to Pi.
- `xtalpi-pi-tools` now hard-pins runtime tool coordination to local JSON action only. Old `<pi_tool_call>` markup is treated as provider drift or historical artifact leakage, then repaired back to JSON action instead of being available as a fallback protocol.
- `xtalpi-pi-tools` final-answer protocol boundary is now centralized in `protocol-boundary.ts`, covering JSON object/array pseudo tool calls, OpenAI `tool_calls`, `function_call`, reserved `until_done_*` calls, and dynamically selected extension tools without relying on a fixed tool-name allowlist.
- Bash and PowerShell xtalpi smoke summarizers now reuse the same protocol-boundary semantics and fail final-answer quality when tool-call-like JSON/protocol content appears in final text, while preserving ordinary business JSON as valid answer text.
- `xtalpi-pi-tools` now safely recovers malformed JSON-action `final` envelopes whose text contains unescaped quotes, then routes the recovered text through the normal final-answer guard instead of exhausting invalid-JSON repair; malformed `tool_call` envelopes still fail closed.
- `xtalpi-pi-tools` JSON action parsing now strips Markdown code fences before protocol validation, so fenced local JSON actions remain on the normal parser path while fenced legacy protocol markup is still rejected.
- `full-suite-strict` smoke trend gates now treat bounded local repair as an operationally acceptable provider success path while continuing to gate empty finals, raw tool markup, process failures, provider errors, case-set drift, and excessive repair rates.
- PowerShell `pi67-xtalpi-pi-tools-smoke.ps1` now includes the two-turn `until-done-continuation` targeted case, matching the documented Windows command and preventing it from failing as an unknown case.
- Install, update, doctor, smoke, and release-check flows now include the `pi-until-done` runtime queue compatibility check/patch so `/until-done` no longer regresses after a normal pi-67 update.
- Pi extension dependency baselines now track the current `pi-subagents`, `@narumitw/pi-plan-mode`, and `@narumitw/pi-btw` releases so `pi67-update.ps1` no longer reverts those packages behind Pi's own extension-update check.

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
- `scripts/pi67-xtalpi-pi-tools-debug-summary.sh --profile full-suite-strict` now applies the full 10-case strict trend-gate contract in one option, reducing operator error from manually repeating long case and threshold arguments.
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
- Accidental native `assistant.tool_calls` returned by the upstream compatibility layer are now re-projected into the same local JSON action boundary even when `content` is empty, and malformed native `function.arguments` fail into repair instead of silently executing `{}`.
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
