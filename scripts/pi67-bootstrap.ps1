#!/usr/bin/env powershell
# Installs or updates the pi-67 manager and managed workspace on Windows.

[CmdletBinding()]
param(
  [ValidateSet("Auto", "Install", "Update")]
  [string]$Mode = "Auto",
  [switch]$DryRun,
  [switch]$SelfTest,
  [string]$AgentDir = "",
  [string]$LogDir = "",
  [switch]$Help
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$MinimumNodeVersion = [version]"22.19.0"
$Pi67Package = "@bigking67/pi-67@latest"
$InstallGuide = "https://github.com/bigKING67/pi-67/blob/main/docs/windows-fresh-install.md"

function Show-Usage {
  @"
pi67-bootstrap.ps1 installs or updates only the pi-67 manager and workspace.

Before running it, install the Windows prerequisites from the manual:
  $InstallGuide

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1 -Mode Install
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1 -Mode Update
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1 -DryRun
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1 -SelfTest

Options:
  -Mode Auto|Install|Update
                   Auto updates an existing Git checkout and installs otherwise.
  -DryRun          Print the pi-67 plan without changing the computer.
  -SelfTest        Run deterministic offline contract tests only.
  -AgentDir        Override the managed workspace. Default: `$HOME\.pi\agent.
  -LogDir          Override the log root. Default: `$HOME\.pi\pi67\logs.
  -Help            Show this help.

Required before execution:
  - Git on PATH.
  - Node.js >= $MinimumNodeVersion and npm on PATH.
  - The upstream pi command on PATH.

This script does not install system or runtime prerequisites, request
Administrator access, modify shell profiles or registry settings, change the
npm registry, configure provider credentials, or run full workstation setup.
Daily use remains:
  pi
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

function Test-IsWindows {
  return $env:OS -eq "Windows_NT"
}

function Get-HomePath {
  if ($env:USERPROFILE) { return $env:USERPROFILE }
  if ($HOME) { return $HOME }
  return [Environment]::GetFolderPath("UserProfile")
}

function ConvertTo-SemVer {
  param([Parameter(Mandatory = $true)][string]$Value)

  $normalized = $Value.Trim()
  if ($normalized.StartsWith("v", [System.StringComparison]::OrdinalIgnoreCase)) {
    $normalized = $normalized.Substring(1)
  }
  $normalized = ($normalized -split '[-+]')[0]
  try {
    return [version]$normalized
  } catch {
    throw "invalid semantic version: $Value"
  }
}

function Test-NodeVersionSupported {
  param([Parameter(Mandatory = $true)][string]$Value)
  return (ConvertTo-SemVer $Value) -ge $MinimumNodeVersion
}

function Get-WorkspaceAction {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("Auto", "Install", "Update")][string]$RequestedMode,
    [Parameter(Mandatory = $true)][bool]$HasGitCheckout
  )

  if ($RequestedMode -eq "Auto") {
    if ($HasGitCheckout) { return "update" }
    return "install"
  }
  return $RequestedMode.ToLowerInvariant()
}

function Get-BootstrapFlow {
  param([Parameter(Mandatory = $true)][ValidateSet("install", "update")][string]$WorkspaceAction)

  return @(
    "preflight",
    "prerequisite-git",
    "prerequisite-node",
    "prerequisite-npm",
    "prerequisite-pi",
    "pi-67-manager",
    "pi-67-workspace-$WorkspaceAction",
    "pi-67-version",
    "pi-67-doctor"
  )
}

function Get-WorkspaceCommandArguments {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("install", "update")][string]$WorkspaceAction,
    [Parameter(Mandatory = $true)][string]$WorkspacePath
  )

  $arguments = @("--agent-dir", $WorkspacePath, "--repo-root", $WorkspacePath)
  if ($WorkspaceAction -eq "install") {
    return @($arguments + @("install", "--repair", "--yes"))
  }
  return @($arguments + @("update"))
}

