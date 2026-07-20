# Windows 纯新电脑从零安装 pi-67

本文面向一台刚完成 Windows 初始化、尚未安装开发工具的 Windows 10/11
电脑。目标是按可观察、可重复、可排障的顺序手动准备基础环境，最后再用
`pi67-bootstrap.ps1` 安装或更新 pi-67 manager 与 `~/.pi/agent` 工作区。

## 一、先理解新的安装边界

Windows 系统前置软件不再由 pi-67 bootstrap 统一接管。安装顺序是：

```text
管理员 Windows PowerShell
→ WinGet
→ Windows Terminal
→ PowerShell 7
→ Notepad4 + 系统集成
→ Git for Windows + 持久 PATH
→ Terminal 默认 PowerShell 7 + 管理员 profile
→ 固定管理员任务入口
→ fnm
→ Node.js 24 LTS + npm
→ npm registry 验证
→ upstream Pi
→ pi-67 manager/workspace bootstrap
→ doctor
→ 日常运行 pi
```

新的 `pi67-bootstrap.ps1` 只负责：

1. 检查 Git、Node.js、npm 和 upstream `pi` 是否已经可用；
2. 安装或更新最新版 `@bigking67/pi-67` manager；
3. 根据 `~/.pi/agent` 是否为 Git checkout，执行 `pi-67 install --repair --yes`
   或 `pi-67 update`；
4. 执行 `pi-67 version --json` 和 `pi-67 doctor --json`；
5. 写入本次运行的日志和 `pi67.manager-bootstrap.v1` summary。

它不会安装 Windows Terminal、PowerShell 7、Notepad4、Git、fnm、Node.js、npm 或 upstream Pi，也不会
请求管理员权限、修改注册表、修改 PowerShell profile、切换 npm registry、输入
晶泰 API key，或代替完整 Windows workstation acceptance。

## 二、第一步：以管理员方式打开 Windows PowerShell

在开始菜单搜索 `Windows PowerShell`，右键选择“以管理员身份运行”。确认窗口标题
包含“管理员”，然后先查看系统内置 PowerShell 版本：

```powershell
$PSVersionTable.PSVersion
```

pi-67 的 Windows 脚本兼容 Windows PowerShell 5.1+。这里不要求先安装
PowerShell 7，也不要为了安装流程永久修改 ExecutionPolicy。

## 三、第二步：确保 WinGet 可用，再安装 Terminal、PowerShell 7、Notepad4 和 Git

### 1. 检查 WinGet

```powershell
winget --version
```

如果能输出版本号，说明 WinGet 已经存在，不需要重复安装，直接进入“安装 Windows
Terminal”。如果提示无法识别 `winget`，按下面顺序恢复，不要直接跳到 Terminal。

#### 路径 A：重新注册系统已有的 App Installer

微软说明，现代 Windows 10/11 的 WinGet 随 **App Installer** 提供；新用户首次
登录后，Store 可能仍在异步注册它。先在管理员 Windows PowerShell 中执行：

```powershell
Add-AppxPackage `
  -RegisterByFamilyName `
  -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe

winget --version
```

如果此时已经输出版本号，继续安装 Windows Terminal。

#### 路径 B：安装或更新 App Installer

如果系统没有 App Installer，使用 Microsoft Store 安装或更新微软官方
**App Installer**：

```text
https://apps.microsoft.com/detail/9nblggh4nns1
```

完成后关闭并重新打开 Windows PowerShell，再执行：

```powershell
winget --version
```

#### 路径 C：使用 PowerShell Gallery 命令行修复 WinGet

如果是 Windows Sandbox、精简镜像、Microsoft Store 不可用，或者前两条路径仍未
恢复 WinGet，可以在管理员 Windows PowerShell 中使用微软官方文档提供的引导方式：

```powershell
$progressPreference = 'silentlyContinue'
Write-Host "Installing WinGet PowerShell module from PSGallery..."
Install-PackageProvider -Name NuGet -Force | Out-Null
Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery | Out-Null
Write-Host "Using Repair-WinGetPackageManager cmdlet to bootstrap WinGet..."
Repair-WinGetPackageManager -AllUsers
Write-Host "Done."

winget --version
```

