# Windows 全新安装 pi-67 0.15.3

本文面向 Windows 10/11 普通用户。pi-67 与 upstream Pi 独立：

- 用户先按 upstream 方式独立安装和维护 `pi`；
- `pi67-bootstrap.ps1` 只安装/更新 `@bigking67/pi-67` manager 与工作台；
- pi-67 不检查、比较、推荐或升级 Pi 版本。

本文对应 `0.15.3`；安装前可用 `npm view @bigking67/pi-67@latest version`
核对 registry 当前正式版本。

## 1. 要求

- Windows 10/11 x64 或 arm64；
- PowerShell 5.1+ 或 PowerShell 7；
- Node.js 22.19+，推荐 Node.js 24 LTS；
- npm 可访问 `@bigking67/pi-67`；
- `pi` 命令已独立安装；
- 普通用户权限即可，不要求 Administrator。

检查：

```powershell
$PSVersionTable.PSVersion
node --version
npm --version
Get-Command pi -ErrorAction SilentlyContinue
```

如果当前 shell 找不到刚安装的 npm global command，先关闭并重开 PowerShell；
不要为了 PATH 问题把整个流程改成管理员安装。

## 2. 推荐：checksum 校验后的 bootstrap

正式 GitHub Release 会提供：

```text
pi67-bootstrap.ps1
pi67-bootstrap.ps1.sha256
```

在下载目录验证：

```powershell
$expected = (Get-Content .\pi67-bootstrap.ps1.sha256 -Raw).Split()[0].Trim().ToLowerInvariant()
$actual = (Get-FileHash .\pi67-bootstrap.ps1 -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "pi67-bootstrap.ps1 checksum mismatch" }
```

