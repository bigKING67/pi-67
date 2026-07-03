# pi-67 Report Schema

`~/.pi/agent/pi67-report.json` is the machine-readable current-state report written by `scripts/pi67-report.sh` after install/update.

The report is intentionally a single overwritten file. It is not an append-only history log.

## Retention contract

- Path by default: `~/.pi/agent/pi67-report.json`
- Write mode: atomic temp-file write followed by rename
- Permissions: best-effort `0600`
- Retention: single current-state file
- Secrets: no API keys, tokens, cookies, private keys, session stores, raw logs, or raw MCP stderr

## Schema versioning

Current schema:

```json
{
  "schemaVersion": 2,
  "schemaId": "pi67-report/v2"
}
```

Compatibility rule:

- Consumers should require `schemaVersion >= 2` for the structured `pi67` and `diagnostics` blocks.
- Legacy top-level `pi67Version` and `packageVersion` are kept for older consumers.
- New optional fields may be added in future minor releases.
- Existing stable fields should not be renamed or removed without a schemaVersion bump.

## v2 top-level fields

| Field | Type | Stability | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | number | stable | Report schema version. Current value: `2`. |
| `schemaId` | string | stable | Schema identifier. Current value: `pi67-report/v2`. |
| `generatedAt` | string | stable | ISO timestamp for report generation. |
| `generatedBy` | string | stable | Script that generated the report. |
| `operation` | string | stable | One of `install`, `update`, or `manual` by convention. |
| `pi67Version` | string | legacy-stable | Legacy alias for `pi67.version`. |
| `packageVersion` | string/null | legacy-stable | Legacy alias for `pi67.packageVersion`. |
| `pi67` | object | stable | pi-67 distribution metadata. |
| `reportPolicy` | object | stable | Retention/write policy metadata. |
| `diagnostics` | object | stable | Reporter diagnostic parameters. |
| `installMode` | string | stable | `in-place` when the repo root is the agent dir; otherwise `linked`. |
| `repository` | object | stable | pi-67 checkout state. |
| `sharedSkillsRoot` | string | stable | Canonical active skill root, normally `~/.agents/skills`. |
| `sharedSkills` | object | stable | Shared skill source/install/duplicate state. |
| `externalPackages` | array | deprecated | Always empty under shared skill governance. Kept for compatibility. |
| `agent` | object | stable | Pi agent directory state. |
| `runtime` | object | stable | Local runtime versions. |
| `doctor` | object | passthrough | Doctor JSON result (`pi67-doctor/v2`) or reporter parse/skip diagnostics. |
| `xtalpiSmoke` | object | optional-stable | Read-only compact summary of local `xtalpi-pi-tools` smoke artifacts, strict trend status, and full-suite drift status. |

## `pi67`

