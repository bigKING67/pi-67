# pi-67 Release Workflow

pi-67 is a full-stack Pi workspace distribution. A release should communicate exactly what a user gets after `git pull` or a fresh install, and whether any local readiness steps are required.

## Version source of truth

- `VERSION` is the pi-67 distribution version.
- `package.json.version` mirrors `VERSION` for tooling visibility.
- `packages/pi67-cli/package.json.version` mirrors `VERSION` for the
  `@bigking67/pi-67` npm manager package.
- `CHANGELOG.md` records user-visible changes.

Do not use the upstream Pi CLI version as the pi-67 release version. Pi itself has its own lifecycle.

## Release checklist

Before tagging or publishing release notes:

PowerShell smoke for Windows-facing changes:

```powershell
.\scripts\pi67-smoke.ps1 -Ci
.\scripts\pi67-doctor.ps1 -Json
.\scripts\pi67-report.ps1 -Operation manual
.\scripts\pi67-patch-pi-until-done-runtime-queue.ps1 -Check
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -SelfTest
.\scripts\pi67-windows-acceptance.ps1 -SelfTest
```

If xtalpi targeted tool calling changed and a live xtalpi key is available on
Windows, also run:

```powershell
.\scripts\pi67-windows-acceptance.ps1 -SkipUpdate
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "read-package,read-enoent-recovery,plan-mode-contract,plan-mode-accepted-continuation,until-done-continuation,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found"
```

If the release changes MCP/browser67 startup behavior and the machine has a
configured browser67 checkout/package, additionally run:

```powershell
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "mcp-connect-tmwd-browser"
```

macOS/Linux and full release gate:

```bash
bash scripts/pi67-release-check.sh
bash scripts/pi67-patch-pi-until-done-runtime-queue.sh --check --agent-dir ~/.pi/agent
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
bash scripts/pi67-release.sh --dry-run
npm pack --dry-run ./packages/pi67-cli
git status --short
```

Expected result:

- release metadata is internally consistent
- Windows PowerShell smoke passes on a PowerShell runtime when Windows-facing files changed
- Windows PowerShell doctor/report run on a PowerShell runtime when Windows install/update diagnostics changed
- Windows one-command acceptance self-test passes; a credentialed Windows host
  passes `pi67-windows-acceptance.ps1 -SkipUpdate` before release
- PowerShell xtalpi targeted smoke self-test passes; live targeted smoke covers
  read, deterministic `ENOENT` repeated-call recovery, FFF, batch fetch,
  sequential-thinking status, MCP, subagent, and recall when xtalpi credentials
  are available
- xtalpi provider error-contract and debug-summary/profile self-tests pass
- `pi-until-done` runtime queue/progress compatibility check passes on the installed agent package when `/until-done` behavior or npm extensions changed
- smoke test passes locally
- clean artifact smoke passes for the current worktree candidate
- npm manager package packs as `@bigking67/pi-67`
- release notes preview is generated from `CHANGELOG.md`
- worktree is clean except the intentional release commit before committing
- GitHub Actions passes after push
- optional user-machine MCP check passes when MCP behavior changed: `bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp`

## Updating a release

1. Update `VERSION`.
2. Update `package.json.version`.
3. Update `packages/pi67-cli/package.json.version`.
4. Add a dated entry at the top of `CHANGELOG.md`.
5. If install/configure/doctor/manager behavior changed, update:
   - `README.md`
   - `docs/full-install.md`
   - `docs/troubleshooting.md`
   - `packages/pi67-cli/README.md` if public npm command behavior changed
   - `packages/pi67-cli/CHANGELOG.md` if npm manager behavior changed
   - `docs/report-schema.md` if `pi67-report.json` fields changed
   - `docs/doctor-schema.md` if doctor JSON fields changed
   - `docs/status.md` if `scripts/pi67-status.sh` behavior changed
   - `docs/skill-migration-schema.md` if `scripts/pi67-migrate-skills.sh --json` behavior changed
   - `docs/external-skill-sync-schema.md` if `scripts/pi67-sync-external-skills.sh --json` behavior changed
   - `docs/skill-governance.md` if skill registry, migration, or external sync behavior changed
   - update workflow docs if `scripts/pi67-update.sh` or `scripts/pi67-update.ps1` changed
   - Windows acceptance docs if `scripts/pi67-windows-acceptance.ps1` changed
   - release artifact docs if `scripts/pi67-release-artifact-smoke.sh` changed
6. Run:

```powershell
.\scripts\pi67-smoke.ps1 -Ci
.\scripts\pi67-doctor.ps1 -Json
.\scripts\pi67-report.ps1 -Operation manual
.\scripts\pi67-patch-pi-until-done-runtime-queue.ps1 -Check
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -SelfTest
.\scripts\pi67-windows-acceptance.ps1 -SelfTest
```

