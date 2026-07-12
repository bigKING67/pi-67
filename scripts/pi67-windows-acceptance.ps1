#!/usr/bin/env pwsh
# One-command Windows update and acceptance gate for upstream Pi + pi-67.

[CmdletBinding()]
param(
  [switch]$SkipUpdate,
  [switch]$ValidateWorkstation,
  [switch]$SkipDesktopPrerequisites,
  [switch]$SkipNotepad4Integration,
  [switch]$NoTerminalAdmin,
  [switch]$SelfTest,
  [string]$RepoRoot = "",
  [string]$AgentDir = "",
  [string]$OutDir = "",
  [switch]$Help
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
pi67-windows-acceptance.ps1 updates pi-67 and runs the Windows acceptance gate.

Usage:
  .\scripts\pi67-windows-acceptance.ps1
  .\scripts\pi67-windows-acceptance.ps1 -SkipUpdate
  .\scripts\pi67-windows-acceptance.ps1 -ValidateWorkstation
  .\scripts\pi67-windows-acceptance.ps1 -SelfTest

Options:
  -SkipUpdate  Skip both manager and distro updates; validate the current install.
  -ValidateWorkstation
               Also validate WinGet, Terminal/PowerShell 7, Notepad4, Git,
               fnm, the PowerShell profile, and the active Node.js source.
  -SkipDesktopPrerequisites
               With -ValidateWorkstation, skip Terminal, PowerShell 7, and
               Notepad4 checks. Git, fnm, Node.js, Pi, and pi-67 remain required.
  -SkipNotepad4Integration
               Require Notepad4 but skip Explorer/Notepad registry checks.
  -NoTerminalAdmin
               Expect Terminal profiles to have elevate=false instead of true.
  -SelfTest    Run offline acceptance-contract tests without updating or calling APIs.
  -RepoRoot    Override the pi-67 checkout path. Defaults to this script's repo.
  -AgentDir    Override the Pi agent directory. Defaults to `$HOME\.pi\agent.
  -OutDir      Override the repo-external artifact directory.
  -Help        Show this help.

Default update order:
  1. pi-67 self-update
  2. pi-67 update --repair --yes
  3. Bare pi runtime, pi-67 workspace, and xtalpi-pi-tools acceptance checks
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
$ScriptDir = Split-Path -Parent $ScriptPath
. (Join-Path $ScriptDir "pi67-json-utils.ps1")

$ExpectedProvider = "xtalpi-pi-tools"
$ExpectedModel = "deepseek-v4-pro"
$ExpectedLiveCases = @("read-package", "read-enoent-recovery")
$MinimumNodeVersion = [version]"22.19.0"
$PreferredNodeMajor = 24
$WindowsPowerShellProfileGuid = "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}"
$PowerShell7ProfileGuid = "{574e775e-4f2a-5b96-ac1e-a2962a402336}"
$FnmProfileLine = "fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression"

function Get-HomePath {
  if ($env:USERPROFILE) { return $env:USERPROFILE }
  if ($HOME) { return $HOME }
  return [Environment]::GetFolderPath("UserProfile")
}

function Get-AbsolutePath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$BasePath
  )

  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Test-IsWindows {
  return $env:OS -eq "Windows_NT"
}

function Test-CommandExists {
  param([Parameter(Mandatory = $true)][string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-CommandPath {
  param([Parameter(Mandatory = $true)][string[]]$Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
      if ($command.Source) { return [string]$command.Source }
      if ($command.Path) { return [string]$command.Path }
      return $name
    }
  }
  return ""
}

function Get-NodeManagerNameForPath {
  param([string]$Path)

  $normalized = ([string]$Path).Replace("/", "\").ToLowerInvariant()
  if ($normalized -match '\\fnm(?:_|\\)|\\\.fnm\\') { return "fnm" }
  if ($normalized -match '\\nvm(?:\\|$)') { return "nvm" }
  if ($normalized -match '\\volta\\|\\\.volta\\') { return "volta" }
  if ($normalized -match '\\scoop\\') { return "scoop" }
  return ""
}

function Test-PathListContains {
  param(
    [AllowEmptyString()][string]$PathValue,
    [Parameter(Mandatory = $true)][string]$Directory
  )

  $expected = $Directory.Trim().TrimEnd('\')
  foreach ($part in @([string]$PathValue -split ';')) {
    if ([string]::Equals($part.Trim().TrimEnd('\'), $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Test-PersistentPathContains {
  param([Parameter(Mandatory = $true)][string]$Directory)

  return (Test-PathListContains ([Environment]::GetEnvironmentVariable("Path", "User")) $Directory) -or
    (Test-PathListContains ([Environment]::GetEnvironmentVariable("Path", "Machine")) $Directory)
}

function Find-Notepad4Executable {
  $resolved = Resolve-CommandPath @("Notepad4.exe", "Notepad4")
  if ($resolved) { return $resolved }
  if ($env:LOCALAPPDATA) {
    $link = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\Notepad4.exe"
    if (Test-Path -LiteralPath $link -PathType Leaf) { return $link }
  }
  return ""
}

function Find-WindowsTerminalExecutable {
  $resolved = Resolve-CommandPath @("wt.exe", "wt")
  if ($resolved) { return $resolved }
  if ($env:LOCALAPPDATA) {
    $link = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\wt.exe"
    if (Test-Path -LiteralPath $link -PathType Leaf) { return $link }
  }
  return ""
}

function Find-PowerShell7Executable {
  $resolved = Resolve-CommandPath @("pwsh.exe", "pwsh")
  if ($resolved) { return $resolved }
  foreach ($root in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $root) { continue }
    $candidate = Join-Path $root "PowerShell\7\pwsh.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return ""
}

function Get-WindowsTerminalSettingsPath {
  if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is unavailable" }
  foreach ($familyName in @(
    "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
    "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"
  )) {
    $path = Join-Path (Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA "Packages") $familyName) "LocalState") "settings.json"
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
  }
  $unpackaged = Join-Path (Join-Path $env:LOCALAPPDATA "Microsoft\Windows Terminal") "settings.json"
  if (Test-Path -LiteralPath $unpackaged -PathType Leaf) { return $unpackaged }
  throw "Windows Terminal settings.json was not found"
}

function Get-PowerShellProfileCandidates {
  $documents = [Environment]::GetFolderPath("MyDocuments")
  if ([string]::IsNullOrWhiteSpace($documents)) {
    $documents = Join-Path (Get-HomePath) "Documents"
  }
  return @(
    (Join-Path (Join-Path $documents "PowerShell") "Microsoft.PowerShell_profile.ps1"),
    (Join-Path (Join-Path $documents "WindowsPowerShell") "Microsoft.PowerShell_profile.ps1")
  )
}

function Assert-TerminalProfileContract {
  param(
    [Parameter(Mandatory = $true)]$Settings,
    [Parameter(Mandatory = $true)][string]$Guid,
    [Parameter(Mandatory = $true)][bool]$Elevate,
    [Parameter(Mandatory = $true)][bool]$MustBeDefault
  )

  $profiles = Get-JsonPropertyValue $Settings "profiles"
  $items = if ($profiles -is [System.Array]) { @($profiles) } else { @((Get-JsonPropertyValue $profiles "list")) }
  $target = $null
  foreach ($item in $items) {
    if ($null -eq $item) { continue }
    if ([string]::Equals([string](Get-JsonPropertyValue $item "guid"), $Guid, [System.StringComparison]::OrdinalIgnoreCase)) {
      $target = $item
      break
    }
  }
  if ($null -eq $target) { throw "Windows Terminal profile is missing: $Guid" }
  if ([bool](Get-JsonPropertyValue $target "elevate") -ne $Elevate) {
    throw "Windows Terminal profile elevate contract drifted: $Guid"
  }
  if ((Get-JsonPropertyValue $target "hidden") -eq $true) {
    throw "Windows Terminal profile is hidden: $Guid"
  }
  if ($MustBeDefault -and -not [string]::Equals(
    [string](Get-JsonPropertyValue $Settings "defaultProfile"),
    $Guid,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw "Windows Terminal defaultProfile is not PowerShell 7"
  }
}

function Assert-FnmPowerShellProfileContract {
  $matchedPath = ""
  foreach ($profilePath in @(Get-PowerShellProfileCandidates)) {
    if (-not (Test-Path -LiteralPath $profilePath -PathType Leaf)) { continue }
    $text = [System.IO.File]::ReadAllText($profilePath)
    if ([regex]::Matches($text, [regex]::Escape($FnmProfileLine)).Count -eq 1) {
      $matchedPath = $profilePath
      break
    }
  }
  if (-not $matchedPath) {
    throw "fnm PowerShell initialization was not found exactly once in a supported profile"
  }
  return $matchedPath
}

function Assert-Notepad4IntegrationContract {
  param([Parameter(Mandatory = $true)][string]$Notepad4Path)

  $contextMenu = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey("*\shell\Notepad4")
  $contextCommand = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey("*\shell\Notepad4\command")
  $notepadIfeo = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\notepad.exe")
  try {
    if ($null -eq $contextMenu -or $contextMenu.GetValue("icon") -ne $Notepad4Path) {
      throw "Notepad4 Explorer context-menu registry contract failed"
    }
    if ($null -eq $contextCommand -or $contextCommand.GetValue("") -ne ('"{0}" "%1"' -f $Notepad4Path)) {
      throw "Notepad4 Explorer command registry contract failed"
    }
    if ($null -eq $notepadIfeo -or $notepadIfeo.GetValue("Debugger") -ne ('"{0}" /z' -f $Notepad4Path)) {
      throw "Notepad4 notepad.exe replacement registry contract failed"
    }
    if ([int]$notepadIfeo.GetValue("UseFilter", -1) -ne 0) {
      throw "Notepad4 UseFilter registry contract failed"
    }
  } finally {
    if ($contextCommand) { $contextCommand.Dispose() }
    if ($contextMenu) { $contextMenu.Dispose() }
    if ($notepadIfeo) { $notepadIfeo.Dispose() }
  }
}

function Assert-WorkstationContract {
  foreach ($command in @("winget", "git", "fnm", "node", "npm")) {
    if (-not (Test-CommandExists $command)) { throw "workstation command not found: $command" }
  }

  $gitPath = Resolve-CommandPath @("git.exe", "git")
  $fnmPath = Resolve-CommandPath @("fnm.exe", "fnm")
  $nodePath = Resolve-CommandPath @("node.exe", "node")
  foreach ($entry in @(
    @{ name = "Git"; path = $gitPath },
    @{ name = "fnm"; path = $fnmPath }
  )) {
    $directory = Split-Path -Parent $entry.path
    if (-not $directory -or -not (Test-PersistentPathContains $directory)) {
      throw "$($entry.name) is not present in persistent User/Machine PATH"
    }
  }
  if ((Get-NodeManagerNameForPath $nodePath) -ne "fnm") {
    throw "active Node.js is not managed by fnm: $nodePath"
  }
  $nodeOutput = @(& $nodePath --version 2>&1)
  if ($LASTEXITCODE -ne 0 -or $nodeOutput.Count -eq 0) { throw "node --version failed during workstation validation" }
  $nodeVersion = Assert-NodeRuntimeContract ([string]$nodeOutput[0])
  if ($nodeVersion.Major -ne $PreferredNodeMajor) {
    throw "fresh-machine Node.js must resolve to major $PreferredNodeMajor through fnm"
  }
  $script:WorkstationNodePath = $nodePath
  $script:FnmProfilePath = Assert-FnmPowerShellProfileContract

  if ($SkipDesktopPrerequisites) { return }
  if (-not (Find-WindowsTerminalExecutable)) { throw "desktop prerequisite command not found: wt.exe" }
  if (-not (Find-PowerShell7Executable)) { throw "desktop prerequisite command not found: pwsh.exe" }
  $notepad4 = Find-Notepad4Executable
  if (-not $notepad4) { throw "desktop prerequisite command not found: Notepad4.exe" }

  $settingsPath = Get-WindowsTerminalSettingsPath
  $settings = Read-Pi67JsonFile $settingsPath
  $elevate = -not [bool]$NoTerminalAdmin
  Assert-TerminalProfileContract $settings $WindowsPowerShellProfileGuid $elevate $false
  Assert-TerminalProfileContract $settings $PowerShell7ProfileGuid $elevate $true
  if (-not $SkipNotepad4Integration) {
    Assert-Notepad4IntegrationContract $notepad4
  }
  $script:TerminalSettingsPath = $settingsPath
  $script:Notepad4Path = $notepad4
}

function Get-ChildPowerShell {
  if (Test-CommandExists "pwsh") { return "pwsh" }
  if (Test-CommandExists "powershell") { return "powershell" }
  return ""
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
  $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList @($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Get-JsonPropertyValue {
  param(
    [object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $Object) { return $null }
  foreach ($property in @($Object.PSObject.Properties)) {
    if ($property.Name -eq $Name) { return $property.Value }
  }
  return $null
}

function ConvertFrom-JsonText {
  param(
    [AllowEmptyString()][string]$Text,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Text)) {
    throw "$Label returned empty JSON"
  }
  try {
    return $Text | ConvertFrom-Json
  } catch {
    throw ("{0} returned invalid JSON: {1}" -f $Label, $_.Exception.Message)
  }
}

function Get-UpdateCommands {
  param(
    [Parameter(Mandatory = $true)][string]$ResolvedRepoRoot,
    [Parameter(Mandatory = $true)][string]$ResolvedAgentDir
  )

  return @(
    [pscustomobject]@{
      Name = "manager-self-update"
      FilePath = "pi-67"
      Arguments = @("self-update")
    },
    [pscustomobject]@{
      Name = "distro-update"
      FilePath = "pi-67"
      Arguments = @(
        "--agent-dir", $ResolvedAgentDir,
        "--repo-root", $ResolvedRepoRoot,
        "update", "--repair", "--yes"
      )
    }
  )
}

function Get-RecoverySuggestion {
  param([string]$Stage)

  switch -Wildcard ($Stage) {
    "preflight" {
      return "Run the published pi67-bootstrap.ps1 to install WinGet readiness, Git, fnm/Node.js 24 LTS, upstream Pi, and pi-67; reopen PowerShell and retry."
    }
    "workstation-prerequisites" {
      return "Rerun pi67-bootstrap.ps1. It repairs WinGet, Terminal/PowerShell 7, Notepad4, Git PATH, fnm, and the PowerShell profile before Pi acceptance."
    }
    "manager-self-update" {
      return "Run: npm install -g @bigking67/pi-67@latest"
    }
    "distro-update" {
      return "Run: pi-67 update --check; resolve the reported blocker; then run pi-67 update --repair --yes"
    }
    "version-and-config" {
      return "Run: pi-67 update --repair --yes"
    }
    "pi-runtime" {
      return "Run: pi --version. If pi is missing, run npm install -g @earendil-works/pi-coding-agent. If Pi reports spawn git ENOENT, run pi-67 install --repair --yes, reopen PowerShell, and retry pi."
    }
    "xtalpi-health" {
      return "Run: pi-67 xtalpi health; verify the xtalpi-pi-tools API key outside source control."
    }
    "xtalpi-capability" {
      return "Run: pi-67 xtalpi capability --json-action-runs 5 --skip-native-probes"
    }
    "xtalpi-live-smoke" {
      return 'Retry: .\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Case "read-package,read-enoent-recovery"'
    }
    "xtalpi-summary-contract" {
      return "Inspect the xtalpi smoke summary JSON and its per-case failureReasons."
    }
    "worktree-clean" {
      return "Run: git status --short; keep user runtime secrets out of commits and resolve only intentional tracked edits."
    }
    default {
      return "Inspect the failed stage log in the acceptance artifact directory, fix the first failure, and rerun."
    }
  }
}

function ConvertTo-NodeVersion {
  param([Parameter(Mandatory = $true)][string]$Value)

  $normalized = $Value.Trim()
  if ($normalized.StartsWith("v", [System.StringComparison]::OrdinalIgnoreCase)) {
    $normalized = $normalized.Substring(1)
  }
  $normalized = ($normalized -split '[-+]')[0]
  try {
    return [version]$normalized
  } catch {
    throw "node --version returned an invalid version: $Value"
  }
}

function Assert-NodeRuntimeContract {
  param([Parameter(Mandatory = $true)][string]$VersionText)

  $version = ConvertTo-NodeVersion $VersionText
  if ($version -lt $MinimumNodeVersion) {
    throw "Node.js $VersionText is unsupported; install Node.js 24 LTS (minimum 22.19.0)"
  }
  return $version
}

function Format-SkippedStageLine {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Message = ""
  )

  if ([string]::IsNullOrWhiteSpace($Message)) {
    return "  SKIP $Name"
  }
  return "  SKIP $Name ($Message)"
}

function Assert-VersionContract {
  param(
    [Parameter(Mandatory = $true)][object]$VersionData,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
  )

  $manager = [string](Get-JsonPropertyValue (Get-JsonPropertyValue $VersionData "manager") "version")
  $distroObject = Get-JsonPropertyValue $VersionData "distro"
  $distro = [string](Get-JsonPropertyValue $distroObject "version")
  $dirty = Get-JsonPropertyValue $distroObject "dirty"

  if ($ExpectedVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw "VERSION is not semver-like: $ExpectedVersion"
  }
  if ($manager -ne $ExpectedVersion) {
    throw "manager version $manager does not match distro VERSION $ExpectedVersion"
  }
  if ($distro -ne $ExpectedVersion) {
    throw "reported distro version $distro does not match VERSION $ExpectedVersion"
  }
  if ($dirty -eq $true) {
    throw "repository is dirty immediately after update"
  }
}

function Assert-ConfigContract {
  param(
    [Parameter(Mandatory = $true)][object]$Settings,
    [Parameter(Mandatory = $true)][object]$Models
  )

  $defaultProvider = [string](Get-JsonPropertyValue $Settings "defaultProvider")
  $defaultModel = [string](Get-JsonPropertyValue $Settings "defaultModel")
  if ($defaultProvider -ne $ExpectedProvider) {
    throw "settings.json defaultProvider must be $ExpectedProvider, got $defaultProvider"
  }
  if ($defaultModel -ne $ExpectedModel) {
    throw "settings.json defaultModel must be $ExpectedModel, got $defaultModel"
  }

  $providers = Get-JsonPropertyValue $Models "providers"
  $provider = Get-JsonPropertyValue $providers $ExpectedProvider
  if ($null -eq $provider) {
    throw "models.json is missing providers.$ExpectedProvider"
  }
  $apiKey = [string](Get-JsonPropertyValue $provider "apiKey")
  if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "models.json providers.$ExpectedProvider.apiKey is not configured"
  }
}

function Assert-HealthContract {
  param([Parameter(Mandatory = $true)][object]$Health)

  if ((Get-JsonPropertyValue $Health "ok") -ne $true) {
    throw "xtalpi provider health did not return ok=true"
  }
  if ([string](Get-JsonPropertyValue $Health "provider") -ne $ExpectedProvider) {
    throw "xtalpi health returned an unexpected provider"
  }
  if ([string](Get-JsonPropertyValue $Health "model") -ne $ExpectedModel) {
    throw "xtalpi health returned an unexpected model"
  }
}

function Assert-CapabilityContract {
  param([Parameter(Mandatory = $true)][object]$Capability)

  if ((Get-JsonPropertyValue $Capability "probeCompleted") -ne $true) {
    throw "xtalpi capability probe did not complete"
  }
  if ((Get-JsonPropertyValue $Capability "runtimeReady") -ne $true) {
    throw "xtalpi capability runtimeReady is not true"
  }
  if ((Get-JsonPropertyValue $Capability "ok") -ne $true) {
    throw "xtalpi capability ok is not true"
  }
  if ([string](Get-JsonPropertyValue $Capability "recommendedMode") -ne "local_json_action_protocol") {
    throw "xtalpi capability did not recommend local_json_action_protocol"
  }

  $summary = Get-JsonPropertyValue $Capability "summary"
  $jsonAction = Get-JsonPropertyValue $summary "jsonAction"
  $passes = [int](Get-JsonPropertyValue $jsonAction "passes")
  $runs = [int](Get-JsonPropertyValue $jsonAction "runs")
  if ((Get-JsonPropertyValue $jsonAction "ok") -ne $true -or $runs -ne 5 -or $passes -ne $runs) {
    throw "xtalpi JSON action capability must pass 5/5 runs"
  }
}

function Get-SmokeCaseSummary {
  param(
    [Parameter(Mandatory = $true)][object]$Summary,
    [Parameter(Mandatory = $true)][string]$CaseName
  )

  $matches = @(@(Get-JsonPropertyValue $Summary "cases") | Where-Object {
    [string](Get-JsonPropertyValue $_ "caseName") -eq $CaseName
  })
  if ($matches.Count -ne 1) {
    throw "expected exactly one $CaseName smoke summary, got $($matches.Count)"
  }
  return $matches[0]
}

function Assert-CommonSmokeCaseContract {
  param(
    [Parameter(Mandatory = $true)][object]$CaseSummary,
    [Parameter(Mandatory = $true)][string]$CaseName
  )

  if ((Get-JsonPropertyValue $CaseSummary "ok") -ne $true) {
    throw "$CaseName did not return ok=true"
  }
  foreach ($field in @("argExpectationOk", "recoveryExpectationOk", "debugTelemetryOk", "finalAnswerQualityOk")) {
    if ((Get-JsonPropertyValue $CaseSummary $field) -ne $true) {
      throw "$CaseName $field is not true"
    }
  }
}

function Assert-XtalpiSmokeSummary {
  param([Parameter(Mandatory = $true)][object]$Summary)

  if ((Get-JsonPropertyValue $Summary "ok") -ne $true) {
    throw "xtalpi smoke summary ok is not true"
  }
  if ([int](Get-JsonPropertyValue $Summary "failures") -ne 0) {
    throw "xtalpi smoke summary failures is not zero"
  }
  $selectedCases = @((Get-JsonPropertyValue $Summary "selectedCases") | ForEach-Object { [string]$_ })
  if (($selectedCases -join ",") -ne ($ExpectedLiveCases -join ",")) {
    throw "xtalpi smoke selectedCases drifted: $($selectedCases -join ',')"
  }

  $readCase = Get-SmokeCaseSummary $Summary "read-package"
  Assert-CommonSmokeCaseContract $readCase "read-package"
  $readTools = @((Get-JsonPropertyValue $readCase "actualToolNames") | ForEach-Object { [string]$_ })
  if (($readTools -join ",") -ne "read") {
    throw "read-package actualToolNames must be read, got $($readTools -join ',')"
  }

  $enoentCase = Get-SmokeCaseSummary $Summary "read-enoent-recovery"
  Assert-CommonSmokeCaseContract $enoentCase "read-enoent-recovery"
  $enoentTools = @((Get-JsonPropertyValue $enoentCase "actualToolNames") | ForEach-Object { [string]$_ })
  if (($enoentTools -join ",") -ne "read,fffind,read") {
    throw "read-enoent-recovery actualToolNames must be read,fffind,read, got $($enoentTools -join ',')"
  }
  if ((Get-JsonPropertyValue $enoentCase "enoentLedgerObserved") -ne $true) {
    throw "read-enoent-recovery did not observe the ENOENT ledger"
  }
  if ([int](Get-JsonPropertyValue $enoentCase "repeatedReadRecoveryCount") -ne 1) {
    throw "read-enoent-recovery repeatedReadRecoveryCount must be 1"
  }
}

function Run-SelfTest {
  $plan = @(Get-UpdateCommands "C:\fixture\agent" "C:\fixture\agent")
  if ($plan.Count -ne 2 -or ($plan[0].Arguments -join " ") -ne "self-update") {
    throw "self-update must be the first acceptance update command"
  }
  if (($plan[1].Arguments -join " ") -notmatch 'update --repair --yes$') {
    throw "distro update command contract drifted"
  }

  $versionFixture = [pscustomobject]@{
    manager = [pscustomobject]@{ version = "1.2.3" }
    distro = [pscustomobject]@{ version = "1.2.3"; dirty = $false }
  }
  Assert-VersionContract $versionFixture "1.2.3"
  Assert-NodeRuntimeContract "v22.19.0" | Out-Null
  Assert-NodeRuntimeContract "v24.18.0" | Out-Null
  $oldNodeRejected = $false
  try {
    Assert-NodeRuntimeContract "v22.18.9" | Out-Null
  } catch {
    $oldNodeRejected = $true
  }
  if (-not $oldNodeRejected) {
    throw "acceptance must reject Node.js versions older than 22.19.0"
  }

  $capabilityFixture = [pscustomobject]@{
    probeCompleted = $true
    runtimeReady = $true
    ok = $true
    recommendedMode = "local_json_action_protocol"
    summary = [pscustomobject]@{
      jsonAction = [pscustomobject]@{ ok = $true; passes = 5; runs = 5 }
    }
  }
  Assert-CapabilityContract $capabilityFixture

  $readFixture = [pscustomobject]@{
    caseName = "read-package"
    ok = $true
    actualToolNames = @("read")
    argExpectationOk = $true
    recoveryExpectationOk = $true
    debugTelemetryOk = $true
    finalAnswerQualityOk = $true
  }
  $enoentFixture = [pscustomobject]@{
    caseName = "read-enoent-recovery"
    ok = $true
    actualToolNames = @("read", "fffind", "read")
    argExpectationOk = $true
    recoveryExpectationOk = $true
    enoentLedgerObserved = $true
    repeatedReadRecoveryCount = 1
    debugTelemetryOk = $true
    finalAnswerQualityOk = $true
  }
  $smokeFixture = [pscustomobject]@{
    ok = $true
    failures = 0
    selectedCases = $ExpectedLiveCases
    cases = @($readFixture, $enoentFixture)
  }
  Assert-XtalpiSmokeSummary $smokeFixture

  $badFixture = $smokeFixture | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  (Get-SmokeCaseSummary $badFixture "read-enoent-recovery").repeatedReadRecoveryCount = 0
  $rejected = $false
  try {
    Assert-XtalpiSmokeSummary $badFixture
  } catch {
    $rejected = $true
  }
  if (-not $rejected) {
    throw "acceptance summary must reject a missing repeated-read recovery"
  }
  if ((Get-RecoverySuggestion "manager-self-update") -notmatch "npm install -g") {
    throw "manager recovery suggestion drifted"
  }
  if ((Get-RecoverySuggestion "pi-runtime") -notmatch "pi --version") {
    throw "Pi runtime recovery suggestion must use the real pi entrypoint"
  }
  if ((Format-SkippedStageLine "manager-self-update" "requested by -SkipUpdate") -notmatch '-SkipUpdate') {
    throw "skipped-stage output must explain why the update was skipped"
  }
  if ((Get-NodeManagerNameForPath "C:\Users\fixture\.fnm\node-versions\v24.18.0\installation\node.exe") -ne "fnm") {
    throw "acceptance must recognize fnm-managed Node.js"
  }
  $terminalFixture = [pscustomobject]@{
    defaultProfile = $PowerShell7ProfileGuid
    profiles = [pscustomobject]@{
      list = @(
        [pscustomobject]@{ guid = $WindowsPowerShellProfileGuid; elevate = $true; hidden = $false },
        [pscustomobject]@{ guid = $PowerShell7ProfileGuid; elevate = $true; hidden = $false }
      )
    }
  }
  Assert-TerminalProfileContract $terminalFixture $WindowsPowerShellProfileGuid $true $false
  Assert-TerminalProfileContract $terminalFixture $PowerShell7ProfileGuid $true $true

  $source = [System.IO.File]::ReadAllText($ScriptPath)
  foreach ($required in @(
    '[switch]$ValidateWorkstation',
    '[switch]$SkipDesktopPrerequisites',
    '[switch]$SkipNotepad4Integration',
    '[switch]$NoTerminalAdmin',
    'Assert-WorkstationContract',
    $FnmProfileLine,
    $PowerShell7ProfileGuid,
    'Invoke-CommandStage "pi-runtime" "pi"'
  )) {
    if (-not $source.Contains($required)) {
      throw "acceptance source is missing required workstation contract: $required"
    }
  }

  Write-Host "pi-67 Windows acceptance self-test passed" -ForegroundColor Green
}

if ($SelfTest) {
  Run-SelfTest
  exit 0
}

$HomePath = Get-HomePath
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
} else {
  $RepoRoot = Get-AbsolutePath $RepoRoot (Get-Location).Path
}
if ([string]::IsNullOrWhiteSpace($AgentDir)) {
  $AgentDir = Join-Path (Join-Path $HomePath ".pi") "agent"
} else {
  $AgentDir = Get-AbsolutePath $AgentDir (Get-Location).Path
}
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pi67-windows-acceptance-{0}-{1}" -f $stamp, $PID)
} else {
  $OutDir = Get-AbsolutePath $OutDir (Get-Location).Path
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$SummaryPath = Join-Path $OutDir "acceptance-summary.json"
$CapabilityPath = Join-Path $OutDir "xtalpi-capability.json"
$XtalpiSmokeSummaryPath = Join-Path $OutDir "xtalpi-smoke-summary.json"
$XtalpiSmokeOutDir = Join-Path $OutDir "xtalpi-smoke"

$script:Stages = @()
$script:CurrentStage = "bootstrap"
$script:FailedStage = ""
$script:FailureMessage = ""
$script:Result = "FAIL"
$script:ChildPowerShell = ""
$script:VersionData = $null
$script:PiRuntimeVersion = ""
$script:NodeRuntimeVersion = ""
$script:ConfigProvider = ""
$script:ConfigModel = ""
$script:HealthData = $null
$script:CapabilityData = $null
$script:XtalpiSmokeData = $null
$script:WorkstationNodePath = ""
$script:FnmProfilePath = ""
$script:TerminalSettingsPath = ""
$script:Notepad4Path = ""

function Add-StageResult {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet("PASS", "FAIL", "SKIP")][string]$Status,
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

function Invoke-NativeCapture {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$LogPath
  )

  $oldErrorActionPreference = $ErrorActionPreference
  $output = @()
  $exitCode = 127
  try {
    $ErrorActionPreference = "Continue"
    Push-Location $WorkingDirectory
    try {
      $global:LASTEXITCODE = 0
      $output = & $FilePath @Arguments 2>&1
      $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
    } catch {
      $output = @($_.Exception.Message)
      $exitCode = 127
    } finally {
      Pop-Location
    }
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }

  $lines = @($output | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
  })
  $text = $lines -join "`n"
  Write-Utf8Text $LogPath $(if ($text) { "$text`n" } else { "" })
  return [pscustomobject]@{
    exitCode = $exitCode
    output = $lines
    text = $text
    logPath = $LogPath
  }
}

