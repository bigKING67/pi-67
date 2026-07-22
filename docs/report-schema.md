# pi-67 report schema v2

`scripts/pi67-report.sh` 与 `scripts/pi67-report.ps1` 生成单文件当前状态报告。

默认路径：`~/.pi/agent/pi67-report.json`。

## Retention

- schema: `pi67-report/v2`；
- 每次原子覆盖，不追加历史；
- POSIX best-effort `0600`，Windows best-effort 当前用户 ACL；
- 不包含 token、password、cookie、private key、raw MCP stderr、session 或 memory
  payload。

## Top-level

```json
{
  "schemaVersion": 2,
  "schemaId": "pi67-report/v2",
  "generatedAt": "2026-07-22T12:00:00Z",
  "generatedBy": "scripts/pi67-report.sh",
  "operation": "manual",
  "pi67Version": "0.15.0",
  "packageVersion": "0.15.0",
  "pi67": {},
  "reportPolicy": {},
  "diagnostics": {},
  "installMode": "immutable-release",
  "repository": {},
  "sharedSkillsRoot": "/home/user/.agents/skills",
  "sharedSkills": {},
  "sharedSkillPacks": {},
  "externalPackages": [],
  "agent": {},
  "runtime": {},
  "doctor": {},
  "xtalpiSmoke": {}
}
```

`externalPackages` 是兼容字段，当前为空。

## `pi67`

```json
{
  "version": "0.15.0",
  "packageVersion": "0.15.0",
  "stateDir": "/home/user/.pi/pi67",
  "release": {
    "version": "0.15.0",
    "path": "/home/user/.pi/pi67/releases/0.15.0",
    "activatedAt": "2026-07-22T12:00:00Z"
  }
}
```

`release` 在 `pi67.stateDir/current.json` 存在、schema 有效且 pointer 绑定当前
agentDir 时出现；source checkout maintainer mode 为 `null`。canonical
`~/.pi/agent` 的 stateDir 是 `~/.pi/pi67`，其他工作台使用稳定的
`~/.pi/pi67/workspaces/<id>`。

## `installMode`

```text
immutable-release  active pointer exists
source-checkout     repoRoot and agentDir are the same source tree
linked-source       repoRoot and agentDir differ without active pointer
```

历史消费者不应只通过 `repository.branch` 判断 runtime 是否有效。0.15.0 的标准用户
layout 不要求 active workspace 是 Git checkout。

## `repository`

```json
{
  "root": "/path/to/source-or-workspace",
  "branch": "main",
  "commit": "full_sha",
  "shortCommit": "027d2cd",
  "dirty": false,
  "remote": "https://github.com/bigKING67/pi-67.git"
}
```

Git fields may be `null` in immutable user layout. They describe the explicit
`repoRoot` used to generate the report, not a requirement for update.

## `runtime`

```json
{
  "platform": "darwin",
  "arch": "arm64",
  "hostname": "host",
  "node": "v24.18.0",
  "npm": "11.x",
  "piCommandAvailable": true
}
```

The report intentionally does not query or store the Pi version. Pi version
management is outside pi-67; only command availability is relevant here.

## `reportPolicy`

```json
{
  "currentFileOverwritten": true,
  "historicalReports": false,
  "retention": "single-current-file"
}
```

## `diagnostics`

```json
{
  "doctorTimeoutMs": 90000,
  "doctorDeepMcp": false,
  "mcpTimeoutMs": 2500
}
```

PowerShell sets deep MCP values to unsupported defaults when applicable.

## `sharedSkills`

The report summarizes bundled source, active root, missing, identical,
conflicts, duplicates, and preserved user-modified Skills. Normal update only
copies missing Skills.

## `sharedSkillPacks`

Passthrough schema: `pi67-shared-skill-packs-status/v1`.

Each pack may include:

```text
name
version
owner
distribution
skills
identical
missing
conflicts
consistent
```

For Commerce/Marketing and AI Berkshire:

```text
owner=pi67-first-party
distribution=bundled-release-only
```

## `agent.files`

Each file/directory state contains existence, type and ownership
classification. Machine-owned runtime examples include:

```text
settings.json
models.json
auth.json
mcp.json
image-gen.json
sessions/
npm/
git/
```

The reporter records metadata/classification, not file content.

## `doctor`

When enabled, this is `pi67-doctor/v2`. When skipped or parse/timeout fails, it
contains an explicit observable diagnostic object rather than fake success.

Doctor v2 exposes `piCommandAvailable` and optional `pi list --no-approve`
probe status, never Pi version compatibility fields.

## `xtalpiSmoke`

Optional compact summary of local xtalpi smoke artifacts. It must not embed
credentials or raw provider payloads. Missing artifacts are reported as
unavailable/skipped, not silently converted to PASS.

## Commands

POSIX:

```bash
bash scripts/pi67-report.sh \
  --operation manual \
  --output /tmp/pi67-report.json
```

PowerShell:

```powershell
& "$env:USERPROFILE\.pi\agent\scripts\pi67-report.ps1" `
  -Operation manual `
  -Output "$env:TEMP\pi67-report.json"
```

No doctor:

```bash
bash scripts/pi67-report.sh --no-doctor --output /tmp/pi67-report.json
```

## Consumer rules

1. Require `schemaVersion >= 2` and matching `schemaId`.
2. Treat new optional fields as forward-compatible.
3. Use `pi67.stateDir`, `pi67.release`, and `installMode`, not Git presence alone,
   for layout.
4. Use `doctor.counts.fail`/`doctor.result`; warnings may represent preserved user state.
5. Never infer Pi version compatibility from this report.
6. Do not persist report history unless an external system defines retention and access control.
