#!/usr/bin/env powershell
# Fresh-Windows bootstrap for upstream Pi plus the pi-67 managed workspace.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Minimal,
  [switch]$SkipNotepad4Integration,
  [switch]$NoTerminalAdmin,
  [switch]$UseNpmMirror,
  [switch]$NoXtalpiPrompt,
  [switch]$SelfTest,
  [switch]$ElevatedRelaunch,
  [string]$AgentDir = "",
  [string]$LogDir = "",
  [switch]$Help
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$MinimumNodeVersion = [version]"22.19.0"
$PreferredNodeMajor = 24
$NodeLtsAlias = "lts/krypton"
$NpmMirrorRegistry = "https://registry.npmmirror.com"
$UpstreamPiPackage = "@earendil-works/pi-coding-agent@latest"
$Pi67Package = "@bigking67/pi-67@latest"
$ExpectedProvider = "xtalpi-pi-tools"
$ExpectedModel = "deepseek-v4-pro"
$WindowsPowerShellProfileGuid = "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}"
$PowerShell7ProfileGuid = "{574e775e-4f2a-5b96-ac1e-a2962a402336}"
$FnmProfileLine = "fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression"

function Show-Usage {
  @"
pi67-bootstrap.ps1 prepares a fresh Windows computer for upstream Pi and pi-67.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1 -Minimal
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1 -UseNpmMirror
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1 -NoXtalpiPrompt
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1 -DryRun
  powershell -NoProfile -ExecutionPolicy Bypass -File .\pi67-bootstrap.ps1 -SelfTest

Options:
  -DryRun          Print the installation plan without changing the computer.
  -Minimal         Skip Windows Terminal, PowerShell 7, and Notepad4 desktop setup.
                   Git, fnm, Node.js, Pi, pi-67, and provider setup still run.
  -SkipNotepad4Integration
                   Install Notepad4 without changing Explorer or Notepad registry integration.
  -NoTerminalAdmin Configure the Terminal profiles without automatic elevation.
  -UseNpmMirror    Persist https://registry.npmmirror.com for this user's npm config.
                   The default does not change the user's npm registry.
  -NoXtalpiPrompt  Do not request a personal xtalpi key. If no existing key or
                   PI67_XTALPI_API_KEY is available, finish as
                   READY_WITHOUT_XTALPI instead of claiming a full pass.
  -SelfTest        Run deterministic offline contract tests only.
  -AgentDir        Override the managed workspace path. Default: `$HOME\.pi\agent.
  -LogDir          Override the log root. Default: `$HOME\.pi\pi67\logs.
  -Help            Show this help.

Daily use after a successful bootstrap:
  pi

The script requests one Administrator session for WinGet repair, Terminal
profile elevation, and Notepad4 system integration. It never changes the
permanent PowerShell execution policy or proxy settings. The npm registry is
changed only when -UseNpmMirror is explicitly supplied. It never accepts an
API key as a command argument.
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

function Test-IsAdministrator {
  if (-not (Test-IsWindows)) { return $false }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal -ArgumentList $identity
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-QuotedPowerShellArgument {
  param([Parameter(Mandatory = $true)][string]$Value)

  return '"' + $Value.Replace('"', '\"') + '"'
}

function Get-ElevatedRelaunchArguments {
  $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
  if (-not $scriptPath) {
    throw "cannot determine the bootstrap script path for Administrator relaunch"
  }

  $arguments = New-Object System.Collections.Generic.List[string]
  foreach ($argument in @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath, "-ElevatedRelaunch")) {
    $arguments.Add([string]$argument)
  }
  foreach ($switchName in @(
    @{ enabled = [bool]$Minimal; value = "-Minimal" },
    @{ enabled = [bool]$SkipNotepad4Integration; value = "-SkipNotepad4Integration" },
    @{ enabled = [bool]$NoTerminalAdmin; value = "-NoTerminalAdmin" },
    @{ enabled = [bool]$UseNpmMirror; value = "-UseNpmMirror" },
    @{ enabled = [bool]$NoXtalpiPrompt; value = "-NoXtalpiPrompt" }
  )) {
    if ($switchName.enabled) { $arguments.Add($switchName.value) }
  }
  if (-not [string]::IsNullOrWhiteSpace($AgentDir)) {
    $arguments.Add("-AgentDir")
    $arguments.Add($AgentDir)
  }
  if (-not [string]::IsNullOrWhiteSpace($LogDir)) {
    $arguments.Add("-LogDir")
    $arguments.Add($LogDir)
  }
  return @($arguments)
}

function Start-ElevatedBootstrap {
  $hostPath = ""
  try {
    $hostPath = [string](Get-Process -Id $PID -ErrorAction Stop).Path
  } catch {
    $hostPath = Join-Path $PSHOME $(if ($PSVersionTable.PSEdition -eq "Core") { "pwsh.exe" } else { "powershell.exe" })
  }
  if (-not (Test-Path -LiteralPath $hostPath -PathType Leaf)) {
    throw "PowerShell host was not found for Administrator relaunch: $hostPath"
  }

  $commandLine = (@(Get-ElevatedRelaunchArguments) | ForEach-Object {
    ConvertTo-QuotedPowerShellArgument ([string]$_)
  }) -join " "

  Write-Host "Administrator access is required once for WinGet repair, Terminal profile elevation, and Notepad4 integration." -ForegroundColor Yellow
  Write-Host "Approve the Windows UAC prompt to continue." -ForegroundColor Yellow
  try {
    $process = Start-Process -FilePath $hostPath -ArgumentList $commandLine -Verb RunAs -Wait -PassThru
  } catch {
    throw "Administrator relaunch was cancelled or failed: $($_.Exception.Message)"
  }
  return [int]$process.ExitCode
}

function Get-BootstrapFlow {
  return @(
    "administrator",
    "winget",
    "windows-terminal",
    "terminal-windows-powershell",
    "powershell-7",
    "terminal-powershell-7",
    "notepad4",
    "notepad4-integration",
    "git",
    "fnm",
    "fnm-powershell-profile",
    "node-lts-krypton",
    "npm-runtime",
    "upstream-pi-runtime",
    "pi-67-manager",
    "pi-67-workspace",
    "xtalpi-configure",
    "windows-acceptance",
    "daily-pi"
  )
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

function Get-NodeManagerNameForPath {
  param([string]$Path)

  $normalized = ([string]$Path).Replace("/", "\").ToLowerInvariant()
  if ($normalized -match '\\scoop\\') { return "scoop" }
  if ($normalized -match '\\fnm(?:_|\\)|\\\.fnm\\') { return "fnm" }
  if ($normalized -match '\\nvm(?:\\|$)') { return "nvm" }
  if ($normalized -match '\\volta\\|\\\.volta\\') { return "volta" }
  return ""
}

function Get-FinalBootstrapResult {
  param(
    [bool]$XtalpiReady,
    [bool]$AcceptancePassed,
    [bool]$PromptDisabled
  )

  if ($XtalpiReady -and $AcceptancePassed) { return "PASS" }
  if (-not $XtalpiReady -and $PromptDisabled) { return "READY_WITHOUT_XTALPI" }
  return "FAIL"
}

function Run-SelfTest {
  if (-not (Test-NodeVersionSupported "v22.19.0")) {
    throw "Node minimum version must accept 22.19.0"
  }
  if (Test-NodeVersionSupported "22.18.9") {
    throw "Node minimum version must reject 22.18.9"
  }
  if (-not (Test-NodeVersionSupported "24.18.0")) {
    throw "Node 24 LTS must satisfy the runtime contract"
  }
  if ((Get-NodeManagerNameForPath "C:\Users\fixture\scoop\shims\node.exe") -ne "scoop") {
    throw "Scoop-managed Node path was not detected"
  }
  if ((Get-NodeManagerNameForPath "C:\Users\fixture\.fnm\node-versions\v24.18.0\installation\node.exe") -ne "fnm") {
    throw "fnm-managed Node path was not detected"
  }
  if ((Get-NodeManagerNameForPath "C:\Users\fixture\AppData\Roaming\nvm\v24.18.0\node.exe") -ne "nvm") {
    throw "nvm-managed Node path was not detected"
  }
  if ((Get-NodeManagerNameForPath "C:\Users\fixture\.volta\bin\node.exe") -ne "volta") {
    throw "Volta-managed Node path was not detected"
  }
  if ((Get-FinalBootstrapResult $true $true $false) -ne "PASS") {
    throw "complete bootstrap must return PASS"
  }
  if ((Get-FinalBootstrapResult $false $false $true) -ne "READY_WITHOUT_XTALPI") {
    throw "prompt-disabled bootstrap must not claim PASS without xtalpi"
  }

  $flow = @(Get-BootstrapFlow)
  $wingetIndex = [array]::IndexOf($flow, "winget")
  $terminalIndex = [array]::IndexOf($flow, "windows-terminal")
  $powerShellIndex = [array]::IndexOf($flow, "powershell-7")
  $terminalPowerShellIndex = [array]::IndexOf($flow, "terminal-powershell-7")
  $notepadIndex = [array]::IndexOf($flow, "notepad4-integration")
  $fnmIndex = [array]::IndexOf($flow, "fnm")
  $nodeIndex = [array]::IndexOf($flow, "node-lts-krypton")
  $piIndex = [array]::IndexOf($flow, "upstream-pi-runtime")
  $managerIndex = [array]::IndexOf($flow, "pi-67-manager")
  $configureIndex = [array]::IndexOf($flow, "xtalpi-configure")
  $acceptanceIndex = [array]::IndexOf($flow, "windows-acceptance")
  if ($wingetIndex -lt 0 -or $terminalIndex -le $wingetIndex) {
    throw "WinGet readiness must precede package installation"
  }
  if ($powerShellIndex -le $terminalIndex -or $terminalPowerShellIndex -le $powerShellIndex) {
    throw "PowerShell 7 must be installed before it becomes the Terminal default"
  }
  if ($notepadIndex -le $terminalPowerShellIndex -or $fnmIndex -le $notepadIndex -or $nodeIndex -le $fnmIndex) {
    throw "desktop setup, fnm, and Node.js ordering drifted"
  }
  if ($piIndex -le $nodeIndex) {
    throw "all Windows prerequisites must finish before upstream Pi is installed"
  }
  if ($piIndex -lt 0 -or $managerIndex -le $piIndex) {
    throw "upstream Pi must be installed before the pi-67 manager"
  }
  if ($configureIndex -lt 0 -or $acceptanceIndex -le $configureIndex) {
    throw "full acceptance must run after xtalpi configuration"
  }
  if ($flow -contains "pi-67-launch") {
    throw "bootstrap must validate and expose bare pi, not a launch wrapper"
  }

  $terminalFixture = @'
{
  // Preserve unrelated settings while updating profiles.
  "theme": "dark",
  "schemes": [
    { "name": "fixture", "background": "#000000", },
  ],
  "profiles": {
    "defaults": { "font": { "face": "Cascadia Mono" } },
    "list": [
      { "guid": "{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}", "name": "Keep Me" },
    ],
  },
}
'@
  $terminalSettings = ConvertFrom-JsoncText $terminalFixture
  Set-TerminalProfileContract $terminalSettings $WindowsPowerShellProfileGuid "Windows PowerShell" "powershell.exe" $true $true | Out-Null
  Set-TerminalProfileContract $terminalSettings $PowerShell7ProfileGuid "PowerShell" "pwsh.exe" $true $true | Out-Null
  Assert-TerminalProfileContract $terminalSettings $WindowsPowerShellProfileGuid $true $false | Out-Null
  Assert-TerminalProfileContract $terminalSettings $PowerShell7ProfileGuid $true $true | Out-Null
  if ([string](Get-JsonPropertyValue $terminalSettings "theme") -ne "dark") {
    throw "Terminal settings mutation removed an unrelated property"
  }
  $profiles = Get-TerminalProfilesObject $terminalSettings
  if (@((Get-JsonPropertyValue $profiles "list")).Count -ne 3) {
    throw "Terminal settings mutation did not preserve the existing profile"
  }

  $profileOnce = Get-FnmManagedProfileText "Write-Host fixture`r`n$FnmProfileLine`r`n"
  $profileTwice = Get-FnmManagedProfileText $profileOnce
  if ($profileOnce -ne $profileTwice) {
    throw "fnm PowerShell profile mutation must be idempotent"
  }
  if ([regex]::Matches($profileTwice, [regex]::Escape($FnmProfileLine)).Count -ne 1) {
    throw "fnm PowerShell profile must contain exactly one initialization line"
  }

  $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
  $source = [System.IO.File]::ReadAllText($scriptPath)
  foreach ($forbidden in @(
    ("Set-" + "ExecutionPolicy"),
    ("pi-67 " + "launch"),
    ("OpenJS." + "NodeJS.LTS"),
    ("--api" + "-key"),
    ("irm" + " | iex")
  )) {
    if ($source.Contains($forbidden)) {
      throw "bootstrap contains forbidden persistent or unsafe shortcut: $forbidden"
    }
  }
  if (-not $source.Contains("Repair-WinGetPackageManager -AllUsers")) {
    throw "bootstrap must repair a missing WinGet installation"
  }
  if (-not $source.Contains("fnm install") -and -not $source.Contains('"install", $NodeLtsAlias')) {
    throw "bootstrap must install Node.js through fnm"
  }
  if (-not $source.Contains($FnmProfileLine)) {
    throw "bootstrap must persist the official fnm PowerShell initialization"
  }
  foreach ($required in @(
    "Microsoft.WindowsTerminal",
    "Microsoft.PowerShell",
    "zufuliu.notepad4",
    "Git.Git",
    "Schniz.fnm",
    "defaultProfile",
    "notepad.exe",
    '"default", $NodeLtsAlias',
    'Invoke-LoggedNative "pi-runtime-final"'
  )) {
    if (-not $source.Contains($required)) {
      throw "bootstrap source is missing required workstation contract: $required"
    }
  }
  $legacyAdminClaim = "Administrator mode is not " + "required"
  if ($source.Contains($legacyAdminClaim)) {
    throw "bootstrap must not claim Administrator access is unnecessary"
  }
  if ($UseNpmMirror) {
    throw "-SelfTest must remain offline and cannot combine with -UseNpmMirror"
  }

  Write-Host "pi-67 Windows bootstrap self-test passed" -ForegroundColor Green
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

function Get-JsonPropertyValue {
  param(
    [AllowNull()]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Set-JsonPropertyValue {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [AllowNull()]$Value
  )

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    Add-Member -InputObject $Object -MemberType NoteProperty -Name $Name -Value $Value
  } else {
    $property.Value = $Value
  }
}

function Remove-JsonComments {
  param([AllowEmptyString()][string]$Text)

  $builder = New-Object System.Text.StringBuilder
  $inString = $false
  $escaped = $false
  $lineComment = $false
  $blockComment = $false
  for ($index = 0; $index -lt $Text.Length; $index++) {
    $character = $Text[$index]
    $next = if ($index + 1 -lt $Text.Length) { $Text[$index + 1] } else { [char]0 }

    if ($lineComment) {
      if ($character -eq "`r" -or $character -eq "`n") {
        $lineComment = $false
        [void]$builder.Append($character)
      }
      continue
    }
    if ($blockComment) {
      if ($character -eq '*' -and $next -eq '/') {
        $blockComment = $false
        $index++
      } elseif ($character -eq "`r" -or $character -eq "`n") {
        [void]$builder.Append($character)
      }
      continue
    }
    if ($inString) {
      [void]$builder.Append($character)
      if ($escaped) {
        $escaped = $false
      } elseif ($character -eq '\') {
        $escaped = $true
      } elseif ($character -eq '"') {
        $inString = $false
      }
      continue
    }
    if ($character -eq '"') {
      $inString = $true
      [void]$builder.Append($character)
      continue
    }
    if ($character -eq '/' -and $next -eq '/') {
      $lineComment = $true
      $index++
      continue
    }
    if ($character -eq '/' -and $next -eq '*') {
      $blockComment = $true
      $index++
      continue
    }
    [void]$builder.Append($character)
  }
  if ($blockComment) { throw "unterminated block comment in JSONC" }
  if ($inString) { throw "unterminated string in JSONC" }
  return $builder.ToString()
}

function Remove-JsonTrailingCommas {
  param([AllowEmptyString()][string]$Text)

  $builder = New-Object System.Text.StringBuilder
  $inString = $false
  $escaped = $false
  for ($index = 0; $index -lt $Text.Length; $index++) {
    $character = $Text[$index]
    if ($inString) {
      [void]$builder.Append($character)
      if ($escaped) {
        $escaped = $false
      } elseif ($character -eq '\') {
        $escaped = $true
      } elseif ($character -eq '"') {
        $inString = $false
      }
      continue
    }
    if ($character -eq '"') {
      $inString = $true
      [void]$builder.Append($character)
      continue
    }
    if ($character -eq ',') {
      $lookAhead = $index + 1
      while ($lookAhead -lt $Text.Length -and [char]::IsWhiteSpace($Text[$lookAhead])) {
        $lookAhead++
      }
      if ($lookAhead -lt $Text.Length -and ($Text[$lookAhead] -eq '}' -or $Text[$lookAhead] -eq ']')) {
        continue
      }
    }
    [void]$builder.Append($character)
  }
  return $builder.ToString()
}

function ConvertFrom-JsoncText {
  param([AllowEmptyString()][string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) { $Text = "{}" }
  $normalized = Remove-JsonTrailingCommas (Remove-JsonComments $Text)
  try {
    $value = $normalized | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "invalid Windows Terminal JSON/JSONC: $($_.Exception.Message)"
  }
  if ($null -eq $value -or $value -is [System.Array] -or $value -is [string] -or $value -is [ValueType]) {
    throw "Windows Terminal settings root must be a JSON object"
  }
  return $value
}

function Get-TerminalProfilesObject {
  param([Parameter(Mandatory = $true)]$Settings)

  $profiles = Get-JsonPropertyValue $Settings "profiles"
  if ($null -eq $profiles) {
    $profiles = [pscustomobject][ordered]@{
      defaults = [pscustomobject]@{}
      list = @()
    }
    Set-JsonPropertyValue $Settings "profiles" $profiles
    return $profiles
  }
  if ($profiles -is [System.Array]) {
    $profiles = [pscustomobject][ordered]@{
      defaults = [pscustomobject]@{}
      list = @($profiles)
    }
    Set-JsonPropertyValue $Settings "profiles" $profiles
    return $profiles
  }
  if ($null -eq (Get-JsonPropertyValue $profiles "defaults")) {
    Set-JsonPropertyValue $profiles "defaults" ([pscustomobject]@{})
  }
  if ($null -eq (Get-JsonPropertyValue $profiles "list")) {
    Set-JsonPropertyValue $profiles "list" @()
  }
  return $profiles
}

function Set-TerminalProfileContract {
  param(
    [Parameter(Mandatory = $true)]$Settings,
    [Parameter(Mandatory = $true)][string]$Guid,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][bool]$Elevate,
    [Parameter(Mandatory = $true)][bool]$MakeDefault
  )

  $profiles = Get-TerminalProfilesObject $Settings
  $items = @()
  $existingItems = Get-JsonPropertyValue $profiles "list"
  if ($null -ne $existingItems) { $items = @($existingItems) }
  $target = $null
  foreach ($item in $items) {
    $itemGuid = [string](Get-JsonPropertyValue $item "guid")
    if ([string]::Equals($itemGuid, $Guid, [System.StringComparison]::OrdinalIgnoreCase)) {
      $target = $item
      break
    }
  }
  if ($null -eq $target) {
    $target = [pscustomobject][ordered]@{ guid = $Guid }
    $items += $target
  }
  Set-JsonPropertyValue $target "name" $Name
  Set-JsonPropertyValue $target "commandline" $CommandLine
  Set-JsonPropertyValue $target "elevate" $Elevate
  Set-JsonPropertyValue $target "hidden" $false
  Set-JsonPropertyValue $profiles "list" @($items)
  if ($MakeDefault) {
    Set-JsonPropertyValue $Settings "defaultProfile" $Guid
  }
  return $target
}

function Assert-TerminalProfileContract {
  param(
    [Parameter(Mandatory = $true)]$Settings,
    [Parameter(Mandatory = $true)][string]$Guid,
    [Parameter(Mandatory = $true)][bool]$Elevate,
    [Parameter(Mandatory = $true)][bool]$MustBeDefault
  )

  $profiles = Get-TerminalProfilesObject $Settings
  $target = $null
  $items = Get-JsonPropertyValue $profiles "list"
  foreach ($item in @($items)) {
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
    throw "Windows Terminal defaultProfile is not $Guid"
  }
  return $target
}

function Get-FnmManagedProfileText {
  param([AllowEmptyString()][string]$ExistingText)

  $startMarker = "# >>> pi-67 fnm initialization >>>"
  $endMarker = "# <<< pi-67 fnm initialization <<<"
  $pattern = "(?ms)^[ \t]*" + [regex]::Escape($startMarker) + "[ \t]*\r?\n.*?^[ \t]*" + [regex]::Escape($endMarker) + "[ \t]*(?:\r?\n)?"
  $withoutManagedBlock = [regex]::Replace([string]$ExistingText, $pattern, "")
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($line in @($withoutManagedBlock -split "\r?\n")) {
    if ($line.Trim() -eq $FnmProfileLine) { continue }
    $lines.Add($line)
  }
  $prefix = ($lines -join "`r`n").TrimEnd()
  $block = @($startMarker, $FnmProfileLine, $endMarker) -join "`r`n"
  if ($prefix) { return "$prefix`r`n`r`n$block`r`n" }
  return "$block`r`n"
}

function Add-ProcessPathEntry {
  param([Parameter(Mandatory = $true)][string]$Directory)

  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return }
  $parts = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  foreach ($part in $parts) {
    if ([string]::Equals($part.TrimEnd('\'), $Directory.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
      return
    }
  }
  $env:Path = "$Directory;$env:Path"
}

function Refresh-ProcessPath {
  $values = @(
    $env:Path,
    [Environment]::GetEnvironmentVariable("Path", "Machine"),
    [Environment]::GetEnvironmentVariable("Path", "User")
  )
  $seen = @{}
  $merged = New-Object System.Collections.Generic.List[string]
  foreach ($value in $values) {
    foreach ($part in @([string]$value -split ';')) {
      $trimmed = $part.Trim()
      if (-not $trimmed) { continue }
      $key = $trimmed.TrimEnd('\').ToLowerInvariant()
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      $merged.Add($trimmed)
    }
  }
  $env:Path = $merged -join ';'
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

function Ensure-UserPathEntry {
  param([Parameter(Mandatory = $true)][string]$Directory)

  if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
    throw "PATH directory does not exist: $Directory"
  }
  Add-ProcessPathEntry $Directory
  if (Test-PersistentPathContains $Directory) { return }

  $userPath = [string][Environment]::GetEnvironmentVariable("Path", "User")
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($part in @($userPath -split ';')) {
    $trimmed = $part.Trim()
    if ($trimmed) { $parts.Add($trimmed) }
  }
  $parts.Add($Directory)
  [Environment]::SetEnvironmentVariable("Path", ($parts -join ';'), "User")
  if (-not (Test-PersistentPathContains $Directory)) {
    throw "failed to persist PATH entry for future Terminal sessions: $Directory"
  }
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

function Find-GitExecutable {
  $resolved = Resolve-CommandPath @("git.exe", "git")
  if ($resolved) { return $resolved }

  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($root in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($root) {
      $candidates.Add((Join-Path $root "Git\cmd\git.exe"))
      $candidates.Add((Join-Path $root "Git\bin\git.exe"))
    }
  }
  if ($env:LOCALAPPDATA) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe"))
  }
  if ($env:USERPROFILE) {
    $candidates.Add((Join-Path $env:USERPROFILE "scoop\apps\git\current\cmd\git.exe"))
  }
  if ($env:ChocolateyInstall) {
    $candidates.Add((Join-Path $env:ChocolateyInstall "bin\git.exe"))
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      Add-ProcessPathEntry (Split-Path -Parent $candidate)
      return $candidate
    }
  }
  return ""
}

function Find-WindowsTerminalExecutable {
  $resolved = Resolve-CommandPath @("wt.exe", "wt")
  if ($resolved) { return $resolved }
  if ($env:LOCALAPPDATA) {
    $candidate = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\wt.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      Add-ProcessPathEntry (Split-Path -Parent $candidate)
      return $candidate
    }
  }
  return ""
}

function Find-PowerShell7Executable {
  $resolved = Resolve-CommandPath @("pwsh.exe", "pwsh")
  if ($resolved) { return $resolved }
  foreach ($root in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $root) { continue }
    $candidate = Join-Path $root "PowerShell\7\pwsh.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      Add-ProcessPathEntry (Split-Path -Parent $candidate)
      return $candidate
    }
  }
  return ""
}

function Find-FnmExecutable {
  $resolved = Resolve-CommandPath @("fnm.exe", "fnm")
  if ($resolved) { return $resolved }
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:LOCALAPPDATA) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\fnm.exe"))
  }
  if ($env:USERPROFILE) {
    $candidates.Add((Join-Path $env:USERPROFILE ".fnm\fnm.exe"))
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      Add-ProcessPathEntry (Split-Path -Parent $candidate)
      return $candidate
    }
  }
  return ""
}