```bash
bash scripts/pi67-release-check.sh
bash scripts/pi67-patch-pi-until-done-runtime-queue.sh --check --agent-dir ~/.pi/agent
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
bash scripts/pi67-release.sh --dry-run
npm pack --dry-run ./packages/pi67-cli
```

7. Commit with a scoped message, for example:

```bash
git commit -m "chore: release pi-67 0.2.0"
```

8. Push and confirm CI:

```bash
git push
gh run list --limit 3 --branch main
```

## Automated tagging and GitHub Release

After the release commit is pushed and CI passes, create the tag and GitHub Release:

```bash
bash scripts/pi67-release.sh --yes
```

The script:

1. Reads `VERSION`.
2. Extracts the matching `CHANGELOG.md` entry.
3. Runs `scripts/pi67-release-check.sh`.
4. Runs `scripts/pi67-smoke.sh --ci` unless `--no-smoke` is passed.
5. Creates annotated tag `vX.Y.Z`.
6. Pushes the tag.
7. Creates a GitHub Release through `gh release create`.

Preview without writing:

```bash
bash scripts/pi67-release.sh --dry-run
```

## npm manager package

The npm package is a thin, long-term public entrypoint for users:

```bash
npm install -g @bigking67/pi-67
pi-67 install
pi-67 update
pi-67 doctor
```

It does not replace or shadow the upstream `pi` binary. `pi update` and
`pi update --extensions` remain upstream Pi commands; `pi-67 update` is the
pi-67 distribution update command.

The manager update path is preserve-first. A real `pi-67 update` / `pi-67
update --repair` builds the update plan, blocks unsafe non-runtime dirty
worktrees, and acquires `~/.pi/pi67/locks/update.lock` before dispatching the
Bash or PowerShell updater. Runtime config backup/restore is owned by the
platform updater script and only runs when an in-place checkout needs to
temporarily clear dirty preserved runtime files. The updater fetches first,
compares incoming `HEAD..FETCH_HEAD` changed paths, and backs up dirty runtime
files only when the incoming update touches those paths.
Those script-level snapshots live under
`~/.pi/pi67/backups/pre-update-runtime-*`. The selected theme lives in the
`settings.json` `theme` field and must not be changed by update. In-place
checkouts with only dirty user runtime config are preserved in place when the
incoming update is already current or changes non-overlapping paths; unrelated
tracked edits still block. Runtime snapshots are deduplicated by preserved-file
content, so repeated no-change updates do not create new timestamped backup
directories. `--help`, blocked update plans, already-up-to-date updates, and
the manager orchestration layer must not create runtime backup directories.

Before publishing the npm package:

```bash
node packages/pi67-cli/bin/pi-67.mjs --help
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" version --json
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" manifest --json
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" manifest --validate
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" extensions doctor --json --no-remote
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" update --check --json --no-remote
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" update --check --json --no-remote --strict-shared-skills
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" publish-check --json --no-remote
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" themes current --json
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" backups list --json
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" backups list --include-legacy --json
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" backups prune --keep-last 10 --dry-run --json
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" xtalpi smoke --self-test
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" doctor --no-skill-list --dry-run
node packages/pi67-cli/bin/pi-67.mjs --agent-dir "$PWD" --repo-root "$PWD" report --json --dry-run
node packages/pi67-cli/bin/pi-67.mjs --dry-run self-update
npm pack --dry-run ./packages/pi67-cli
```

The GitHub `npm-publish.yml` workflow repeats the release metadata check and
runs the full `bash scripts/pi67-smoke.sh --ci` gate before `npm publish`. This
keeps Trusted Publishing from publishing a package whose local release/smoke
contract is already known to be failing.

For release/parity checks where preserved user-modified global shared skills
should block instead of being kept, run:

```bash
pi-67 update --check --strict-shared-skills
```

`pi-67 update --check --json` must include `actions`, `blocked`, and `warnings`
so release consumers can see planned writes, preserved user-owned paths, and
policy blockers before a real update.
It must also expose `policy.preservedRuntimeFiles`, `policy.themePolicy`,
`policy.sharedSkillsPolicy`, and `policy.externalDirtyPolicy` so scripts and
docs can prove that update behavior is governed by the same manifest contract.
`pi-67 backups list`, `pi-67 backups inspect <backup-id-or-path>`,
`pi-67 backups restore --from <backup-id-or-path> --dry-run|--yes`,
`pi-67 backups prune --keep-last N --dry-run|--yes`, and
`pi-67 backups archive --keep-last N --older-than 30d --dry-run|--yes` are the
supported recovery and retention paths for repo-external runtime snapshots;
restore only writes preserved runtime files and creates a pre-restore backup
first.
Legacy PowerShell `~/.pi/agent-backups/pre-update-*` known-conflict snapshots
are exposed as read-only diagnostics with `pi-67 backups list --include-legacy`
and `pi-67 backups inspect <pre-update-id> --legacy`; they are not restored by
the runtime backup restore path and are no longer written by the normal
PowerShell updater.

