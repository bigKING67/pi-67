# Windows 纯新电脑安装 pi-67

本文面向一台刚拿到手、还没有安装 Windows Terminal、PowerShell 7、Git、
Node.js、upstream Pi 或 pi-67 的 Windows 电脑。

pi-67 的目标不是再造一个 Pi runtime，而是把 67 长期使用 Pi 的配置、习惯、
extensions、Skills、rules、prompts 和公司统一的 `xtalpi-pi-tools` 配置，封装成
小白可以重复执行、持续升级、可诊断、可验收的一键工作台。

架构边界始终是：

| 命令 | 角色 | 日常是否使用 |
| --- | --- | --- |
| `pi` | upstream `@earendil-works/pi-coding-agent`，唯一 Pi runtime | **是，日常入口** |
| `pi-67` | 工作台安装、配置、更新、修复、doctor、smoke、验收和发行管理器 | 维护时使用 |

安装完成后，每天直接运行：

```powershell
pi
```

不要把 `pi-67 launch` 当成标准入口。它只保留给旧终端 PATH 尚未刷新时的兼容
场景，不能代替真实 `pi` 验收。

## 一、新机完整顺序

默认 bootstrap 严格按下面的顺序执行：

```text
Windows 10/11 + Windows PowerShell 5.1 preflight
  -> 请求一次 UAC 管理员权限
  -> 检查 WinGet；缺失时先修复 WinGet 安装器基础能力
  -> winget install Microsoft.WindowsTerminal
  -> Windows Terminal 默认打开系统内置 Windows PowerShell
  -> Windows PowerShell profile 默认 elevate=true
  -> winget install Microsoft.PowerShell
  -> Windows Terminal 最终默认 profile 改为 PowerShell 7
  -> PowerShell 7 profile 默认 elevate=true
  -> winget install zufuliu.notepad4
  -> 配置 Notepad4 资源管理器右键菜单
  -> 配置 notepad.exe 默认由 Notepad4 打开
  -> winget install --id Git.Git -e --source winget
  -> 验证 git --version 和未来 Terminal 的持久 PATH
  -> winget install Schniz.fnm
  -> 幂等维护 PowerShell 7 $PROFILE
  -> fnm install lts/krypton
  -> fnm default lts/krypton
  -> fnm use lts/krypton
  -> 验证 Node.js 24 LTS、npm 和 fnm 来源
  -> npm install -g @earendil-works/pi-coding-agent@latest
  -> 验证真实 pi --version
  -> npm install -g @bigking67/pi-67@latest
  -> pi-67 install --repair --yes
  -> pi-67 xtalpi configure --verify
  -> 完整 Windows acceptance
  -> 日常运行 pi
```

### 为什么 WinGet 检查排在 Terminal 安装之前

用户看到的第一个桌面软件仍然是 Windows Terminal，但 Terminal、PowerShell 7、
Notepad4、Git 和 fnm 都通过 WinGet 安装。因此安装器内部必须先确保 `winget.exe`
可用，否则连第一条 `winget install Microsoft.WindowsTerminal` 都无法执行。

这一步只是准备“安装器能力”，不是跳过 Windows Terminal。

## 二、推荐的一键安装

### 1. 下载发布版 bootstrap

先在系统内置 **Windows PowerShell** 中执行：

```powershell
$Bootstrap = Join-Path $env:TEMP "pi67-bootstrap.ps1"
Invoke-WebRequest `
  -UseBasicParsing `
  -Uri "https://github.com/bigKING67/pi-67/releases/latest/download/pi67-bootstrap.ps1" `
  -OutFile $Bootstrap
```

### 2. 可选但推荐：校验 SHA-256

每个 GitHub Release 同时提供：

```text
pi67-bootstrap.ps1
pi67-bootstrap.ps1.sha256
```

完整校验命令：

```powershell
$Checksum = "$Bootstrap.sha256"
$Base = "https://github.com/bigKING67/pi-67/releases/latest/download"

