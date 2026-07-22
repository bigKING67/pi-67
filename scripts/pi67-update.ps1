#!/usr/bin/env pwsh
# Deprecated PowerShell compatibility updater for legacy Git source checkouts.
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
  [switch]$SkillDriftDetails,
  [switch]$NoAutoResolveKnownConflicts,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
pi67-update.ps1 updates only a legacy pi-67 Git source checkout.

Usage:
  .\scripts\pi67-update.ps1 [options]

Options:
  -RepoRoot DIR       pi-67 checkout to update. Defaults to this script's repo.
  -AgentDir DIR       Pi agent dir. Defaults to `$HOME\.pi\agent.
  -SkillsDir DIR      Shared skills dir. Defaults to `$HOME\.agents\skills.
  -Remote NAME        Git remote to pull from. Defaults to origin.
  -Branch NAME        Git branch to pull. Otherwise use the configured upstream,
                      a matching remote branch, or an equivalent remote default branch.
  -DryRun             Print planned actions without changing files.
  -CheckOnly          Inspect update status without pulling or writing files.
  -NoNpm              Skip npm dependency sync.
  -ForceNpm           Deprecated compatibility flag; never runs whole-lock npm ci.
  -NoConfigure        Skip workspace template sync and config normalization.
  -NoSmoke            Skip PowerShell smoke after update.
  -NoReport           Skip pi67-report.json generation.
  -NoDoctor           Do not embed PowerShell doctor output in the report.
  -AllowDirty         Let git attempt the update with local tracked edits.
  -StrictSharedSkills Stop when a preserved user-modified global shared skill
                      differs from the pi-67 bundled baseline. Default keeps
                      the existing global skill and continues.
  -SkillDriftDetails  Print per-Skill paths and hashes for preserved drift.
  -NoAutoResolveKnownConflicts
                       Do not auto-backup/restore dirty user runtime config
                       files when incoming changed paths overlap them.
  -Help               Show this help.

After migrating to 0.15.0 immutable releases, use:

  pi-67 self-update
  pi-67 update --check --json
  pi-67 update

This script never overwrites existing local config files such as models.json,
auth.json, mcp.json, or image-gen.json. Missing files are copied from examples.
If an existing local JSON file uses a Windows-unfriendly encoding such as
UTF-16, UTF-8 BOM, or leading NUL bytes, the updater backs it up and rewrites it
as UTF-8 without BOM before Pi starts.
Provider authentication, model selection, and their persistence remain owned by
upstream Pi and are not changed by this updater.
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
$Pi67GitPathInit = Initialize-Pi67GitPath

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
$NpmInstallArgs = @("ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline")
$UserPreservedTrackedUpdatePaths = @(
  "settings.json",
  "models.json",
  "auth.json",
  "mcp.json",
  "image-gen.json",
  "settings.json.theme"
)
$PreservedSkillDrifts = [System.Collections.Generic.List[string]]::new()
$UpdateStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$UpdateTimings = [ordered]@{
  gitMs = 0
  configMs = 0
  skillsMs = 0
  npmMs = 0
  verifyMs = 0
}

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

function Get-RemoteBranchCommit {
  param([string]$Name)
  try {
    $line = Invoke-Git @("ls-remote", $Remote, "refs/heads/$Name") | Select-Object -First 1
    if ($line) {
      return ($line -split "\s+")[0]
    }
  } catch {
    return ""
  }
  return ""
}

function Get-RemoteDefaultBranch {
  try {
    foreach ($line in @(Invoke-Git @("ls-remote", "--symref", $Remote, "HEAD"))) {
      if ($line -match '^ref:\s+refs/heads/(\S+)\s+HEAD$') {
        return $Matches[1]
      }
    }
  } catch {
    return ""
  }
  return ""
}

