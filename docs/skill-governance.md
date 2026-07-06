# pi-67 skill governance

`~/.agents/skills` is the canonical active skill registry shared by Pi and
Codex. pi-67 stores its distributable skill source in `shared-skills/` and the
installer copies those skills into `~/.agents/skills`.

The global registry is authoritative for already-installed skills. If a target
machine already has `~/.agents/skills/<name>` and its content differs from the
pi-67 bundled baseline, installers and updaters keep the existing global skill
by default and warn. A hash mismatch only proves that the directories differ;
it does not prove the pi-67 copy is newer. Use `--strict-shared-skills` only
for release/parity checks where differing global skills should block.

`~/.pi/agent/skills` is legacy. If it exists with active skills, treat it as a
duplicate source and remove or back it up after confirming the same skills exist
in `~/.agents/skills`.

The installer handles linked installs by backing up `~/.pi/agent/skills` into
the normal install backup directory. The update helper removes only old
pi-67-owned skill symlinks; local non-symlink directories are preserved and
reported so the user can review them manually.

## Classification

Use three buckets when migrating or reviewing skills.

### A. Public distribution skill

Add a skill to `shared-skills/` only when it is suitable for other machines:

- no secrets, credentials, cookies, or private tokens
- no personal absolute paths
- clear `SKILL.md` entrypoint
- documented trigger/use case
- dependencies are either standard tools or documented optional prerequisites
- useful beyond one local workflow

`commerce-growth-os` is a public distribution skill in this bucket. Its
upstream source repository is:

```text
https://github.com/bigKING67/commerce-growth-os
```

pi-67 keeps a vendored distribution copy at
`shared-skills/commerce-growth-os` so other macOS/Windows machines receive it
through the normal pi-67 pull/update path. Do not put a maintainer's local
checkout path or this GitHub repository into `settings.json.packages`; the
active copy should still be installed into `~/.agents/skills` by the normal
shared-skill sync.

### B. Personal overlay skill

Keep a skill outside this repository when it is useful locally but not suitable
for public distribution:

- depends on a private repo, account, browser profile, or local path
- contains personal workflow assumptions
- wraps a tool that is not part of the pi-67 distribution
- is experimental or too narrow for shared release

Use `~/.agents/skills` or a private repository for this class. Do not copy it
into pi-67 just because it existed in an old runtime manifest.

### Package-owned external skill

When a skill has its own public source-of-truth repository and release cadence,
install the skill into the global active root instead of declaring it as an
active Pi package:

```text
~/.agents/skills/design-craft
~/.agents/skills/frontend-craft
~/.agents/skills/tmwd-browser-mcp
~/.agents/skills/js-reverse
```

Normal installs copy the skill directories into `~/.agents/skills`. Symlinks are
only for local development when the maintainer wants live edits in a checkout to
be visible immediately.

If the same repository also provides MCP servers, keep that checkout/cache
outside active skill roots and point `mcp.json` at the server files:

```text
~/.agents/packages/browser67/src/mcp/browser/server.mjs
~/.agents/packages/browser67/src/mcp/js-reverse/server.mjs
```

Do not install or expose the same skill name from both `~/.agents/skills` and
`~/.pi/agent/git/.../skills`; Pi will de-duplicate, but the warning means the
skill registry is no longer single-source.

### C. Stale or obsolete skill

Do not restore a legacy entry when its symlink target is missing, it has no
`SKILL.md`, or it is superseded by a newer maintained skill. Keep the old
manifest as evidence, but leave the skill out of the active distribution.

## Audit helper

Use the audit helper to compare pi-67 shared skills with legacy manifests:

```bash
bash scripts/pi67-skill-audit.sh \
  --legacy-names /path/to/current-skills.txt \
  --legacy-links /path/to/current-skill-symlinks.txt
```

Generate a local ignored JSON report:

```bash
bash scripts/pi67-skill-audit.sh \
  --legacy-names /path/to/current-skills.txt \
  --legacy-links /path/to/current-skill-symlinks.txt \
  --json \
  --output ~/.pi/agent/pi67-skill-audit.json
```

`pi67-skill-audit.json` is ignored because it may include local machine paths or
private overlay skill names.

Use the inventory helper when doctor reports that global shared skills differ
from pi-67's bundled source:

```bash
bash scripts/pi67-shared-skills-inventory.sh
bash scripts/pi67-shared-skills-inventory.sh --json
```

The inventory is read-only. It compares `shared-skills/` with
`~/.agents/skills`, reports matching / missing / differing / extra global
skills, and includes per-skill SHA-256 fingerprints in JSON mode without
printing skill contents. A `global_differs` entry means pi-67 will keep the
existing global skill by default; use `--strict` only for release/parity checks
that should fail when global content differs from the bundled baseline.