After the local release gates pass, use the public manager command to inspect
the end-to-end npm publish path:

```bash
pi-67 publish-check
```

The check reports version consistency, Trusted Publishing workflow readiness,
npm registry state, npm namespace visibility, local npm auth state, and
`npm pack --dry-run`. A missing local `npm whoami` is not a blocker for GitHub
Actions Trusted Publishing.
It also gates the ownership manifest release policy, so preserved runtime
config files, required local extensions, theme preservation, shared-skill
preservation, external-repo dirty blocking, and unknown baseline runtime
packages cannot drift silently before publish.
Use `pi-67 manifest --json` when changing packages, extensions, themes, shared
skills, or external repo behavior; it is the user-visible ownership contract
that separates pi-67 managed resources from report-only user resources.
Use `pi-67 manifest --validate` for the standalone registry policy gate before
publishing, even when no npm publish check is being run.
Use `pi-67 extensions doctor` / `pi-67 extensions inspect <id>` for the
operator-facing view of the same extension registry without editing user state.
New extensions must also be registered in
`packages/pi67-cli/src/data/extension-registry.json` with owner,
install/update/repair strategy, config patch mode, and smoke gates. The release
gate and `publish-check` use the same validator and reject duplicate extension
ids, missing smoke gates, unsupported config patch modes, and forbidden
behaviors such as overwriting user config, selecting a theme during update,
overwriting different shared skills, or updating dirty external repos.

Preferred publish path: GitHub Actions with npm Trusted Publishing / OIDC.
This keeps long-lived npm publish tokens out of the repository and out of
maintainer machines. The workflow still uses `--access public` because
`@bigking67/pi-67` is a scoped public package.

If npm refuses the first Trusted Publishing attempt with a registry `E404` for
`@bigking67/pi-67`, treat it as an npm-side identity/bootstrap problem, not a
package build problem. It means the package is not visible to the publishing
identity yet, the scope is not controlled by the maintainer account, or the
Trusted Publisher has not been attached to the package. `npm publish --dry-run`
does not prove this write permission.

Manual publish remains a fallback when a trusted publisher has not been
configured yet:

```bash
npm publish ./packages/pi67-cli --access public --provenance
```

After publishing, verify the public latest-version path from a clean shell:

```bash
npx -y @bigking67/pi-67@latest --help
npx -y @bigking67/pi-67@latest update --check --no-remote
```

If publishing manually, verify identity first:

```bash
npm whoami
```

For normal releases, do not configure `NODE_AUTH_TOKEN` in the workflow. npm
Trusted Publishing uses GitHub Actions OIDC (`id-token: write`) and generates
provenance for supported CI publishes.

### GitHub Actions npm publish

The checked-in workflow is:

```text
.github/workflows/npm-publish.yml
```

It is intentionally manual-only (`workflow_dispatch`) so normal pushes cannot
publish a package by accident. It validates:

- workflow input `version`
- `VERSION`
- root `package.json.version`
- `packages/pi67-cli/package.json.version`
- npm version support for Trusted Publishing
- setup-node's bundled npm is used directly; do not float the workflow to
  `npm@latest`, because npm major releases can drift and break CI publishing
  independently of pi-67.
- npm manager smoke commands
- `scripts/pi67-release-check.sh`
- `npm pack --dry-run ./packages/pi67-cli`
- for real publishes, a remote `pi-67 publish-check --strict --no-pack`
  preflight so missing npm scopes and unconfirmed first publishes fail before
  the final `npm publish`

Repository setup:

1. Make sure the npm scope `@bigking67` exists and is controlled by the
   maintainer. If npm reports `Scope not found`, create or claim that npm
   user/org first, or rename the package to a scope/name the maintainer owns.
2. In npm, configure a trusted publisher for `@bigking67/pi-67`.
3. Use provider `GitHub Actions`, repository `bigKING67/pi-67`, and workflow
   filename `npm-publish.yml`.
4. Allow the `npm publish` action for the trusted publisher.
5. Keep GitHub Actions permissions for the workflow at `contents: read` and
   `id-token: write`.
6. Keep the workflow manual-only (`workflow_dispatch`) so ordinary pushes cannot
   publish a package.

