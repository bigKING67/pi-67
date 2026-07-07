#!/usr/bin/env pwsh
# PowerShell-native updater for Windows users.
# It preserves local runtime config files through the first-class
# ~/.pi/pi67/backups path. Legacy ~/.pi/agent-backups snapshots are no longer
# written by the normal updater.

[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$AgentDir,
  [string]$SkillsDir,
  [string]$Remote = "origin",
  [string]$Branch = "",
  [switch]$DryRun,
  [switch]$CheckOnly,
  [switch]$NoNpm,
  [switch]$ForceNpm,
  [switch]$NoConfigure,
  [switch]$NoSmoke,
  [switch]$NoReport,
  [switch]$NoDoctor,
  [switch]$AllowDirty,
  [switch]$StrictSharedSkills,
  [switch]$NoAutoResolveKnownConflicts,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
pi67-update.ps1 safely updates an existing pi-67 checkout from PowerShell.

Usage:
  .\scripts\pi67-update.ps1 [options]

Options:
  -RepoRoot DIR       pi-67 checkout to update. Defaults to this script's repo.
  -AgentDir DIR       Pi agent dir. Defaults to `$HOME\.pi\agent.
  -SkillsDir DIR      Shared skills dir. Defaults to `$HOME\.agents\skills.
  -Remote NAME        Git remote to pull from. Defaults to origin.
  -Branch NAME        Git branch to pull. Defaults to current branch.
  -DryRun             Print planned actions without changing files.
  -CheckOnly          Inspect update status without pulling or writing files.
  -NoNpm              Skip npm dependency sync.
  -ForceNpm           Run npm install even when package.json did not change.
  -NoConfigure        Skip local config template sync and xtalpi migration.
  -NoSmoke            Skip PowerShell smoke after update.
  -NoReport           Skip pi67-report.json generation.
  -NoDoctor           Do not embed PowerShell doctor output in the report.
  -AllowDirty         Let git attempt the update with local tracked edits.
  -StrictSharedSkills Stop when an existing global shared skill differs from
                      the pi-67 bundled baseline. Default keeps the existing
                      global skill and continues.
  -NoAutoResolveKnownConflicts
                       Do not auto-backup/restore dirty user runtime config
                       files before git update.
  -Help               Show this help.

Normal Windows update:

  Set-Location `$env:USERPROFILE\.pi\agent
  .\scripts\pi67-update.ps1

This script never overwrites existing local config files such as models.json,
auth.json, mcp.json, or image-gen.json. Missing files are copied from examples.
If an existing local JSON file uses a Windows-unfriendly encoding such as
UTF-16, UTF-8 BOM, or leading NUL bytes, the updater backs it up and rewrites it
as UTF-8 without BOM before Pi starts.
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

function Get-HomePath {
  if ($env:USERPROFILE) {
    return $env:USERPROFILE
  }
  if ($HOME) {
    return $HOME
  }
  return [Environment]::GetFolderPath("UserProfile")
}

function Resolve-ScriptPath {
  if ($PSCommandPath) {
    return $PSCommandPath
  }
  return $MyInvocation.MyCommand.Path
}

$HomePath = Get-HomePath
$ScriptPath = Resolve-ScriptPath
$ScriptDir = Split-Path -Parent $ScriptPath
. (Join-Path $ScriptDir "pi67-json-utils.ps1")

if (-not $RepoRoot) {
  $RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
} else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}

if (-not $AgentDir) {
  $AgentDir = Join-Path (Join-Path $HomePath ".pi") "agent"
}

if (-not $SkillsDir) {
  $SkillsDir = Join-Path (Join-Path $HomePath ".agents") "skills"
}

$NpmDir = Join-Path $AgentDir "npm"
$NpmInstallArgs = @("install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline")
$UserPreservedTrackedUpdatePaths = @(
  "settings.json",
  "models.json",
  "auth.json",
  "mcp.json",
  "image-gen.json",
  "settings.json.theme"
)

function Write-Info {
  param([string]$Message)
  Write-Host $Message
}

function Write-Pass {
  param([string]$Message)
  Write-Host ("  PASS {0}" -f $Message) -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host ("  WARN {0}" -f $Message) -ForegroundColor Yellow
}

function Write-Fail {
  param([string]$Message)
  throw $Message
}

function Write-Section {
  param([string]$Name)
  Write-Host ""
  Write-Host ("--- {0} ---" -f $Name) -ForegroundColor Cyan
}

function Test-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [switch]$Echo
  )

  # Windows PowerShell 5.1 can promote native stderr lines into ErrorRecord
  # objects when 2>&1 is used. Git writes normal fetch progress to stderr, so
  # temporarily relax ErrorActionPreference and decide success from LASTEXITCODE.
  $oldErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & $FilePath @Arguments 2>&1
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }

  $lines = @($output | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) {
      $_.ToString()
    } else {
      [string]$_
    }
  })

  if ($Echo) {
    foreach ($line in $lines) {
      Write-Host $line
    }
  }
  if ($exitCode -ne 0) {
    $excerpt = ($lines | Select-Object -First 30) -join "`n"
    throw ("command failed with exit {0}: {1} {2}`n{3}" -f $exitCode, $FilePath, ($Arguments -join " "), $excerpt)
  }
  return $lines
}

function Invoke-Git {
  param(
    [string[]]$Arguments,
    [switch]$Echo
  )
  return Invoke-External "git" (@("-C", $RepoRoot) + $Arguments) -Echo:$Echo
}