function Write-StageFailureExcerpt {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [object[]]$Output = @(),
    [int]$MaxLines = 40
  )

  Write-Host ("  FAIL {0}" -f $Name) -ForegroundColor Red
  Write-Host ("  LOG  {0}" -f $LogPath) -ForegroundColor Yellow
  $lines = @($Output | ForEach-Object { [string]$_ })
  if ($lines.Count -eq 0) {
    return
  }

  $tail = @($lines | Select-Object -Last $MaxLines)
  Write-Host ("  --- output tail ({0}/{1} lines) ---" -f $tail.Count, $lines.Count) -ForegroundColor DarkYellow
  foreach ($line in $tail) {
    Write-Host ("  {0}" -f $line)
  }
  Write-Host "  --- end output tail ---" -ForegroundColor DarkYellow
}

function Invoke-CommandStage {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [scriptblock]$Validate = $null
  )

  $script:CurrentStage = $Name
  $logPath = Join-Path $OutDir ("{0}.log" -f $Name)
  Write-Host ("  RUN  {0}" -f $Name) -ForegroundColor Cyan
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $result = $null
  try {
    $result = Invoke-NativeCapture $FilePath $Arguments $RepoRoot $logPath
    if ($result.exitCode -ne 0) {
      throw ("command exited {0}; see {1}" -f $result.exitCode, $logPath)
    }
    if ($null -ne $Validate) {
      & $Validate $result
    }
    $timer.Stop()
    Add-StageResult $Name "PASS" $timer.ElapsedMilliseconds $logPath
    Write-Host ("  PASS {0}" -f $Name) -ForegroundColor Green
    return $result
  } catch {
    $timer.Stop()
    Add-StageResult $Name "FAIL" $timer.ElapsedMilliseconds $logPath $_.Exception.Message
    $failureOutput = if ($null -ne $result) { @($result.output) } else { @() }
    Write-StageFailureExcerpt $Name $logPath $failureOutput
    throw
  }
}