function Resolve-CommandPath {
  param([Parameter(Mandatory = $true)][string[]]$Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { continue }
    if ($command.Source) { return [string]$command.Source }
    if ($command.Path) { return [string]$command.Path }
    if ($command.Definition) { return [string]$command.Definition }
  }
  return ""
}

function Add-ProcessPathEntry {
  param([Parameter(Mandatory = $true)][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $entries = @($env:PATH -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  foreach ($entry in $entries) {
    if ([string]::Equals($entry.TrimEnd('\'), $fullPath.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
      return
    }
  }
  $env:PATH = "$fullPath;$env:PATH"
}

function Write-Utf8Text {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowEmptyString()][string]$Text
  )

  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Get-StageLogPath {
  param([Parameter(Mandatory = $true)][string]$Name)
  $safe = $Name -replace '[^A-Za-z0-9._-]', '-'
  return Join-Path $script:RunLogDir "$safe.log"
}

function Append-BootstrapLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  if (-not $script:BootstrapLog) { return }
  [System.IO.File]::AppendAllText($script:BootstrapLog, "$Message`r`n", $script:Utf8NoBom)
}

function Add-StageResult {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet("PASS", "FAIL")][string]$Status,
    [long]$ElapsedMs = 0,
    [string]$LogPath = "",
    [string]$Message = ""
  )

  $script:Stages += [pscustomobject][ordered]@{
    name = $Name
    status = $Status
    elapsedMs = $ElapsedMs
    logPath = $LogPath
    message = $Message
  }
}

function Invoke-Stage {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Body
  )

  $script:CurrentStage = $Name
  $script:CurrentStageLog = ""
  Write-Host "  RUN  $Name" -ForegroundColor Cyan
  Append-BootstrapLog "RUN $Name"
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    & $Body | Out-Null
    $timer.Stop()
    Add-StageResult $Name "PASS" $timer.ElapsedMilliseconds $script:CurrentStageLog
    Write-Host "  PASS $Name" -ForegroundColor Green
    Append-BootstrapLog "PASS $Name"
  } catch {
    $timer.Stop()
    $message = $_.Exception.Message
    Add-StageResult $Name "FAIL" $timer.ElapsedMilliseconds $script:CurrentStageLog $message
    Write-Host "  FAIL $Name ($message)" -ForegroundColor Red
    Append-BootstrapLog "FAIL $Name ($message)"
    throw
  }
}

function Format-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  $formatted = @($Arguments | ForEach-Object {
    $value = [string]$_
    if ($value -match '[\s"]') { return '"' + $value.Replace('"', '\"') + '"' }
    return $value
  })
  if ($formatted.Count -eq 0) { return $FilePath }
  return "$FilePath $($formatted -join ' ')"
}

function Invoke-LoggedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  $logPath = Get-StageLogPath $Name
  $script:CurrentStageLog = $logPath
  Write-Utf8Text $logPath "COMMAND: $(Format-NativeCommand $FilePath $Arguments)`r`n"
  $global:LASTEXITCODE = 0
  try {
    & $FilePath @Arguments 2>&1 | ForEach-Object {
      $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
      Write-Host "    $line"
      [System.IO.File]::AppendAllText($logPath, "$line`r`n", $script:Utf8NoBom)
    }
  } catch {
    [System.IO.File]::AppendAllText($logPath, "ERROR: $($_.Exception.Message)`r`n", $script:Utf8NoBom)
    throw
  }
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  if ($exitCode -ne 0) {
    [System.IO.File]::AppendAllText($logPath, "EXIT_CODE: $exitCode`r`n", $script:Utf8NoBom)
    throw "$Name exited with code $exitCode; see $logPath"
  }
}

