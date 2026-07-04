# pi-67 Release Workflow

pi-67 is a full-stack Pi workspace distribution. A release should communicate exactly what a user gets after `git pull` or a fresh install, and whether any local readiness steps are required.

## Version source of truth

- `VERSION` is the pi-67 distribution version.
- `package.json.version` mirrors `VERSION` for tooling visibility.
- `CHANGELOG.md` records user-visible changes.

Do not use the upstream Pi CLI version as the pi-67 release version. Pi itself has its own lifecycle.

## Release checklist

Before tagging or publishing release notes:

PowerShell smoke for Windows-facing changes:

```powershell
.\scripts\pi67-smoke.ps1 -Ci
.\scripts\pi67-doctor.ps1 -Json
.\scripts\pi67-report.ps1 -Operation manual
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -SelfTest
```

If xtalpi targeted tool calling changed and a live xtalpi key is available on
Windows, also run:

```powershell
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "read-package,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found"
```

macOS/Linux and full release gate:

```bash
bash scripts/pi67-release-check.sh
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
bash scripts/pi67-release.sh --dry-run
git status --short
```

Expected result:

- release metadata is internally consistent
- Windows PowerShell smoke passes on a PowerShell runtime when Windows-facing files changed
- Windows PowerShell doctor/report run on a PowerShell runtime when Windows install/update diagnostics changed
- PowerShell xtalpi targeted smoke self-test passes; live targeted smoke covers read, FFF, batch fetch, sequential-thinking status, MCP, subagent, and recall when xtalpi credentials are available
- xtalpi provider error-contract and debug-summary/profile self-tests pass
- smoke test passes locally
- clean artifact smoke passes for the current worktree candidate
- release notes preview is generated from `CHANGELOG.md`
- worktree is clean except the intentional release commit before committing
- GitHub Actions passes after push
- optional user-machine MCP check passes when MCP behavior changed: `bash ~/.pi/agent/scripts/pi67-doctor.sh --deep-mcp`

## Updating a release

1. Update `VERSION`.
2. Update `package.json.version`.
3. Add a dated entry at the top of `CHANGELOG.md`.
4. If install/configure/doctor behavior changed, update:
   - `README.md`
   - `docs/full-install.md`
   - `docs/troubleshooting.md`
   - `docs/report-schema.md` if `pi67-report.json` fields changed
   - `docs/doctor-schema.md` if doctor JSON fields changed
   - `docs/status.md` if `scripts/pi67-status.sh` behavior changed
   - `docs/skill-migration-schema.md` if `scripts/pi67-migrate-skills.sh --json` behavior changed
   - `docs/external-skill-sync-schema.md` if `scripts/pi67-sync-external-skills.sh --json` behavior changed
   - `docs/skill-governance.md` if skill registry, migration, or external sync behavior changed
   - update workflow docs if `scripts/pi67-update.sh` or `scripts/pi67-update.ps1` changed
   - release artifact docs if `scripts/pi67-release-artifact-smoke.sh` changed
5. Run:

```powershell
.\scripts\pi67-smoke.ps1 -Ci
.\scripts\pi67-doctor.ps1 -Json
.\scripts\pi67-report.ps1 -Operation manual
.\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -SelfTest
```

```bash
bash scripts/pi67-release-check.sh
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
bash scripts/pi67-release.sh --dry-run
```

6. Commit with a scoped message, for example:

```bash
git commit -m "chore: release pi-67 0.2.0"
```

7. Push and confirm CI:

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
- `bash scripts/pi67-smoke.sh --ci`
- GitHub Actions CI: passed

### Notes

- pi-67 remains full-install by default.
- Missing API keys, local MCP paths, or optional binaries are reported by doctor as readiness warnings.
````