这条路径依赖 PowerShell Gallery 和 NuGet 可访问。公司设备如果同时禁用了 Store、
PSGallery 或 WinGet，应交给 IT 通过软件分发策略安装 App Installer，不要在 pi-67
bootstrap 中静默绕过组织策略。

微软官方说明：

```text
https://learn.microsoft.com/windows/package-manager/winget/
```

### 2. WinGet 可用后安装 Windows Terminal

在当前管理员 Windows PowerShell 中执行：

```powershell
winget install `
  --id Microsoft.WindowsTerminal `
  -e `
  --source winget `
  --accept-package-agreements `
  --accept-source-agreements
```

安装后可以验证：

```powershell
winget list --id Microsoft.WindowsTerminal -e
Get-Command wt.exe
```

### 3. 安装 PowerShell 7

继续在当前管理员 Windows PowerShell 中执行：

```powershell
winget install `
  --id Microsoft.PowerShell `
  -e `
  --source winget `
  --accept-package-agreements `
  --accept-source-agreements
```

安装后验证：

```powershell
Get-Command pwsh.exe
pwsh --version
```

预期 `pwsh --version` 输出 PowerShell 7.x。系统内置 Windows PowerShell 5.1
保留用于最初的系统准备和兼容性恢复；后续日常默认 Shell 改为 PowerShell 7。

### 4. 安装 Notepad4，并完成系统集成

继续安装 Notepad4：

```powershell
winget install `
  --id zufuliu.notepad4 `
  -e `
  --source winget `
  --accept-package-agreements `
  --accept-source-agreements
```

安装后检查并以管理员身份打开：

```powershell
winget list --id zufuliu.notepad4 -e
$Notepad4 = (Get-Command Notepad4.exe -ErrorAction Stop).Source
Start-Process -FilePath $Notepad4 -Verb RunAs
```

在 Notepad4 中按图形界面完成：

1. 进入 **设置 -> 高级设置 -> 系统集成**。
2. 勾选 **将 Notepad4 添加到 Windows 资源管理器的右键菜单**。
3. 右键菜单文字可以保留默认的“使用 Notepad4 编辑”。
4. 勾选 **通过注册表替换 Windows 记事本**。
5. **启用任务栏跳转列表**不是本流程的必选项，按个人需要决定。
6. 点击“确定”；如果 Windows 请求管理员确认，选择“是”。

完成后验证注册表合同：

```powershell
reg.exe query "HKCR\*\shell\Notepad4\command" /ve
reg.exe query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\notepad.exe" /v Debugger
```

两条结果都应指向当前 `Notepad4.exe`。再右键任意文本文件，确认出现“使用
Notepad4 编辑”；执行下面的命令时应实际打开 Notepad4，而不是系统记事本：

```powershell
Start-Process notepad.exe
```

如需回滚，不要直接手工删除注册表键；重新以管理员身份打开 Notepad4，在同一个“系统
集成”窗口取消勾选右键菜单和 Windows 记事本替换，再点击“确定”。

### 5. 安装 Git for Windows，并确认持久 PATH

```powershell
winget install `
  --id Git.Git `
  -e `
  --source winget `
  --accept-package-agreements `
  --accept-source-agreements
```

安装器通常会把 `C:\Program Files\Git\cmd` 写入系统 PATH，但当前 PowerShell 进程
可能仍持有安装前的环境变量。先从注册表重新加载当前窗口的 PATH，再验证 Git：

```powershell
$MachinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$MachinePath;$UserPath"

where.exe git
git --version

$GitExe = (Get-Command git.exe -ErrorAction Stop).Source
$GitDir = Split-Path -Parent $GitExe
$PersistentParts = @(("$MachinePath;$UserPath") -split ';' |
  ForEach-Object { $_.Trim().TrimEnd('\') } |
  Where-Object { $_ })
$GitPersisted = [bool]($PersistentParts | Where-Object {
  [string]::Equals($_, $GitDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
})
$GitPersisted
```

预期 `where.exe git` 指向 Git for Windows 的 `cmd\git.exe`，`git --version` 输出版本，
最后一行是 `True`。这证明 Git 不只是当前窗口临时可见，而是已经写入 User/Machine
持久 PATH。

只有最后一行是 `False` 或新 Terminal 找不到 Git 时，才执行下面的去重修复：

