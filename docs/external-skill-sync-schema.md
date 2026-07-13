# pi-67 External Skill Sync Schema

`scripts/pi67-sync-external-skills.sh --json` emits the machine-readable sync
plan/result for copying skills from external repositories into the canonical
shared skill registry.

The command answers one question: which external skill directories can be
installed into `~/.agents/skills` without overwriting canonical skills?

Supported source layouts:

```text
repo/SKILL.md
repo/skills/<skill-name>/SKILL.md
```

Manifest-built monorepos with deeper source layouts or materialized shared
resources are outside this generic copy contract. Use the upstream repository's
own installer, or a dedicated pi-67 vendoring helper, rather than recursively
copying source directories without their build step.

For `repo/SKILL.md`, the canonical skill name is read from the `name:` field in
the `SKILL.md` frontmatter. For `repo/skills/<skill-name>/SKILL.md`, the same
frontmatter name is used when present; otherwise the directory basename is used.

## Schema versioning

Current schema:

```json
{
  "schemaVersion": 1,
  "schemaId": "pi67-external-skill-sync/v1"
}
```

Compatibility rule:

- Consumers should require `schemaId === "pi67-external-skill-sync/v1"`.
- Existing top-level fields should not be renamed without a schema version bump.
- New optional fields may be added in future minor releases.

## Top-level fields

| Field | Type | Stability | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | number | stable | External sync schema version. Current value: `1`. |
| `schemaId` | string | stable | Schema identifier. Current value: `pi67-external-skill-sync/v1`. |
| `generatedAt` | string | stable | UTC timestamp for report generation. |
| `mode` | string | stable | `dry-run` or `apply`. |
| `sharedSkillsDir` | string | stable | Canonical shared skill root. |
| `backupDir` | string | reserved | Reserved for future explicit replace flows; current sync does not overwrite. |
| `repositories` | array | stable | Per external repository inspection result. |
| `actions` | array | stable | Planned copy actions. |
| `counts` | object | stable | Aggregate result counters. |
| `hints` | array | stable | Optional user-facing follow-up hints. |
| `result` | string | stable | Final sync result. |

## `result`

`result` is one of:

| Result | Meaning |
| --- | --- |
| `NOOP` | All discovered skills are already installed and identical. |
| `READY_TO_APPLY` | Dry-run found missing canonical skills and no conflicts. |
| `APPLIED` | Apply mode copied missing canonical skills. |
| `NEEDS_REVIEW` | At least one canonical skill differs from an external copy; no overwrite is performed. |
| `INVALID_INPUT` | At least one `--repo` does not exist or has no `SKILL.md` / `skills/*/SKILL.md` entries. |

When `--apply` sees `NEEDS_REVIEW` or `INVALID_INPUT`, the command exits
non-zero and leaves canonical skills unchanged.

## `repositories[]`

Each repository entry records whether a source repo has valid skill directories:

```json
{
  "repo": "/path/to/design-craft",
  "exists": true,
  "skillsDir": "/path/to/design-craft/skills",
  "sourceLayouts": ["skills-dir"],
  "skillCount": 2,
  "skills": []
}
```

Root-level single-Skill repositories report `sourceLayouts: ["repo-root"]`:

```json
{
  "repo": "/path/to/root-skill-repo",
  "exists": true,
  "skillsDir": "/path/to/root-skill-repo/skills",
  "sourceLayouts": ["repo-root"],
  "skillCount": 1,
  "skills": []
}
```

Invalid entries include an `error` field:

```json
{
  "repo": "/missing/repo",
  "exists": false,
  "skillsDir": "/missing/repo/skills",
  "sourceLayouts": [],
  "skillCount": 0,
  "skills": [],
  "error": "repo not found"
}
```

## `repositories[].skills[]`

Each skill entry compares an external repo skill with the canonical shared root:

```json
{
  "name": "design-craft",
  "status": "identical",
  "sourceLayout": "skills-dir",
  "source": "/path/to/design-craft/skills/design-craft",
  "canonical": "~/.agents/skills/design-craft",
  "sourceHash": "sha256...",
  "canonicalHash": "sha256..."
}
```

`status` is one of:

| Status | Meaning |
| --- | --- |
| `missing-canonical` | `~/.agents/skills/<name>` is missing and can be copied from the external repo. |
| `identical` | Canonical and external directories have the same fingerprint. |
| `conflict` | Canonical and external directories differ. The helper refuses to overwrite. |

Fingerprints are directory-content SHA-256 digests over file paths and file
content. They are intended for equality checks, not for user-facing security
claims.

For root-level repositories, repository/cache/private-eval artifacts are
ignored for both fingerprints and copies. The filtered paths include `.git`,
`.gitignore`, `.DS_Store`, Python/Node caches, common build output, virtual
environments, and `eval/answers`.

## `actions[]`

Current action type:

```json
{
  "type": "copy-skill",
  "name": "design-craft",
  "source": "/path/to/design-craft/skills/design-craft",
  "destination": "~/.agents/skills/design-craft"
}
```

Apply mode only executes `copy-skill` actions after all repositories are valid
and all discovered canonical copies are non-conflicting.

## `counts`

```json
{
  "repos": 2,
  "reposWithSkills": 2,
  "invalidRepos": 0,
  "skillsScanned": 4,
  "missingCanonical": 1,
  "identical": 3,
  "conflicts": 0,
  "copied": 1
}
```

`copied` is only non-zero in apply mode.

## `hints`

`hints[]` is for non-blocking follow-up guidance. For browser67-like repos, the
sync command may recommend:

```text
browser67 MCP hint: run scripts/pi67-configure.sh --tmwd-repo /path/to/browser67 --no-prompt if this checkout should serve MCP.
```

Hints do not imply that the sync command edited MCP config.

## Secret handling

External sync JSON may include local repository paths and skill names. It must
not include API keys, cookies, tokens, raw config files, or full skill content.

Do not publish sync JSON from a private workstation without reviewing path names
first.