Invoke-WebRequest `
  -UseBasicParsing `
  -Uri "$Base/pi67-bootstrap.ps1.sha256" `
  -OutFile $Checksum

$Expected = ((Get-Content $Checksum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$Actual = (Get-FileHash $Bootstrap -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Expected) {
  throw "pi67-bootstrap.ps1 SHA-256 mismatch"
}
```

### 3. 执行

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap
```

脚本会自动请求一次 UAC 管理员权限，原窗口等待管理员子进程完成并返回真实退出码。
不需要用户先手工右键“以管理员身份运行 PowerShell”。如果 UAC 被取消，脚本会
明确失败，不会继续或伪装成功。

这里的 `-ExecutionPolicy Bypass` 只作用于这一次 bootstrap 子进程。脚本不会执行
`Set-ExecutionPolicy`，不会永久修改 PowerShell 执行策略，也不会写系统代理。

不要把下载和执行压缩成管道直接执行。先保存文件，才能检查源码和 SHA-256，失败
时也能保留同一份脚本复现。

## 三、各前置阶段的真实合同

### 1. WinGet 缺失时自动修复

已经存在 `winget` 时，bootstrap 只运行 `winget --version` 验证，不重复安装模块。

缺失时，管理员进程执行：

```powershell
$progressPreference = 'silentlyContinue'
Install-PackageProvider -Name NuGet -Force | Out-Null
Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery | Out-Null
Write-Host "Using Repair-WinGetPackageManager cmdlet to bootstrap WinGet..."
Repair-WinGetPackageManager -AllUsers
```

然后刷新当前进程 PATH，并再次验证：

```powershell
winget --version
```

修复失败会终止安装，不会在缺少包管理器的情况下继续假成功。

### 2. Windows Terminal

安装命令：

```powershell
winget install --id Microsoft.WindowsTerminal -e --source winget
```

bootstrap 会安全读取 Windows Terminal 的 JSON/JSONC 设置，支持：

- `//` 行注释；
- `/* ... */` 块注释；
- 尾逗号；
- 已有 profiles、schemes、actions 和其他用户设置。

修改前会备份 `settings.json`，不会覆盖掉其他 profile。安装 PowerShell 7 前，先把
系统内置 Windows PowerShell profile 写成默认并设置：

```json
{
  "guid": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}",
  "elevate": true,
  "hidden": false
}
```

### 3. PowerShell 7

安装命令：

```powershell
winget install --id Microsoft.PowerShell -e --source winget
```

安装后，Windows Terminal 的最终合同是：

```json
{
  "defaultProfile": "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
  "profiles": {
    "list": [
      {
        "guid": "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
        "name": "PowerShell",
        "commandline": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "elevate": true,
        "hidden": false
      }
    ]
  }
}
```

也就是以后打开 Windows Terminal，默认进入 PowerShell 7，并按用户要求默认请求
管理员权限。

如果公司安全策略不允许 Terminal profile 自动提权，可以显式使用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -NoTerminalAdmin
```

这会把两个 profile 的 `elevate` 写为 `false`；默认仍然是 `true`。

### 4. Notepad4

安装命令：

```powershell
winget install --id zufuliu.notepad4 -e --source winget
```

`zufuliu.notepad4` 是 portable/zip 型 WinGet 包，仅安装软件并不会自动完成截图中的
系统集成。因此 bootstrap 还会备份并写入以下注册表合同。

资源管理器右键菜单：

```text
HKEY_CLASSES_ROOT\*\shell\Notepad4
  (Default) = Edit with Notepad4
  icon      = <Notepad4.exe full path>

HKEY_CLASSES_ROOT\*\shell\Notepad4\command
  (Default) = "<Notepad4.exe full path>" "%1"
```

让 `notepad.exe` 默认启动 Notepad4：

```text
HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\notepad.exe
  (Default) = <Notepad4.exe full path>
  Debugger  = "<Notepad4.exe full path>" /z
  UseFilter = 0 (REG_DWORD)