```powershell
$GitCmd = Join-Path $env:ProgramFiles 'Git\cmd'
if (-not (Test-Path -LiteralPath (Join-Path $GitCmd 'git.exe'))) {
  throw "Git executable not found: $GitCmd"
}

$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$UserParts = @($UserPath -split ';' | Where-Object { $_ })
$AlreadyPresent = [bool]($UserParts | Where-Object {
  [string]::Equals($_.Trim().TrimEnd('\'), $GitCmd.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
})
if (-not $AlreadyPresent) {
  [Environment]::SetEnvironmentVariable(
    'Path',
    ((@($UserParts) + $GitCmd) -join ';'),
    'User'
  )
}
```

关闭所有 Windows Terminal 窗口，再重新打开并执行：

```powershell
where.exe git
git --version
```

两条命令必须仍然成功，才说明以后启动 Windows Terminal 时可以直接使用 Git。

### 6. 设置 PowerShell 7 默认管理员，并创建免重复 UAC 的入口

Windows Terminal 的 `Automatically run as Administrator` / `elevate=true`
表示从普通入口启动该 profile 时向 Windows 请求提权，因此原始 Terminal 图标会弹
UAC。Windows 没有只针对某个普通应用的“永久信任且静默提权”开关。

团队工作站同时满足两个合同：PowerShell 7 profile 本身配置为管理员启动；另注册一个
动作固定、以最高权限运行的计划任务，并把它的快捷方式作为日常 Terminal 入口。
从这个固定入口启动时 Windows Terminal 已处于管理员上下文，不会再次弹 UAC；误用
原始 Terminal 图标时仍会按 Windows 安全机制显示 UAC。

先从开始菜单打开 Windows Terminal，完成 profile 设置：

1. 按 `Ctrl+,` 打开 Windows Terminal 设置。
2. 进入 **启动（Startup）**，把 **默认配置文件（Default profile）** 设置为
   **PowerShell**。这里指刚安装的 PowerShell 7，不是系统内置 Windows
   PowerShell 5.1。
3. 进入 **配置文件（Profiles） -> PowerShell -> 高级（Advanced）**。
4. 开启 **以管理员身份运行此配置文件（Automatically run as Administrator）**。
5. 保存并关闭全部 Windows Terminal 窗口。

对应的 Windows Terminal 设置合同是：

```json
{
  "defaultProfile": "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
  "profiles": {
    "list": [
      {
        "guid": "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
        "name": "PowerShell",
        "elevate": true
      }
    ]
  }
}
```

上面的 JSON 只用于解释最终合同，不要用整段覆盖现有 `settings.json`；优先使用
Windows Terminal 设置界面，避免删除已有 profiles、schemes 或快捷键配置。

保持当前管理员 Windows PowerShell 窗口，执行一次下面的命令注册固定管理员任务，
并在当前用户的开始菜单中创建日常快捷方式：

```powershell
$TaskName = 'Pi67-WindowsTerminal-Admin'
$WtPath = (Get-Command wt.exe -ErrorAction Stop).Source
$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$Action = New-ScheduledTaskAction `
  -Execute $WtPath `
  -Argument '-p "PowerShell"'
$Principal = New-ScheduledTaskPrincipal `
  -UserId $UserId `
  -LogonType Interactive `
  -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Principal $Principal `
  -Settings $Settings `
  -Description 'Open Windows Terminal as Administrator without repeated UAC prompts.' `
  -Force | Out-Null

$ShortcutPath = Join-Path `
  ([Environment]::GetFolderPath('Programs')) `
  'Windows Terminal (Administrator).lnk'
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "$env:SystemRoot\System32\schtasks.exe"
$Shortcut.Arguments = "/run /tn `"$TaskName`""
$Shortcut.WorkingDirectory = $HOME
$Shortcut.WindowStyle = 7
$Shortcut.IconLocation = "$WtPath,0"
$Shortcut.Save()

Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
Write-Host "Created: $ShortcutPath"
```

这是唯一一次需要从管理员 PowerShell 完成的配置。然后：

1. 在开始菜单搜索 **Windows Terminal (Administrator)**。
2. 右键把这个新入口固定到开始菜单或任务栏。
3. 取消固定原始 Windows Terminal 图标，避免误用。
4. 日常只从新入口打开；它会调用固定计划任务，不再弹 UAC。

因为 PowerShell profile 已开启管理员启动，原始 Windows Terminal 图标仍会弹 UAC。
Windows 本身不能让原始图标同时满足“始终管理员”和“永不弹 UAC”；若把系统策略改
为静默批准，则会取消当前管理员账户所有应用的 UAC 提示，因此本手册不采用该全局
方案。

可以先手动触发任务验证启动链：

```powershell
Start-ScheduledTask -TaskName 'Pi67-WindowsTerminal-Admin'
```

在新打开的 Windows Terminal 中验证 PowerShell 7 和管理员状态：

```powershell
$PSVersionTable.PSEdition
$PSVersionTable.PSVersion

$Principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
$Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

预期结果：

```text
PSEdition = Core
PSVersion = 7.x
Administrator = True
```

再检查计划任务没有漂移：

```powershell
$Task = Get-ScheduledTask -TaskName 'Pi67-WindowsTerminal-Admin'
$Task.Principal.RunLevel
$Task.Actions.Execute
$Task.Actions.Arguments
```

预期 `RunLevel` 为 `Highest`，执行文件指向 `wt.exe`，参数只固定打开
`PowerShell`。这个任务只消除该固定入口的重复确认，不会关闭系统 UAC。
它相当于给当前 Windows 用户保留一个持久管理员终端入口，只应配置在受控的个人开发
电脑上。

如需恢复为每次提权都由 UAC 确认，在管理员 Windows PowerShell 中删除任务和快捷
方式：

```powershell
Unregister-ScheduledTask `
  -TaskName 'Pi67-WindowsTerminal-Admin' `
  -Confirm:$false

$ShortcutPath = Join-Path `
  ([Environment]::GetFolderPath('Programs')) `
  'Windows Terminal (Administrator).lnk'
Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
```

微软官方依据：

```text
https://learn.microsoft.com/windows/terminal/customize-settings/startup
https://learn.microsoft.com/windows/terminal/customize-settings/profile-general
https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows
https://learn.microsoft.com/powershell/module/scheduledtasks/register-scheduledtask
https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks-run
```

## 四、第三步：安装 fnm

在 Windows Terminal 的 PowerShell 7 中执行：

```powershell
winget install `
  --id Schniz.fnm `
  -e `
  --source winget `
  --accept-package-agreements `
  --accept-source-agreements
```

完成后关闭所有 Windows Terminal 窗口，再重新打开一个新的 Windows Terminal。
这一步让新窗口继承 fnm 写入的 PATH。验证：

```powershell
fnm --version
```

如果 `winget` 显示已经安装，但新窗口仍找不到命令，先检查：

```powershell
winget list --id Schniz.fnm -e
$env:PATH -split ';'
```

不要在 bootstrap 中重复安装这些工具，也不要把临时 PATH 修复误认为永久安装完成。

## 五、第四步：配置 fnm，并安装 Node.js 24 LTS

### 1. 把 fnm 初始化写入当前用户 PowerShell profile

`fnm install` 只下载 Node.js；`fnm use` 还要求当前 PowerShell 会话先执行
`fnm env`。如果没有初始化 profile，会看到：

```text
error: We can't find the necessary environment variables to replace the Node version.
You should setup your shell profile to evaluate `fnm env`.
```

先确认当前使用的是 PowerShell 7 profile 路径：

```powershell
$PROFILE
```

典型路径是：

```text
C:\Users\<用户名>\Documents\PowerShell\Microsoft.PowerShell_profile.ps1
```

如果直接执行 `notepad $PROFILE` 时提示文件不存在，可以在提示框选择“是”；更稳妥的
标准步骤是先创建父目录和 profile 文件：

```powershell
$ProfileDir = Split-Path -Parent $PROFILE
if (-not (Test-Path -LiteralPath $ProfileDir)) {
  New-Item -Path $ProfileDir -ItemType Directory -Force | Out-Null
}

if (-not (Test-Path -LiteralPath $PROFILE)) {
  New-Item -Path $PROFILE -ItemType File -Force | Out-Null
}