function Invoke-CheckStage {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Body
  )

  $script:CurrentStage = $Name
  Write-Host ("  RUN  {0}" -f $Name) -ForegroundColor Cyan
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $value = & $Body
    $timer.Stop()
    Add-StageResult $Name "PASS" $timer.ElapsedMilliseconds
    Write-Host ("  PASS {0}" -f $Name) -ForegroundColor Green
    return $value
  } catch {
    $timer.Stop()
    Add-StageResult $Name "FAIL" $timer.ElapsedMilliseconds "" $_.Exception.Message
    throw
  }
}

function Add-SkippedStage {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Message
  )
  Add-StageResult $Name "SKIP" 0 "" $Message
  Write-Host (Format-SkippedStageLine $Name $Message) -ForegroundColor Yellow
}

Write-Host ""
Write-Host "pi-67 Windows one-command acceptance" -ForegroundColor Cyan
Write-Host ("Artifacts: {0}" -f $OutDir)

$exitCode = 0
try {
  Invoke-CheckStage "preflight" {
    if (-not (Test-IsWindows)) {
      throw "this acceptance entrypoint must run on Windows PowerShell"
    }
    if ($PSVersionTable.PSVersion.Major -lt 5) {
      throw "PowerShell 5.1 or newer is required"
    }
    foreach ($command in @("node", "pi-67", "pi")) {
      if (-not (Test-CommandExists $command)) {
        throw "required command not found: $command"
      }
    }
    $nodeOutput = @(& node --version 2>&1)
    $nodeExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
    if ($nodeExitCode -ne 0 -or $nodeOutput.Count -eq 0) {
      throw "node --version failed"
    }
    $script:NodeRuntimeVersion = ([string]$nodeOutput[0]).Trim()
    $nodeVersion = Assert-NodeRuntimeContract $script:NodeRuntimeVersion
    if ($nodeVersion.Major -ne $PreferredNodeMajor) {
      Write-Host ("  WARN compatible Node.js {0} detected; Node.js 24 LTS is preferred" -f $script:NodeRuntimeVersion) -ForegroundColor Yellow
    }
    Initialize-Pi67GitPath | Out-Null
    if (-not (Test-CommandExists "git")) {
      throw "required command not found: git"
    }
    if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
      throw "repo root not found: $RepoRoot"
    }
    if (-not (Test-Path -LiteralPath $AgentDir -PathType Container)) {
      throw "agent dir not found: $AgentDir"
    }
    foreach ($file in @(
      (Join-Path $RepoRoot "VERSION"),
      (Join-Path $AgentDir "settings.json"),
      (Join-Path $AgentDir "models.json"),
      (Join-Path $ScriptDir "pi67-xtalpi-pi-tools-smoke.ps1")
    )) {
      if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "required file not found: $file"
      }
    }
    $script:ChildPowerShell = Get-ChildPowerShell
    if (-not $script:ChildPowerShell) {
      throw "no child PowerShell executable found"
    }
  } | Out-Null

  if ($ValidateWorkstation) {
    Invoke-CheckStage "workstation-prerequisites" {
      Assert-WorkstationContract
    } | Out-Null
  }

  if ($SkipUpdate) {
    Add-SkippedStage "manager-self-update" "requested by -SkipUpdate; validating current install only"
    Add-SkippedStage "distro-update" "requested by -SkipUpdate; validating current install only"
  } else {
    foreach ($command in @(Get-UpdateCommands $RepoRoot $AgentDir)) {
      Invoke-CommandStage $command.Name $command.FilePath $command.Arguments | Out-Null
    }
  }

  $contextArgs = @("--agent-dir", $AgentDir, "--repo-root", $RepoRoot)
  Invoke-CommandStage "version-and-config" "pi-67" ($contextArgs + @("version", "--json")) {
    param($commandResult)
    $script:VersionData = ConvertFrom-JsonText $commandResult.text "pi-67 version --json"
    $expectedVersion = (Get-Content -LiteralPath (Join-Path $RepoRoot "VERSION") -Raw).Trim()
    Assert-VersionContract $script:VersionData $expectedVersion
    $settings = Read-Pi67JsonFile (Join-Path $AgentDir "settings.json")
    $models = Read-Pi67JsonFile (Join-Path $AgentDir "models.json")
    Assert-ConfigContract $settings $models
    $script:ConfigProvider = [string](Get-JsonPropertyValue $settings "defaultProvider")
    $script:ConfigModel = [string](Get-JsonPropertyValue $settings "defaultModel")
  } | Out-Null

  Invoke-CommandStage "doctor" "pi-67" ($contextArgs + @("doctor")) | Out-Null
  Invoke-CommandStage "repository-smoke" "pi-67" ($contextArgs + @("smoke", "--quick")) | Out-Null
  Invoke-CommandStage "pi-runtime" "pi" @("--version") {
    param($commandResult)
    $script:PiRuntimeVersion = ([string]$commandResult.text).Trim()
    if ([string]::IsNullOrWhiteSpace($script:PiRuntimeVersion)) {
      throw "pi --version returned empty output"
    }
  } | Out-Null

  Invoke-CommandStage "xtalpi-health" "pi-67" ($contextArgs + @(
    "xtalpi", "health",
    "--provider", $ExpectedProvider,
    "--model", $ExpectedModel,
    "--timeout-ms", "30000",
    "--attempts", "2"
  )) {
    param($commandResult)
    $script:HealthData = ConvertFrom-JsonText $commandResult.text "pi-67 xtalpi health"
    Assert-HealthContract $script:HealthData
  } | Out-Null

  Invoke-CommandStage "xtalpi-capability" "pi-67" ($contextArgs + @(
    "xtalpi", "capability",
    "--provider", $ExpectedProvider,
    "--model", $ExpectedModel,
    "--timeout-ms", "30000",
    "--json-action-runs", "5",
    "--skip-native-probes",
    "--output-file", $CapabilityPath
  )) {
    param($commandResult)
    $script:CapabilityData = ConvertFrom-JsonText $commandResult.text "pi-67 xtalpi capability"
    Assert-CapabilityContract $script:CapabilityData
    if (-not (Test-Path -LiteralPath $CapabilityPath -PathType Leaf)) {
      throw "capability JSON artifact was not written"
    }
  } | Out-Null

  $xtalpiSmokeScript = Join-Path $ScriptDir "pi67-xtalpi-pi-tools-smoke.ps1"
  Invoke-CommandStage "xtalpi-smoke-self-test" $script:ChildPowerShell @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $xtalpiSmokeScript, "-SelfTest"
  ) | Out-Null

  Invoke-CommandStage "xtalpi-live-smoke" $script:ChildPowerShell @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $xtalpiSmokeScript,
    "-AgentDir", $AgentDir,
    "-Provider", $ExpectedProvider,
    "-Model", $ExpectedModel,
    "-Case", ($ExpectedLiveCases -join ","),
    "-NoPreflight",
    "-CaseTimeoutSeconds", "180",
    "-CaseRetries", "1",
    "-RequestTimeoutMs", "120000",
    "-OutDir", $XtalpiSmokeOutDir,
    "-SummaryFile", $XtalpiSmokeSummaryPath
  ) | Out-Null

  Invoke-CheckStage "xtalpi-summary-contract" {
    if (-not (Test-Path -LiteralPath $XtalpiSmokeSummaryPath -PathType Leaf)) {
      throw "xtalpi smoke summary was not written: $XtalpiSmokeSummaryPath"
    }
    $script:XtalpiSmokeData = Read-Pi67JsonFile $XtalpiSmokeSummaryPath
    Assert-XtalpiSmokeSummary $script:XtalpiSmokeData
  } | Out-Null

  Invoke-CommandStage "worktree-clean" "git" @(
    "-C", $RepoRoot, "status", "--porcelain=v1", "--untracked-files=no"
  ) {
    param($commandResult)
    if (-not [string]::IsNullOrWhiteSpace($commandResult.text)) {
      throw "tracked worktree changes remain after acceptance; see the stage log"
    }
  } | Out-Null

  $script:Result = "PASS"
} catch {
  $exitCode = 1
  $script:Result = "FAIL"
  $script:FailedStage = $script:CurrentStage
  $script:FailureMessage = $_.Exception.Message
}