只对当前 PowerShell 进程放宽脚本策略并执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& .\pi67-bootstrap.ps1
```

bootstrap 的职责：

1. 检查 Node/npm 与用户级 global prefix；
2. 安装 `@bigking67/pi-67@latest`；
3. 根据现场选择 `pi-67 install` 或 `pi-67 update`；
4. 输出 manager/workspace JSON 摘要；
5. 不安装 Pi、不写 provider credentials、不执行生产或外部账号动作。

维护者或发布验收可运行自测试：

```powershell
& .\pi67-bootstrap.ps1 -SelfTest
```

## 3. 手工安装 manager

安装指定版本：

```powershell
npm install --global @bigking67/pi-67@0.15.3 --no-audit --no-fund --no-update-notifier
pi-67 --help
```

全新、空的 `~/.pi/agent`：

```powershell
pi-67 install
```

安装从 npm manager artifact 内置 distro 激活，不需要 Git clone pi-67 仓库。

## 4. legacy Git checkout 迁移

如果 `%USERPROFILE%\.pi\agent\.git` 存在，`pi-67 install` 不会直接覆盖。

预览：

```powershell
pi-67 migrate --check --json
```

执行：

```powershell
pi-67 migrate --yes
```

原 checkout 被移动到：

```text
%USERPROFILE%\.pi\pi67\backups\<timestamp>-runtime-layout\legacy-agent
```

迁移保留：

```text
settings.json
models.json
auth.json
mcp.json
image-gen.json
settings.json.theme
extensions\
git\
npm\
sessions\
```

个人 `agent_memory` 若已存在于 ignored `mcp.json`，会作为用户状态原样保留；它不
属于公共 template、baseline 或推荐安装项。

恢复 legacy layout：

```powershell
pi-67 rollback --migration --check
pi-67 rollback --migration --yes
```

## 5. 0.15.0 extension policy

21 个 default extensions 全部保留。更新规则：

```text
missing                安装 minimum baseline
safe behind/pristine   升级到 minimum baseline
equal                  保持
ahead/newer            保持，never downgrade
modified/diverged      保持并报告 conflict
unknown                保持为 user-managed
```

本机自行升级的第三方 extension 只要高于 baseline，就不会被较旧 pi-67 覆盖。
相同或较低版本但内容已修改，也不会被自动替换。

检查：

```powershell
pi-67 extensions list --json
pi-67 extensions plan --json
pi-67 extensions status --deep --json
pi-67 extensions doctor --deep --json
```

深度 probe 使用真实 `pi list --no-approve` 检查 configured packages 是否解析；
它不读取 Pi 版本。

显式恢复单个扩展：

```powershell
pi-67 extensions restore <id> --check --json
pi-67 extensions restore <id> --yes
```

## 6. 两层公共记忆

- `pi-observational-memory`：session compression；
- `pi-hy-memory`：cross-session long-term memory。

两者职责不同且都在默认发行版中。用户自管 MCP 不会被 install/update/migrate/
repair 创建、删除或覆盖。

## 7. 默认 Skills

0.15.0 bundle 包含 62 个 shared Skills：

- 27 个 Lark Skills；
- 8 个 Commerce/Marketing first-party Skills；
- 21 个 AI Berkshire first-party Skills；
- 其他公共工作台 Skills。

正常 update 只补 missing。active Skill 内容不同则保留。Commerce 与 AI Berkshire
只随维护者发布的新 pi-67 baseline 升级，不在用户机器自动拉第三方 source。

```powershell
pi-67 skills inventory
pi-67 skills packs --json
pi-67 skills plan
```

## 8. 日常更新

显式更新 npm manager：

```powershell
pi-67 self-update --dry-run
pi-67 self-update
```

预览并激活该 manager 自带 distro：

```powershell
pi-67 update --check --json
pi-67 update
```

可选：

```powershell
pi-67 update --repair
pi-67 update --no-npm
pi-67 update --check --no-remote --json
pi-67 update --check --strict-shared-skills --json
```

`--repair` 不执行整个 runtime lockfile 的 `npm ci`，所以不会把 ahead extension
降级回 release baseline。

## 9. Immutable release rollback

```powershell
pi-67 rollback --check --json
pi-67 rollback --yes
```

release store：

```text
%USERPROFILE%\.pi\pi67\releases\<version>
%USERPROFILE%\.pi\pi67\current.json
%USERPROFILE%\.pi\pi67\journals
```

同版本内容冲突会 fail closed。激活中断时
`%USERPROFILE%\.pi\pi67\pending-activation.json` 保留恢复线索；再次运行 update 可
幂等恢复。

## 10. Doctor 与 acceptance

基础检查：

```powershell
pi-67 version --json
pi-67 manifest --validate
pi-67 update --check --json
& "$env:USERPROFILE\.pi\agent\scripts\pi67-doctor.ps1" -Json
```

带真实 Pi package probe：

```powershell
& "$env:USERPROFILE\.pi\agent\scripts\pi67-doctor.ps1" -PiList -PiListTimeoutSeconds 60 -Json
```

完整 smoke 与 Windows acceptance：

```powershell
& "$env:USERPROFILE\.pi\agent\scripts\pi67-smoke.ps1" -Ci
& "$env:USERPROFILE\.pi\agent\scripts\pi67-windows-acceptance.ps1"
```

acceptance 必须验证真实 `pi` command、真实配置加载和至少一个真实 startup/tool
路径。wrapper/mock 只能证明 wrapper 自身。

`0.15.2` 起，PowerShell doctor 会从 external-command 结果的 `text` 字段解析 MCP
runtime 与 active provider helper JSON。若旧版报告
`Unexpected character encountered while parsing value: S`，升级 manager 后执行
`pi-67 update` 激活同版本 distro；不要为此删除或重写本机 `mcp.json`、provider、
model 或 auth 配置。

immutable release 的 `npm/package*.json` 不要求与 distro 根目录 manifest 字节相等。
doctor 会继续检查 installed dependencies、managed extension 状态和实际兼容性，且不
再引导普通用户运行 deprecated `pi67-update.ps1`。

`0.15.3` 起，若 Scoop/npm 将 `pi` 解析为 `pi.ps1`，PowerShell doctor 会通过当前
PowerShell host 执行该 shim，而不是把脚本直接交给 `ProcessStartInfo`。因此手工
`pi list --no-approve` 成功时不再产生 `pi list failed` 假阳性；真实失败会报告 exit
code 和有界错误摘要。

## 11. JSON 编码

Windows PowerShell 5.1 的默认重定向可能产生 UTF-16。仓库中的 JSON helpers 会
显式处理 BOM/UTF-16/UTF-8。手工生成 JSON 时使用：

```powershell
$json | Set-Content -LiteralPath $path -Encoding UTF8
```

不要用字符串拼接写含反斜杠路径的 JSON；使用 `ConvertTo-Json`。

## 12. browser67

browser67 是 explicit external repo：

```powershell
pi-67 external install browser67 --dry-run
pi-67 external install browser67 --yes
pi-67 external doctor browser67 --deep
```

dirty checkout 不会被 reset、clean 或覆盖。真实浏览器权限、profile 和 extension
授权仍需按 browser67 文档完成。

## 13. xtalpi（可选）

```powershell
pi-67 xtalpi configure --verify
& "$env:USERPROFILE\.pi\agent\scripts\pi67-xtalpi-pi-tools-smoke.ps1" -Quick
```

xtalpi credential 只写 machine-owned 受保护配置。未配置 xtalpi 不应阻止 Pi
零凭据启动或其他 provider 的 upstream login/model flow。

## 14. 常见故障

### 找不到 `pi-67`

```powershell
npm prefix --global
npm bin --global 2>$null
Get-Command pi-67 -ErrorAction SilentlyContinue
```

重开 shell。必要时检查 `%APPDATA%\npm` 是否在用户 PATH。

### manager 与 distro 版本不同

```powershell
pi-67 version --json
pi-67 self-update
pi-67 update --check --json
pi-67 update
```

不要通过手工复制源码修正版本错位。

### extension conflict

```powershell
pi-67 extensions inspect <id> --json
pi-67 extensions diff <id> --json
```

先确认它是用户新版/修改版还是损坏。只有确认需要 release baseline 时才执行显式
restore。

### migration 磁盘空间不足

先用资源管理器或 PowerShell 测量 `npm`、`git`、`sessions`。不要删除原 backup；
修复空间后重试，或执行 migration rollback。

## 15. 安全检查表

- [ ] 未用管理员 PowerShell 执行普通用户安装；
- [ ] 未把 token/password 写入命令历史或文档；
- [ ] `mcp.json`、`auth.json`、`models.json` 仍为本机状态；
- [ ] `pi-67 update --check --json` 无意外 overwrite；
- [ ] ahead/diverged extensions 被保留；
- [ ] 27 个 Lark Skills 无 missing；
- [ ] `pi-67 doctor` 与 Windows acceptance 已运行；
- [ ] 未因安装 pi-67 隐式改变 Pi 版本。