notepad $PROFILE
```

由于前面已经替换系统记事本，这条命令会用 Notepad4 打开 profile。添加并保存下面这一
行，必须使用普通 ASCII 半角短横线：

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

保存后回到 PowerShell，检查这一行只存在一次，并立即加载 profile：

```powershell
$FnmLine = 'fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression'

if (-not (Select-String -LiteralPath $PROFILE -SimpleMatch $FnmLine -Quiet)) {
  throw "fnm initialization line was not saved to $PROFILE"
}

. $PROFILE
```

不要输入带排版长横线的 `New-Item –Path`；正确参数是 ASCII 的 `-Path`。如果不执行
`. $PROFILE`，当前窗口仍然没有加载 `fnm env`，需要再次关闭并重新打开 Terminal。

如果公司策略禁止加载 profile，不要自行放宽整机 ExecutionPolicy。可以先在当前窗口
直接执行以下初始化行，并联系 IT 处理用户 profile 策略：

```powershell
fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression
```

### 2. 安装和选择 Node.js 24 LTS Krypton

```powershell
fnm install lts/krypton
fnm default lts/krypton
fnm use lts/krypton
```

验证：

```powershell
fnm current
node --version
npm --version
Get-Command node
Get-Command npm
```

推荐 Node.js 24 LTS；最低合同为 Node.js `22.19.0`。如果 `node --version`
低于 `v22.19.0`，不要继续安装 Pi。

如果 `fnm use lts/krypton` 仍出现“necessary environment variables”错误，执行：

```powershell
Select-String -LiteralPath $PROFILE -SimpleMatch 'fnm env --use-on-cd --shell powershell'
. $PROFILE
fnm use lts/krypton
```

第一条必须能找到初始化行；第二条重新加载当前 Shell；第三条才会切换 Node 版本。

### 3. 设置并验证 npm 镜像源

Node.js 与 npm 验证通过后，设置 npm 镜像源：

```powershell
npm config set registry https://registry.npmmirror.com
npm config get registry
```

预期输出为：

```text
https://registry.npmmirror.com/
```

继续验证镜像和下一步需要的包是否可查询：

```powershell
npm ping
npm view @earendil-works/pi-coding-agent version
npm view @bigking67/pi-67 version
```

如果镜像暂时未同步目标包、返回 `E404` 或版本明显滞后，可以临时切到 npm 官方源
完成对应包的查询或安装：

```powershell
npm config set registry https://registry.npmjs.org/
npm config get registry
```

临时操作完成后必须切回团队约定的镜像源，并再次确认最终值：

```powershell
npm config set registry https://registry.npmmirror.com
npm config get registry
```

最终输出应为 `https://registry.npmmirror.com/`。后续 Windows workstation acceptance
只读取并验证这个最终值，不会替用户修改 npm 配置。

不要把 npm registry 设置放回轻量 bootstrap；它是用户级持久配置，应在手动工作站步骤
中显式完成和验证。

### 4. 可选：安装 Oh My Posh 美化 PowerShell 7

这一步只改变终端提示符外观，不影响 Node.js、npm、upstream Pi 或 pi-67 是否可用，
也不是 workstation acceptance 的阻断项。在 PowerShell 7 中执行：

```powershell
winget install JanDeDobbeleer.OhMyPosh --source winget --scope user --force
```

安装完成后关闭全部 Windows Terminal 窗口，再从固定的
`Windows Terminal (Administrator)` 入口重新打开 PowerShell 7，然后验证：

```powershell
oh-my-posh version
```

截图中的文件夹、闪电、勾选等图标需要 Nerd Font。团队主推荐是
`Maple Mono NF CN`：它同时包含 Nerd Font 图标、简体中文、繁体中文和日文字形，
并针对中英文终端提供 2:1 等宽对齐。不要误装成缺少图标的 `Maple Mono CN` 或缺少
完整中文的 `Maple Mono NF`。

从 Maple Mono 官方最新 release 下载标准 hinted 版本及对应 SHA-256，在安装前完成
完整性校验。压缩包较大，下载需要一些时间：