`npm publish --dry-run` does not prove that a first publish can write the scoped
package. For a package that has never been published, the real-publish workflow
will stop during `Validate npm publish target` unless the maintainer explicitly
types the package name in the `first_publish_confirm` input:

```text
first_publish_confirm: @bigking67/pi-67
```

Only use that confirmation after the npm scope exists and the Trusted Publisher
is configured. The confirmation is intentionally not needed after the package is
visible on the npm registry.

If npm requires the package to exist before Trusted Publishing can be attached,
publish the first version once from an npm-authenticated maintainer shell, then
immediately configure the trusted publisher and use the workflow for future
releases.

The workflow also has an explicit first-publish fallback:

1. Create a short-lived npm granular access token with publish permission for
   the owned scope/package.
2. Add it as the repository secret `NPM_TOKEN`.
3. Run the workflow with `auth_mode: token-bootstrap` and
   `first_publish_confirm: @bigking67/pi-67`.
4. Verify the package is public on npm.
5. Delete or restrict `NPM_TOKEN`.
6. Configure npm Trusted Publishing for future releases and return to
   `auth_mode: trusted`.

CLI equivalent:

```bash
gh workflow run npm-publish.yml \
  -f version=<VERSION> \
  -f tag=latest \
  -f dry_run=false \
  -f auth_mode=token-bootstrap \
  -f first_publish_confirm=@bigking67/pi-67
```

Dry-run first from GitHub Actions:

```text
Actions -> npm publish pi-67 manager -> Run workflow
version: <VERSION>
tag: latest
dry_run: true
auth_mode: trusted
```

Publish after CI and dry-run pass:

```text
Actions -> npm publish pi-67 manager -> Run workflow
version: <VERSION>
tag: latest
dry_run: false
auth_mode: trusted
first_publish_confirm: @bigking67/pi-67   # first publish only
```

Manual publish remains valid when an npm-authenticated maintainer shell is
available:

```bash
npm whoami
npm publish ./packages/pi67-cli --access public --provenance
```

## Artifact smoke

Use `scripts/pi67-release-artifact-smoke.sh` to verify that a clean copy/ref can
perform the essential release-consumer checks without touching the real Pi
config:

```bash
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
bash scripts/pi67-release-artifact-smoke.sh --ref HEAD
bash scripts/pi67-release-artifact-smoke.sh --ref v0.9.0
```

`WORKTREE` is for pre-commit local candidates and copies Git-tracked plus
non-ignored candidate files into a temporary Git repo. `HEAD` and tag refs use a
normal clone checkout, which is the right shape for post-commit or published
release validation.

Duplicate policy:

- Historical release tags are retained. Do not delete old versions just to reduce clutter; release history is the audit trail.
- Same-version duplicates are blocked by default. If `v$(cat VERSION)` already exists, the script stops.
- If a release attempt failed and you must redo the same current version, use:

```bash
bash scripts/pi67-release.sh --replace-existing --yes
```

`--replace-existing --yes` is intentionally scoped: it only replaces the tag/release for the current `VERSION`, not older versions.

## Manual tagging fallback

Use annotated tags for release points:

```bash
git tag -a "v$(cat VERSION)" -m "pi-67 $(cat VERSION)"
git push origin "v$(cat VERSION)"
```

Do not tag before CI passes on the release commit.

## GitHub release notes template

````markdown
## pi-67 vX.Y.Z

### What changed

- ...

### Install / update

Fresh install:

Windows PowerShell:

```powershell
git clone https://github.com/bigKING67/pi-67.git $env:USERPROFILE\.pi\agent
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-smoke.ps1 -Ci
```

macOS/Linux:

```bash
git clone https://github.com/bigKING67/pi-67.git
cd pi-67
./install.sh
```

Update existing install:

Windows PowerShell:

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-update.ps1
```

macOS/Linux:

```bash
cd /path/to/pi-67
git pull --ff-only
bash scripts/pi67-update.sh
bash ~/.pi/agent/scripts/pi67-doctor.sh
bash ~/.pi/agent/scripts/pi67-status.sh
```

Configure local readiness:

```bash
bash ~/.pi/agent/scripts/pi67-configure.sh --prompt-secrets
```

### Verification

- `.\scripts\pi67-smoke.ps1 -Ci` on Windows PowerShell / PowerShell Core
- `.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -SelfTest` on Windows PowerShell / PowerShell Core
- `.\scripts\pi67-windows-acceptance.ps1 -SelfTest` on Windows PowerShell / PowerShell Core
- `bash scripts/pi67-smoke.sh --ci`
- GitHub Actions CI: passed

### Notes

- pi-67 remains full-install by default.
- Missing API keys, local MCP paths, or optional binaries are reported by doctor as readiness warnings.
````
