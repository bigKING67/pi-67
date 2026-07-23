# pi-67 故障排查

适用版本：`0.15.4`。先判断故障属于哪一层：

1. 独立 upstream `pi` runtime；
2. `@bigking67/pi-67` npm manager；
3. immutable distro 与 active workspace；
4. default extension minimum baseline；
5. shared Skills；
6. external browser67/xtalpi/Hy-Memory。

不要用“更新 pi-67”替代所有层的诊断。pi-67 不管理 Pi 版本。

## 1. 最小只读采集

```bash
command -v pi
command -v pi-67
npm prefix -g
pi-67 version --json
pi-67 status --json
pi-67 update --check --no-remote --json
pi-67 extensions plan --json
```

Windows：

```powershell
Get-Command pi -ErrorAction SilentlyContinue
Get-Command pi-67 -ErrorAction SilentlyContinue
npm prefix --global
pi-67 version --json
pi-67 update --check --no-remote --json
```

`status` 和 `update --check` 不写入。先保存 JSON artifact，再只摘取关键字段，不要
在聊天或工单中粘贴 auth、MCP payload 或完整 session。

## 2. `pi` command missing

`pi-67 doctor` 只检查 Pi command 可用性，不会安装或推荐版本。

```bash
command -v pi
```

缺失时按 upstream Pi 官方方式独立安装/修复。修好后重新打开 shell并运行：

```bash
pi --help
pi list --no-approve
```

不要把 `pi-67 launch` 当标准启动器；它只允许作为 Windows PATH refresh helper。

## 3. `pi-67` command missing 或版本错位

```bash
command -v pi-67
npm prefix -g
npm list -g @bigking67/pi-67 --depth=0
pi-67 version --json
```

NVM/fnm 的 global packages 按 Node 版本隔离。切换 Node 后，当前 shell 可能仍指向
另一个 prefix。

显式更新 manager：

```bash
pi-67 self-update --dry-run
pi-67 self-update
```

然后预览/激活它自带 distro：

```bash
pi-67 update --check --json
pi-67 update
```

不要手工复制 Git checkout 来修 manager/distro 版本错位。

## 4. install 拒绝非空 `~/.pi/agent`

这是所有权保护，不是安装器故障。

若存在 `.git`：

```bash
pi-67 migrate --check --json
pi-67 migrate --yes
```

若非空但不是 legacy checkout，先人工确认来源。不要用 destructive clean、
`reset --hard` 或递归删除绕过。machine-owned 状态应先备份。

## 5. migration 失败

### 检查项

```bash
pi-67 migrate --check --json
du -sh ~/.pi/agent/npm ~/.pi/agent/git ~/.pi/agent/sessions ~/.pi/agent/extensions 2>/dev/null
ls -la ~/.pi/pi67/backups
ls -la ~/.pi/pi67/migrations
```

迁移先 rename 原 checkout，再激活新工作台并复制 runtime dirs。复制大目录需要额外
磁盘与时间。失败路径会把原目录 rename 回去；不要删除 backup。

回滚：

```bash
pi-67 rollback --migration --check
pi-67 rollback --migration --yes
```

如果同一 blocker 连续出现三次，停止重复重试，回到最早不确定阶段：磁盘、权限、
源 artifact 完整性或目录所有权。

## 6. immutable release 激活中断

检查：

```bash
ls -la ~/.pi/pi67/pending-activation.json ~/.pi/pi67/current.json 2>/dev/null
pi-67 version --json
pi-67 update --check --json
```

`pending-activation.json` 表示逐文件激活未完成，或 pointer 已提交但 marker 尚未清理。
再次执行同一 manager 的 `pi-67 update` 会幂等重放；同版本/不同内容会拒绝继续，
避免静默污染 immutable release。

上一版本回滚：

```bash
pi-67 rollback --check --json
pi-67 rollback --yes
```

不要直接编辑 `current.json`。

## 7. extension 状态异常

```bash
pi-67 extensions list --json
pi-67 extensions inspect <id> --json
pi-67 extensions diff <id> --json
pi-67 extensions status --deep --json
```

### `missing`

正常 `pi-67 update` 会安装 baseline。npm 被明确跳过时：

```bash
pi-67 update --check --json
pi-67 update
```

确认没有 `--no-npm`。

### `below-baseline`

只有 ledger/hash/source 能证明 pristine 时才自动升级。否则状态应是 conflict。

### `user-managed-ahead`

这是预期状态：保留，不降级。不要为了让 doctor 全绿执行 restore。

### `user-managed-diverged`

pi-67 默认保留。先审阅：