function Invoke-PlannedExternal {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = ""
  )

  if ($DryRun) {
    if ($WorkingDirectory) {
      Write-Host ("  DRY-RUN ({0}) {1} {2}" -f $WorkingDirectory, $FilePath, ($Arguments -join " ")) -ForegroundColor Cyan
    } else {
      Write-Host ("  DRY-RUN {0} {1}" -f $FilePath, ($Arguments -join " ")) -ForegroundColor Cyan
    }
    return @()
  }

  if ($WorkingDirectory) {
    Push-Location $WorkingDirectory
    try {
      return Invoke-External $FilePath $Arguments -Echo
    } finally {
      Pop-Location
    }
  }

  return Invoke-External $FilePath $Arguments -Echo
}

function ConvertTo-RepoPath {
  param([string]$Path)
  return $Path.Replace("\", "/")
}

function Get-StatusPath {
  param([string]$Line)
  if ($Line.Length -lt 4) {
    return ""
  }
  $path = $Line.Substring(3).Trim()
  $arrow = " -> "
  if ($path.Contains($arrow)) {
    $path = $path.Substring($path.IndexOf($arrow) + $arrow.Length)
  }
  if ($path.StartsWith('"') -and $path.EndsWith('"')) {
    $path = $path.Substring(1, $path.Length - 2)
  }
  return ConvertTo-RepoPath $path
}

function Get-GitStatusLines {
  param([switch]$IncludeUntracked)
  $mode = if ($IncludeUntracked) { "--untracked-files=all" } else { "--untracked-files=no" }
  return @(Invoke-Git @("status", "--porcelain=v1", $mode))
}

function Get-CurrentBranch {
  $branch = (Invoke-Git @("rev-parse", "--abbrev-ref", "HEAD") | Select-Object -First 1)
  if ($branch -eq "HEAD" -and -not $Branch) {
    Write-Fail "detached HEAD; pass -Branch explicitly"
  }
  if (-not $Branch) {
    return $branch
  }
  return $Branch
}

function Get-FileHashValue {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return "missing"
  }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-DirectoryHashValue {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return "missing"
  }

  $root = [IO.Path]::GetFullPath($Path).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $hash = [System.Security.Cryptography.SHA256]::Create()
  $separator = [byte[]](0)
  try {
    $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force | Sort-Object FullName)
    foreach ($file in $files) {
      $full = [IO.Path]::GetFullPath($file.FullName)
      $relative = $full.Substring($root.Length).TrimStart(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
      ).Replace("\", "/")
      $relativeBytes = [System.Text.Encoding]::UTF8.GetBytes($relative)
      $fileHashBytes = [System.Text.Encoding]::UTF8.GetBytes((Get-FileHashValue $file.FullName))
      [void]$hash.TransformBlock($relativeBytes, 0, $relativeBytes.Length, $null, 0)
      [void]$hash.TransformBlock($separator, 0, $separator.Length, $null, 0)
      [void]$hash.TransformBlock($fileHashBytes, 0, $fileHashBytes.Length, $null, 0)
      [void]$hash.TransformBlock($separator, 0, $separator.Length, $null, 0)
    }
    [void]$hash.TransformFinalBlock([byte[]]::new(0), 0, 0)
    return ([BitConverter]::ToString($hash.Hash) -replace "-", "").ToLowerInvariant()
  } finally {
    $hash.Dispose()
  }
}

function Copy-FileIfMissing {
  param(
    [string]$Source,
    [string]$Target,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    Write-Warn ("example file missing: {0}" -f $Source)
    return
  }

  if (Test-Path -LiteralPath $Target) {
    Write-Pass ("{0} exists; kept existing local config" -f $Label)
    return
  }

  if ($DryRun) {
    Write-Host ("  DRY-RUN copy {0} -> {1}" -f $Source, $Target) -ForegroundColor Cyan
    return
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Target
  Write-Warn ("created new local config from template: {0}" -f $Label)
}

function Read-JsonFile {
  param([string]$Path)
  return Read-Pi67JsonFile $Path
}

function Save-JsonFile {
  param(
    [string]$Path,
    [object]$Data
  )
  if ($DryRun) {
    Write-Host ("  DRY-RUN write JSON {0}" -f $Path) -ForegroundColor Cyan
    return
  }
  Save-Pi67JsonFileUtf8NoBom $Path $Data
}

function Test-JsonProperty {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) {
    return $false
  }
  return [bool]($Object.PSObject.Properties[$Name])
}

function Get-JsonPropertyValue {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) {
    return $null
  }
  $prop = $Object.PSObject.Properties[$Name]
  if ($prop) {
    return $prop.Value
  }
  return $null
}