```powershell
$MapleBaseUri = 'https://github.com/subframe7536/maple-font/releases/latest/download'
$MapleZip = Join-Path $env:TEMP 'MapleMono-NF-CN.zip'
$MapleShaFile = Join-Path $env:TEMP 'MapleMono-NF-CN.sha256'

Invoke-WebRequest `
  -UseBasicParsing `
  -Uri "$MapleBaseUri/MapleMono-NF-CN.zip" `
  -OutFile $MapleZip

Invoke-WebRequest `
  -UseBasicParsing `
  -Uri "$MapleBaseUri/MapleMono-NF-CN.sha256" `
  -OutFile $MapleShaFile

$ExpectedHash = (Get-Content -LiteralPath $MapleShaFile -Raw).Trim().ToLowerInvariant()
$ActualHash = (Get-FileHash -LiteralPath $MapleZip -Algorithm SHA256).Hash.ToLowerInvariant()

if ($ExpectedHash -notmatch '^[0-9a-f]{64}$') {
  throw 'Invalid Maple Mono SHA-256 file'
}
if ($ActualHash -ne $ExpectedHash) {
  throw "Maple Mono SHA-256 mismatch: expected $ExpectedHash, actual $ActualHash"
}

oh-my-posh font install $MapleZip --headless
Remove-Item -LiteralPath $MapleZip, $MapleShaFile -Force
```

安装后进入 Windows Terminal 的 **设置 -> 配置文件 -> PowerShell -> 外观 -> 字体**，
把字体设为 `Maple Mono NF CN`。保存后关闭全部 Terminal 窗口再重新打开，确认中文、
Powerline 分隔符和图标均正常显示。

如果 GitHub 字体包暂时无法下载，可以临时使用兼容 fallback：

```powershell
oh-my-posh font install meslo
```

此时 Terminal 字体改为 `MesloLGM Nerd Font`；Meslo 不再是中文团队的主推荐。如果
不想安装任何 Nerd Font，应从主题库选择名称中带 `minimal` 的主题。

打开 profile：

```powershell
notepad $PROFILE
```

把下面一行放在 `$PROFILE` 的最后，并确保只出现一次：

```powershell
oh-my-posh init pwsh | Invoke-Expression
```

保存后回到 PowerShell 7，立即重新加载：

```powershell
. $PROFILE
```

如果 ExecutionPolicy 阻止普通初始化，不要同时保留两条 Oh My Posh 初始化命令；把
上一行替换为下面的官方 fallback：

```powershell
oh-my-posh init pwsh --eval | Invoke-Expression
```

`--eval` 会让 Shell 初始化更慢，因此只在普通写法确实失败时使用。更多主题及预览：

```text
https://ohmyposh.dev/docs/themes
https://github.com/subframe7536/maple-font/blob/variable/README_CN.md
```

要恢复原始 PowerShell 提示符，只需从 `$PROFILE` 删除 Oh My Posh 初始化行，再重新
打开 Terminal；不要删除前面用于 fnm 的初始化行。

## 六、第五步：安装真实 upstream Pi

pi-67 不是聊天运行时。真实运行时始终是 upstream
`@earendil-works/pi-coding-agent`，日常入口始终是 `pi`。

```powershell
npm install --global `
  @earendil-works/pi-coding-agent@latest `
  --no-audit `
  --no-fund `
  --no-update-notifier
```

验证：

```powershell
pi --version
Get-Command pi
```

如果 npm 安装成功但当前窗口找不到 `pi`，关闭并重新打开 Windows Terminal，执行
`fnm use lts/krypton`，再重试 `pi --version`。

## 七、第六步：下载并运行轻量 pi-67 bootstrap

### 1. 下载 release asset

```powershell
$Bootstrap = Join-Path $env:TEMP 'pi67-bootstrap.ps1'
$Checksum = "$Bootstrap.sha256"
$Base = 'https://github.com/bigKING67/pi-67/releases/latest/download'

Invoke-WebRequest `
  -UseBasicParsing `
  -Uri "$Base/pi67-bootstrap.ps1" `
  -OutFile $Bootstrap

Invoke-WebRequest `
  -UseBasicParsing `
  -Uri "$Base/pi67-bootstrap.ps1.sha256" `
  -OutFile $Checksum
```

不要使用下载后立即执行的网络管道。先保存、校验，再运行，失败时才能复用
同一份脚本排障。

### 2. 校验 SHA-256

