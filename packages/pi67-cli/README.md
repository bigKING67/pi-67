# @bigking67/pi-67

`@bigking67/pi-67` is the distribution and configuration manager for the
pi-67 Pi workstation. The independent upstream `pi` executable remains the
only chat runtime.

Version: `0.15.0` (release candidate; not published by this source change).

## Boundary

pi-67 manages:

- the versioned workspace activated at `~/.pi/agent`;
- 21 default extension minimum baselines;
- bundled rules, prompts, templates, themes, and shared Skills;
- diagnostics, migration, immutable-release rollback, and backups;
- optional browser67 and xtalpi integration helpers.

pi-67 never installs, updates, compares, recommends, or constrains the Pi
runtime version. Provider login, model selection, auth persistence, extension
loading, and task execution remain upstream Pi responsibilities.

## Install

After `0.15.0` is published:

```bash
npm install --global @bigking67/pi-67@0.15.0
pi-67 install
pi-67 doctor --json
pi
```

The npm package contains an immutable distro built by `prepack`. Install does
not clone GitHub `main`. If `~/.pi/agent` is an existing legacy Git checkout,
install fails closed and requires the explicit migration flow:

```bash
pi-67 migrate --check --json
pi-67 migrate --yes
```

Migration moves the original checkout under the active workspace
`stateDir/backups`, activates the manager-bundled distro, and preserves runtime
config, sessions, npm/Git extensions, local extensions, MCP configuration, and
theme selection.

## Update model

```bash
pi-67 self-update --dry-run
pi-67 self-update
pi-67 update --check --json
pi-67 update
```

The manager artifact and distro have the same version. Normal install/update
never fetches the pi-67 workspace from a mutable Git branch.

Default extension policy:

| State | Action |
| --- | --- |
| missing | install the release minimum baseline |
| safely behind and manager-pristine | upgrade to the minimum baseline |
| equal | keep |
| newer/ahead | keep; never downgrade |
| modified/diverged/forked | keep and report a conflict |
| unknown | keep as user-managed |
| configured but unresolved by the deep Pi load probe | report `load-failed`; do not overwrite |

The ownership ledger is `stateDir/extension-ledger.json`. The canonical
`~/.pi/agent` workspace uses `~/.pi/pi67`; custom `--agent-dir` workspaces use
stable hashed roots under `~/.pi/pi67/workspaces/<id>` so pointers, ledgers,
locks, backups, and journals never cross workspace boundaries. The ledger
records only content that pi-67 actually installed or verified.
`update --repair` does not run a whole-runtime `npm ci` and cannot resynchronize
an ahead extension back to an older release baseline.

## Immutable release store

```text
~/.pi/pi67/releases/<version>/
~/.pi/pi67/current.json
~/.pi/pi67/pending-activation.json
~/.pi/pi67/journals/
~/.pi/pi67/migrations/
~/.pi/pi67/backups/
```

Those paths are retained for canonical `~/.pi/agent` compatibility. Use
`pi-67 version --json` or `pi-67 status --json` to inspect `paths.stateDir` for
a custom workspace.

Same-version content collisions fail closed. Re-activating the current release
is a no-op. An interrupted activation keeps a pending marker and resumes
idempotently on the next attempt; the active pointer changes only after all
package-owned files are written.

Rollback commands:

```bash
pi-67 rollback --check --json
pi-67 rollback --yes
pi-67 rollback --migration --check
pi-67 rollback --migration --yes
```

## Default extensions

The release keeps all 17 package/Git defaults and all 4 first-party bundled
extensions. The canonical registry is
`src/data/managed-extension-baselines.json`.

The two public memory layers have different responsibilities:

- `pi-observational-memory`: in-session observation and compression;
- `pi-hy-memory`: cross-session long-term recall and capture.

A user's personal `agent_memory` MCP is not a public dependency, template,
manifest entry, or recommendation. Existing ignored `mcp.json` state is still
preserved by install, update, migration, repair, and rollback.

Extension commands:

```bash
pi-67 extensions list --json
pi-67 extensions plan --json
pi-67 extensions status --deep --json
pi-67 extensions doctor --deep --json
pi-67 extensions inspect <id> --json
pi-67 extensions diff <id> --json
pi-67 extensions restore <id> --check --json
pi-67 extensions restore <id> --yes
```

Explicit restore backs up and replaces only the selected default extension.

## Shared Skills

The artifact bundles 62 shared Skills, including all 27 Lark Skills, eight
Commerce/Marketing Skills, and 21 AI Berkshire Skills. Existing active Skills
with different content are preserved; normal update only copies missing
Skills.

The Commerce/Marketing and AI Berkshire packs are first-party distribution
assets:

```text
owner=pi67-first-party
distribution=bundled-release-only
```

They are maintained and released through pi-67 rather than auto-updated from a
third-party runtime source on user machines.

```bash
pi-67 skills inventory
pi-67 skills packs --json
pi-67 skills plan
pi-67 skills diff <name>
```

Explicit pack replacement requires `skills sync-pack <pack> --yes` and uses a
transactional deploy lock.

## User-owned state

Activation excludes and preserves:

```text
settings.json
models.json
auth.json
mcp.json
image-gen.json
settings.json.theme
extensions/
git/
npm/
sessions/
```

Templates are used only when machine-owned files are absent. Provider, model,
auth, MCP, and selected theme values are not replaced during normal update.

## Status and diagnostics

```bash
pi-67 version --json
pi-67 status --json
pi-67 manifest --json
pi-67 manifest --validate
pi-67 update --check --json
pi-67 doctor --json
pi-67 extensions doctor --deep --json
pi-67 backups list --json
```

`pi67.version.v2` intentionally contains manager/distro/Node/platform/theme
information and no Pi version policy. Deep extension doctor uses the real
`pi list --no-approve` resolution path without comparing Pi versions.

## Commands

```text
install       activate the manager-bundled distro
update        activate this manager's distro and apply safe minimum baselines
migrate       move a legacy Git layout to immutable releases
rollback      restore a previous distro or legacy layout
doctor        run readiness diagnostics
status        print a lightweight read-only summary
version       print manager and distro versions
manifest      inspect package/config ownership policy
extensions    inspect, diff, diagnose, or explicitly restore defaults
skills        inventory and govern shared Skills and first-party Packs
themes        manage theme selection without update-time overwrite
backups       inspect and restore runtime backups
memory        manage private pi-hy-memory service state
external      manage explicit external repositories such as browser67
xtalpi        optional company provider/tool convenience
self-update   explicitly update this npm manager
publish-check verify npm release readiness
```

Use `pi-67 <command> --help` for exact options.

## Development and package verification

From the repository root:

```bash
node packages/pi67-cli/scripts/check.mjs
npm run typecheck:xtalpi
npm run typecheck:hy-memory
npm run test:rules-loader
npm run test:xtalpi
npm run test:hy-memory
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-test-ai-berkshire-skill-pack.sh
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-check.sh
bash scripts/pi67-release-artifact-smoke.sh
```

The packed artifact gate must build the distro, run `npm pack --ignore-scripts`,
install the tarball into an isolated prefix/HOME, and execute the installed CLI.
Source-checkout tests alone do not prove that the published artifact works.

Release publication uses `pi-67 publish-check`, npm Trusted Publishing, exact
version and `latest` dist-tag verification, then separately creates committed
GitHub Release assets. None of those external actions are performed by an
ordinary source commit.