function Set-JsonPropertyValue {
  param([object]$Object, [string]$Name, [object]$Value)
  if ($null -eq $Object) {
    throw "cannot set JSON property on null object: $Name"
  }
  $prop = $Object.PSObject.Properties[$Name]
  if ($prop) {
    $prop.Value = $Value
  } else {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function Remove-JsonProperty {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) {
    return
  }
  if ($Object.PSObject.Properties[$Name]) {
    $Object.PSObject.Properties.Remove($Name)
  }
}

function Copy-JsonObject {
  param([object]$Value)
  return ($Value | ConvertTo-Json -Depth 80 | ConvertFrom-Json)
}

function Test-PlaceholderApiKey {
  param([object]$Value)
  if ($null -eq $Value) {
    return $true
  }
  $text = [string]$Value
  return ($text -eq "" -or $text.Contains("YOUR_") -or $text.Contains("REPLACE_") -or $text -eq "changeme")
}

function Get-FirstRealProviderKey {
  param([object]$Providers, [string[]]$ProviderIds)
  foreach ($providerId in $ProviderIds) {
    $provider = Get-JsonPropertyValue $Providers $providerId
    if ($provider) {
      $key = Get-JsonPropertyValue $provider "apiKey"
      if (-not (Test-PlaceholderApiKey $key)) {
        return $key
      }
    }
  }
  return ""
}

function Sync-LocalConfigTemplates {
  Write-Section "local config templates"
  Copy-FileIfMissing (Join-Path $RepoRoot "models.example.json") (Join-Path $AgentDir "models.json") "models.json"
  Copy-FileIfMissing (Join-Path $RepoRoot "mcp.example.json") (Join-Path $AgentDir "mcp.json") "mcp.json"
  Copy-FileIfMissing (Join-Path $RepoRoot "auth.example.json") (Join-Path $AgentDir "auth.json") "auth.json"
  Copy-FileIfMissing (Join-Path $RepoRoot "image-gen.example.json") (Join-Path $AgentDir "image-gen.json") "image-gen.json"
}

function Repair-LocalConfigJsonEncoding {
  Write-Section "local config JSON encoding"
  $targets = @(
    @("models.json", (Join-Path $AgentDir "models.json")),
    @("mcp.json", (Join-Path $AgentDir "mcp.json")),
    @("auth.json", (Join-Path $AgentDir "auth.json")),
    @("image-gen.json", (Join-Path $AgentDir "image-gen.json")),
    @("settings.json", (Join-Path $AgentDir "settings.json"))
  )

  foreach ($target in $targets) {
    $label = $target[0]
    $path = $target[1]
    $result = Repair-Pi67JsonFileEncoding -Path $path -Label $label -DryRun:$DryRun
    if ($result.Status -eq "missing") {
      Write-Warn ("{0} missing; skipped encoding normalization" -f $label)
    } elseif ($result.Status -eq "unchanged") {
      Write-Pass ("{0} already UTF-8 JSON compatible" -f $label)
    } elseif ($result.Status -eq "would-normalize") {
      Write-Warn ("would normalize {0} from {1} to UTF-8 without BOM" -f $label, $result.EncodingName)
    } else {
      Write-Warn ("normalized {0} from {1} to UTF-8 without BOM; backup: {2}" -f $label, $result.EncodingName, $result.BackupPath)
    }
  }
}

function Invoke-LocalConfigMigration {
  if ($NoConfigure) {
    Write-Warn "local config migration skipped by -NoConfigure"
    return
  }

  Write-Section "local config migration"

  $settingsPath = Join-Path $AgentDir "settings.json"
  $modelsPath = Join-Path $AgentDir "models.json"
  $modelsExamplePath = Join-Path $RepoRoot "models.example.json"

  if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
    Write-Warn "settings.json missing; skipped settings migration"
  }

  if (-not (Test-Path -LiteralPath $modelsPath -PathType Leaf)) {
    Write-Warn "models.json missing; skipped model provider migration"
    return
  }

  if (-not (Test-Path -LiteralPath $modelsExamplePath -PathType Leaf)) {
    Write-Warn "models.example.json missing; skipped model provider migration"
    return
  }

  $changedModels = $false
  $changedSettings = $false
  $models = Read-JsonFile $modelsPath
  $examples = Read-JsonFile $modelsExamplePath

  if (-not (Test-JsonProperty $models "providers")) {
    Set-JsonPropertyValue $models "providers" ([pscustomobject]@{})
    $changedModels = $true
  }

  $providers = $models.providers
  $exampleProviders = $examples.providers
  $xtalpiProvider = Get-JsonPropertyValue $providers "xtalpi-pi-tools"

  if (-not $xtalpiProvider) {
    $exampleProvider = Get-JsonPropertyValue $exampleProviders "xtalpi-pi-tools"
    if ($exampleProvider) {
      $xtalpiProvider = Copy-JsonObject $exampleProvider
      Set-JsonPropertyValue $providers "xtalpi-pi-tools" $xtalpiProvider
      $changedModels = $true
      Write-Pass "added provider xtalpi-pi-tools from models.example.json"
    } else {
      Write-Warn "models.example.json missing provider xtalpi-pi-tools"
    }
  }

  if ($xtalpiProvider) {
    $migratedKey = Get-FirstRealProviderKey $providers @("xtalpi-pi-tools", "xtalpi-tools", "xtalpi")
    $currentKey = Get-JsonPropertyValue $xtalpiProvider "apiKey"
    if ((Test-PlaceholderApiKey $currentKey) -and $migratedKey) {
      Set-JsonPropertyValue $xtalpiProvider "apiKey" $migratedKey
      $changedModels = $true
      Write-Pass "migrated xtalpi API key to provider xtalpi-pi-tools"
    }

    $legacyTools = Get-JsonPropertyValue $providers "xtalpi-tools"
    $legacyXtalpi = Get-JsonPropertyValue $providers "xtalpi"
    $legacyBaseUrl = ""
    if ($legacyTools) {
      $legacyBaseUrl = Get-JsonPropertyValue $legacyTools "baseUrl"
    }
    if (-not $legacyBaseUrl -and $legacyXtalpi) {
      $legacyBaseUrl = Get-JsonPropertyValue $legacyXtalpi "baseUrl"
    }
    if ($legacyBaseUrl -and (Get-JsonPropertyValue $xtalpiProvider "baseUrl") -ne $legacyBaseUrl) {
      Set-JsonPropertyValue $xtalpiProvider "baseUrl" $legacyBaseUrl
      $changedModels = $true
      Write-Pass "migrated xtalpi baseUrl to provider xtalpi-pi-tools"
    }

    if ($env:PI67_KEEP_LEGACY_XTALPI_PROVIDERS -ne "1") {
      if (Get-JsonPropertyValue $providers "xtalpi-tools") {
        Remove-JsonProperty $providers "xtalpi-tools"
        $changedModels = $true
        Write-Pass "removed legacy provider xtalpi-tools"
      }
      if (Get-JsonPropertyValue $providers "xtalpi") {
        Remove-JsonProperty $providers "xtalpi"
        $changedModels = $true
        Write-Pass "removed legacy provider xtalpi"
      }
    }
  }

  if ($settingsPath -and (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
    $settings = Read-JsonFile $settingsPath
    if ($settings.defaultProvider -eq "xtalpi-tools" -or $settings.defaultProvider -eq "xtalpi") {
      Set-JsonPropertyValue $settings "defaultProvider" "xtalpi-pi-tools"
      if (-not $settings.defaultModel) {
        Set-JsonPropertyValue $settings "defaultModel" "deepseek-v4-pro"
      }
      Set-JsonPropertyValue $settings "defaultThinkingLevel" "off"
      $changedSettings = $true
      Write-Pass "migrated default provider to xtalpi-pi-tools"
    }
    if ($changedSettings) {
      Save-JsonFile $settingsPath $settings
    } else {
      Write-Pass "settings.json unchanged"
    }
  }

  if ($changedModels) {
    Save-JsonFile $modelsPath $models
  } else {
    Write-Pass "models.json unchanged"
  }
}

function Sync-SharedSkills {
  Write-Section "shared skills"
  $sourceRoot = Join-Path $RepoRoot "shared-skills"
  if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    Write-Warn "shared skill source missing"
    return
  }

  if ($DryRun) {
    Write-Host ("  DRY-RUN ensure directory {0}" -f $SkillsDir) -ForegroundColor Cyan
  } else {
    New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
  }

  $skillDirs = @(Get-ChildItem -LiteralPath $sourceRoot -Directory)
  if ($skillDirs.Count -eq 0) {
    Write-Warn "no shared skills found"
    return
  }

  foreach ($skill in $skillDirs) {
    $target = Join-Path $SkillsDir $skill.Name
    $skillMd = Join-Path $skill.FullName "SKILL.md"
    if (-not (Test-Path -LiteralPath $skillMd -PathType Leaf)) {
      Write-Warn ("shared skill missing SKILL.md, skipped: {0}" -f $skill.Name)
      continue
    }

    if (Test-Path -LiteralPath $target) {
      $sourceHash = Get-DirectoryHashValue $skill.FullName
      $targetHash = Get-DirectoryHashValue $target
      if ($sourceHash -eq $targetHash -and $targetHash -ne "missing") {
        Write-Pass ("shared skill already synced: {0}" -f $skill.Name)
        continue
      }
      if ($StrictSharedSkills) {
        Write-Fail ("shared skill conflict: {0} (existing={1} dirHash={2} source={3} dirHash={4}). Strict mode enabled; resolve manually or choose a different -SkillsDir." -f $skill.Name, $target, $targetHash, $skill.FullName, $sourceHash)
      }
      Write-Warn ("shared skill differs from pi-67 baseline; keeping existing global skill: {0}" -f $skill.Name)
      Write-Warn ("existing={0} dirHash={1}" -f $target, $targetHash)
      Write-Warn ("source skipped={0} dirHash={1}" -f $skill.FullName, $sourceHash)
      continue
    }

    if ($DryRun) {
      Write-Host ("  DRY-RUN copy {0} -> {1}" -f $skill.FullName, $target) -ForegroundColor Cyan
    } else {
      Copy-Item -LiteralPath $skill.FullName -Destination $target -Recurse
    }
    Write-Pass ("synced shared skill: {0}" -f $skill.Name)
  }
}