function Find-Notepad4Executable {
  $resolved = Resolve-CommandPath @("Notepad4.exe", "Notepad4")
  if ($resolved) { return $resolved }

  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:LOCALAPPDATA) {
    $candidates.Add((Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\Notepad4.exe"))
  }
  foreach ($root in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($root) { $candidates.Add((Join-Path $root "Notepad4\Notepad4.exe")) }
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      Add-ProcessPathEntry (Split-Path -Parent $candidate)
      return $candidate
    }
  }

  if ($env:LOCALAPPDATA) {
    $packageRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path -LiteralPath $packageRoot -PathType Container) {
      $match = Get-ChildItem -LiteralPath $packageRoot -Directory -Filter "zufuliu.notepad4_*" -ErrorAction SilentlyContinue |
        ForEach-Object {
          Get-ChildItem -LiteralPath $_.FullName -File -Filter "Notepad4.exe" -Recurse -ErrorAction SilentlyContinue
        } |
        Select-Object -First 1
      if ($match) {
        Add-ProcessPathEntry (Split-Path -Parent $match.FullName)
        return [string]$match.FullName
      }
    }
  }
  return ""
}

function Get-WindowsTerminalSettingsPath {
  if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is unavailable" }

  $packageFamilyNames = New-Object System.Collections.Generic.List[string]
  foreach ($packageName in @("Microsoft.WindowsTerminal", "Microsoft.WindowsTerminalPreview")) {
    try {
      $package = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($package -and $package.PackageFamilyName) {
        $packageFamilyNames.Add([string]$package.PackageFamilyName)
      }
    } catch {
      # The known package-family fallbacks below cover constrained shells.
    }
  }
  foreach ($fallback in @(
    "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
    "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"
  )) {
    if (-not $packageFamilyNames.Contains($fallback)) { $packageFamilyNames.Add($fallback) }
  }
  foreach ($familyName in $packageFamilyNames) {
    $localState = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA "Packages") $familyName) "LocalState"
    if (Test-Path -LiteralPath (Split-Path -Parent $localState) -PathType Container) {
      return Join-Path $localState "settings.json"
    }
  }
  return Join-Path (Join-Path $env:LOCALAPPDATA "Microsoft\Windows Terminal") "settings.json"
}

