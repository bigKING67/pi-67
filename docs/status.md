# pi-67 状态与更新计划

适用版本：`0.15.0`。

## 命令层级

| 命令 | 写入 | 成本 | 用途 |
| --- | --- | --- | --- |
| `pi-67 version --json` | 否 | 很低 | manager/distro/Node/platform/theme |
| `pi-67 status --json` | 否 | 低 | 当前工作台、extensions、Skills、external 摘要 |
| `pi-67 update --check --json` | 否 | 中 | 生成可执行 update plan |
| `pi-67 extensions status --deep --json` | 否 | 中 | 内容 hash + 真实 Pi package load probe |
| `pi-67 doctor --json` | 否 | 高 | 配置、脚本、MCP、package 与运行态检查 |
| `pi-67 update` | 是 | 中/高 | 激活 distro 并执行安全 baseline action |

所有命令都不安装、更新或比较 Pi 版本。

## `pi67.version.v2`

```json
{
  "schema": "pi67.version.v2",
  "manager": {
    "package": "@bigking67/pi-67",
    "version": "0.15.0"
  },
  "distro": {
    "version": "0.15.0",
    "releasePath": "~/.pi/pi67/releases/0.15.0",
    "immutable": true
  },
  "runtime": {
    "node": "v24.x",
    "platform": "darwin-arm64"
  },
  "theme": {},
  "paths": {
    "agentDir": "~/.pi/agent",
    "stateDir": "~/.pi/pi67"
  },
  "recommendations": []
}
```

源码 checkout maintainer mode 可能显示 `immutable=false`、空 `releasePath`；只有真实
install/migrate 后的 active pointer 能证明 immutable runtime 已激活。

canonical `~/.pi/agent` 继续使用 `~/.pi/pi67`；custom `--agent-dir` 的
`paths.stateDir` 为稳定的 `~/.pi/pi67/workspaces/<id>`，用于隔离 pointer、
ledger、locks、backups、journals 和 migrations。

## `pi67.update-plan.v1`

顶层：

```text
schema
createdAt
manager
paths
policy
distro
runtimeState
settings
extensions
skills
skillPacks
external
actions
blocked
warnings
recommendations
```

### `extensions.summary`

```text
total
missing
belowBaseline
atBaseline
userManagedAhead
userManagedDiverged
loadFailed
unknown
automaticActions
```

普通 plan 不运行 Pi load probe，因此 `loadFailed` 通常为 0；使用
`extensions doctor/status --deep` 才能产生真实 load-probe 结论。

### action 语义

每个 action 至少含：

```text
id
kind
operation
writes[]
preserves[]
risk
reason
explicitCommand?
```

`actions` 只包含 manager 能安全执行的写入；ahead/diverged/unknown 不应出现自动
overwrite action。

### blockers

`blocked` 表示必须先由 owner 处理的状态，例如 manager freshness、strict Skill
conflict 或 dirty external repo。legacy active workspace 由 `migrate --check` 独立
诊断，不通过 Git pull plan 接管。

### warnings

常见 warning：

- user-modified active Skills 被保留；
- diverged extension 被保留；
- remote check 被跳过；
- optional external repo 未安装。

warning 不等于失败。先看 `blocked`、missing 和真实 load failure。

## Extension 状态

`pi67.managed-extensions-status.v1` 包含：

```text
policy
ledger
loadProbe
summary
extensions[]
unknown[]
```

最低 baseline policy：

```json
{
  "versionModel": "minimum-supported-baseline",
  "missing": "install",
  "behindManaged": "upgrade",
  "atBaseline": "keep",
  "ahead": "keep-never-downgrade",
  "diverged": "keep-and-report-conflict",
  "unknown": "keep-user-managed"
}
```

深度 load probe schema：`pi67.pi-extension-load-probe.v1`。只有 probe exit 0、识别
`User packages:` 且已配置 spec 未出现在 resolved list 时，才把该 entry 标记
`load-failed`；探针自身失败不会伪装成单个 extension 内容故障。

## Skills 状态

shared Skills 摘要：

```text
source
missing
identical
conflicts
preservedUserModified
```

默认策略：missing 自动补齐，conflict 保留。first-party Pack status 额外输出：

```text
owner=pi67-first-party
distribution=bundled-release-only
```

## 推荐读取顺序

```bash
pi-67 version --json
pi-67 update --check --no-remote --json
pi-67 extensions doctor --deep --json
pi-67 doctor --json
```

解读：

1. manager/distro 是否同版本；
2. active immutable release path 是否存在；
3. `blocked` 是否为空；
4. extension missing/below/ahead/diverged/loadFailed；
5. Skill missing/conflict；
6. warning 是否只是保留用户修改；
7. `pi` command 与真实 package resolution 是否通过。

## 输出与隐私

状态 JSON 不应包含 token/password/private key/cookie、完整 auth、MCP environment、
session 文本或 memory payload。若需要提交诊断，先保存本地 artifact并做字段级摘要。