$managerVersion = ""
$distroVersion = ""
if ($null -ne $script:VersionData) {
  $managerVersion = [string](Get-JsonPropertyValue (Get-JsonPropertyValue $script:VersionData "manager") "version")
  $distroVersion = [string](Get-JsonPropertyValue (Get-JsonPropertyValue $script:VersionData "distro") "version")
}

$healthOk = $false
if ($null -ne $script:HealthData) {
  $healthOk = (Get-JsonPropertyValue $script:HealthData "ok") -eq $true
}
$capabilityReady = $false
$recommendedMode = ""
if ($null -ne $script:CapabilityData) {
  $capabilityReady = (Get-JsonPropertyValue $script:CapabilityData "runtimeReady") -eq $true
  $recommendedMode = [string](Get-JsonPropertyValue $script:CapabilityData "recommendedMode")
}

$readTools = @()
$enoentTools = @()
if ($null -ne $script:XtalpiSmokeData) {
  try {
    $readTools = @((Get-JsonPropertyValue (Get-SmokeCaseSummary $script:XtalpiSmokeData "read-package") "actualToolNames"))
    $enoentTools = @((Get-JsonPropertyValue (Get-SmokeCaseSummary $script:XtalpiSmokeData "read-enoent-recovery") "actualToolNames"))
  } catch {
    $readTools = @()
    $enoentTools = @()
  }
}

