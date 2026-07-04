#!/usr/bin/env pwsh
# PowerShell-native updater for Windows users.
# It preserves local runtime config files and only auto-resolves a narrow set of
# known tracked migration conflicts after writing a backup.

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
  [switch]$AllowDirty,
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
  -AllowDirty         Let git attempt the update with local tracked edits.
  -NoAutoResolveKnownConflicts
                       Do not auto-backup/restore known migration conflicts.
  -Help               Show this help.

Normal Windows update:

  Set-Location `$env:USERPROFILE\.pi\agent
  .\scripts\pi67-update.ps1

This script never overwrites existing local config files such as models.json,
auth.json, mcp.json, or image-gen.json. Missing files are copied from examples.
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
$KnownMigrationConflictPaths = @(
  "settings.json",
  "extensions/xtalpi-compat/index.ts"
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
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
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
  $Data | ConvertTo-Json -Depth 80 | Set-Content -LiteralPath $Path -Encoding UTF8
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
    if (Test-Path -LiteralPath $target) {
      Write-Pass ("shared skill exists; kept: {0}" -f $skill.Name)
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
    Write-Host ("  DRY-RUN npm install --ignore-scripts in {0}" -f $NpmDir) -ForegroundColor Cyan
    return
  }

  New-Item -ItemType Directory -Force -Path $NpmDir | Out-Null
  Copy-Item -LiteralPath $repoPackage -Destination $agentPackage -Force
  Invoke-PlannedExternal "npm" @("install", "--ignore-scripts") -WorkingDirectory $NpmDir | Out-Null
  Write-Pass ("npm packages synced in {0}" -f $NpmDir)
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

function Backup-And-RestoreKnownMigrationConflicts {
  param([string[]]$TrackedStatus)

  $dirtyPaths = @()
  foreach ($line in $TrackedStatus) {
    $path = Get-StatusPath $line
    if ($path) {
      $dirtyPaths += $path
    }
  }

  if ($dirtyPaths.Count -eq 0) {
    return $false
  }

  $unknown = @($dirtyPaths | Where-Object { $KnownMigrationConflictPaths -notcontains $_ })
  if ($unknown.Count -gt 0) {
    return $false
  }

  if ($NoAutoResolveKnownConflicts) {
    return $false
  }

  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupDir = Join-Path (Join-Path (Join-Path $HomePath ".pi") "agent-backups") ("pre-update-{0}" -f $stamp)

  Write-Warn "tracked changes are limited to known pi-67 migration conflict files"
  Write-Warn ("backing them up before restore: {0}" -f $backupDir)

  if ($DryRun) {
    Write-Host ("  DRY-RUN backup known conflict files to {0}" -f $backupDir) -ForegroundColor Cyan
    Write-Host ("  DRY-RUN git restore -- {0}" -f ($KnownMigrationConflictPaths -join " ")) -ForegroundColor Cyan
    return $true
  }

  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Invoke-Git (@("diff", "--") + $KnownMigrationConflictPaths) | Set-Content -LiteralPath (Join-Path $backupDir "local.diff") -Encoding UTF8

  foreach ($rel in $KnownMigrationConflictPaths) {
    $source = Join-Path $RepoRoot ($rel -replace "/", [IO.Path]::DirectorySeparatorChar)
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      $safeName = $rel -replace "[\\/]", "__"
      Copy-Item -LiteralPath $source -Destination (Join-Path $backupDir $safeName)
    }
  }

  Invoke-Git (@("restore", "--") + $KnownMigrationConflictPaths) | Out-Null
  Write-Pass "known migration conflicts restored from HEAD after backup"
  return $true
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
    $unknown = @($dirtyPaths | Where-Object { $KnownMigrationConflictPaths -notcontains $_ })
    if ($unknown.Count -eq 0 -and -not $NoAutoResolveKnownConflicts) {
      Write-Pass "tracked edits are auto-resolvable known migration conflicts"
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
    Write-Pass "local config templates and xtalpi migration would be checked"
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

  if ($trackedStatus.Count -gt 0 -and -not $AllowDirty) {
    $resolved = Backup-And-RestoreKnownMigrationConflicts $trackedStatus
    if (-not $resolved) {
      foreach ($line in $trackedStatus) {
        Write-Host $line
      }
      Write-Fail "repo has tracked local changes; commit/stash them, rerun with -AllowDirty, or keep auto-resolve enabled for known migration conflicts"
    }
  } elseif ($trackedStatus.Count -gt 0) {
    Write-Warn "repo has tracked local changes; proceeding because -AllowDirty was provided"
  }

  $before = (Invoke-Git @("rev-parse", "--short", "HEAD") | Select-Object -First 1)
  if ($DryRun) {
    Write-Host ("  DRY-RUN git -C {0} pull --ff-only {1} {2}" -f $RepoRoot, $Remote, $targetBranch) -ForegroundColor Cyan
    Write-Pass ("current revision: {0}" -f $before)
    return
  }

  Invoke-Git @("pull", "--ff-only", $Remote, $targetBranch) -Echo | Out-Null
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
    Invoke-LocalConfigMigration
  }
  Sync-SharedSkills
  Sync-Npm
  Invoke-Smoke

  Write-Host ""
  Write-Host "pi-67 PowerShell update finished" -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host ("pi-67 PowerShell update failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
  exit 1
}