function Get-PowerShell7ProfilePath {
  $documents = [Environment]::GetFolderPath("MyDocuments")
  if ([string]::IsNullOrWhiteSpace($documents)) {
    $documents = Join-Path (Get-HomePath) "Documents"
  }
  return Join-Path (Join-Path $documents "PowerShell") "Microsoft.PowerShell_profile.ps1"
}

function Get-WindowsPowerShellProfilePath {
  $documents = [Environment]::GetFolderPath("MyDocuments")
  if ([string]::IsNullOrWhiteSpace($documents)) {
    $documents = Join-Path (Get-HomePath) "Documents"
  }
  return Join-Path (Join-Path $documents "WindowsPowerShell") "Microsoft.PowerShell_profile.ps1"
}

function Get-ActiveNodeManager {
  param([string]$NodePath)

  $fromPath = Get-NodeManagerNameForPath $NodePath
  if ($fromPath) { return $fromPath }
  if ($NodePath) { return "" }
  foreach ($candidate in @("fnm", "nvm", "volta")) {
    if (Resolve-CommandPath @($candidate, "$candidate.exe")) { return $candidate }
  }
  return ""
}

function Get-NodeInfo {
  $nodePath = Resolve-CommandPath @("node.exe", "node")
  $manager = Get-ActiveNodeManager $nodePath
  if (-not $nodePath) {
    return [pscustomobject]@{
      found = $false
      path = ""
      manager = $manager
      rawVersion = ""
      version = $null
    }
  }

  $output = @(& $nodePath --version 2>&1)
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  if ($exitCode -ne 0 -or $output.Count -eq 0) {
    throw "node --version failed for $nodePath"
  }
  $rawVersion = ([string]$output[0]).Trim()
  return [pscustomobject]@{
    found = $true
    path = $nodePath
    manager = $manager
    rawVersion = $rawVersion
    version = ConvertTo-SemVer $rawVersion
  }
}