function Invoke-CapturedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  $logPath = Get-StageLogPath $Name
  $script:CurrentStageLog = $logPath
  $global:LASTEXITCODE = 0
  $output = @()
  try {
    $output = @(& $FilePath @Arguments 2>&1)
  } catch {
    $output = @($_.Exception.Message)
    $global:LASTEXITCODE = 127
  }
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  $text = @($output | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
  }) -join "`n"
  $logText = "COMMAND: $(Format-NativeCommand $FilePath $Arguments)`r`n"
  if ($text) { $logText += "$text`r`n" }
  Write-Utf8Text $logPath $logText
  if ($exitCode -ne 0) {
    throw "$Name exited with code $exitCode; see $logPath"
  }
  return [pscustomobject]@{ text = $text; logPath = $logPath }
}

function Get-FirstOutputLine {
  param([AllowEmptyString()][string]$Text)

  foreach ($line in @($Text -split "`r?`n")) {
    if (-not [string]::IsNullOrWhiteSpace($line)) { return $line.Trim() }
  }
  return ""
}

function Refresh-NpmGlobalPath {
  param([Parameter(Mandatory = $true)][string]$NpmPath)

  $global:LASTEXITCODE = 0
  $output = @(& $NpmPath "prefix" "--global" 2>$null)
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  if ($exitCode -ne 0 -or $output.Count -eq 0) { return }
  $prefix = ([string]$output[0]).Trim()
  if ($prefix -and (Test-Path -LiteralPath $prefix -PathType Container)) {
    Add-ProcessPathEntry $prefix
  }
}

function Run-SelfTest {
  if (-not (Test-NodeVersionSupported "v22.19.0")) {
    throw "Node minimum version must accept 22.19.0"
  }
  if (Test-NodeVersionSupported "22.18.9") {
    throw "Node minimum version must reject 22.18.9"
  }
  if ((Get-WorkspaceAction "Auto" $false) -ne "install") {
    throw "Auto mode must install when no Git checkout exists"
  }
  if ((Get-WorkspaceAction "Auto" $true) -ne "update") {
    throw "Auto mode must update an existing Git checkout"
  }
  if ((Get-WorkspaceAction "Install" $true) -ne "install") {
    throw "Install mode must remain explicit"
  }
  if ((Get-WorkspaceAction "Update" $false) -ne "update") {
    throw "Update mode must remain explicit"
  }
  $installArguments = @(Get-WorkspaceCommandArguments "install" "C:\fixture\.pi\agent")
  $updateArguments = @(Get-WorkspaceCommandArguments "update" "C:\fixture\.pi\agent")
  if (($installArguments -join " ") -notmatch ' install --repair --yes$') {
    throw "install command contract drifted"
  }
  if (($updateArguments -join " ") -notmatch ' update$') {
    throw "update command contract drifted"
  }

  $installFlow = @(Get-BootstrapFlow "install")
  $updateFlow = @(Get-BootstrapFlow "update")
  if ([array]::IndexOf($installFlow, "pi-67-manager") -ge [array]::IndexOf($installFlow, "pi-67-workspace-install")) {
    throw "manager installation must precede workspace installation"
  }
  if ([array]::IndexOf($updateFlow, "pi-67-workspace-update") -ge [array]::IndexOf($updateFlow, "pi-67-doctor")) {
    throw "workspace update must precede doctor"
  }

  $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
  $source = [System.IO.File]::ReadAllText($scriptPath)
  foreach ($required in @(
    "@bigking67/pi-67@latest",
    '"install", "--repair", "--yes"',
    'return @($arguments + @("update"))',
    '"version", "--json"',
    '"doctor", "--json"',
    "pi67.manager-bootstrap.v1"
  )) {
    if (-not $source.Contains($required)) {
      throw "manager bootstrap source is missing required contract: $required"
    }
  }
  foreach ($forbidden in @(
    ("Repair-" + "WinGetPackageManager"),
    ("Microsoft.Windows" + "Terminal"),
    ("Microsoft.Power" + "Shell"),
    ("zufuliu." + "notepad4"),
    ("Schniz." + "fnm"),
    ("Git." + "Git"),
    ("@earendil-works/" + "pi-coding-agent"),
    ("Start-" + "Process"),
    ("Set-" + "ExecutionPolicy"),
    ("xtalpi" + " configure"),
    ("pi67-windows-" + "acceptance"),
    ("npm config set" + " registry")
  )) {
    if ($source.Contains($forbidden)) {
      throw "manager bootstrap contains removed workstation responsibility: $forbidden"
    }
  }

  Write-Host "pi-67 manager bootstrap self-test passed" -ForegroundColor Green
}

