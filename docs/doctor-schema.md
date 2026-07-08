# pi-67 Doctor Schema

`scripts/pi67-doctor.sh --json` and `scripts/pi67-doctor.ps1 -Json` emit the
machine-readable readiness result for a pi-67 install.

Doctor answers one question: is the full configuration installed, and which local capabilities still need keys, paths, or binaries?

## Schema versioning

Current schema:

```json
{
  "schemaVersion": 2,
  "schemaId": "pi67-doctor/v2"
}
```

Compatibility rule:

- Consumers should require `schemaVersion >= 2` for the `schemaId`, `generatedBy`, `pi67`, and `diagnostics` fields.
- Legacy fields `repository`, `agentDir`, `result`, `counts`, and `checks` remain stable.
- New optional fields may be added in future minor releases.
- Existing stable fields should not be renamed or removed without a schemaVersion bump.

## Top-level fields

| Field | Type | Stability | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | number | stable | Doctor schema version. Current value: `2`. |
| `schemaId` | string | stable | Schema identifier. Current value: `pi67-doctor/v2`. |
| `generatedAt` | string | stable | UTC timestamp for doctor JSON generation. |
| `generatedBy` | string | stable | Script that generated the result. |
| `pi67` | object | stable | Distribution metadata. |
| `diagnostics` | object | stable | Doctor mode and timeout settings. |
| `installMode` | string | stable | `in-place` when the repo root is the agent dir; otherwise `linked`. |
| `repository` | string | legacy-stable | Repository root inspected by doctor. |
| `agentDir` | string | legacy-stable | Pi agent directory inspected by doctor. |
| `agent` | object | stable | Structured agent metadata, including `dir` and `installMode`. |
| `result` | string | stable | Final readiness result. |
| `counts` | object | stable | PASS/WARN/FAIL counts. |
| `checks` | array | stable | Individual check results. |

## `result`

`result` is one of:

| Result | Meaning |
| --- | --- |
| `READY` | No blocking failures and no warnings. |
| `READY WITH WARNINGS` | Full install is structurally usable, but some optional/local capabilities need setup. |
| `NOT READY` | One or more blocking failures exist. |

Fresh installs often produce `READY WITH WARNINGS` because API keys, MCP paths, or optional local binaries still need user-specific configuration.

Doctor also validates shared skill governance:

- `shared-skills/` must contain pi-67's distributable skill source.
- `~/.agents/skills` must contain installed copies of those shared skills.
- `settings.json` must not declare `design-craft` or `browser67` as active Pi skill packages; install their skills into `~/.agents/skills` instead.
- Existing `~/.pi/agent/skills` or package clone skill directories are reported as duplicate sources when they overlap with `~/.agents/skills`.
- `pi skill list` output is checked for duplicate/conflict/skipped/`auto (user)` skill-selection warnings and reported as a doctor warning when present.

## `counts`

```json
{
  "pass": 32,
  "warn": 8,
  "fail": 0
}
```

`fail > 0` should be treated as blocking. `warn > 0` means the installed configuration is present but not fully locally ready.

## `checks[]`

Each check is a compact object:

```json
{
  "level": "WARN",
  "message": "MCP tmwd_browser path missing or needs local edit: /path/to/browser67"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `level` | string | `PASS`, `WARN`, or `FAIL`. |
| `message` | string | Human-readable diagnostic message. |

Messages are intended for display and troubleshooting. Do not parse specific wording as a long-term API; use `level`, `counts`, and `result` for automation.

## `diagnostics`

```json
{
  "deepMcp": false,
  "mcpTimeoutMs": 2500,
  "skillList": true,
  "skillListTimeoutSeconds": 30
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `deepMcp` | boolean | Whether doctor started stdio MCP servers and called JSON-RPC `initialize` + `tools/list`. |
| `mcpTimeoutMs` | number | Per-server timeout used by deep MCP probing. |
| `skillList` | boolean | Whether doctor ran `pi skill list`. |
| `skillListTimeoutSeconds` | number | Watchdog timeout for `pi skill list`; timeout becomes a `WARN` so doctor does not hang indefinitely. |

Normal doctor mode only checks MCP commands and paths. `--deep-mcp` is opt-in because it starts local MCP server processes.

The PowerShell doctor is Windows-native and intentionally does not start MCP
servers. It emits the same `schemaId`/`schemaVersion` contract, sets
`diagnostics.deepMcp` to `false`, and focuses on local files, config JSON,
xtalpi provider settings, npm sync state, Node engine readiness, shared-skill
copies, and the `/chat/completions` endpoint contract.

If `pi skill list` is slow on a machine, keep doctor bounded:

```bash
pi-67 doctor --no-skill-list
pi-67 doctor --skill-list-timeout-seconds 10
```

Windows PowerShell parity:

```powershell
.\scripts\pi67-doctor.ps1 -SkillList -SkillListTimeoutSeconds 10
```

By default, doctor reports pi-67 bundled shared skills that differ from
installed global skills as `WARN`, not `FAIL`, because the global
`~/.agents/skills/<name>` copy may be newer or intentionally maintained outside
pi-67. Use `--strict-shared-skills` when release/parity checks should treat
those differences as blocking failures.
For an explainable per-skill inventory with hashes, run
`bash scripts/pi67-shared-skills-inventory.sh --json`; the helper is read-only
and keeps existing global skills by default.

Deep MCP probing uses standard `Content-Length` framed stdio JSON-RPC by default.
For browser67 / legacy tmwd-browser-mcp and the local agent-memory EverOS
entrypoint, doctor uses newline-delimited JSON-RPC because those servers expose
line-oriented stdio adapters.

## Secret handling

Doctor JSON must not contain API keys, tokens, cookies, private keys, session stores, raw MCP stderr, or raw local logs.

Deep MCP probe failures intentionally report compact status messages only. They do not print raw MCP stderr because those logs can include machine-specific private details.

## Consumer guidance

Minimal readiness gate:

```js
const doctor = JSON.parse(fs.readFileSync("doctor.json", "utf8"));
if (doctor.schemaVersion < 2) throw new Error("doctor schema too old");
if (doctor.counts.fail > 0) throw new Error("pi-67 is not ready");
if (doctor.counts.warn > 0) console.warn("pi-67 has local readiness warnings");
```

For a quick human summary without generating new JSON, use:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
```