## Migration helper

Use the migration helper when Pi reports duplicate/conflict/skipped skill
selection warnings, or when an old install still has active skill roots under
`~/.pi/agent`:

```bash
bash scripts/pi67-migrate-skills.sh --dry-run
bash scripts/pi67-migrate-skills.sh --apply --yes
```

It scans the known legacy active roots:

```text
~/.pi/agent/skills
~/.pi/agent/git/github.com/bigKING67/design-craft/skills
~/.pi/agent/git/github.com/bigKING67/browser67/skills
```

Rules:

- Copy a legacy skill into `~/.agents/skills/<name>` only when the canonical
  skill is missing.
- Treat byte-identical canonical skills as already migrated.
- Treat different canonical skills as conflicts; do not overwrite either side.
- Move fully migrated legacy roots into a timestamped backup directory.
- Default to dry-run; require `--apply --yes` for writes.

The backup is intentionally a move, not a delete. If a migration was too broad,
restore the backed-up root manually or with the normal restore workflow.

## External repo sync helper

Use the external sync helper for package-owned skill repositories:

```bash
bash scripts/pi67-sync-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67 \
  --dry-run

bash scripts/pi67-sync-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67 \
  --apply --yes
```

This command reads either `repo/SKILL.md` or `repo/skills/*/SKILL.md` from each
repo and copies missing skills into `~/.agents/skills`. It skips identical
skills and refuses different canonical copies. It deliberately does not modify
Pi package cache directories or MCP config; for browser67 MCP paths, run:

```bash
bash scripts/pi67-configure.sh --tmwd-repo /path/to/browser67 --no-prompt
```

Root-level skill repos such as `commerce-growth-os` can be checked the same way:

```bash
bash scripts/pi67-check-external-skills.sh \
  --repo /path/to/commerce-growth-os

bash scripts/pi67-sync-external-skills.sh \
  --repo /path/to/commerce-growth-os \
  --dry-run
```

`pi67-sync-external-skills.sh` filters repository/cache/private-eval artifacts
when it copies root-level skill repositories, including `.git`, `.gitignore`,
Node/Python caches, virtual environments, build output, and `eval/answers`.

## Vendored commerce-growth-os sync

`commerce-growth-os` is also vendored in pi-67 under
`shared-skills/commerce-growth-os` so ordinary users get it through the normal
pi-67 update path. Maintainers should refresh that vendored copy from the
standalone upstream checkout with:

```bash
bash scripts/pi67-sync-commerce-growth-os.sh \
  --source /path/to/commerce-growth-os \
  --dry-run

bash scripts/pi67-sync-commerce-growth-os.sh \
  --source /path/to/commerce-growth-os \
  --apply --yes
```

The default source is resolved in this order:

```text
$COMMERCE_GROWTH_OS_REPO
../commerce-growth-os next to the pi-67 checkout
```

Use `--source DIR` when the upstream checkout lives elsewhere. The helper
requires `SKILL.md` frontmatter `name: commerce-growth-os`, replaces only
`shared-skills/commerce-growth-os`, filters repository/cache/private-eval
artifacts, and does not stage or commit changes.

## Validation helpers

Use the dedicated governance fixture test when changing migration or external
sync behavior:

```bash
bash scripts/pi67-test-skill-governance.sh
```

It creates temporary legacy roots and external repositories, then validates:

- migration dry-run does not write
- migration apply copies missing skills and backs up migrated roots
- migration conflicts return `NEEDS_REVIEW` and preserve both sides
- external sync dry-run does not write
- external sync apply copies missing skills
- external sync supports both root-level `SKILL.md` and `skills/*/SKILL.md`
- external sync conflicts return `NEEDS_REVIEW` and preserve canonical skills
- commerce-growth-os vendored sync dry-runs/applies without copying repo/cache artifacts
- migration and sync JSON outputs keep their documented schema IDs

Use the optional external repo integration check before applying real
`design-craft`, `browser67`, or similar repo skills into the global registry:

```bash
bash scripts/pi67-check-external-skills.sh \
  --repo /path/to/design-craft \
  --repo /path/to/browser67
```

This command is read-only. It wraps `pi67-sync-external-skills.sh --dry-run
--json`, summarizes missing/identical/conflicting skills, and exits zero for
warnings by default. Add `--strict` in local release preparation when conflicts
or invalid repo paths should fail the check:

```bash
bash scripts/pi67-check-external-skills.sh --repo /path/to/design-craft --strict
```

## Migration rule

When a legacy manifest reports `stale_broken_link`, do not automatically restore
that skill. First recover the source skill, inspect its `SKILL.md`, then classify
it as public distribution, personal overlay, or obsolete.