function Get-WingetPath {
  return Resolve-CommandPath @("winget.exe", "winget")
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

function Write-Info {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host "  INFO $Message" -ForegroundColor Cyan
  Append-BootstrapLog "INFO $Message"
}

function Write-WarningMessage {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host "  WARN $Message" -ForegroundColor Yellow
  Append-BootstrapLog "WARN $Message"
}

function Add-StageResult {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet("PASS", "FAIL", "WARN", "NOT_APPLICABLE", "PLANNED")][string]$Status,
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
    [Parameter(Mandatory = $true)][scriptblock]$Body,
    [switch]$Optional
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
    if ($Optional) {
      Add-StageResult $Name "WARN" $timer.ElapsedMilliseconds $script:CurrentStageLog $message
      Write-Host "  WARN $Name ($message)" -ForegroundColor Yellow
      Append-BootstrapLog "WARN $Name ($message)"
      return
    }
    Add-StageResult $Name "FAIL" $timer.ElapsedMilliseconds $script:CurrentStageLog $message
    Write-Host "  FAIL $Name ($message)" -ForegroundColor Red
    Append-BootstrapLog "FAIL $Name ($message)"
    throw
  }
}

function Add-NotApplicableStage {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Message
  )
  Add-StageResult $Name "NOT_APPLICABLE" 0 "" $Message
  Write-Host "  NOT_APPLICABLE $Name ($Message)" -ForegroundColor DarkYellow
  Append-BootstrapLog "NOT_APPLICABLE $Name ($Message)"
}

function Invoke-LoggedNative {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [switch]$Interactive
  )

  $logPath = Get-StageLogPath $Name
  $script:CurrentStageLog = $logPath
  Write-Utf8Text $logPath "COMMAND: $FilePath $($Arguments -join ' ')`r`n"
  $global:LASTEXITCODE = 0
  $exitCode = 127
  try {
    if ($Interactive) {
      & $FilePath @Arguments
    } else {
      & $FilePath @Arguments 2>&1 | ForEach-Object {
        $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
        Write-Host "    $line"
        [System.IO.File]::AppendAllText($logPath, "$line`r`n", $script:Utf8NoBom)
      }
    }
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } catch {
    [System.IO.File]::AppendAllText($logPath, "ERROR: $($_.Exception.Message)`r`n", $script:Utf8NoBom)
    throw
  }
  if ($exitCode -ne 0) {
    [System.IO.File]::AppendAllText($logPath, "EXIT_CODE: $exitCode`r`n", $script:Utf8NoBom)
    throw "$Name exited with code $exitCode; see $logPath"
  }
  return [pscustomobject]@{ exitCode = $exitCode; logPath = $logPath }
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
  Write-Utf8Text $logPath $(if ($text) { "$text`r`n" } else { "" })
  if ($exitCode -ne 0) {
    throw "$Name exited with code $exitCode; see $logPath"
  }
  return [pscustomobject]@{ exitCode = $exitCode; text = $text; logPath = $logPath }
}

