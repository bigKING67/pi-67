# pi-67 skill governance

`~/.agents/skills` is the canonical active skill registry shared by Pi and
Codex. pi-67 stores its distributable skill source in `shared-skills/` and the
installer copies those skills into `~/.agents/skills`.

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

## Migration rule

When a legacy manifest reports `stale_broken_link`, do not automatically restore
that skill. First recover the source skill, inspect its `SKILL.md`, then classify
it as public distribution, personal overlay, or obsolete.
