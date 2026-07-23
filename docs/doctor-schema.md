# pi-67 doctor JSON schema v2

`pi-67 doctor --json` delegates to the active distro's POSIX or PowerShell
doctor and emits `pi67-doctor/v2`.

## Top-level contract

```json
{
  "schemaVersion": 2,
  "schemaId": "pi67-doctor/v2",
  "generatedAt": "2026-07-22T12:00:00Z",
  "generatedBy": "scripts/pi67-doctor.sh",
  "pi67": {
    "version": "0.15.4"
  },
  "piCommandAvailable": true,
  "diagnostics": {
    "deepMcp": false,
    "mcpTimeoutMs": 8000,
    "piList": true,
    "piListTimeoutSeconds": 60,
    "skillList": true,
    "skillListTimeoutSeconds": 60
  },
  "installMode": "immutable-release",
  "repository": "/home/user/.pi/agent",
  "agentDir": "/home/user/.pi/agent",
  "agent": {
    "dir": "/home/user/.pi/agent",
    "installMode": "immutable-release"
  },
  "result": "READY WITH WARNINGS",
  "counts": {
    "pass": 47,
    "warn": 1,
    "fail": 0
  },
  "checks": [
    {
      "level": "PASS",
      "message": "pi command found"
    }
  ]
}
```

PowerShell adds `diagnostics.strictSharedSkills` and uses
`generatedBy=scripts/pi67-doctor.ps1`.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | integer | Always `2`. |
| `schemaId` | string | Always `pi67-doctor/v2`. |
| `generatedAt` | string | UTC generation time. |
| `generatedBy` | string | POSIX or PowerShell doctor implementation. |
| `pi67.version` | string | Active distro version read from `VERSION`. |
| `piCommandAvailable` | boolean | Whether a real `pi` command is resolvable. |
| `diagnostics.deepMcp` | boolean | Whether deeper MCP probes ran. |
| `diagnostics.mcpTimeoutMs` | integer | POSIX deep-MCP timeout. |
| `diagnostics.piList` | boolean | Whether `pi list --no-approve` was requested. |
| `diagnostics.piListTimeoutSeconds` | integer | Package probe timeout. |
| `diagnostics.skillList` | boolean | Deprecated compatibility mirror of `piList`. |
| `diagnostics.skillListTimeoutSeconds` | integer | Deprecated compatibility mirror. |
| `diagnostics.strictSharedSkills` | boolean | PowerShell strict Skill conflict mode, when present. |
| `installMode` | string | Observed workspace layout. |
| `repository` | string | Distro/workspace root used by the script. |
| `agentDir` | string | Active Pi workspace. |
| `agent` | object | Compatibility grouping for dir/installMode. |
| `result` | enum | `READY`, `READY WITH WARNINGS`, or `NOT READY`. |
| `counts` | object | PASS/WARN/FAIL totals. |
| `checks` | array | Ordered check results with `level` and `message`. |

## Pi boundary

Doctor v2 intentionally has no Pi version fields, release-tested version,
registry latest query, compatibility comparison, or Pi update command. Pi is
an independent runtime.

Allowed diagnostics:

1. `piCommandAvailable`;
2. real `pi list --no-approve` package resolution;
3. real startup/tool acceptance in the dedicated acceptance scripts.

The non-interactive package probe may report warnings or timeout, but those are
not Pi version compatibility conclusions.

On Windows, commands resolved to `.ps1` shims are executed through the current
PowerShell host rather than passed directly to `ProcessStartInfo`. A failed
package probe reports its exit code and a bounded first error line; consumers
must not infer an upstream Pi version problem from that warning.

## Exit and result semantics

```text
fail > 0  -> NOT READY, non-zero exit
fail = 0 and warn > 0 -> READY WITH WARNINGS, zero exit
fail = 0 and warn = 0 -> READY, zero exit
```

Preserved user-modified Skills or optional external components may create a
warning without making the workstation unusable. Consumers should inspect
`counts.fail` before treating any warning as a failed release.

## Commands

Default:

```bash
pi-67 doctor --json
```

Skip package probe:

```bash
pi-67 doctor --no-pi-list --json
```

Set timeout:

```bash
pi-67 doctor --pi-list-timeout-seconds 60 --json
```

POSIX deep MCP:

```bash
pi-67 doctor --deep-mcp --mcp-timeout-ms 8000 --json
```

Strict shared Skills:

```bash
pi-67 doctor --strict-shared-skills --json
```

## Extension-specific deep doctor

Use the manager-native extension schema when per-extension baseline/load status
is required:

```bash
pi-67 extensions doctor --deep --json
```

That output includes:

```text
schema=pi67.extensions-doctor.v2
managedExtensions.schema=pi67.managed-extensions-status.v1
managedExtensions.loadProbe.schema=pi67.pi-extension-load-probe.v1
managedExtensions.summary.loadFailed
```

A successful recognized Pi list probe that omits a configured default package
marks only that entry `load-failed` and keeps it without automatic overwrite.

## Security

The JSON must not include auth tokens, passwords, cookies, private keys, raw
MCP environment variables, session text, or memory payloads. Check messages
must summarize a condition rather than dump a secret-bearing file.