function Ensure-WinGet {
  Invoke-Stage "winget" {
    $winget = Get-WingetPath
    if (-not $winget) {
      if (-not (Test-IsAdministrator)) {
        throw "WinGet is missing and Repair-WinGetPackageManager requires Administrator access"
      }
      Write-Info "WinGet is missing; bootstrapping Microsoft.WinGet.Client from PowerShell Gallery"
      $progressPreference = 'silentlyContinue'
      Install-PackageProvider -Name NuGet -Force | Out-Null
      Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery | Out-Null
      Import-Module Microsoft.WinGet.Client -Force
      Write-Host "Using Repair-WinGetPackageManager cmdlet to bootstrap WinGet..."
      Append-BootstrapLog "Using Repair-WinGetPackageManager cmdlet to bootstrap WinGet..."
      Repair-WinGetPackageManager -AllUsers | Out-Null
      Refresh-ProcessPath
      $winget = Get-WingetPath
    }
    if (-not $winget) {
      throw "WinGet repair completed, but winget.exe is still unavailable"
    }
    $script:WingetCommand = $winget
    $result = Invoke-CapturedNative "winget-version" $winget @("--version")
    $script:WingetVersion = $result.text.Trim()
    if (-not $script:WingetVersion) { throw "winget --version returned empty output" }
  }
}

function Invoke-WingetPackage {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$PackageId,
    [ValidateSet("install", "upgrade")][string]$Action = "install"
  )

  $winget = if ($script:WingetCommand) { $script:WingetCommand } else { Get-WingetPath }
  if (-not $winget) { throw "WinGet is unavailable; the winget readiness stage did not complete" }
  $arguments = @(
    $Action,
    "--id", $PackageId,
    "--exact",
    "--source", "winget",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--silent"
  )
  Invoke-LoggedNative $Name $winget $arguments | Out-Null
  Refresh-ProcessPath
}

function Save-WindowsTerminalSettings {
  param(
    [Parameter(Mandatory = $true)][string]$Guid,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][bool]$MakeDefault
  )

  $settingsPath = Get-WindowsTerminalSettingsPath
  $parent = Split-Path -Parent $settingsPath
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $existingText = if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    [System.IO.File]::ReadAllText($settingsPath)
  } else {
    "{}"
  }
  $settings = ConvertFrom-JsoncText $existingText
  $elevate = -not [bool]$NoTerminalAdmin
  Set-TerminalProfileContract $settings $Guid $Name $CommandLine $elevate $MakeDefault | Out-Null
  Assert-TerminalProfileContract $settings $Guid $elevate $MakeDefault | Out-Null

  $serialized = ($settings | ConvertTo-Json -Depth 100) + "`r`n"
  $tempPath = "$settingsPath.pi67-$PID.tmp"
  $backupPath = ""
  if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $backupPath = "$settingsPath.bak-pi67-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff'))"
    Copy-Item -LiteralPath $settingsPath -Destination $backupPath -Force
  }
  Write-Utf8Text $tempPath $serialized
  ConvertFrom-JsoncText ([System.IO.File]::ReadAllText($tempPath)) | Out-Null
  Move-Item -LiteralPath $tempPath -Destination $settingsPath -Force

  try {
    $verified = ConvertFrom-JsoncText ([System.IO.File]::ReadAllText($settingsPath))
    Assert-TerminalProfileContract $verified $Guid $elevate $MakeDefault | Out-Null
  } catch {
    if ($backupPath -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
      Copy-Item -LiteralPath $backupPath -Destination $settingsPath -Force
    }
    throw
  }
  $script:TerminalSettingsPath = $settingsPath
  if ($backupPath) { $script:TerminalSettingsBackups += $backupPath }
  Write-Info "Windows Terminal settings verified: $settingsPath"
}

function Ensure-WindowsTerminal {
  if ($Minimal) {
    Add-NotApplicableStage "windows-terminal" "desktop setup disabled by -Minimal"
    Add-NotApplicableStage "terminal-windows-powershell" "Windows Terminal disabled by -Minimal"
    return
  }

  Invoke-Stage "windows-terminal" {
    $terminal = Find-WindowsTerminalExecutable
    if (-not $terminal) {
      Invoke-WingetPackage "windows-terminal-winget-install" "Microsoft.WindowsTerminal" "install"
      $terminal = Find-WindowsTerminalExecutable
    }
    if (-not $terminal) { throw "Windows Terminal installed, but wt.exe is unavailable" }
    $script:WindowsTerminalCommand = $terminal
  }

  Invoke-Stage "terminal-windows-powershell" {
    $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
      throw "Windows PowerShell executable was not found: $windowsPowerShell"
    }
    Save-WindowsTerminalSettings $WindowsPowerShellProfileGuid "Windows PowerShell" $windowsPowerShell $true
  }
}

function Ensure-PowerShell7 {
  if ($Minimal) {
    Add-NotApplicableStage "powershell-7" "desktop setup disabled by -Minimal"
    Add-NotApplicableStage "terminal-powershell-7" "PowerShell 7 disabled by -Minimal"
    return
  }

  Invoke-Stage "powershell-7" {
    $pwsh = Find-PowerShell7Executable
    if (-not $pwsh) {
      Invoke-WingetPackage "powershell-7-winget-install" "Microsoft.PowerShell" "install"
      $pwsh = Find-PowerShell7Executable
    }
    if (-not $pwsh) { throw "PowerShell 7 installed, but pwsh.exe is unavailable" }
    $result = Invoke-CapturedNative "powershell-7-version" $pwsh @("-NoLogo", "-NoProfile", "-Command", '$PSVersionTable.PSVersion.ToString()')
    $script:PowerShell7Command = $pwsh
    $script:PowerShell7Version = $result.text.Trim()
  }

  Invoke-Stage "terminal-powershell-7" {
    Save-WindowsTerminalSettings $PowerShell7ProfileGuid "PowerShell" $script:PowerShell7Command $true
    $verified = ConvertFrom-JsoncText ([System.IO.File]::ReadAllText($script:TerminalSettingsPath))
    Assert-TerminalProfileContract $verified $PowerShell7ProfileGuid (-not [bool]$NoTerminalAdmin) $true | Out-Null
  }
}

function Export-RegistryKeyIfPresent {
  param(
    [Parameter(Mandatory = $true)][string]$ProviderPath,
    [Parameter(Mandatory = $true)][string]$RegPath,
    [Parameter(Mandatory = $true)][string]$FileName
  )

  if (-not (Test-Path -LiteralPath $ProviderPath)) { return "" }
  $reg = Resolve-CommandPath @("reg.exe", "reg")
  if (-not $reg) { throw "reg.exe was not found for registry backup" }
  $backupPath = Join-Path $script:RunLogDir $FileName
  Invoke-LoggedNative "registry-backup-$FileName" $reg @("export", $RegPath, $backupPath, "/y") | Out-Null
  return $backupPath
}