function Sync-Npm {
  if ($NoNpm) {
    Write-Warn "npm sync skipped by -NoNpm"
    return
  }

  Write-Section "npm sync"
  if (-not (Test-CommandExists "npm")) {
    Write-Warn "npm not found; skipped npm sync"
    return
  }

  $repoPackage = Join-Path $RepoRoot "package.json"
  $agentPackage = Join-Path $NpmDir "package.json"
  if (-not (Test-Path -LiteralPath $repoPackage -PathType Leaf)) {
    Write-Warn "package.json missing; skipped npm sync"
    return
  }

  $repoHash = Get-FileHashValue $repoPackage
  $agentHash = Get-FileHashValue $agentPackage
  if (-not $ForceNpm -and $repoHash -eq $agentHash) {
    Write-Pass "npm package.json already synced"
    return
  }

  if ($DryRun) {
    Write-Host ("  DRY-RUN copy {0} -> {1}" -f $repoPackage, $agentPackage) -ForegroundColor Cyan
    Write-Host ("  DRY-RUN npm {0} in {1}" -f ($NpmInstallArgs -join " "), $NpmDir) -ForegroundColor Cyan
    return
  }

  New-Item -ItemType Directory -Force -Path $NpmDir | Out-Null
  Copy-Item -LiteralPath $repoPackage -Destination $agentPackage -Force
  Invoke-PlannedExternal "npm" $NpmInstallArgs -WorkingDirectory $NpmDir | Out-Null
  Write-Pass ("npm packages synced in {0}" -f $NpmDir)
}