```bash
pi-67 extensions diff <id> --json
```

确认确实需要丢弃本机修改后，才运行：

```bash
pi-67 extensions restore <id> --check --json
pi-67 extensions restore <id> --yes
```

restore 先备份，只处理一个 ID。

### `load-failed`

深度检查中的成功 `pi list --no-approve` 没有解析已配置 package。文件/version
状态会保存在 `baselineStatus`，不会自动覆盖。

```bash
pi list --no-approve
pi-67 extensions doctor --deep --json
```

检查 Pi 输出中的 package path、warning/error、Windows 路径和 settings spec。若 probe
本身失败，先修 `pi` command/timeout，而不是恢复扩展。

## 8. `pi list` timeout 或 warning

macOS/Linux doctor 默认使用非交互 package probe，可跳过：

```bash
bash scripts/pi67-doctor.sh --no-pi-list --json
```

设置 timeout：

```bash
bash scripts/pi67-doctor.sh --pi-list-timeout-seconds 60 --json
```

Windows 显式开启：

```powershell
& "$env:USERPROFILE\.pi\agent\scripts\pi67-doctor.ps1" -PiList -PiListTimeoutSeconds 60 -Json
```

timeout 是 warning，不应被写成 Pi version compatibility failure。`pi list` exit 0 但
出现 `warning|error|duplicate|conflict|skipped` 时，保留原始输出到本地 artifact，
只汇报命中行。

## 9. npm extension 安装失败

```bash
npm --version
npm config get registry
npm ping
pi-67 extensions inspect <id> --json
```

0.15.0 的 manager 对单个 missing/safe-behind npm extension 使用 targeted install。
它不会复制整个 release lock 后执行 runtime-wide `npm ci`。因此 registry/network
失败只应影响目标 extension，不应降级其他已安装 extension。

离线时先运行：

```bash
pi-67 update --check --no-remote --json
```

不要把 `--no-remote` 误认为“可以离线安装不存在的 npm tarball”。

## 10. Git extension 异常

```bash
git -C ~/.pi/agent/git/<path> status --short
git -C ~/.pi/agent/git/<path> remote -v
git -C ~/.pi/agent/git/<path> rev-parse HEAD
```

判断顺序：origin -> tracked dirty -> baseline ancestry。fork、source change、tracked
dirty 或非祖先关系全部保持 conflict。untracked build output 不自动等同 tracked source
modification。

不要修改嵌套第三方 checkout 的 lockfile 来让 pi-67 release gate 通过。

## 11. Shared Skill missing/conflict

```bash
pi-67 skills inventory
pi-67 skills packs --json
pi-67 skills plan
pi-67 skills diff <name>
```

默认 update 只补 missing。conflict 是“active 内容不同”，通常表示用户自行更新或
维护，默认保留。严格诊断：

```bash
pi-67 update --check --strict-shared-skills --json
```

Commerce/Marketing 和 AI Berkshire 是 `pi67-first-party`、
`bundled-release-only`；它们只随新 pi-67 baseline 到达。显式 pack 替换：

```bash
pi-67 skills sync-pack <pack> --dry-run
pi-67 skills sync-pack <pack> --yes
```

Legacy/external Skill 维护辅助：

```bash
bash scripts/pi67-migrate-skills.sh --dry-run
bash scripts/pi67-sync-external-skills.sh --dry-run
```

## 12. Lark Skills

默认发行版应有 27 个 Lark Skills。检查 missing/conflict：

```bash
pi-67 skills inventory --json
```

如果 active Lark Skill 新于 bundled baseline，normal update 保留 active 版本。这类
warning 不应通过强制覆盖来“消绿”。只有 missing 才自动补齐。

## 13. 记忆功能

公共默认架构：

- `pi-observational-memory`：session 内 compression；
- `pi-hy-memory`：cross-session long-term memory。

两者都应保留。个人 `agent_memory` 不在公共模板中，但 ignored `mcp.json` 中已有
配置会被 update/migrate/repair 保留。

Hy-Memory：

```bash
pi-67 memory status --json
pi-67 memory doctor --deep
pi-67 memory outbox status --json
```

关注 initialized/enabled/ready/running 与 pending/processing/deadLetter。不要把私有
memory DB、bearer、raw recall/capture 文本写入 Git 或日志。

## 14. MCP 配置

```bash
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log("ok")' ~/.pi/agent/mcp.json
```

install/update/migrate 不应覆盖已有 `mcp.json`。公共 `mcp.example.json` 只提供公共
模板。排查时不要打印完整文件，因为它可能包含用户命令参数或环境变量。

## 15. provider/model/auth