function Set-Notepad4SystemIntegration {
  param([Parameter(Mandatory = $true)][string]$Notepad4Path)

  $script:Notepad4RegistryBackups = @(
    Export-RegistryKeyIfPresent "Registry::HKEY_CLASSES_ROOT\*\shell\Notepad4" "HKCR\*\shell\Notepad4" "notepad4-context-menu-before.reg"
    Export-RegistryKeyIfPresent "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\notepad.exe" "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\notepad.exe" "notepad4-notepad-ifeo-before.reg"
  ) | Where-Object { $_ }

  $contextMenu = [Microsoft.Win32.Registry]::ClassesRoot.CreateSubKey("*\shell\Notepad4")
  $contextCommand = $null
  $notepadIfeo = $null
  try {
    $contextMenu.SetValue("", "Edit with Notepad4", [Microsoft.Win32.RegistryValueKind]::String)
    $contextMenu.SetValue("icon", $Notepad4Path, [Microsoft.Win32.RegistryValueKind]::String)
    $contextCommand = $contextMenu.CreateSubKey("command")
    $contextCommand.SetValue("", ('"{0}" "%1"' -f $Notepad4Path), [Microsoft.Win32.RegistryValueKind]::String)

    $notepadIfeo = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey("SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\notepad.exe")
    $notepadIfeo.SetValue("", $Notepad4Path, [Microsoft.Win32.RegistryValueKind]::String)
    $notepadIfeo.SetValue("Debugger", ('"{0}" /z' -f $Notepad4Path), [Microsoft.Win32.RegistryValueKind]::String)
    $notepadIfeo.SetValue("UseFilter", 0, [Microsoft.Win32.RegistryValueKind]::DWord)
    $notepadIfeo.DeleteValue("AppExecutionAliasRedirectPackages", $false)
    $notepadIfeo.DeleteValue("AppExecutionAliasRedirect", $false)
  } finally {
    if ($contextCommand) { $contextCommand.Dispose() }
    if ($contextMenu) { $contextMenu.Dispose() }
    if ($notepadIfeo) { $notepadIfeo.Dispose() }
  }

  $contextMenu = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey("*\shell\Notepad4")
  $contextCommand = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey("*\shell\Notepad4\command")
  $notepadIfeo = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\notepad.exe")
  try {
    if ($null -eq $contextMenu -or $contextMenu.GetValue("icon") -ne $Notepad4Path) {
      throw "Notepad4 Explorer context-menu registry verification failed"
    }
    if ($null -eq $contextCommand -or $contextCommand.GetValue("") -ne ('"{0}" "%1"' -f $Notepad4Path)) {
      throw "Notepad4 Explorer command registry verification failed"
    }
    if ($null -eq $notepadIfeo -or $notepadIfeo.GetValue("Debugger") -ne ('"{0}" /z' -f $Notepad4Path)) {
      throw "Notepad4 replacement registry verification failed"
    }
    if ([int]$notepadIfeo.GetValue("UseFilter", -1) -ne 0) {
      throw "Notepad4 UseFilter registry verification failed"
    }
  } finally {
    if ($contextCommand) { $contextCommand.Dispose() }
    if ($contextMenu) { $contextMenu.Dispose() }
    if ($notepadIfeo) { $notepadIfeo.Dispose() }
  }
}

function Ensure-Notepad4 {
  if ($Minimal) {
    Add-NotApplicableStage "notepad4" "desktop setup disabled by -Minimal"
    Add-NotApplicableStage "notepad4-integration" "Notepad4 disabled by -Minimal"
    return
  }

  Invoke-Stage "notepad4" {
    $notepad4 = Find-Notepad4Executable
    if (-not $notepad4) {
      Invoke-WingetPackage "notepad4-winget-install" "zufuliu.notepad4" "install"
      $notepad4 = Find-Notepad4Executable
    }
    if (-not $notepad4) { throw "Notepad4 installed, but Notepad4.exe is unavailable" }
    Ensure-UserPathEntry (Split-Path -Parent $notepad4)
    $script:Notepad4Command = $notepad4
  }

  if ($SkipNotepad4Integration) {
    Add-NotApplicableStage "notepad4-integration" "requested by -SkipNotepad4Integration"
    return
  }
  Invoke-Stage "notepad4-integration" {
    if (-not (Test-IsAdministrator)) { throw "Notepad4 system integration requires Administrator access" }
    Set-Notepad4SystemIntegration $script:Notepad4Command
  }
}

function Ensure-Git {
  Invoke-Stage "git" {
    $git = Find-GitExecutable
    if (-not $git) {
      Invoke-WingetPackage "git-winget-install" "Git.Git" "install"
      $git = Find-GitExecutable
    }
    if (-not $git) { throw "Git for Windows installed, but git.exe is unavailable" }
    $gitDirectory = Split-Path -Parent $git
    Ensure-UserPathEntry $gitDirectory
    Refresh-ProcessPath
    $result = Invoke-CapturedNative "git-version" $git @("--version")
    $script:GitCommand = $git
    $script:GitVersion = $result.text.Trim()
    if (-not (Test-PersistentPathContains $gitDirectory)) {
      throw "Git is available only in the bootstrap process and not in persistent PATH"
    }
  }
}

function Ensure-Fnm {
  Invoke-Stage "fnm" {
    $fnm = Find-FnmExecutable
    if (-not $fnm) {
      Invoke-WingetPackage "fnm-winget-install" "Schniz.fnm" "install"
      $fnm = Find-FnmExecutable
    }
    if (-not $fnm) { throw "fnm installed, but fnm.exe is unavailable" }
    Ensure-UserPathEntry (Split-Path -Parent $fnm)
    $result = Invoke-CapturedNative "fnm-version" $fnm @("--version")
    $script:FnmCommand = $fnm
    $script:FnmVersion = $result.text.Trim()
  }
}

function Ensure-FnmPowerShellProfile {
  Invoke-Stage "fnm-powershell-profile" {
    $profilePath = if ($Minimal -and -not (Find-PowerShell7Executable)) {
      Get-WindowsPowerShellProfilePath
    } else {
      Get-PowerShell7ProfilePath
    }
    $existing = if (Test-Path -LiteralPath $profilePath -PathType Leaf) {
      [System.IO.File]::ReadAllText($profilePath)
    } else {
      ""
    }
    $updated = Get-FnmManagedProfileText $existing
    if ($updated -ne $existing) {
      if (Test-Path -LiteralPath $profilePath -PathType Leaf) {
        $backup = "$profilePath.bak-pi67-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff'))"
        Copy-Item -LiteralPath $profilePath -Destination $backup -Force
        $script:FnmProfileBackup = $backup
      }
      Write-Utf8Text $profilePath $updated
    }
    $verified = [System.IO.File]::ReadAllText($profilePath)
    if ([regex]::Matches($verified, [regex]::Escape($FnmProfileLine)).Count -ne 1) {
      throw "fnm PowerShell initialization must appear exactly once in $profilePath"
    }
    $script:FnmProfilePath = $profilePath
  }
}

function Initialize-FnmEnvironment {
  $result = Invoke-CapturedNative "fnm-env" $script:FnmCommand @("env", "--use-on-cd", "--shell", "powershell")
  if ([string]::IsNullOrWhiteSpace($result.text)) { throw "fnm env returned empty output" }
  Invoke-Expression $result.text
  if (-not $env:FNM_MULTISHELL_PATH) { throw "fnm env did not initialize FNM_MULTISHELL_PATH" }
  Add-ProcessPathEntry $env:FNM_MULTISHELL_PATH
}

function Ensure-NodeThroughFnm {
  Invoke-Stage "node-lts-krypton" {
    Invoke-LoggedNative "fnm-install-node-lts-krypton" $script:FnmCommand @("install", $NodeLtsAlias) | Out-Null
    Invoke-LoggedNative "fnm-default-node-lts-krypton" $script:FnmCommand @("default", $NodeLtsAlias) | Out-Null
    Initialize-FnmEnvironment
    Invoke-LoggedNative "fnm-use-node-lts-krypton" $script:FnmCommand @("use", $NodeLtsAlias) | Out-Null
    Refresh-ProcessPath

    $info = Get-NodeInfo
    if (-not $info.found) { throw "fnm selected $NodeLtsAlias, but node.exe is unavailable" }
    if ($info.version -lt $MinimumNodeVersion) {
      throw "fnm selected Node.js $($info.rawVersion), below the required $MinimumNodeVersion"
    }
    if ($info.version.Major -ne $PreferredNodeMajor) {
      throw "fnm alias $NodeLtsAlias resolved to $($info.rawVersion), expected Node.js $PreferredNodeMajor LTS"
    }
    if ($info.manager -ne "fnm") {
      throw "active Node.js is not managed by fnm: $($info.path)"
    }
    $script:NodeVersion = $info.rawVersion
    $script:NodeCommand = $info.path
    $script:NodeManager = $info.manager
    Invoke-LoggedNative "node-version" $info.path @("--version") | Out-Null

    $npm = Resolve-CommandPath @("npm.cmd", "npm")
    if (-not $npm) { throw "npm.cmd was not found in the active fnm Node.js environment" }
    $npmResult = Invoke-CapturedNative "npm-version-after-fnm" $npm @("--version")
    $script:NpmCommand = $npm
    $script:NpmVersion = $npmResult.text.Trim()
  }
}