function Invoke-UntilDoneRuntimeQueuePatch {
  Write-Section "pi-until-done runtime queue patch"
  $patcher = Join-Path (Join-Path $RepoRoot "scripts") "pi67-patch-pi-until-done-runtime-queue.ps1"
  if (-not (Test-Path -LiteralPath $patcher -PathType Leaf)) {
    Write-Warn "pi-until-done runtime queue patcher missing"
    return
  }
  if (-not (Test-CommandExists "node")) {
    Write-Warn "node not found; skipped pi-until-done runtime queue patch"
    return
  }
  if ($DryRun) {
    Write-Host ("  DRY-RUN {0} -Apply -AgentDir {1}" -f $patcher, $AgentDir) -ForegroundColor Cyan
    return
  }
  & $patcher -Apply -AgentDir $AgentDir
  if ($LASTEXITCODE -ne 0) {
    throw "pi-until-done runtime queue patch failed"
  }
}

function Test-UntilDoneRuntimeQueueStatus {
  if (-not (Test-CommandExists "node")) {
    Write-Warn "node not found; skipped pi-until-done runtime queue/progress compatibility check"
    return
  }
  $patcher = Join-Path (Join-Path $RepoRoot "scripts") "pi67-patch-pi-until-done-runtime-queue.ps1"
  if (-not (Test-Path -LiteralPath $patcher -PathType Leaf)) {
    Write-Warn "pi-until-done runtime queue patcher missing"
    return
  }
  & $patcher -Check -AgentDir $AgentDir | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Pass "pi-until-done runtime queue/progress compatibility is already patched or package is not installed"
  } else {
    Write-Warn "pi-until-done runtime queue/progress compatibility would be patched after npm sync"
  }
}

function Invoke-Smoke {
  if ($NoSmoke) {
    Write-Warn "PowerShell smoke skipped by -NoSmoke"
    return
  }

  Write-Section "PowerShell smoke"
  $smoke = Join-Path (Join-Path $RepoRoot "scripts") "pi67-smoke.ps1"
  if (-not (Test-Path -LiteralPath $smoke -PathType Leaf)) {
    Write-Warn "PowerShell smoke script missing"
    return
  }

  if ($DryRun) {
    Write-Host ("  DRY-RUN powershell -ExecutionPolicy Bypass -File {0} -Ci" -f $smoke) -ForegroundColor Cyan
    return
  }

  $psExe = "powershell"
  if (Test-CommandExists "pwsh") {
    $psExe = "pwsh"
  } elseif (-not (Test-CommandExists "powershell")) {
    Write-Warn "no child PowerShell executable found; skipped smoke"
    return
  }
  Invoke-PlannedExternal $psExe @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $smoke, "-Ci") | Out-Null
}

function Invoke-Report {
  if ($NoReport) {
    Write-Warn "report skipped by -NoReport"
    return
  }

  Write-Section "pi-67 report"
  $reporter = Join-Path (Join-Path $RepoRoot "scripts") "pi67-report.ps1"
  if (-not (Test-Path -LiteralPath $reporter -PathType Leaf)) {
    Write-Warn "PowerShell report script missing"
    return
  }

  $psExe = "powershell"
  if (Test-CommandExists "pwsh") {
    $psExe = "pwsh"
  } elseif (-not (Test-CommandExists "powershell")) {
    Write-Warn "no child PowerShell executable found; skipped report"
    return
  }

  $args = @(
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $reporter,
    "-RepoRoot",
    $RepoRoot,
    "-AgentDir",
    $AgentDir,
    "-SkillsDir",
    $SkillsDir,
    "-Operation",
    "update"
  )
  if ($NoDoctor) {
    $args += "-NoDoctor"
  }

  if ($DryRun) {
    Write-Host ("  DRY-RUN {0} {1}" -f $psExe, ($args -join " ")) -ForegroundColor Cyan
    return
  }

  try {
    Invoke-PlannedExternal $psExe $args | Out-Null
    Write-Pass ("report written: {0}" -f (Join-Path $AgentDir "pi67-report.json"))
  } catch {
    Write-Warn "report generation failed; rerun scripts/pi67-report.ps1 manually for details"
    Write-Warn $_.Exception.Message
  }
}

function Get-UserRuntimeBackupRoot {
  return Join-Path (Join-Path (Join-Path $HomePath ".pi") "pi67") "backups"
}

function Get-SafeBackupFileName {
  param([string]$Path)
  return $Path -replace "[\\/]", "__"
}

function Test-StringArraySame {
  param([string[]]$Left, [string[]]$Right)
  $leftSorted = @($Left | Sort-Object)
  $rightSorted = @($Right | Sort-Object)
  if ($leftSorted.Count -ne $rightSorted.Count) {
    return $false
  }
  return (($leftSorted -join "`n") -eq ($rightSorted -join "`n"))
}