```

写入后会逐项回读验证。注册表备份保存在本次 bootstrap 日志目录。

如果只想安装 Notepad4、不修改系统集成：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -SkipNotepad4Integration
```

### 5. Git for Windows

安装命令：

```powershell
winget install --id Git.Git -e --source winget
```

bootstrap 不只检查当前进程能不能临时找到 Git，还会：

1. 定位真实 `git.exe`；
2. 运行 `git --version`；
3. 验证 Git 目录存在于 User 或 Machine 持久 PATH；
4. 缺失时幂等加入 User PATH；
5. 在最终 acceptance 中再次检查。

这样新开的 Windows Terminal 才能直接使用 Git，避免 upstream Pi 报：

```text
spawn git ENOENT
```

### 6. fnm + Node.js 24 LTS Krypton

安装命令：

```powershell
winget install --id Schniz.fnm -e --source winget
```

PowerShell 7 profile 默认位置：

```text
%USERPROFILE%\Documents\PowerShell\Microsoft.PowerShell_profile.ps1
```

bootstrap 使用带边界标记的 managed block 幂等写入官方初始化行：

```powershell
# >>> pi-67 fnm initialization >>>
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
# <<< pi-67 fnm initialization <<<
```

重复运行不会重复追加，也不会删除 profile 中其他用户配置。修改前会创建备份。

然后执行：

```powershell
fnm install lts/krypton
fnm default lts/krypton
fnm use lts/krypton
```

最终必须同时满足：

```text
Node.js major = 24
Node.js >= 22.19.0
active node.exe comes from fnm
npm --version succeeds
```

`fnm default lts/krypton` 是长期可用合同：新开的 PowerShell 7 通过 `$PROFILE`
初始化 fnm 后，会自动使用默认 Node，而不是只在 bootstrap 当前窗口临时生效。

pi-67 不再在纯新机流程中直接安装 `OpenJS.NodeJS.LTS`，也不会静默叠加第二套
unmanaged Node。

## 四、最后才安装 Pi 和 pi-67

只有以上前置阶段全部通过后，bootstrap 才运行：

```powershell
npm install -g @earendil-works/pi-coding-agent@latest
pi --version

npm install -g @bigking67/pi-67@latest
pi-67 --version

pi-67 install --repair --yes
pi-67 xtalpi configure --verify
```

这里必须区分：

- npm 包 `@earendil-works/pi-coding-agent` 提供真实 `pi`；
- npm 包 `@bigking67/pi-67` 提供管理命令 `pi-67`；
- `pi-67 install` 部署/修复 `~/.pi/agent` 工作台内容；
- 日常聊天和工具执行仍然运行 `pi`。

## 五、晶泰 API key

公司统一使用：

```text
provider = xtalpi-pi-tools
model    = deepseek-v4-pro
```

每个人只维护自己的 key。`pi-67 xtalpi configure --verify` 使用隐藏输入，不会把 key
放进命令行参数、shell history、Git 仓库、bootstrap summary 或普通日志。

无人值守环境可以通过以下任一 secret 环境变量注入，优先级从上到下：

```text
PI67_XTALPI_PI_TOOLS_API_KEY
PI67_XTALPI_TOOLS_API_KEY
PI67_XTALPI_API_KEY
```

不要把 key 写进 `.ps1`、README 或 CI 日志。