function Resolve-AgentDir {
  param([AllowEmptyString()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return Join-Path (Join-Path (Get-HomePath) ".pi") "agent"
  }
  return [System.IO.Path]::GetFullPath($Value)
}

function Resolve-LogDir {
  param([AllowEmptyString()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return Join-Path (Join-Path (Join-Path (Get-HomePath) ".pi") "pi67") "logs"
  }
  return [System.IO.Path]::GetFullPath($Value)
}

function Show-DryRunPlan {
  $resolvedAgentDir = Resolve-AgentDir $AgentDir
  $hasGitCheckout = Test-Path -LiteralPath (Join-Path $resolvedAgentDir ".git")
  $workspaceAction = Get-WorkspaceAction $Mode $hasGitCheckout
  $workspaceArguments = @(Get-WorkspaceCommandArguments $workspaceAction $resolvedAgentDir)

  Write-Host ""
  Write-Host "pi-67 manager/workspace bootstrap plan" -ForegroundColor Cyan
  Write-Host "  Requested mode: $Mode"
  Write-Host "  Workspace action: $workspaceAction"
  Write-Host "  Agent directory: $resolvedAgentDir"
  Write-Host ""
  Write-Host "Manual prerequisites checked during a real run:"
  Write-Host "  Git, Node.js >= $MinimumNodeVersion, npm, and upstream pi on PATH"
  if ($Mode -eq "Update" -and -not $hasGitCheckout) {
    Write-Host "  WARN Update mode requires an existing Git checkout at the agent directory." -ForegroundColor Yellow
  }
  Write-Host ""
  foreach ($stage in @(Get-BootstrapFlow $workspaceAction)) {
    Write-Host "  PLANNED $stage"
  }
  Write-Host ""
  Write-Host "Manager command: npm install --global $Pi67Package --no-audit --no-fund --no-update-notifier"
  Write-Host "Workspace command: $(Format-NativeCommand 'pi-67' $workspaceArguments)"
  Write-Host "Verification: pi-67 version --json; pi-67 doctor --json"
  Write-Host "No system/runtime prerequisite installation or Administrator relaunch is planned."
  Write-Host "RESULT: DRY_RUN" -ForegroundColor Green
}

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList @($false)

if ($SelfTest) {
  Run-SelfTest
  exit 0
}

if ($DryRun) {
  Show-DryRunPlan
  exit 0
}

if (-not (Test-IsWindows)) {
  throw "this bootstrap must run on Windows; use the standard pi-67 npm commands on other platforms"
}

$script:AgentDir = Resolve-AgentDir $AgentDir
$resolvedLogDir = Resolve-LogDir $LogDir
$hasGitCheckout = Test-Path -LiteralPath (Join-Path $script:AgentDir ".git")
$script:WorkspaceAction = Get-WorkspaceAction $Mode $hasGitCheckout

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$script:RunLogDir = Join-Path $resolvedLogDir ("manager-bootstrap-{0}-{1}" -f $stamp, $PID)
New-Item -ItemType Directory -Force -Path $script:RunLogDir | Out-Null
$script:BootstrapLog = Join-Path $script:RunLogDir "bootstrap.log"
$script:SummaryPath = Join-Path $script:RunLogDir "bootstrap-summary.json"
Write-Utf8Text $script:BootstrapLog "pi-67 manager bootstrap started at $((Get-Date).ToUniversalTime().ToString('o'))`r`n"

$script:Stages = @()
$script:CurrentStage = "preflight"
$script:CurrentStageLog = ""
$script:GitCommand = ""
$script:GitVersion = ""
$script:NodeCommand = ""
$script:NodeVersion = ""
$script:NpmCommand = ""
$script:NpmVersion = ""
$script:PiCommand = ""
$script:PiVersion = ""
$script:Pi67Command = ""
$script:ManagerVersion = ""
$script:DistroVersion = ""
$script:DoctorSchema = ""
$script:Result = "FAIL"
$script:FailureMessage = ""

Write-Host ""
Write-Host "pi-67 manager/workspace bootstrap" -ForegroundColor Cyan
Write-Host "Requested mode: $Mode"
Write-Host "Workspace action: $script:WorkspaceAction"
Write-Host "Workspace: $script:AgentDir"
Write-Host "Logs: $script:RunLogDir"
Write-Host "Administrator access: not required"

$exitCode = 0
try {
  Invoke-Stage "preflight" {
    if (-not (Test-IsWindows)) { throw "this bootstrap must run on Windows" }
    if ($PSVersionTable.PSVersion -lt [version]"5.1") {
      throw "PowerShell 5.1 or newer is required"
    }
    if ($Mode -eq "Update" -and -not $hasGitCheckout) {
      throw "Update mode requires an existing pi-67 Git checkout at $script:AgentDir. Use -Mode Install or -Mode Auto."
    }
  }

  Invoke-Stage "prerequisite-git" {
    $script:GitCommand = Resolve-CommandPath @("git.exe", "git")
    if (-not $script:GitCommand) {
      throw "Git is required but was not found on PATH. Complete the Windows manual, reopen the terminal, and rerun this script: $InstallGuide"
    }
    $result = Invoke-CapturedNative "git-version" $script:GitCommand @("--version")
    $script:GitVersion = Get-FirstOutputLine $result.text
  }

  Invoke-Stage "prerequisite-node" {
    $script:NodeCommand = Resolve-CommandPath @("node.exe", "node")
    if (-not $script:NodeCommand) {
      throw "Node.js is required but was not found on PATH. Complete the Windows manual, reopen the terminal, and rerun this script: $InstallGuide"
    }
    $result = Invoke-CapturedNative "node-version" $script:NodeCommand @("--version")
    $script:NodeVersion = Get-FirstOutputLine $result.text
    if (-not (Test-NodeVersionSupported $script:NodeVersion)) {
      throw "Node.js $script:NodeVersion is unsupported; install Node.js 24 LTS or any supported version >= $MinimumNodeVersion"
    }
  }

  Invoke-Stage "prerequisite-npm" {
    $script:NpmCommand = Resolve-CommandPath @("npm.cmd", "npm")
    if (-not $script:NpmCommand) {
      throw "npm is required but was not found on PATH. Complete the Windows manual, reopen the terminal, and rerun this script: $InstallGuide"
    }
    $result = Invoke-CapturedNative "npm-version" $script:NpmCommand @("--version")
    $script:NpmVersion = Get-FirstOutputLine $result.text
  }

  Invoke-Stage "prerequisite-pi" {
    $script:PiCommand = Resolve-CommandPath @("pi.cmd", "pi")
    if (-not $script:PiCommand) {
      throw "The upstream pi command is required but was not found on PATH. Complete the Windows manual, reopen the terminal, and rerun this script: $InstallGuide"
    }
    $result = Invoke-CapturedNative "pi-version" $script:PiCommand @("--version")
    $script:PiVersion = Get-FirstOutputLine $result.text
  }

  Invoke-Stage "pi-67-manager" {
    Invoke-LoggedNative "install-pi-67-manager" $script:NpmCommand @(
      "install", "--global", $Pi67Package,
      "--no-audit", "--no-fund", "--no-update-notifier"
    )
    Refresh-NpmGlobalPath $script:NpmCommand
    $script:Pi67Command = Resolve-CommandPath @("pi-67.cmd", "pi-67")
    if (-not $script:Pi67Command) {
      throw "pi-67 was installed by npm, but pi-67.cmd was not found in the current process PATH"
    }
  }

  Invoke-Stage "pi-67-workspace-$script:WorkspaceAction" {
    $workspaceArguments = @(Get-WorkspaceCommandArguments $script:WorkspaceAction $script:AgentDir)
    Invoke-LoggedNative "pi-67-workspace-$script:WorkspaceAction" $script:Pi67Command $workspaceArguments
    if (-not (Test-Path -LiteralPath (Join-Path $script:AgentDir ".git"))) {
      throw "pi-67 workspace command completed without a Git checkout at $script:AgentDir"
    }
  }

  Invoke-Stage "pi-67-version" {
    $result = Invoke-CapturedNative "pi-67-version-json" $script:Pi67Command @(
      "--agent-dir", $script:AgentDir,
      "--repo-root", $script:AgentDir,
      "version", "--json"
    )
    try {
      $versionData = $result.text | ConvertFrom-Json -ErrorAction Stop
      $script:ManagerVersion = [string]$versionData.manager.version
      $script:DistroVersion = [string]$versionData.distro.version
    } catch {
      throw "pi-67 version --json returned invalid JSON; see $($result.logPath)"
    }
  }

  Invoke-Stage "pi-67-doctor" {
    $result = Invoke-CapturedNative "pi-67-doctor-json" $script:Pi67Command @(
      "--agent-dir", $script:AgentDir,
      "--repo-root", $script:AgentDir,
      "doctor", "--json"
    )
    try {
      $doctorData = $result.text | ConvertFrom-Json -ErrorAction Stop
      $script:DoctorSchema = [string]$doctorData.schema
    } catch {
      throw "pi-67 doctor --json returned invalid JSON; see $($result.logPath)"
    }
  }

  $script:Result = "PASS"
} catch {
  $exitCode = 1
  $script:Result = "FAIL"
  $script:FailureMessage = $_.Exception.Message
  Append-BootstrapLog "FATAL $($script:FailureMessage)"
}

$summary = [pscustomobject][ordered]@{
  schema = "pi67.manager-bootstrap.v1"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  result = $script:Result
  requestedMode = $Mode
  workspaceAction = $script:WorkspaceAction
  failedStage = if ($script:Result -eq "FAIL") { $script:CurrentStage } else { "" }
  failureMessage = $script:FailureMessage
  requirements = [pscustomobject][ordered]@{
    minimumNodeVersion = [string]$MinimumNodeVersion
    prerequisitesInstalledByScript = $false
    manualGuide = $InstallGuide
  }
  paths = [pscustomobject][ordered]@{
    agentDir = $script:AgentDir
    logDirectory = $script:RunLogDir
    bootstrapLog = $script:BootstrapLog
    summary = $script:SummaryPath
  }
  versions = [pscustomobject][ordered]@{
    git = $script:GitVersion
    node = $script:NodeVersion
    npm = $script:NpmVersion
    pi = $script:PiVersion
    manager = $script:ManagerVersion
    distro = $script:DistroVersion
  }
  verification = [pscustomobject][ordered]@{
    versionJson = [bool]$script:ManagerVersion
    doctorJson = [bool]$script:DoctorSchema
    doctorSchema = $script:DoctorSchema
  }
  stages = @($script:Stages)
}
Write-Utf8Text $script:SummaryPath (($summary | ConvertTo-Json -Depth 7) + "`r`n")

Write-Host ""
if ($script:Result -eq "PASS") {
  Write-Host "RESULT: PASS" -ForegroundColor Green
  Write-Host "pi-67 manager: $script:ManagerVersion"
  Write-Host "pi-67 distro: $script:DistroVersion"
  Write-Host "The pi-67 workspace is ready. Daily use: pi"
} else {
  Write-Host "RESULT: FAIL" -ForegroundColor Red
  Write-Host "Failed stage: $script:CurrentStage"
  Write-Host "Reason: $script:FailureMessage"
}
Write-Host "Summary: $script:SummaryPath"
Write-Host "Logs: $script:RunLogDir"

exit $exitCode