function Test-BackupFilesMatchCurrentRuntime {
  param([string]$BackupDir, [string[]]$DirtyPaths)

  $filesDir = Join-Path $BackupDir "files"
  foreach ($rel in $DirtyPaths) {
    $target = Join-Path $RepoRoot ($rel -replace "/", [IO.Path]::DirectorySeparatorChar)
    $backupFile = Join-Path $filesDir (Get-SafeBackupFileName $rel)
    $targetExists = Test-Path -LiteralPath $target -PathType Leaf
    $backupExists = Test-Path -LiteralPath $backupFile -PathType Leaf
    if ($targetExists -ne $backupExists) {
      return $false
    }
    if ($targetExists -and ((Get-FileHashValue $target) -ne (Get-FileHashValue $backupFile))) {
      return $false
    }
  }
  return $true
}

function Find-EquivalentUserRuntimeBackup {
  param([string[]]$DirtyPaths)

  $root = Get-UserRuntimeBackupRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    return ""
  }

  $dirs = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  foreach ($dir in $dirs) {
    $manifestPath = Join-Path $dir.FullName "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
      continue
    }
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    } catch {
      continue
    }
    $paths = @($manifest.paths | ForEach-Object { [string]$_ })
    if (-not (Test-StringArraySame $paths $DirtyPaths)) {
      continue
    }
    if (Test-BackupFilesMatchCurrentRuntime $dir.FullName $DirtyPaths) {
      return $dir.FullName
    }
  }
  return ""
}

function Backup-And-ClearUserRuntimeTrackedEdits {
  param([string[]]$TrackedStatus)

  $dirtyPaths = @()
  foreach ($line in $TrackedStatus) {
    $path = Get-StatusPath $line
    if ($path) {
      $dirtyPaths += $path
    }
  }

  if ($dirtyPaths.Count -eq 0) {
    return $null
  }

  $unknown = @($dirtyPaths | Where-Object { $UserPreservedTrackedUpdatePaths -notcontains $_ })
  if ($unknown.Count -gt 0) {
    return $null
  }

  $existingBackupDir = Find-EquivalentUserRuntimeBackup $dirtyPaths
  if ($existingBackupDir) {
    Write-Warn "tracked edits are limited to user-owned runtime config files"
    Write-Warn ("reusing existing identical runtime backup: {0}" -f $existingBackupDir)

    if ($DryRun) {
      Write-Host ("  DRY-RUN reuse preserved runtime backup {0}" -f $existingBackupDir) -ForegroundColor Cyan
      Write-Host ("  DRY-RUN git restore --worktree --staged -- {0}" -f ($dirtyPaths -join " ")) -ForegroundColor Cyan
      return [pscustomobject]@{
        BackupDir = $existingBackupDir
        Paths = $dirtyPaths
        DryRun = $true
        Reused = $true
      }
    }

    Invoke-Git (@("restore", "--worktree", "--staged", "--") + $dirtyPaths) | Out-Null
    return [pscustomobject]@{
      BackupDir = $existingBackupDir
      Paths = $dirtyPaths
      DryRun = $false
      Reused = $true
    }
  }

  Write-Warn "tracked edits are limited to user-owned runtime config files"
  $stamp = Get-Date -Format "yyyyMMddTHHmmssZ"
  $backupDir = Join-Path (Get-UserRuntimeBackupRoot) ("pre-update-runtime-{0}" -f $stamp)
  $filesDir = Join-Path $backupDir "files"
  Write-Warn ("backing them up and restoring them after git update: {0}" -f $backupDir)

  if ($DryRun) {
    Write-Host ("  DRY-RUN backup preserved runtime files to {0}" -f $backupDir) -ForegroundColor Cyan
    Write-Host ("  DRY-RUN git restore --worktree --staged -- {0}" -f ($dirtyPaths -join " ")) -ForegroundColor Cyan
    return [pscustomobject]@{
      BackupDir = $backupDir
      Paths = $dirtyPaths
      DryRun = $true
    }
  }

  New-Item -ItemType Directory -Force -Path $filesDir | Out-Null
  Invoke-Git (@("diff", "--") + $dirtyPaths) | Set-Content -LiteralPath (Join-Path $backupDir "local.diff") -Encoding UTF8

  foreach ($rel in $dirtyPaths) {
    $source = Join-Path $RepoRoot ($rel -replace "/", [IO.Path]::DirectorySeparatorChar)
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $filesDir (Get-SafeBackupFileName $rel)) -Force
    }
  }

  @{
    schema = "pi67.runtime-preserve-backup.v1"
    createdAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    repoRoot = $RepoRoot
    paths = $dirtyPaths
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $backupDir "manifest.json") -Encoding UTF8

  Invoke-Git (@("restore", "--worktree", "--staged", "--") + $dirtyPaths) | Out-Null
  return [pscustomobject]@{
    BackupDir = $backupDir
    Paths = $dirtyPaths
    DryRun = $false
    Reused = $false
  }
}