$summary = [pscustomobject][ordered]@{
  schema = "pi67.windows-acceptance.v2"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  result = $script:Result
  failedStage = $script:FailedStage
  failureMessage = $script:FailureMessage
  recoverySuggestion = if ($script:Result -eq "FAIL") { Get-RecoverySuggestion $script:FailedStage } else { "" }
  updateSkipped = [bool]$SkipUpdate
  options = [pscustomobject][ordered]@{
    validateWorkstation = [bool]$ValidateWorkstation
    skipDesktopPrerequisites = [bool]$SkipDesktopPrerequisites
    skipNotepad4Integration = [bool]$SkipNotepad4Integration
    terminalProfilesElevated = -not [bool]$NoTerminalAdmin
  }
  paths = [pscustomobject][ordered]@{
    repoRoot = $RepoRoot
    agentDir = $AgentDir
    outputDirectory = $OutDir
    summary = $SummaryPath
  }
  versions = [pscustomobject][ordered]@{
    node = $script:NodeRuntimeVersion
    manager = $managerVersion
    distro = $distroVersion
    piRuntime = $script:PiRuntimeVersion
  }
  workstation = [pscustomobject][ordered]@{
    validated = [bool]$ValidateWorkstation
    nodePath = $script:WorkstationNodePath
    fnmPowerShellProfile = $script:FnmProfilePath
    windowsTerminalSettings = $script:TerminalSettingsPath
    notepad4 = $script:Notepad4Path
  }
  config = [pscustomobject][ordered]@{
    defaultProvider = $script:ConfigProvider
    defaultModel = $script:ConfigModel
  }
  xtalpi = [pscustomobject][ordered]@{
    healthOk = $healthOk
    runtimeReady = $capabilityReady
    recommendedMode = $recommendedMode
    readPackageActualTools = $readTools
    enoentRecoveryActualTools = $enoentTools
  }
  artifacts = [pscustomobject][ordered]@{
    capability = $CapabilityPath
    xtalpiSmokeSummary = $XtalpiSmokeSummaryPath
    stageLogs = $OutDir
  }
  stages = @($script:Stages)
}

