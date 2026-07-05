# pi-67 Status

`scripts/pi67-status.sh` is the read-only "what state am I in?" command for pi-67 installs.

It summarizes:

- installed pi-67 version and package version
- install mode (`in-place` or `linked`)
- local Git branch, commit, dirty state, upstream ahead/behind
- optional remote branch head status
- `~/.pi/agent/pi67-report.json` freshness
- doctor summary from the latest report
- latest local `xtalpi-pi-tools` smoke artifact history and `full-suite-strict` trend status
- recommended next command

It does **not** run `git pull`, `npm install`, `pi67-doctor.sh`, `pi67-report.sh`, or live smoke tests, and it does not write files.

## Usage

```bash
bash ~/.pi/agent/scripts/pi67-status.sh
```

From a checkout:

```bash
bash scripts/pi67-status.sh
```

Machine-readable output:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh --json
```

Skip the remote `git ls-remote` check:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh --no-remote
```

Inspect a specific branch or remote:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh --remote origin --branch main
```

Inspect a non-default xtalpi smoke artifact directory:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh --xtalpi-smoke-dir /path/to/xtalpi-pi-tools-smoke
```

Skip local smoke artifact summarization:

```bash
bash ~/.pi/agent/scripts/pi67-status.sh --no-xtalpi-smoke
```

## Status results

The JSON `result` field is one of:

| Result | Meaning |
| --- | --- |
| `READY` | Checkout, report, and latest doctor summary are current with no doctor warnings. |
| `READY_WITH_WARNINGS` | No blocking failure, but local readiness warnings, stale/missing report, dirty checkout, or unknown remote state need attention. |
| `UPDATE_AVAILABLE` | Remote has a different/newer head and `pi67-update.sh` should be run. |
| `ACTION_REQUIRED` | Blocking state, such as invalid report JSON, doctor failures, or diverged Git history. |

Human text prints the same value with spaces:

```text
Result: READY WITH WARNINGS
```

## Schema

Current JSON schema:

```json
{
  "schemaVersion": 1,
  "schemaId": "pi67-status/v1"
}
```

Stable top-level fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | number | Status schema version. Current value: `1`. |
| `schemaId` | string | Schema identifier. Current value: `pi67-status/v1`. |
| `generatedAt` | string | ISO timestamp for status generation. |
| `generatedBy` | string | Script that generated the result. |
| `pi67` | object | Version metadata from `VERSION` and `package.json`. |
| `repository` | object | Local checkout state. |
| `remote` | object | Optional remote head state. |
| `installMode` | string | `in-place` when the repo root is the agent dir; otherwise `linked`. |
| `agent` | object | Pi agent directory path. |
| `report` | object | Existing `pi67-report.json` parse/freshness state. |
| `xtalpiSmoke` | object | Read-only compact summary of local xtalpi smoke artifacts, `full-suite-strict` trend status, and full-suite drift status. |
| `result` | string | Overall status result. |
| `blockers` | array | Blocking issues. |
| `warnings` | array | Non-blocking issues. |
| `recommendations` | array | Concrete next commands/actions. |

## xtalpi smoke status

By default, status reads the local smoke artifact directory
`~/tmp/xtalpi-pi-tools-smoke` through:

```bash
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools-debug-summary.sh --history 3 --json
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools-debug-summary.sh --trend-gate 3 --profile full-suite-strict --json
bash ~/.pi/agent/scripts/pi67-xtalpi-pi-tools-debug-summary.sh --drift 10 --run-kind full-suite --json
```

These debug-summary modes are read-only. When an older persisted summary lacks
request-latency fields but its per-case debug JSONL files still exist,
debug-summary backfills the compact request-latency telemetry from those JSONL
files without running live smoke.

The resulting `xtalpiSmoke` block uses schema
`pi67-xtalpi-smoke-status/v1` and includes:

- `artifactDir`, `historyLimit`, `strictTrendLimit`, `driftLimit`, and command
  timeout
- compact `history` data with newest run ids, `runKind`, selected cases,
  recoveries, provider errors, request latency, slow request counts, and summary
  gate status
- compact `strictTrendGate` data with `ok`, gate failures, run-kind counts, and
  recovery trend, plus request latency / slow request telemetry for selected
  trend runs
- compact `rankingTrendGate` data using `full-suite-ranking-strict` when the
  selected full-suite artifacts already contain reason-code telemetry; legacy
  artifacts without reason-code counts are marked as a compatibility skip rather
  than failing status
- compact selected-tool telemetry for the newest strict trend run, including
  selected tool names, `maxTools`, valid / omitted tool counts, clipping state,
  and selected / omitted reason-code counts
- compact `drift` data for newest full-suite artifacts, including provider/model,
  case-set hash, runtime fingerprint hash, runtime bounds hash, provider-health
  hash, request-latency quality signal totals, per-run latency telemetry, and
  drift booleans
- `result`: `OK`, `ATTENTION`, `NO_ARTIFACTS`, or `UNAVAILABLE`

`full-suite-strict` filters the trend gate to `runKind=full-suite` before
selecting newest N, while the plain history block still shows the latest overall
artifacts. Text output includes `eligible`, `filtered_out`, and
`run_kind_filter` so a targeted diagnostic run can be distinguished from full
suite evidence instead of silently weakening the trend gate.

The drift block is observational rather than a gate: it can show historical
runtime or provider-health changes even when the strict trend gate is currently
green. Text output prints drift flags for provider/model, case-set,
runtime-fingerprint, runtime-bounds, provider-health, and quality-signal
presence. When artifact summaries contain request telemetry, text output also
prints compact `request_latency_ms=max/avg/count`, `slow_requests`, and
`slow_request_threshold_ms` fields for the latest history and strict trend runs,
plus drift-level request-latency quality totals.

The ranking gate is compatibility-aware. `pi67-status.sh` first evaluates the
ordinary `full-suite-strict` trend gate and checks whether every selected
full-suite run contains reason-code telemetry. If yes, it also runs
`full-suite-ranking-strict` and treats failures as `ATTENTION`. If not, it prints
`Ranking gate: skipped` with the unsupported run ids; this is informational for
older artifact directories and does not by itself change the top-level status
result. Text output also prints `Tool select:` so newly installed extensions can
be triaged by checking whether they appeared in selected tool names, whether
`maxTools` clipped the list, and how many tools were valid / omitted.

`NO_ARTIFACTS` is informational and does not by itself change the top-level
status result. `ATTENTION` and `UNAVAILABLE` are reported as warnings with a
debug-summary command recommendation.

## Report freshness

Status marks the report stale when:

- `pi67-report.json` is missing or invalid
- report schema is older than `pi67-report/v2`
- report version does not match current `VERSION`
- report commit does not match current checkout commit
- report dirty state does not match current checkout dirty state
- embedded doctor JSON is older than `pi67-doctor/v2`

Regenerate the report with:

```bash
bash ~/.pi/agent/scripts/pi67-report.sh --operation manual
```

Or update the installed checkout and regenerate report in one flow:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh
```

## Choosing status vs update check-only

Use `pi67-status.sh` for the current local summary and recommendation.

Use `pi67-update.sh --check-only` when you want the full update plan preview, including local config template checks and npm sync status:

```bash
bash ~/.pi/agent/scripts/pi67-update.sh --check-only
```