function Get-TargetBranchInfo {
  $current = (Invoke-Git @("rev-parse", "--abbrev-ref", "HEAD") | Select-Object -First 1)
  if ($current -eq "HEAD" -and -not $Branch) {
    Write-Fail "detached HEAD; pass -Branch explicitly"
  }
  if ($Branch) {
    return [pscustomobject]@{ Name = $Branch; Source = "explicit -Branch"; Current = $current }
  }

  try {
    $upstream = (Invoke-Git @("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") | Select-Object -First 1)
    $prefix = "$Remote/"
    if ($upstream -and $upstream.StartsWith($prefix)) {
      $candidate = $upstream.Substring($prefix.Length)
      if (Get-RemoteBranchCommit $candidate) {
        return [pscustomobject]@{ Name = $candidate; Source = "upstream $upstream"; Current = $current }
      }
    }
  } catch {
    # Continue with deterministic remote discovery.
  }

  if (Get-RemoteBranchCommit $current) {
    return [pscustomobject]@{ Name = $current; Source = "matching remote branch $Remote/$current"; Current = $current }
  }

  $defaultBranch = Get-RemoteDefaultBranch
  $localFull = (Invoke-Git @("rev-parse", "HEAD") | Select-Object -First 1)
  $defaultFull = if ($defaultBranch) { Get-RemoteBranchCommit $defaultBranch } else { "" }
  if ($defaultFull -and $localFull -eq $defaultFull) {
    return [pscustomobject]@{
      Name = $defaultBranch
      Source = "remote default equivalence at $localFull"
      Current = $current
    }
  }

  $hint = if ($defaultBranch) { $defaultBranch } else { "the remote default branch" }
  Write-Fail ("current branch '{0}' has no usable {1} branch; switch to {2} or rerun with -Branch NAME" -f $current, $Remote, $hint)
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

function Sync-LocalConfigTemplates {
  Write-Section "local config templates"
  Copy-FileIfMissing (Join-Path $RepoRoot "settings.example.json") (Join-Path $AgentDir "settings.json") "settings.json"
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

function Invoke-WorkspaceConfigNormalization {
  if ($NoConfigure) {
    Write-Warn "workspace config normalization skipped by -NoConfigure"
    return
  }

  Write-Section "deterministic workspace normalization"
  Invoke-McpConfigNormalization
}

function Invoke-McpConfigNormalization {
  $tool = Join-Path (Join-Path $RepoRoot "scripts") "pi67-mcp-config-utils.cjs"
  $mcpPath = Join-Path $AgentDir "mcp.json"

  if (-not (Test-Path -LiteralPath $mcpPath -PathType Leaf)) {
    Write-Warn "mcp.json missing; skipped MCP runtime path normalization"
    return
  }
  if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
    Write-Warn ("MCP config normalizer missing: {0}" -f $tool)
    return
  }
  if (-not (Test-CommandExists "node")) {
    Write-Warn "node not found; skipped MCP runtime path normalization"
    return
  }

  $args = @(
    $tool,
    "--normalize",
    "--file",
    $mcpPath,
    "--agent-dir",
    $AgentDir,
    "--json"
  )
  if ($DryRun) {
    $args += "--dry-run"
  }

  try {
    if ($DryRun) {
      Invoke-PlannedExternal "node" $args | Out-Null
      return
    }
    $output = Invoke-External "node" $args
    $result = ($output -join "`n") | ConvertFrom-Json
    if ($result.changed) {
      foreach ($change in @($result.changes)) {
        Write-Pass ("normalized MCP runtime path: {0}" -f $change)
      }
    } else {
      Write-Pass "mcp.json runtime paths unchanged"
    }
    foreach ($issue in @($result.issues)) {
      Write-Warn ("MCP {0}.{1} still uses unsupported runtime placeholder: {2}" -f $issue.server, $issue.field, $issue.value)
    }
  } catch {
    Write-Warn ("MCP runtime path normalization failed: {0}" -f $_.Exception.Message)
  }
}

function Invoke-SettingsRuntimeStateMigration {
  param([string]$Phase = "")

  if ($Phase) {
    Write-Section ("settings runtime state ({0})" -f $Phase)
  } else {
    Write-Section "settings runtime state"
  }
  $tool = Join-Path (Join-Path (Join-Path $RepoRoot "packages") "pi67-cli") "src/tools/settings-runtime-state-filter.mjs"
  $stateDir = Join-Path (Join-Path $HomePath ".pi") "pi67"
  if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
    Write-Warn ("settings runtime state tool missing: {0}" -f $tool)
    return
  }
  if (-not (Test-CommandExists "node")) {
    Write-Warn "node not found; skipped settings runtime state migration"
    return
  }
  $args = @(
    $tool,
    "--migrate",
    "--agent-dir",
    $AgentDir,
    "--repo-root",
    $RepoRoot,
    "--state-dir",
    $stateDir,
    "--normalize",
    "--install-git-filter"
  )
  if ($DryRun) {
    Write-Host ("  DRY-RUN node {0}" -f ($args -join " ")) -ForegroundColor Cyan
    return
  }
  Invoke-PlannedExternal "node" $args | Out-Null
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
        Write-Fail ("preserved user-modified shared skill differs from pi-67 baseline: {0} (existing={1} dirHash={2} source={3} dirHash={4}). Strict mode enabled; resolve manually or choose a different -SkillsDir." -f $skill.Name, $target, $targetHash, $skill.FullName, $sourceHash)
      }
      $PreservedSkillDrifts.Add($skill.Name)
      if ($SkillDriftDetails) {
        Write-Warn ("preserved user-modified shared skill; keeping existing global skill: {0}" -f $skill.Name)
        Write-Warn ("existing={0} dirHash={1}" -f $target, $targetHash)
        Write-Warn ("source skipped={0} dirHash={1}" -f $skill.FullName, $sourceHash)
      }
      continue
    }

    if ($DryRun) {
      Write-Host ("  DRY-RUN copy {0} -> {1}" -f $skill.FullName, $target) -ForegroundColor Cyan
    } else {
      Copy-Item -LiteralPath $skill.FullName -Destination $target -Recurse
    }
    Write-Pass ("synced shared skill: {0}" -f $skill.Name)
  }
  if ($PreservedSkillDrifts.Count -gt 0) {
    Write-Warn ("preserved {0} user-modified global Skills: {1}" -f $PreservedSkillDrifts.Count, ($PreservedSkillDrifts -join ", "))
    Write-Warn "details: pi-67 skills inventory --json (or rerun with -SkillDriftDetails)"
  }
}