function Restore-UserRuntimeTrackedEdits {
  param([object]$Backup)

  if (-not $Backup) {
    return
  }
  if ($Backup.DryRun) {
    Write-Host ("  DRY-RUN restore preserved runtime files from {0}" -f $Backup.BackupDir) -ForegroundColor Cyan
    return
  }

  $filesDir = Join-Path $Backup.BackupDir "files"
  foreach ($rel in @($Backup.Paths)) {
    $source = Join-Path $filesDir (Get-SafeBackupFileName $rel)
    $target = Join-Path $RepoRoot ($rel -replace "/", [IO.Path]::DirectorySeparatorChar)
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      Copy-Item -LiteralPath $source -Destination $target -Force
    } elseif (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Force
    }
  }
  Write-Pass "restored preserved runtime config after update"
}

function Show-ReportStatus {
  param(
    [string]$CurrentVersion,
    [string]$CurrentShort,
    [bool]$CurrentDirty
  )

  Write-Section "report status"
  if ($NoReport) {
    Write-Warn "report generation disabled by -NoReport"
    return
  }

  $reportPath = Join-Path $AgentDir "pi67-report.json"
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    Write-Warn ("report missing; update would write {0}" -f $reportPath)
    return
  }

  try {
    $report = Read-JsonFile $reportPath
  } catch {
    Write-Warn ("report is not valid JSON: {0}" -f $_.Exception.Message)
    return
  }

  Write-Info ("Report path : {0}" -f $reportPath)
  Write-Info ("Generated   : {0}" -f $(if ($report.generatedAt) { $report.generatedAt } else { "unknown" }))
  Write-Info ("Schema      : {0}" -f $(if ($report.schemaVersion) { $report.schemaVersion } else { "missing" }))
  Write-Info ("Version     : {0}" -f $(if ($report.pi67Version) { $report.pi67Version } else { "unknown" }))
  Write-Info ("Commit      : {0}" -f $(if ($report.repository.shortCommit) { $report.repository.shortCommit } else { "unknown" }))
  if ($report.doctor) {
    $doctorResult = if ($report.doctor.skipped -eq $true) { "SKIPPED" } elseif ($report.doctor.result) { $report.doctor.result } else { "unknown" }
    Write-Info ("Doctor      : {0}" -f $doctorResult)
  }

  $staleReasons = @()
  if ([int]($report.schemaVersion -as [int]) -lt 2) {
    $staleReasons += "schemaVersion < 2"
  }
  if ([string]$report.pi67Version -ne [string]$CurrentVersion) {
    $staleReasons += ("version {0} != {1}" -f $(if ($report.pi67Version) { $report.pi67Version } else { "unknown" }), $CurrentVersion)
  }
  if ([string]$report.repository.shortCommit -ne [string]$CurrentShort) {
    $staleReasons += ("commit {0} != {1}" -f $(if ($report.repository.shortCommit) { $report.repository.shortCommit } else { "unknown" }), $CurrentShort)
  }
  if ([bool]$report.repository.dirty -ne $CurrentDirty) {
    $staleReasons += ("dirty {0} != {1}" -f ([bool]$report.repository.dirty), $CurrentDirty)
  }
  if ($report.doctor -and $report.doctor.skipped -ne $true -and [int]($report.doctor.schemaVersion -as [int]) -lt 2) {
    $staleReasons += "doctor schemaVersion < 2"
  }

  if ($staleReasons.Count -gt 0) {
    Write-Warn ("report is stale: {0}" -f ($staleReasons -join "; "))
    Write-Info "update would overwrite the report after smoke"
  } else {
    Write-Pass "report matches current checkout"
  }
}

function Show-CheckOnly {
  Write-Section "check only"
  if (-not (Test-CommandExists "git")) {
    Write-Fail "git not found"
  }
  Invoke-Git @("rev-parse", "--is-inside-work-tree") | Out-Null

  $targetBranch = Get-CurrentBranch
  $localShort = (Invoke-Git @("rev-parse", "--short", "HEAD") | Select-Object -First 1)
  $trackedStatus = Get-GitStatusLines
  $allStatus = Get-GitStatusLines -IncludeUntracked

  Write-Info ("Local branch : {0}" -f ((Invoke-Git @("rev-parse", "--abbrev-ref", "HEAD") | Select-Object -First 1)))
  Write-Info ("Target branch: {0}" -f $targetBranch)
  Write-Info ("Local commit : {0}" -f $localShort)

  if ($trackedStatus.Count -eq 0) {
    Write-Pass "no tracked local edits"
  } else {
    Write-Warn "tracked local edits exist"
    foreach ($line in $trackedStatus) {
      Write-Host ("  {0}" -f $line)
    }
    $dirtyPaths = @($trackedStatus | ForEach-Object { Get-StatusPath $_ })
    $unknown = @($dirtyPaths | Where-Object { $UserPreservedTrackedUpdatePaths -notcontains $_ })
    if ($unknown.Count -eq 0 -and -not $NoAutoResolveKnownConflicts) {
      Write-Pass "tracked edits are user-owned runtime config and will be preserved across update"
    } else {
      Write-Warn "tracked edits require manual commit/stash or -AllowDirty"
    }
  }

  $untracked = @($allStatus | Where-Object { $_.StartsWith("?? ") })
  if ($untracked.Count -gt 0) {
    Write-Warn ("untracked files exist; update ignores them unless Git reports a path collision ({0} shown)" -f [Math]::Min($untracked.Count, 10))
    $untracked | Select-Object -First 10 | ForEach-Object { Write-Host ("  {0}" -f $_) }
  }

  $remoteRef = "refs/heads/$targetBranch"
  try {
    $remoteLine = Invoke-External "git" @("ls-remote", $Remote, $remoteRef) | Select-Object -First 1
    if ($remoteLine) {
      $remoteFull = ($remoteLine -split "\s+")[0]
      Write-Info ("Remote head : {0} ({1}/{2})" -f $remoteFull.Substring(0, 7), $Remote, $targetBranch)
    } else {
      Write-Warn ("could not read remote head: {0} {1}" -f $Remote, $remoteRef)
    }
  } catch {
    Write-Warn ("could not read remote head: {0}" -f $_.Exception.Message)
  }

  if ($NoConfigure) {
    Write-Warn "local config template/config migration would be skipped"
  } else {
    Write-Pass "local config templates, JSON encoding normalization, and xtalpi migration would be checked"
  }

  if ($NoNpm) {
    Write-Warn "npm sync would be skipped"
  } else {
    $repoPackage = Join-Path $RepoRoot "package.json"
    $agentPackage = Join-Path $NpmDir "package.json"
    if ((Get-FileHashValue $repoPackage) -eq (Get-FileHashValue $agentPackage) -and -not $ForceNpm) {
      Write-Pass "npm package.json already synced"
    } else {
      Write-Warn "npm package.json differs or -ForceNpm is set; npm sync would run"
    }
  }
  Test-UntilDoneRuntimeQueueStatus

  $currentVersion = ""
  $versionPath = Join-Path $RepoRoot "VERSION"
  if (Test-Path -LiteralPath $versionPath -PathType Leaf) {
    $currentVersion = (Get-Content -LiteralPath $versionPath -Raw).Trim()
  }
  $currentDirty = ($allStatus.Count -gt 0)
  Show-ReportStatus $currentVersion $localShort $currentDirty

  Write-Pass "check-only completed without writing files"
}