```json
{
  "version": "0.8.0",
  "packageVersion": "0.8.0"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | string | Distribution version from `VERSION`. |
| `packageVersion` | string/null | `package.json.version`, expected to match `version`. |

## `reportPolicy`

```json
{
  "currentFileOverwritten": true,
  "historicalReports": false,
  "retention": "single-current-file"
}
```

This block is intentionally explicit so downstream tools do not assume report history exists.

## `diagnostics`

```json
{
  "doctorTimeoutMs": 90000,
  "doctorDeepMcp": false,
  "mcpTimeoutMs": 2500
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `doctorTimeoutMs` | number | Timeout used for doctor JSON collection. |
| `doctorDeepMcp` | boolean | Whether report generation requested doctor `--deep-mcp`. |
| `mcpTimeoutMs` | number | Per-server timeout passed to deep MCP doctor mode. |

## `repository`

```json
{
  "root": "/path/to/pi-67",
  "branch": "main",
  "commit": "full_sha",
  "shortCommit": "3417566",
  "dirty": false,
  "remote": "https://github.com/bigKING67/pi-67.git"
}
```

`dirty` is derived from `git status --porcelain=v1 --untracked-files=all`.

## `sharedSkills`

```json
{
  "canonicalRoot": "~/.agents/skills",
  "sourceDir": "/path/to/pi-67/shared-skills",
  "sourceCount": 31,
  "installedCount": 31,
  "sourceSkills": ["lark-base"],
  "installedSkills": ["lark-base"],
  "missingInstalled": [],
  "duplicateRoots": [],
  "activeSkillPackageSources": []
}
```

`missingInstalled` should be empty after install/update. `duplicateRoots`
reports legacy active roots such as `~/.pi/agent/skills` or package clone
`skills/` directories when they overlap with the canonical global root.
`activeSkillPackageSources` should be empty; skill repositories are installed
into `~/.agents/skills` instead of declared as active Pi packages.

## `externalPackages`

This field is kept as an empty array for compatibility with older consumers.
Do not use it for shared skill readiness; read `sharedSkills` instead.

## `agent`

```json
{
  "dir": "~/.pi/agent",
  "installMode": "in-place",
  "reportPath": "~/.pi/agent/pi67-report.json",
  "files": {
    "settings": { "exists": true, "type": "file", "classification": "tracked_file" },
    "agents": { "exists": true, "type": "file", "classification": "tracked_file" },
    "rules": { "exists": true, "type": "directory", "classification": "tracked_dir" },
    "prompts": { "exists": true, "type": "directory", "classification": "tracked_dir" },
    "sharedSkillsSource": { "exists": true, "type": "directory", "classification": "tracked_dir" },
    "legacyAgentSkills": { "exists": false, "type": "missing", "classification": "missing" },
    "scripts": { "exists": true, "type": "directory", "classification": "tracked_dir" },
    "models": { "exists": true, "type": "file", "classification": "local_file" },
    "mcp": { "exists": true, "type": "file", "classification": "local_file" },
    "auth": { "exists": true, "type": "file", "classification": "local_file" },
    "imageGen": { "exists": true, "type": "file", "classification": "local_file" }
  }
}
```

File `type` is one of `symlink`, `directory`, `file`, `other`, or `missing`.

File `classification` is one of `tracked_file`, `tracked_dir`, `local_file`, `ignored_runtime`, `symlink`, `missing`, or `other`. Linked installs usually report tracked assets as `symlink`; in-place installs report them as `tracked_file` or `tracked_dir`.

## `runtime`

```json
{
  "platform": "darwin",
  "arch": "arm64",
  "hostname": "machine",
  "node": "v24.18.0",
  "npm": "11.6.2",
  "pi": "0.0.0"
}
```

`hostname` is included for local diagnostics. Do not publish report files if you consider hostnames sensitive.

## `doctor`

When doctor runs successfully with `--json`, this block includes the doctor result:

```json
{
  "skipped": false,
  "exitCode": 0,
  "deepMcp": false,
  "schemaVersion": 2,
  "schemaId": "pi67-doctor/v2",
  "generatedBy": "scripts/pi67-doctor.sh",
  "result": "READY WITH WARNINGS",
  "counts": {
    "pass": 32,
    "warn": 8,
    "fail": 0
  },
  "checks": []
}
```

The embedded doctor schema is documented in `docs/doctor-schema.md`. Consumers that depend on structured doctor metadata should require `doctor.schemaVersion >= 2` when `doctor.skipped !== true`.

When doctor is skipped:

```json
{
  "skipped": true,
  "reason": "disabled by caller"
}
```

When doctor fails to emit valid JSON:

```json
{
  "skipped": false,
  "exitCode": null,
  "signal": "SIGTERM",
  "error": "spawnSync bash ETIMEDOUT",
  "deepMcp": false,
  "parseError": "doctor did not emit valid JSON",
  "timeoutMs": 90000,
  "stdoutBytes": 0,
  "stderrBytes": 0
}
```

The reporter intentionally stores byte counts instead of raw stdout/stderr to avoid leaking local private details.

## `xtalpiSmoke`

`scripts/pi67-report.sh` includes a read-only smoke artifact summary by default.
It does not run live smoke cases and does not write to the smoke artifact
directory. It calls debug-summary JSON modes and stores compact results:

```json
{
  "schemaVersion": 1,
  "schemaId": "pi67-xtalpi-smoke-status/v1",
  "artifactDir": "<home>/tmp/xtalpi-pi-tools-smoke",
  "historyLimit": 3,
  "strictTrendLimit": 3,
  "driftLimit": 10,
  "result": "ATTENTION",
  "history": {
    "ok": true,
    "data": {
      "found": 3,
      "totalArtifacts": 77,
      "candidateArtifacts": 77,
      "filteredOutArtifacts": 0,
      "runs": [
        {
          "runId": "20260703-151935",
          "runKind": "full-suite",
          "ok": true,
          "failures": 0,
          "cases": 8,
          "requestCount": 18,
          "requestLatencyMsMin": 1110,
          "requestLatencyMsMax": 123058,
          "requestLatencyMsAvg": 19574,
          "slowRequestCount": 2,
          "slowRequestThresholdMs": 60000
        }
      ]
    }
  },
  "strictTrendGate": {
    "ok": true,
    "data": {
      "ok": true,
      "candidateArtifacts": 42,
      "filteredOutArtifacts": 35,
      "filter": {
        "runKinds": ["full-suite"]
      },
      "runKindCounts": {
        "full-suite": 3
      },
      "gateFailures": [],
      "runs": [
        {
          "runId": "20260703-151935",
          "requestCount": 18,
          "requestLatencyMsMax": 123058,
          "requestLatencyMsAvg": 19574,
          "slowRequestCount": 2,
          "slowRequestThresholdMs": 60000
        }
      ]
    }
  },
  "drift": {
    "ok": true,
    "data": {
      "found": 5,
      "requested": 10,
      "filter": {
        "runKinds": ["full-suite"]
      },
      "drift": {
        "providerModelChanged": false,
        "caseSetChanged": false,
        "runtimeFingerprintChanged": true,
        "runtimeBoundsChanged": false,
        "providerHealthChanged": false,
        "qualitySignalsPresent": true
      },
      "qualityTotals": {
        "requestLatencyMsMax": 123058,
        "slowRequestCount": 2
      },
      "dimensions": {
        "runtimeFingerprints": [
          {
            "sha256": "95eec8991ba8e52e",
            "count": 3
          }
        ]
      },
      "runs": [
        {
          "runId": "20260703-151935",
          "requestLatencyMsMax": 123058,
          "requestLatencyMsAvg": 19574,
          "slowRequestCount": 2,
          "runtimeFingerprintSha256": "95eec8991ba8e52e",
          "runtimeBoundsSha256": "076487a98c40fedd",
          "providerHealthSha256": "b7d1db01e9af26c8"
        }
      ]
    }
  }
}
```

Result values:

| Result | Meaning |
| --- | --- |
| `OK` | Smoke artifacts were found, history parsed, the `full-suite-strict` trend gate passed, and the drift command parsed when enabled. |
| `ATTENTION` | History, strict trend, or drift evaluation failed to run/parse, or strict trend returned gate failures. |
| `NO_ARTIFACTS` | The artifact directory is missing; this is informational for fresh installs. |
| `UNAVAILABLE` | The local debug-summary helper is missing or not executable. |

Options:

```bash
bash ~/.pi/agent/scripts/pi67-report.sh --xtalpi-smoke-dir /path/to/xtalpi-pi-tools-smoke
bash ~/.pi/agent/scripts/pi67-report.sh --xtalpi-smoke-drift 20
bash ~/.pi/agent/scripts/pi67-report.sh --no-xtalpi-smoke
```

The `strictTrendGate` block uses the `full-suite-strict` profile, which filters
persisted summaries to `runKind=full-suite` before selecting newest N. The
overall `history` block remains unfiltered so consumers can still see the latest
targeted or preflight-failed diagnostic runs. Compact run entries preserve
request-latency telemetry when it is present in smoke summaries:
`requestCount`, `requestLatencyMsMin`, `requestLatencyMsMax`,
`requestLatencyMsAvg`, `slowRequestCount`, and `slowRequestThresholdMs`. Older
artifacts that predate latency telemetry are backfilled from per-case debug
JSONL when those files are present; otherwise these fields may report as `null`.

The `drift` block is produced from `--drift <N> --run-kind full-suite`. It is a
compact, read-only observability surface rather than a pass/fail gate: consumers
can alert on `runtimeFingerprintChanged`, `runtimeBoundsChanged`, provider
health signature changes, or historical quality-signal presence without
weakening the strict full-suite trend gate. `qualityTotals.requestLatencyMsMax`
and `qualityTotals.slowRequestCount` expose whether recent full-suite artifacts
contained slow model requests without turning drift into a default performance
gate.

## Consumer guidance

Minimal freshness check:

```js
const report = JSON.parse(fs.readFileSync(`${process.env.HOME}/.pi/agent/pi67-report.json`, "utf8"));
if (report.schemaVersion < 2) throw new Error("pi67 report schema too old");
if (report.repository.dirty) console.warn("pi-67 checkout was dirty when report was generated");
console.log(report.pi67.version, report.repository.shortCommit, report.doctor.result);
```

For a no-write update preview, prefer:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --check-only
```