function Sync-Npm {
  if ($NoNpm) {
    Write-Warn "npm sync skipped by -NoNpm"
    return
  }

  Write-Warn "legacy whole-lock npm sync is disabled to prevent extension downgrades"
  Write-Warn "run pi-67 update so missing/safely-behind extensions are updated individually"
}

function Invoke-UntilDoneRuntimeQueuePatch {
  Write-Warn "legacy bulk updater does not patch extensions; pi-67 manager applies version/hash-gated patches"
}

function Invoke-SmartFetchCharsetPatch {
  Write-Warn "legacy bulk updater does not patch extensions; pi-67 manager applies version/hash-gated patches"
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

function Test-SmartFetchCharsetStatus {
  if (-not (Test-CommandExists "node")) {
    Write-Warn "node not found; skipped pi-smart-fetch charset compatibility check"
    return
  }
  $patcher = Join-Path (Join-Path $RepoRoot "scripts") "pi67-patch-pi-smart-fetch-charset.mjs"
  if (-not (Test-Path -LiteralPath $patcher -PathType Leaf)) {
    Write-Warn "pi-smart-fetch charset patcher missing"
    return
  }
  & node $patcher --check --agent-dir $AgentDir | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Pass "pi-smart-fetch charset compatibility is already patched or package is not installed"
  } elseif ($LASTEXITCODE -eq 3) {
    Write-Warn "pi-smart-fetch charset compatibility requires review; run the charset checker for details"
  } else {
    Write-Warn "pi-smart-fetch charset compatibility would be patched after npm sync"
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

function Test-StringArrayContainsAll {
  param([string[]]$Container, [string[]]$Required)

  $seen = @{}
  foreach ($item in @($Container)) {
    if ($item) {
      $seen[[string]$item] = $true
    }
  }
  foreach ($item in @($Required)) {
    if (-not $seen.ContainsKey([string]$item)) {
      return $false
    }
  }
  return $true
}

function Test-StringArrayOverlaps {
  param([string[]]$Left, [string[]]$Right)

  $seen = @{}
  foreach ($item in @($Right)) {
    if ($item) {
      $seen[[string]$item] = $true
    }
  }
  foreach ($item in @($Left)) {
    if ($seen.ContainsKey([string]$item)) {
      return $true
    }
  }
  return $false
}

function Get-DirtyPathsFromTrackedStatus {
  param([string[]]$TrackedStatus)

  $dirtyPaths = @()
  foreach ($line in @($TrackedStatus)) {
    $path = Get-StatusPath $line
    if ($path) {
      $dirtyPaths += $path
    }
  }
  return @($dirtyPaths)
}

function Write-RuntimeDirtyNoBackupNeeded {
  param([string[]]$DirtyPaths)

  Write-Warn "tracked edits are limited to user-owned runtime config files"
  Write-Warn "incoming git update does not touch them; leaving them in place without creating a runtime backup"
  Write-Host ("  preserved: {0}" -f ($DirtyPaths -join " "))
}

function Get-BackupManifestPath {
  param([string]$BackupDir)

  foreach ($name in @("manifest.json", "backup-manifest.json")) {
    $candidate = Join-Path $BackupDir $name
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return $candidate
    }
  }
  return ""
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
    $manifestPath = Get-BackupManifestPath $dir.FullName
    if (-not $manifestPath) {
      continue
    }
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    } catch {
      continue
    }
    $paths = @()
    if ($manifest.PSObject.Properties.Name -contains "paths") {
      $paths = @($manifest.paths | ForEach-Object { [string]$_ })
    } elseif ($manifest.PSObject.Properties.Name -contains "files") {
      $paths = @($manifest.files | ForEach-Object { [string]$_.path })
    }
    if (-not (Test-StringArrayContainsAll $paths $DirtyPaths)) {
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

  $dirtyPaths = @(Get-DirtyPathsFromTrackedStatus -TrackedStatus $TrackedStatus)

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

  $target = Get-TargetBranchInfo
  $targetBranch = $target.Name
  $localShort = (Invoke-Git @("rev-parse", "--short", "HEAD") | Select-Object -First 1)
  $trackedStatus = Get-GitStatusLines
  $allStatus = Get-GitStatusLines -IncludeUntracked

  Write-Info ("Local branch : {0}" -f $target.Current)
  Write-Info ("Target branch: {0}" -f $targetBranch)
  Write-Info ("Target source: {0}" -f $target.Source)
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
    Write-Warn "workspace template/config normalization would be skipped"
  } else {
    Write-Pass "workspace templates, JSON encoding, and MCP runtime paths would be checked without changing upstream Pi provider/model state"
  }
  Write-Pass "settings.json lastChangelogVersion would be migrated into ignored state and normalized"

  if ($NoNpm) {
    Write-Warn "npm sync would be skipped"
  } else {
    Write-Pass "whole-lock npm sync is disabled; pi-67 manager evaluates each default extension independently"
  }
  Test-UntilDoneRuntimeQueueStatus
  Test-SmartFetchCharsetStatus

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

  $target = Get-TargetBranchInfo
  $targetBranch = $target.Name
  Write-Info ("Target branch: {0}/{1} ({2})" -f $Remote, $targetBranch, $target.Source)
  $trackedStatus = Get-GitStatusLines
  $runtimeBackup = $null
  $dirtyPaths = @(Get-DirtyPathsFromTrackedStatus -TrackedStatus $trackedStatus)
  $unknownDirtyPaths = @($dirtyPaths | Where-Object { $UserPreservedTrackedUpdatePaths -notcontains $_ })

  if ($trackedStatus.Count -gt 0 -and -not $AllowDirty -and ($NoAutoResolveKnownConflicts -or $unknownDirtyPaths.Count -gt 0)) {
    foreach ($line in $trackedStatus) {
      Write-Host $line
    }
    if ($NoAutoResolveKnownConflicts) {
      Write-Fail "repo has tracked local changes and auto-preserve is disabled; commit/stash them or rerun with -AllowDirty"
    }
    Write-Fail "repo has non-runtime tracked local changes; commit/stash them or rerun with -AllowDirty"
  } elseif ($trackedStatus.Count -gt 0 -and $AllowDirty) {
    Write-Warn "repo has tracked local changes; proceeding because -AllowDirty was provided"
  }

  $before = (Invoke-Git @("rev-parse", "--short", "HEAD") | Select-Object -First 1)
  if ($DryRun) {
    if ($trackedStatus.Count -gt 0 -and -not $AllowDirty) {
      Write-Host "  DRY-RUN inspect incoming changed paths before deciding whether runtime backup is needed" -ForegroundColor Cyan
    }
    Write-Host ("  DRY-RUN git -C {0} fetch --prune {1} {2}" -f $RepoRoot, $Remote, $targetBranch) -ForegroundColor Cyan
    Write-Host ("  DRY-RUN git -C {0} merge --ff-only FETCH_HEAD" -f $RepoRoot) -ForegroundColor Cyan
    Write-Pass ("current revision: {0}" -f $before)
    return
  }

  Invoke-Git @("fetch", "--prune", $Remote, $targetBranch) -Echo | Out-Null
  $mergeTarget = "FETCH_HEAD"
  try {
    Invoke-Git @("merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD") | Out-Null
  } catch {
    try {
      Invoke-Git @("merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD") | Out-Null
      Write-Warn ("local checkout is ahead of {0}/{1}; no incoming fast-forward changes to merge" -f $Remote, $targetBranch)
      $mergeTarget = ""
    } catch {
      Write-Fail ("remote update is not a fast-forward; inspect {0}/{1} before updating" -f $Remote, $targetBranch)
    }
  }
  $incomingChangedPaths = if ($mergeTarget) {
    @(Invoke-Git @("diff", "--name-only", "HEAD", $mergeTarget, "--") | Where-Object { $_ })
  } else {
    @()
  }

  if ($trackedStatus.Count -gt 0 -and -not $AllowDirty) {
    if (Test-StringArrayOverlaps -Left $dirtyPaths -Right $incomingChangedPaths) {
      $runtimeBackup = Backup-And-ClearUserRuntimeTrackedEdits $trackedStatus
      if (-not $runtimeBackup) {
        foreach ($line in $trackedStatus) {
          Write-Host $line
        }
        Write-Fail "repo has non-runtime tracked local changes; commit/stash them or rerun with -AllowDirty"
      }
    } else {
      Write-RuntimeDirtyNoBackupNeeded $dirtyPaths
    }
  }

  try {
    if ($mergeTarget) {
      Invoke-Git @("merge", "--ff-only", $mergeTarget) -Echo | Out-Null
    }
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

  $phase = [System.Diagnostics.Stopwatch]::StartNew()
  Update-Repo
  $phase.Stop()
  $UpdateTimings.gitMs = $phase.ElapsedMilliseconds

  $phase.Restart()
  if ($NoConfigure) {
    Write-Warn "local config template sync skipped by -NoConfigure"
  } else {
    Sync-LocalConfigTemplates
    Repair-LocalConfigJsonEncoding
    Invoke-WorkspaceConfigNormalization
  }
  Invoke-SettingsRuntimeStateMigration "preflight"
  $phase.Stop()
  $UpdateTimings.configMs = $phase.ElapsedMilliseconds

  $phase.Restart()
  Sync-SharedSkills
  $phase.Stop()
  $UpdateTimings.skillsMs = $phase.ElapsedMilliseconds

  $phase.Restart()
  Sync-Npm
  Invoke-UntilDoneRuntimeQueuePatch
  Invoke-SmartFetchCharsetPatch
  $phase.Stop()
  $UpdateTimings.npmMs = $phase.ElapsedMilliseconds

  $phase.Restart()
  Invoke-Smoke
  Invoke-Report
  Invoke-SettingsRuntimeStateMigration "final"
  $phase.Stop()
  $UpdateTimings.verifyMs = $phase.ElapsedMilliseconds
  $UpdateStopwatch.Stop()

  Write-Section "update timings"
  Write-Info ("git={0}ms config={1}ms skills={2}ms npm={3}ms verify={4}ms total={5}ms" -f `
    $UpdateTimings.gitMs,
    $UpdateTimings.configMs,
    $UpdateTimings.skillsMs,
    $UpdateTimings.npmMs,
    $UpdateTimings.verifyMs,
    $UpdateStopwatch.ElapsedMilliseconds)

  Write-Host ""
  Write-Host "pi-67 PowerShell update finished" -ForegroundColor Green
} catch {
  Write-Host ""
  Write-Host ("pi-67 PowerShell update failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
  exit 1
}