暂时没有 key 时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -NoXtalpiPrompt
```

基础工作站和 Pi 会安装完成，但结果明确为：

```text
RESULT: READY_WITHOUT_XTALPI
```

拿到 key 后执行：

```powershell
pi-67 xtalpi configure --verify
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-windows-acceptance.ps1 -ValidateWorkstation
```

## 六、验收

bootstrap 默认会调用：

```powershell
.\scripts\pi67-windows-acceptance.ps1 -ValidateWorkstation
```

它会验证：

- WinGet；
- Windows Terminal / PowerShell 7 默认 profile 与 `elevate`；
- Notepad4 和注册表集成；
- Git 当前可用性与持久 PATH；
- fnm、PowerShell profile、Node 24 来源；
- npm、upstream Pi 和真实 `pi --version`；
- pi-67 manager 与本地发行版更新；
- `xtalpi-pi-tools + deepseek-v4-pro` 配置、健康度和真实工具调用。

只有全部通过才输出：

```text
RESULT: PASS
```

成功后关闭所有旧 Terminal 窗口，重新打开 Windows Terminal，再执行：

```powershell
winget --version
$PSVersionTable.PSVersion
git --version
fnm --version
fnm current
node --version
npm --version
pi --version
pi-67 --version
pi
```

## 七、可选模式

### 只预览，不修改电脑

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -DryRun
```

### 最小模式

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Minimal
```

`-Minimal` 只跳过桌面体验：

```text
Windows Terminal
PowerShell 7
Notepad4
```

下面这些仍然是必需项，不会被跳过：

```text
WinGet readiness
Git
fnm
Node.js 24 LTS
upstream Pi
pi-67
xtalpi
acceptance
```

默认推荐完整模式，不建议小白使用 `-Minimal`。

### npm 镜像

默认不修改用户 npm registry。只有明确需要并显式传入时才永久设置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -UseNpmMirror
```

等价于：

```powershell
npm config set registry https://registry.npmmirror.com
```

不要把 npm、GitHub、晶泰 API 和公司代理问题混成一个“网络问题”。它们是四条独立
链路，应分别检查。

## 八、日志和失败恢复

每次运行创建独立目录：

```text
%USERPROFILE%\.pi\pi67\logs\bootstrap-<timestamp>-<pid>\
```

主要文件：

```text
bootstrap.log
bootstrap-summary.json
各阶段命令日志
Windows Terminal settings.json 备份路径（记录在 summary）
Notepad4 注册表备份
PowerShell profile 备份路径（记录在 summary）
acceptance\
```

常见结果：

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| `PASS` | 工作站、Pi、pi-67、公司 API、真实工具调用全部通过 | 重开 Terminal，运行 `pi` |
| `READY_WITHOUT_XTALPI` | 工作站和 Pi 已完成，但没有个人晶泰 key | `pi-67 xtalpi configure --verify` |
| `FAIL` | 某个必需阶段失败 | 查看 `failedStage` 和对应日志 |
| `DRY_RUN` | 只输出计划，没有修改电脑 | 去掉 `-DryRun` 重跑 |

反馈问题时发送 `bootstrap-summary.json`、失败阶段名和对应日志即可。不要发送
`models.json` 全文，也不要发送 API key。

## 九、已安装用户如何更新

已经装好工作站的电脑不需要每次重跑 bootstrap。日常更新使用：

```powershell
pi-67 update
```

完整更新并验收：

```powershell
Set-Location $env:USERPROFILE\.pi\agent
.\scripts\pi67-windows-acceptance.ps1
```

如果还要复查这套新机工作站前置合同：

```powershell
.\scripts\pi67-windows-acceptance.ps1 -ValidateWorkstation
```

只有明确只验当前版本、不更新 manager 和发行版时，才使用：

```powershell
.\scripts\pi67-windows-acceptance.ps1 -SkipUpdate
```

## 十、官方合同参考

- Windows Terminal startup/default profile:
  <https://learn.microsoft.com/windows/terminal/customize-settings/startup>
- Windows Terminal profile general settings / `elevate`:
  <https://learn.microsoft.com/windows/terminal/customize-settings/profile-general>
- WinGet PowerShell repair client:
  <https://www.powershellgallery.com/packages/Microsoft.WinGet.Client>
- fnm installation and PowerShell profile initialization:
  <https://github.com/Schniz/fnm>
- Notepad4 system integration:
  <https://github.com/zufuliu/notepad4/wiki/System-Integration>