function Refresh-NpmGlobalPath {
  param([Parameter(Mandatory = $true)][string]$NpmPath)

  $global:LASTEXITCODE = 0
  $prefixOutput = @(& $NpmPath "config" "get" "prefix" 2>$null)
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  if ($exitCode -eq 0 -and $prefixOutput.Count -gt 0) {
    $prefix = ([string]$prefixOutput[0]).Trim()
    if ($prefix -and (Test-Path -LiteralPath $prefix -PathType Container)) {
      if ((Get-NodeManagerNameForPath $prefix) -eq "fnm") {
        Add-ProcessPathEntry $prefix
      } else {
        Ensure-UserPathEntry $prefix
      }
    }
  }
}

function Install-NpmTooling {
  $npm = if ($script:NpmCommand) { $script:NpmCommand } else { Resolve-CommandPath @("npm.cmd", "npm") }
  if (-not $npm) {
    throw "npm.cmd was not found after fnm Node.js installation"
  }
  Invoke-Stage "npm-runtime" {
    if ($UseNpmMirror) {
      Invoke-LoggedNative "npm-registry-mirror" $npm @("config", "set", "registry", $NpmMirrorRegistry) | Out-Null
      $script:NpmRegistryChanged = $true
    }
    Invoke-LoggedNative "npm-version" $npm @("--version") | Out-Null
  }

  Invoke-Stage "upstream-pi-runtime" {
    Invoke-LoggedNative "install-upstream-pi" $npm @(
      "install", "--global", $UpstreamPiPackage,
      "--no-audit", "--no-fund", "--no-update-notifier"
    ) | Out-Null
    Refresh-ProcessPath
    Refresh-NpmGlobalPath $npm
    $pi = Resolve-CommandPath @("pi.cmd", "pi")
    if (-not $pi) { throw "upstream Pi installed, but pi.cmd was not found" }
    Invoke-LoggedNative "pi-version-after-install" $pi @("--version") | Out-Null
    $script:PiCommand = $pi
  }

  Invoke-Stage "pi-67-manager" {
    Invoke-LoggedNative "install-pi-67-manager" $npm @(
      "install", "--global", $Pi67Package,
      "--no-audit", "--no-fund", "--no-update-notifier"
    ) | Out-Null
    Refresh-ProcessPath
    Refresh-NpmGlobalPath $npm
    $pi67 = Resolve-CommandPath @("pi-67.cmd", "pi-67")
    if (-not $pi67) { throw "pi-67 installed, but pi-67.cmd was not found" }
    Invoke-LoggedNative "pi-67-version-after-install" $pi67 @("--version") | Out-Null
    $script:Pi67Command = $pi67
  }
}

function Install-Pi67Workspace {
  Invoke-Stage "pi-67-workspace" {
    Invoke-LoggedNative "pi-67-install" $script:Pi67Command @(
      "--agent-dir", $script:AgentDir,
      "--repo-root", $script:AgentDir,
      "install", "--repair", "--yes"
    ) | Out-Null
    if (-not (Test-Path -LiteralPath $script:AgentDir -PathType Container)) {
      throw "managed workspace was not created: $script:AgentDir"
    }
  }
}

function Get-XtalpiConfigurationPreview {
  $result = Invoke-CapturedNative "xtalpi-configure-preview" $script:Pi67Command @(
    "--agent-dir", $script:AgentDir,
    "--repo-root", $script:AgentDir,
    "xtalpi", "configure", "--dry-run", "--no-prompt", "--json"
  )
  try {
    return $result.text | ConvertFrom-Json
  } catch {
    throw "xtalpi configure preview returned invalid JSON; see $($result.logPath)"
  }
}

function Configure-Xtalpi {
  $script:XtalpiPreview = $null
  Invoke-Stage "xtalpi-readiness" {
    $script:XtalpiPreview = Get-XtalpiConfigurationPreview
    if ([string]$script:XtalpiPreview.provider -ne $ExpectedProvider -or [string]$script:XtalpiPreview.model -ne $ExpectedModel) {
      throw "xtalpi configure preview returned an unexpected provider/model contract"
    }
  }
  $preview = $script:XtalpiPreview

  if ($NoXtalpiPrompt -and $preview.configured -ne $true) {
    Add-NotApplicableStage "xtalpi-configure" "no existing or environment-provided personal key; prompt disabled"
    return $false
  }

  $needsPrompt = $preview.configured -ne $true
  Invoke-Stage "xtalpi-configure" {
    $arguments = @(
      "--agent-dir", $script:AgentDir,
      "--repo-root", $script:AgentDir,
      "xtalpi", "configure", "--verify"
    )
    if ($NoXtalpiPrompt) { $arguments += "--no-prompt" }
    Invoke-LoggedNative "xtalpi-configure-verify" $script:Pi67Command $arguments -Interactive:$needsPrompt | Out-Null
  }
  return $true
}

function Invoke-FullAcceptance {
  Invoke-Stage "windows-acceptance" {
    $acceptance = Join-Path $script:AgentDir "scripts\pi67-windows-acceptance.ps1"
    if (-not (Test-Path -LiteralPath $acceptance -PathType Leaf)) {
      throw "Windows acceptance script not found: $acceptance"
    }
    $childPowerShell = Resolve-CommandPath @("pwsh.exe", "pwsh", "powershell.exe", "powershell")
    if (-not $childPowerShell) { throw "no PowerShell child executable was found" }
    $arguments = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", $acceptance,
      "-RepoRoot", $script:AgentDir,
      "-AgentDir", $script:AgentDir,
      "-OutDir", (Join-Path $script:RunLogDir "acceptance"),
      "-ValidateWorkstation"
    )
    if ($Minimal) { $arguments += "-SkipDesktopPrerequisites" }
    if ($SkipNotepad4Integration) { $arguments += "-SkipNotepad4Integration" }
    if ($NoTerminalAdmin) { $arguments += "-NoTerminalAdmin" }
    Invoke-LoggedNative "windows-acceptance" $childPowerShell $arguments | Out-Null
  }
}

function Invoke-BaseReadinessWithoutXtalpi {
  $context = @("--agent-dir", $script:AgentDir, "--repo-root", $script:AgentDir)
  Invoke-Stage "pi-67-version" {
    Invoke-LoggedNative "pi-67-version" $script:Pi67Command ($context + @("version", "--json")) | Out-Null
  }
  Invoke-Stage "pi-67-doctor" {
    Invoke-LoggedNative "pi-67-doctor" $script:Pi67Command ($context + @("doctor")) | Out-Null
  }
  Invoke-Stage "repository-smoke" {
    Invoke-LoggedNative "repository-smoke" $script:Pi67Command ($context + @("smoke", "--quick")) | Out-Null
  }
  Invoke-Stage "pi-runtime-final" {
    if (-not $script:PiCommand) {
      $script:PiCommand = Resolve-CommandPath @("pi.cmd", "pi")
    }
    if (-not $script:PiCommand) { throw "bare pi command is unavailable" }
    Invoke-LoggedNative "pi-runtime-final" $script:PiCommand @("--version") | Out-Null
  }
}

function Show-DryRunPlan {
  Write-Host ""
  Write-Host "pi-67 Windows fresh-machine bootstrap plan" -ForegroundColor Cyan
  foreach ($step in @(Get-BootstrapFlow)) {
    if ($Minimal -and $step -in @(
      "windows-terminal",
      "terminal-windows-powershell",
      "powershell-7",
      "terminal-powershell-7",
      "notepad4",
      "notepad4-integration"
    )) {
      Write-Host "  NOT_APPLICABLE $step (disabled by -Minimal)" -ForegroundColor DarkYellow
    } elseif ($SkipNotepad4Integration -and $step -eq "notepad4-integration") {
      Write-Host "  NOT_APPLICABLE $step (disabled by -SkipNotepad4Integration)" -ForegroundColor DarkYellow
    } else {
      Write-Host "  PLANNED $step"
    }
  }
  Write-Host ""
  Write-Host "Required Node contract: fnm $NodeLtsAlias -> Node.js 24 LTS, minimum >=$MinimumNodeVersion"
  Write-Host "Runtime package: $UpstreamPiPackage"
  Write-Host "Workspace manager: $Pi67Package"
  Write-Host "Administrator: one UAC-approved bootstrap session"
  Write-Host "Terminal automatic elevation: $(-not [bool]$NoTerminalAdmin)"
  Write-Host "Persistent npm mirror: $([bool]$UseNpmMirror)"
  Write-Host "No permanent ExecutionPolicy or proxy change will be made."
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
  throw "this bootstrap must run on Windows"
}
if (-not (Test-IsAdministrator)) {
  if ($ElevatedRelaunch) {
    throw "Administrator relaunch did not receive an elevated token"
  }
  exit (Start-ElevatedBootstrap)
}