```powershell
$Expected = ((Get-Content $Checksum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$Actual = (Get-FileHash $Bootstrap -Algorithm SHA256).Hash.ToLowerInvariant()

if ($Actual -ne $Expected) {
  throw 'pi67-bootstrap.ps1 SHA-256 mismatch'
}
```

### 3. 先预览，再执行

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -DryRun -Mode Auto

powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Mode Auto
```

`-ExecutionPolicy Bypass` 只作用于这一次 PowerShell 进程，不会永久修改系统策略。
新 bootstrap 不会请求 UAC。

`-Mode` 的语义：

| 模式 | 行为 |
| --- | --- |
| `Auto` | 默认；`~/.pi/agent/.git` 存在时 update，否则 install |
| `Install` | 显式执行 `pi-67 install --repair --yes` |
| `Update` | 显式执行 `pi-67 update`；要求工作区已是 Git checkout |

正常完成会输出：

```text
RESULT: PASS
```

同时在 `~/.pi/pi67/logs/manager-bootstrap-*/` 生成：

```text
bootstrap.log
bootstrap-summary.json
git-version.log
node-version.log
npm-version.log
pi-version.log
install-pi-67-manager.log
pi-67-workspace-install.log 或 pi-67-workspace-update.log
pi-67-version-json.log
pi-67-doctor-json.log
```

## 八、不使用 bootstrap 的等价手动命令

如果 Git、Node.js、npm 和 upstream Pi 已经全部就绪，也可以直接执行：

```powershell
npm install --global `
  @bigking67/pi-67@latest `
  --no-audit `
  --no-fund `
  --no-update-notifier

pi-67 install --repair --yes
pi-67 version --json
pi-67 doctor --json
```

已有 `~/.pi/agent` Git checkout 时，把 install 换成：

```powershell
pi-67 update
```

bootstrap 的价值是统一 Auto/Install/Update 判断、前置检查、日志和 summary；它不再
承担 Windows 工作站配置。

## 九、第七步：关闭 Terminal，重新打开并完成验收

安装完成后关闭旧 Windows Terminal，再从固定的
**Windows Terminal (Administrator)** 入口打开新窗口：

```powershell
winget --version
pwsh --version
git --version
fnm --version
fnm current
node --version
npm --version
pi --version
pi-67 version --json
pi-67 doctor --json

Test-Path "$env:USERPROFILE\.pi\agent\.git"
```

最终一行应为 `True`。然后运行：

```powershell
pi
```

Pi 能进入交互界面即说明 upstream runtime 和工作区加载链已经建立。没有任何 provider
key 时，Pi 仍应能够启动；只是模型请求需要先完成登录或本地 key 配置。

## 十、登录、选择模型、可选晶泰配置和 Hy-Memory

在 Pi 交互界面中，认证和模型选择由 upstream Pi 自己持久化：

```text
/login
/model
```

公司用户如果要提前配置个人晶泰 key，可以在终端执行：

```powershell
pi-67 xtalpi configure --verify
```

该命令使用隐藏输入，不要把 API key 写进命令参数、脚本、仓库、聊天记录或截图。
晶泰 key 不是安装 pi-67 或启动 Pi 的前置条件。

如果要给当前 Windows 用户启用跨项目长期记忆，先安装 Python 3.11（只需
一次）：

```powershell
winget install --id Python.Python.3.11 -e --source winget
py -3.11 --version
```

然后确认已经在 upstream Pi 中配置 provider `deepseek`，执行：

```powershell
pi-67 memory init
pi-67 memory doctor --deep
pi
```

`memory init` 会隐藏读取 SiliconFlow key，并把独立 Python runtime、凭据、
Chroma/SQLite 数据和 outbox 放到
`$env:USERPROFILE\.hy-memory\pi67`。不要把 key 放入 PowerShell 命令参数、
profile、仓库、截图或聊天记录。该目录只属于当前 Windows 用户，但记忆会在
该用户的所有 Pi 项目之间共享。完整说明见
[`hy-memory.md`](hy-memory.md)。

## 十一、日常更新

### 1. 只更新 upstream Pi runtime

upstream Pi 是独立 npm 包，只通过自己的安装命令更新：

```powershell
npm install --global @earendil-works/pi-coding-agent@latest --no-audit --no-fund --no-update-notifier
pi --version
```

### 2. 只更新 pi-67 manager 和工作区

重新下载最新 bootstrap 后执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Mode Auto
```