这些归 upstream Pi 所有。pi-67 只提供 optional `xtalpi configure` convenience：

```bash
pi-67 xtalpi configure --verify
pi-67 xtalpi smoke --quick
```

缺失 xtalpi credentials 不应阻止 Pi 使用其他 provider 或 zero-key startup path。
不要把 provider 故障写成 pi-67 distro version 故障。

## 16. browser67

```bash
pi-67 external doctor browser67 --deep
```

未安装：

```bash
pi-67 external install browser67 --dry-run
pi-67 external install browser67 --yes
```

dirty：先由 checkout owner 处理或提交本机修改；pi-67 不 reset/clean。真实 Chrome
profile、OS permissions、managed-tab ownership 属于 browser67 runtime 验收。

## 17. Windows JSON 与 PATH

PATH：

```powershell
npm prefix --global
Get-Command pi-67 -ErrorAction SilentlyContinue
$env:Path -split ';'
```

JSON 必须用对象序列化，不要手拼反斜杠：

```powershell
$value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $path -Encoding UTF8
```

PowerShell 5.1 UTF-16/BOM 问题由项目 JSON helper 做兼容读取；修复后仍应验证 JSON
parse 和 exact path。

### doctor 报 `Unexpected character encountered while parsing value: S`

`0.15.1` 的 PowerShell doctor 曾把 external-command 结果对象本身交给
`ConvertFrom-Json`，从而把 `System.Collections.Specialized.OrderedDictionary` 的首字母
`S` 误当成 JSON。该问题已在 `0.15.2` 修复；它不是 `mcp.json`、provider 配置或
credential 损坏。

升级 manager 并激活同版本 distro：

```powershell
pi-67 self-update
pi-67 update --check --json
pi-67 update
pi-67 doctor --json
```

`installMode=immutable-release` 时，doctor 不要求 distro 根目录与 `npm/package*.json`
字节相等，也不会建议普通用户运行 deprecated `pi67-update.ps1`。依赖和扩展健康由
installed dependency、managed baseline/ledger 及真实兼容性 probe 判断。legacy/source
layout 如报告 manifest drift，使用 `pi-67 update --check` 决定是否执行 `pi-67 update`。

### Windows doctor 报 `pi list failed`，但手工执行成功

Scoop、npm 或其他 Windows shim 可能把 `pi` 解析为 `pi.ps1`。`0.15.2` 的超时执行器
曾把该脚本直接交给 `ProcessStartInfo`，从而产生假阳性 WARN；交互式 PowerShell
执行同一命令仍会返回 `exitCode=0`。`0.15.3` 起，doctor 会通过当前 PowerShell host
执行 `.ps1` shim，并保留原始参数、timeout、stdout/stderr 和 exit code。

只读复核：

```powershell
$piListOutput = & pi list --no-approve 2>&1
$piListExitCode = $LASTEXITCODE
[pscustomobject]@{
  exitCode = $piListExitCode
  output = ($piListOutput -join "`n")
} | ConvertTo-Json
```

真实失败时，doctor WARN 会包含 exit code 和最多 240 字符的首条错误摘要；不再只输出
无法定位的 `pi list failed`。不要因该 probe 的假阳性运行 repair 或升级 upstream Pi。

## 18. release/smoke 失败

按最小范围依次运行：

```bash
node packages/pi67-cli/scripts/check.mjs
bash scripts/pi67-test-skill-governance.sh
bash scripts/pi67-test-ai-berkshire-skill-pack.sh
bash scripts/pi67-release-check.sh
bash scripts/pi67-release-artifact-smoke.sh
bash scripts/pi67-smoke.sh --ci
```

packed artifact 报 `MODULE_NOT_FOUND` 时，源码 check 通过不能证明 package 可用。
检查 `packages/pi67-cli/package.json#files`、prepack bundle、tarball inventory 和隔离
prefix/HOME 中的 installed CLI。

`npm pack --dry-run` 也不等于隔离安装。必须实际安装 tarball 并运行至少
`--help`、`version`、`manifest`、`install/update --dry-run`。

## 19. 安全恢复原则

- 先 `--check` / `--dry-run`，再 `--yes`；
- 不删除 tracked/user files 来绕过 blocker；
- 不使用 `git reset --hard`、`git clean -fd` 或 force push；
- 不把 credentials、raw logs、session 或 memory data 放进 issue；
- ahead/diverged/unknown 默认保留；
- rollback 先检查 immutable release 或 migration journal；
- 如果现场证据与文档冲突，以真实 runtime -> active assets -> current config ->
  persisted state -> source 的顺序重新定位。
