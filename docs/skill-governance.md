# pi-67 skill governance

`skills/` is part of the public pi-67 distribution. In the recommended in-place
layout, these directories are tracked source under `~/.pi/agent/skills`; they
are not symlinks into a private machine-specific skill root.

## Classification

Use three buckets when migrating or reviewing skills.

### A. Public distribution skill

Add a skill to `skills/` only when it is suitable for other machines:

- no secrets, credentials, cookies, or private tokens
- no personal absolute paths
- clear `SKILL.md` entrypoint
- documented trigger/use case
- dependencies are either standard tools or documented optional prerequisites
- useful beyond one local workflow

### B. Personal overlay skill

Keep a skill outside this repository when it is useful locally but not suitable
for public distribution:

- depends on a private repo, account, browser profile, or local path
- contains personal workflow assumptions
- wraps a tool that is not part of the pi-67 distribution
- is experimental or too narrow for shared release

Use a local/private skill root or private repository for this class. Do not copy
it into pi-67 just because it existed in an old runtime manifest.

### Package-owned external skill

Keep a skill outside `pi-67/skills` when it has its own public source-of-truth
repository and release cadence. Current package-owned skill sources:

```text
git:github.com/bigKING67/design-craft@ae3f27e79893bf8a63fcfb6431842b557be7b46a
git:github.com/bigKING67/browser67@e6b4c1071a6488d84f83db9984c0d986e3105f71
```

These packages are declared in `settings.json` and installed under ignored
runtime package clones:

```text
~/.pi/agent/git/github.com/bigKING67/design-craft
~/.pi/agent/git/github.com/bigKING67/browser67
```

Do not vendor/copy their skills into `~/.pi/agent/skills`. Upgrade flow is:
commit and push the upstream package repo first, then update the pinned
`git:github.com/bigKING67/<repo>@<commit>` source in pi-67.

MCP servers from `browser67` belong in local `mcp.json`, not in pi-67 skill
directories. The tracked `mcp.example.json` points at the package clone's
canonical `src/mcp/...` entrypoints.

### C. Stale or obsolete skill

Do not restore a legacy entry when its symlink target is missing, it has no
`SKILL.md`, or it is superseded by a newer maintained skill. Keep the old
manifest as evidence, but leave the skill out of the active distribution.

## Audit helper

Use the audit helper to compare tracked skills with legacy manifests:

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

## Migration rule

When a legacy manifest reports `stale_broken_link`, do not automatically restore
that skill. First recover the source skill, inspect its `SKILL.md`, then classify
it as public distribution, personal overlay, or obsolete.