try {
  Save-Pi67JsonFileUtf8NoBom $SummaryPath $summary
} catch {
  $exitCode = 1
  $script:Result = "FAIL"
  if (-not $script:FailedStage) { $script:FailedStage = "summary-write" }
  if (-not $script:FailureMessage) { $script:FailureMessage = $_.Exception.Message }
}

Write-Host ""
if ($script:Result -eq "PASS" -and $exitCode -eq 0) {
  Write-Host "RESULT: PASS" -ForegroundColor Green
  Write-Host ("Version: {0}" -f $distroVersion)
  Write-Host ("Pi runtime: {0}" -f $script:PiRuntimeVersion)
  if ($ValidateWorkstation) {
    Write-Host ("Workstation: validated (Node via fnm: {0})" -f $script:WorkstationNodePath)
  }
  Write-Host ("xtalpi: health=true runtimeReady=true mode={0}" -f $recommendedMode)
} else {
  Write-Host "RESULT: FAIL" -ForegroundColor Red
  Write-Host ("Failed stage: {0}" -f $script:FailedStage)
  Write-Host ("Reason: {0}" -f $script:FailureMessage)
  Write-Host ("Recovery: {0}" -f (Get-RecoverySuggestion $script:FailedStage))
}
Write-Host ("Summary: {0}" -f $SummaryPath)
Write-Host ("Logs: {0}" -f $OutDir)

exit $exitCode
