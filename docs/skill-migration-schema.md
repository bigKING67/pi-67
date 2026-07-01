# pi-67 Skill Migration Schema

`scripts/pi67-migrate-skills.sh --json` emits the machine-readable migration
plan/result for retiring legacy active Pi skill roots into the canonical shared
skill registry.

The command answers one question: which legacy skill roots can be safely copied
or moved without overwriting `~/.agents/skills`?

## Schema versioning

Current schema:

```json
{
  "schemaVersion": 1,
  "schemaId": "pi67-skill-migration/v1"
}
```

Compatibility rule:

- Consumers should require `schemaId === "pi67-skill-migration/v1"`.
- Existing top-level fields should not be renamed without a schema version bump.
- New optional fields may be added in future minor releases.

## Top-level fields

| Field | Type | Stability | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | number | stable | Migration schema version. Current value: `1`. |
| `schemaId` | string | stable | Schema identifier. Current value: `pi67-skill-migration/v1`. |
| `generatedAt` | string | stable | UTC timestamp for report generation. |
| `mode` | string | stable | `dry-run` or `apply`. |
| `agentDir` | string | stable | Pi agent directory inspected. Home paths may be displayed as `~`. |
| `sharedSkillsDir` | string | stable | Canonical shared skill root. |
| `backupDir` | string | stable | Backup root for retired legacy skill roots. |
| `roots` | array | stable | Per legacy-root inspection result. |
| `actions` | array | stable | Planned copy or backup actions. |
| `counts` | object | stable | Aggregate result counters. |
| `result` | string | stable | Final migration result. |

## `result`

`result` is one of:

| Result | Meaning |
| --- | --- |
| `NOOP` | No legacy active skill roots or no actions needed. |
| `READY_TO_APPLY` | Dry-run found safe actions and no conflicts. |
| `APPLIED` | Apply mode completed safe actions. |
| `NEEDS_REVIEW` | At least one canonical skill differs from a legacy copy; no overwrite is performed. |

When `--apply` sees `NEEDS_REVIEW`, the command exits non-zero and leaves both
legacy and canonical roots in place.

## `roots[]`

Each root entry describes one known legacy source:

```json
{
  "kind": "legacy-agent-skills",
  "root": "~/.pi/agent/skills",
  "exists": true,
  "skillCount": 1,
  "skills": [],
  "backupTarget": "~/.pi/agent/backup-20260701-120000/skills-migration/skills",
  "willBackupRoot": true
}
```

Known `kind` values:

| Kind | Meaning |
| --- | --- |
| `legacy-agent-skills` | Old active `~/.pi/agent/skills` root. |
| `package-cache-design-craft` | Old Pi package-cache skills for `bigKING67/design-craft`. |
| `package-cache-browser67` | Old Pi package-cache skills for `bigKING67/browser67`. |

## `roots[].skills[]`

Each skill entry compares a legacy skill with the canonical shared root:

```json
{
  "name": "design-craft",
  "status": "identical",
  "source": "~/.pi/agent/git/github.com/bigKING67/design-craft/skills/design-craft",
  "canonical": "~/.agents/skills/design-craft",
  "sourceHash": "sha256...",
  "canonicalHash": "sha256..."
}
```

`status` is one of:

| Status | Meaning |
| --- | --- |
| `missing-canonical` | `~/.agents/skills/<name>` is missing and can be copied from the legacy source. |
| `identical` | Canonical and legacy directories have the same fingerprint. |
| `conflict` | Canonical and legacy directories differ. The helper refuses to overwrite. |

Fingerprints are directory-content SHA-256 digests over file paths and file
content. They are intended for equality checks, not for user-facing security
claims.

## `actions[]`

Actions are deterministic and safe-by-default:

```json
{
  "type": "copy-skill",
  "name": "legacy-skill",
  "source": "~/.pi/agent/skills/legacy-skill",
  "destination": "~/.agents/skills/legacy-skill"
}
```

```json
{
  "type": "backup-root",
  "kind": "legacy-agent-skills",
  "source": "~/.pi/agent/skills",
  "destination": "~/.pi/agent/backup-20260701-120000/skills-migration/skills"
}
```

`copy-skill` is performed before `backup-root` in apply mode. Legacy roots are
moved into backup only when every skill under that root is non-conflicting.

## `counts`

```json
{
  "rootsFound": 1,
  "skillsScanned": 2,
  "missingCanonical": 1,
  "identical": 1,
  "conflicts": 0,
  "rootsToBackup": 1,
  "copied": 1,
  "backedUpRoots": 1
}
```

`copied` and `backedUpRoots` are only non-zero in apply mode.

## Secret handling

Migration JSON may include local file paths and skill names. It must not include
API keys, cookies, tokens, raw config files, or full skill content.

Do not publish migration JSON from a private workstation without reviewing path
names first.