$HomePath = Get-HomePath
if ([string]::IsNullOrWhiteSpace($AgentDir)) {
  $AgentDir = Join-Path (Join-Path $HomePath ".pi") "agent"
} else {
  $AgentDir = [System.IO.Path]::GetFullPath($AgentDir)
}
if ([string]::IsNullOrWhiteSpace($LogDir)) {
  $LogDir = Join-Path (Join-Path (Join-Path $HomePath ".pi") "pi67") "logs"
} else {
  $LogDir = [System.IO.Path]::GetFullPath($LogDir)
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$script:RunLogDir = Join-Path $LogDir ("bootstrap-{0}-{1}" -f $stamp, $PID)
New-Item -ItemType Directory -Force -Path $script:RunLogDir | Out-Null
$script:BootstrapLog = Join-Path $script:RunLogDir "bootstrap.log"
Write-Utf8Text $script:BootstrapLog "pi-67 bootstrap started at $((Get-Date).ToUniversalTime().ToString('o'))`r`n"
$script:SummaryPath = Join-Path $script:RunLogDir "bootstrap-summary.json"
$script:Stages = @()
$script:CurrentStage = "preflight"
$script:CurrentStageLog = ""
$script:AgentDir = $AgentDir
$script:WingetCommand = ""
$script:WingetVersion = ""
$script:WindowsTerminalCommand = ""
$script:TerminalSettingsPath = ""
$script:TerminalSettingsBackups = @()
$script:PowerShell7Command = ""
$script:PowerShell7Version = ""
$script:Notepad4Command = ""
$script:Notepad4RegistryBackups = @()
$script:GitCommand = ""
$script:GitVersion = ""
$script:FnmCommand = ""
$script:FnmVersion = ""
$script:FnmProfilePath = ""
$script:FnmProfileBackup = ""
$script:NodeVersion = ""
$script:NodeCommand = ""
$script:NodeManager = ""
$script:NpmCommand = ""
$script:NpmVersion = ""
$script:NpmRegistryChanged = $false
$script:PiCommand = ""
$script:Pi67Command = ""
$script:Result = "FAIL"
$script:FailureMessage = ""

Write-Host ""
Write-Host "pi-67 Windows fresh-machine bootstrap" -ForegroundColor Cyan
Write-Host "Workspace: $script:AgentDir"
Write-Host "Logs: $script:RunLogDir"
Write-Host "Administrator: confirmed for this bootstrap session"

$exitCode = 0
$xtalpiReady = $false
$acceptancePassed = $false
try {
  Invoke-Stage "preflight" {
    if (-not (Test-IsWindows)) { throw "this bootstrap must run on Windows" }
    if ($PSVersionTable.PSVersion -lt [version]"5.1") {
      throw "PowerShell 5.1 or newer is required"
    }
  }

  Invoke-Stage "administrator" {
    if (-not (Test-IsAdministrator)) { throw "Administrator token is required" }
  }
  Ensure-WinGet
  Ensure-WindowsTerminal
  Ensure-PowerShell7
  Ensure-Notepad4
  Ensure-Git
  Ensure-Fnm
  Ensure-FnmPowerShellProfile
  Ensure-NodeThroughFnm
  Install-NpmTooling
  Install-Pi67Workspace
  $xtalpiReady = Configure-Xtalpi
  if ($xtalpiReady) {
    Invoke-FullAcceptance
    $acceptancePassed = $true
  } else {
    Invoke-BaseReadinessWithoutXtalpi
  }
  $script:Result = Get-FinalBootstrapResult $xtalpiReady $acceptancePassed ([bool]$NoXtalpiPrompt)
} catch {
  $exitCode = 1
  $script:Result = "FAIL"
  $script:FailureMessage = $_.Exception.Message
  Append-BootstrapLog "FATAL $($script:FailureMessage)"
}

$summary = [pscustomobject][ordered]@{
  schema = "pi67.windows-bootstrap.v2"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  result = $script:Result
  failedStage = if ($script:Result -eq "FAIL") { $script:CurrentStage } else { "" }
  failureMessage = $script:FailureMessage
  options = [pscustomobject][ordered]@{
    minimal = [bool]$Minimal
    skipNotepad4Integration = [bool]$SkipNotepad4Integration
    terminalProfilesElevated = -not [bool]$NoTerminalAdmin
    npmMirrorEnabled = [bool]$UseNpmMirror
    noXtalpiPrompt = [bool]$NoXtalpiPrompt
  }
  requirements = [pscustomobject][ordered]@{
    preferredNodeMajor = $PreferredNodeMajor
    minimumNodeVersion = [string]$MinimumNodeVersion
    nodeLtsAlias = $NodeLtsAlias
  }
  paths = [pscustomobject][ordered]@{
    agentDir = $script:AgentDir
    logDirectory = $script:RunLogDir
    bootstrapLog = $script:BootstrapLog
    summary = $script:SummaryPath
    windowsTerminalSettings = $script:TerminalSettingsPath
    fnmPowerShellProfile = $script:FnmProfilePath
  }
  versions = [pscustomobject][ordered]@{
    winget = $script:WingetVersion
    powershell7 = $script:PowerShell7Version
    git = $script:GitVersion
    fnm = $script:FnmVersion
    node = $script:NodeVersion
    npm = $script:NpmVersion
  }
  workstation = [pscustomobject][ordered]@{
    windowsTerminal = $script:WindowsTerminalCommand
    terminalSettingsBackups = @($script:TerminalSettingsBackups)
    notepad4 = $script:Notepad4Command
    notepad4RegistryBackups = @($script:Notepad4RegistryBackups)
    git = $script:GitCommand
    fnm = $script:FnmCommand
    node = $script:NodeCommand
    nodeManager = $script:NodeManager
    fnmProfileBackup = $script:FnmProfileBackup
    npmRegistryChanged = [bool]$script:NpmRegistryChanged
  }
  xtalpi = [pscustomobject][ordered]@{
    provider = $ExpectedProvider
    model = $ExpectedModel
    configuredAndVerified = [bool]$xtalpiReady
  }
  stages = @($script:Stages)
}
Write-Utf8Text $script:SummaryPath (($summary | ConvertTo-Json -Depth 8) + "`r`n")

Write-Host ""
switch ($script:Result) {
  "PASS" {
    Write-Host "RESULT: PASS" -ForegroundColor Green
    Write-Host "Pi and the pi-67 workspace passed the complete Windows acceptance gate."
    Write-Host "Close and reopen PowerShell, then use: pi"
  }
  "READY_WITHOUT_XTALPI" {
    Write-Host "RESULT: READY_WITHOUT_XTALPI" -ForegroundColor Yellow
    Write-Host "Pi and the pi-67 workspace are installed, but the company API is not configured."
    Write-Host "Finish later with: pi-67 xtalpi configure --verify"
    Write-Host "Then rerun: powershell -NoProfile -ExecutionPolicy Bypass -File `"$script:AgentDir\scripts\pi67-windows-acceptance.ps1`""
  }
  default {
    Write-Host "RESULT: FAIL" -ForegroundColor Red
    Write-Host "Failed stage: $script:CurrentStage"
    Write-Host "Reason: $script:FailureMessage"
  }
}
Write-Host "Summary: $script:SummaryPath"
Write-Host "Logs: $script:RunLogDir"

exit $exitCode