function Update-Repo {
  Write-Section "git update"
  if (-not (Test-CommandExists "git")) {
    Write-Fail "git not found"
  }
  Invoke-Git @("rev-parse", "--is-inside-work-tree") | Out-Null

  $targetBranch = Get-CurrentBranch
  $trackedStatus = Get-GitStatusLines
  $runtimeBackup = $null

  if ($trackedStatus.Count -gt 0 -and -not $AllowDirty -and -not $NoAutoResolveKnownConflicts) {
    $runtimeBackup = Backup-And-ClearUserRuntimeTrackedEdits $trackedStatus
    if (-not $runtimeBackup) {
      foreach ($line in $trackedStatus) {
        Write-Host $line
      }
      Write-Fail "repo has non-runtime tracked local changes; commit/stash them or rerun with -AllowDirty"
    }
  } elseif ($trackedStatus.Count -gt 0 -and $AllowDirty) {
    Write-Warn "repo has tracked local changes; proceeding because -AllowDirty was provided"
  } elseif ($trackedStatus.Count -gt 0) {
    foreach ($line in $trackedStatus) {
      Write-Host $line
    }
    Write-Fail "repo has tracked local changes and auto-preserve is disabled; commit/stash them or rerun with -AllowDirty"
  }

  $before = (Invoke-Git @("rev-parse", "--short", "HEAD") | Select-Object -First 1)
  if ($DryRun) {
    Write-Host ("  DRY-RUN git -C {0} pull --ff-only {1} {2}" -f $RepoRoot, $Remote, $targetBranch) -ForegroundColor Cyan
    Write-Pass ("current revision: {0}" -f $before)
    return
  }

  try {
    Invoke-Git @("pull", "--ff-only", $Remote, $targetBranch) -Echo | Out-Null
  } catch {
    Restore-UserRuntimeTrackedEdits $runtimeBackup
    throw
  }
  Restore-UserRuntimeTrackedEdits $runtimeBackup
  $after = (Invoke-Git @("rev-parse", "--short", "HEAD") | Select-Object -First 1)

  if ($before -eq $after) {
    Write-Pass ("already up to date at {0}" -f $after)
  } else {
    Write-Pass ("updated {0} -> {1}" -f $before, $after)
    Invoke-Git @("--no-pager", "log", "--oneline", "$before..$after") -Echo | Out-Null
  }
}

Write-Host ""
Write-Host "pi-67 PowerShell updater" -ForegroundColor Cyan
Write-Host ("Repository : {0}" -f $RepoRoot)
Write-Host ("Agent dir  : {0}" -f $AgentDir)
Write-Host ("Skills dir : {0}" -f $SkillsDir)
Write-Host ("Remote     : {0}" -f $Remote)
if ($Branch) {
  Write-Host ("Branch     : {0}" -f $Branch)
}
if ($DryRun) {
  Write-Host "Dry run    : yes" -ForegroundColor Yellow
}
if ($CheckOnly) {
  Write-Host "Check only : yes" -ForegroundColor Yellow
}

try {
  if ($CheckOnly) {
    Show-CheckOnly
    exit 0
  }

  Update-Repo
  if ($NoConfigure) {
    Write-Warn "local config template sync skipped by -NoConfigure"
  } else {
    Sync-LocalConfigTemplates
    Repair-LocalConfigJsonEncoding
    Invoke-LocalConfigMigration
  }
  Sync-SharedSkills
  Sync-Npm
  Invoke-UntilDoneRuntimeQueuePatch
  Invoke-Smoke
  Invoke-Report

  Write-Host ""
  Write-Host "pi-67 PowerShell update finished" -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host ("pi-67 PowerShell update failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
  exit 1
}