或使用手动命令：

```powershell
npm install --global @bigking67/pi-67@latest --no-audit --no-fund --no-update-notifier
pi-67 update
pi-67 version --json
pi-67 doctor --json
```

如果 release notes 标明 Hy-Memory SDK/wrapper 已升级，再运行：

```powershell
pi-67 memory upgrade --dry-run
pi-67 memory upgrade
pi-67 memory doctor --deep
```

`memory upgrade` 保留该用户的 config、secrets、data 和 outbox；它不会迁移
或删除现有 `agent_memory`/EverOS 数据。

普通 update 会自动同步 update plan 检测到的缺失或落后的 managed npm packages。
只有 plan 显示正常但本机 `npm/node_modules` 仍损坏时，才执行
`pi-67 update --repair` 强制重装。`pi-67 update --yes` 不再是有效参数。

pi-67 只负责 manager、`~/.pi/agent`、托管 extensions、Skills、rules、prompts、
templates、MCP/provider 模板、配置迁移、修复、doctor、smoke 与 report。
pi-67 不会安装或更新 upstream Pi；它最多只读报告 Pi 的 installed/tested/latest 和
兼容性。旧的 `--include-pi` 与跨所有权的 `--all` 已移除，继续使用会直接报
`unknown option`。

`pi update --extensions` 仅适用于 user-managed upstream Pi extensions；
pi-67-managed extensions 使用 `pi-67 update`；明确损坏时再使用
`pi-67 update --repair`。

## 十二、常见失败和恢复

### 1. prerequisite 阶段失败

`prerequisite-git`、`prerequisite-node`、`prerequisite-npm` 或
`prerequisite-pi` 失败，表示对应手动步骤没有完成，或当前 Terminal 还没继承新的
PATH。不要反复重跑 bootstrap；先关闭 Terminal、重新打开，并单独验证失败的命令。

### 2. `Update mode requires an existing pi-67 Git checkout`

`-Mode Update` 只用于已有 `~/.pi/agent/.git` 的电脑。纯新机改用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Bootstrap -Mode Install
```

或者直接使用默认的 `-Mode Auto`。

### 3. `agent dir exists but is not a git checkout`

说明 `~/.pi/agent` 已被其他流程创建成普通目录。使用 repair 安装会先把旧目录移动到
`~/.pi/pi67/backups/<timestamp>-non-git-agent-dir/agent`，再 clone 正式工作区：

```powershell
pi-67 install --repair --yes --dry-run
pi-67 install --repair --yes
```

### 4. update 被 dirty checkout 阻断

pi-67 默认不覆盖未知本地改动。先查看：

```powershell
Set-Location "$env:USERPROFILE\.pi\agent"
git status --short
git diff
```

确认改动归属后再决定是保留、提交还是按项目流程处理。不要用 `git reset --hard`
或 `git clean -fd` 代替判断。

### 5. npm 或网络失败

打开本次 `manager-bootstrap-*` 日志目录，优先查看失败 stage 对应的 `.log`。bootstrap
不会静默切换 npm registry、代理或镜像；网络、证书、公司代理或 registry 问题应在
环境层显式修复。

## 十三、维护者验证

修改 `scripts/pi67-bootstrap.ps1` 或本文后，至少验证：

```powershell
.\scripts\pi67-bootstrap.ps1 -SelfTest
.\scripts\pi67-bootstrap.ps1 -DryRun
.\scripts\pi67-bootstrap.ps1 -DryRun -Mode Install
.\scripts\pi67-bootstrap.ps1 -DryRun -Mode Update
```

仓库 release gate 还应运行：

```bash
bash scripts/pi67-release-check.sh
bash scripts/pi67-smoke.sh --ci
bash scripts/pi67-release-artifact-smoke.sh --ref WORKTREE
```

发布时 GitHub Release 仍同时上传：

```text
pi67-bootstrap.ps1
pi67-bootstrap.ps1.sha256
```

但该 asset 现在是轻量的 pi-67 manager/workspace bootstrap，不再代表完整 Windows
工作站安装器。
