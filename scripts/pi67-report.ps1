#!/usr/bin/env pwsh
# PowerShell-native current-state report writer for Windows updates.
# The report is a single overwritten JSON file and does not include secrets.

[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$AgentDir,
  [string]$SkillsDir,
  [string]$Operation = "manual",
  [string]$Output,
  [switch]$NoDoctor,
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
pi67-report.ps1 writes the current pi-67 report from PowerShell.

Usage:
  .\scripts\pi67-report.ps1 [options]

Options:
  -RepoRoot DIR    pi-67 checkout. Defaults to this script's repo.
  -AgentDir DIR    Pi agent dir. Defaults to `$HOME\.pi\agent.
  -SkillsDir DIR   Shared skills dir. Defaults to `$HOME\.agents\skills.
  -Operation NAME  install, update, or manual. Defaults to manual.
  -Output FILE     Output path. Defaults to `$HOME\.pi\agent\pi67-report.json.
  -NoDoctor        Do not run PowerShell doctor; mark doctor as skipped.
  -DryRun          Print target path without writing.
  -Help            Show this help.
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

function Get-HomePath {
  if ($env:USERPROFILE) { return $env:USERPROFILE }
  if ($HOME) { return $HOME }
  return [Environment]::GetFolderPath("UserProfile")
}

function Resolve-ScriptPath {
  if ($PSCommandPath) { return $PSCommandPath }
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

if (-not $Output) {
  $Output = Join-Path $AgentDir "pi67-report.json"
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = $RepoRoot
  )

  $oldErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    Push-Location $WorkingDirectory
    try {
      $output = & $FilePath @Arguments 2>&1
      $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
    } finally {
      Pop-Location
    }
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }

  $lines = @($output | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
  })

  return [ordered]@{
    exitCode = $exitCode
    output = $lines
    text = ($lines -join "`n")
  }
}

function Read-Text {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $text = Get-Content -LiteralPath $Path -Raw
    if ($null -eq $text) { return "" }
    return ([string]$text).Trim()
  }
  return ""
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-JsonPropertyValue {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $prop = $Object.PSObject.Properties[$Name]
  if ($prop) { return $prop.Value }
  return $null
}

function Get-GitText {
  param([string[]]$Arguments)
  $result = Invoke-External "git" (@("-C", $RepoRoot) + $Arguments)
  if ($result.exitCode -eq 0) {
    $text = $result.text
    if ($null -eq $text) { return "" }
    return ([string]$text).Trim()
  }
  return ""
}

function Get-PowerShellVersionText {
  if ($PSVersionTable -and $PSVersionTable.PSVersion) {
    return $PSVersionTable.PSVersion.ToString()
  }
  return ""
}

function Get-OSArchitectureText {
  try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    if ($null -ne $arch) { return $arch.ToString() }
  } catch {
  }
  if ($env:PROCESSOR_ARCHITECTURE) { return $env:PROCESSOR_ARCHITECTURE }
  return ""
}

function Test-GitTracks {
  param([string]$Rel)
  $tracked = Get-GitText @("ls-files", "--", $Rel)
  return [bool]$tracked
}

function Test-GitIgnored {
  param([string]$Rel)
  $result = Invoke-External "git" @("-C", $RepoRoot, "check-ignore", "-q", $Rel)
  return $result.exitCode -eq 0
}

function Get-FileState {
  param([string]$Path, [string]$Rel)
  if (-not (Test-Path -LiteralPath $Path)) {
    return [ordered]@{
      exists = $false
      type = "missing"
      classification = "missing"
    }
  }

  $item = Get-Item -LiteralPath $Path -Force
  $type = if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    "symlink"
  } elseif ($item.PSIsContainer) {
    "directory"
  } else {
    "file"
  }

  $classification = "other"
  if ($type -eq "symlink") {
    $classification = "symlink"
  } elseif (Test-GitTracks $Rel) {
    $classification = if ($type -eq "directory") { "tracked_dir" } else { "tracked_file" }
  } elseif (Test-GitIgnored $Rel) {
    $classification = if (@("models.json", "mcp.json", "auth.json", "image-gen.json") -contains $Rel) { "local_file" } else { "ignored_runtime" }
  }

  return [ordered]@{
    exists = $true
    type = $type
    classification = $classification
  }
}

function Get-CommandVersion {
  param([string]$Command, [string[]]$Arguments = @("--version"))
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    return $null
  }
  $result = Invoke-External $Command $Arguments
  if ($result.exitCode -eq 0 -and $result.output.Count -gt 0) {
    return ($result.output | Select-Object -First 1)
  }
  return $null
}

function Detect-InstallMode {
  try {
    $repoReal = (Resolve-Path $RepoRoot).ProviderPath
    $agentReal = (Resolve-Path $AgentDir).ProviderPath
    if ($repoReal -eq $agentReal) { return "in-place" }
  } catch {
  }
  return "linked"
}

function Get-SharedSkillsSummary {
  $sourceRoot = Join-Path $RepoRoot "shared-skills"
  $sourceSkills = @()
  if (Test-Path -LiteralPath $sourceRoot -PathType Container) {
    $sourceSkills = @(Get-ChildItem -LiteralPath $sourceRoot -Directory | ForEach-Object { $_.Name } | Sort-Object)
  }
  $installedSkills = @()
  if (Test-Path -LiteralPath $SkillsDir -PathType Container) {
    $installedSkills = @(Get-ChildItem -LiteralPath $SkillsDir -Directory | ForEach-Object { $_.Name } | Sort-Object)
  }
  $missing = @($sourceSkills | Where-Object { $installedSkills -notcontains $_ })
  return [ordered]@{
    canonicalRoot = $SkillsDir
    sourceDir = $sourceRoot
    sourceCount = $sourceSkills.Count
    installedCount = $installedSkills.Count
    sourceSkills = $sourceSkills
    installedSkills = $installedSkills
    missingInstalled = $missing
    duplicateRoots = @()
    activeSkillPackageSources = @()
  }
}

function Get-SharedSkillPacksStatus {
  $helper = Join-Path $ScriptDir "pi67-shared-skill-packs-status.mjs"
  $registryPath = Join-Path $RepoRoot "shared-skill-packs.json"
  $lockPath = Join-Path $RepoRoot "shared-skill-packs.lock.json"
  if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    return [ordered]@{
      schemaId = "pi67-shared-skill-packs-status/v1"
      registry = [ordered]@{ path = $registryPath; exists = (Test-Path -LiteralPath $registryPath -PathType Leaf); valid = $false }
      lock = [ordered]@{ path = $lockPath; exists = (Test-Path -LiteralPath $lockPath -PathType Leaf); valid = $false }
      skillsDir = $SkillsDir
      summary = [ordered]@{ packs = 0; consistent = 0; attention = 1 }
      packs = @()
      errors = @("node is required to inspect shared Skill Packs")
    }
  }
  if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    return [ordered]@{
      schemaId = "pi67-shared-skill-packs-status/v1"
      registry = [ordered]@{ path = $registryPath; exists = (Test-Path -LiteralPath $registryPath -PathType Leaf); valid = $false }
      lock = [ordered]@{ path = $lockPath; exists = (Test-Path -LiteralPath $lockPath -PathType Leaf); valid = $false }
      skillsDir = $SkillsDir
      summary = [ordered]@{ packs = 0; consistent = 0; attention = 1 }
      packs = @()
      errors = @("shared Skill Pack status helper is missing")
    }
  }

  $result = Invoke-External "node" @(
    $helper,
    "--repo-root", $RepoRoot,
    "--skills-dir", $SkillsDir,
    "--json"
  )
  try {
    $status = $result.text | ConvertFrom-Json
    if ($status.schemaId -ne "pi67-shared-skill-packs-status/v1") {
      throw "unexpected schemaId: $($status.schemaId)"
    }
    return $status
  } catch {
    return [ordered]@{
      schemaId = "pi67-shared-skill-packs-status/v1"
      registry = [ordered]@{ path = $registryPath; exists = (Test-Path -LiteralPath $registryPath -PathType Leaf); valid = $false }
      lock = [ordered]@{ path = $lockPath; exists = (Test-Path -LiteralPath $lockPath -PathType Leaf); valid = $false }
      skillsDir = $SkillsDir
      summary = [ordered]@{ packs = 0; consistent = 0; attention = 1 }
      packs = @()
      errors = @($_.Exception.Message)
    }
  }
}

function Invoke-DoctorJson {
  if ($NoDoctor) {
    return [ordered]@{
      skipped = $true
      reason = "disabled by caller"
    }
  }

  $doctor = Join-Path $ScriptDir "pi67-doctor.ps1"
  if (-not (Test-Path -LiteralPath $doctor -PathType Leaf)) {
    return [ordered]@{
      skipped = $true
      reason = "pi67-doctor.ps1 missing"
    }
  }

  $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $doctor, "-Json", "-RepoRoot", $RepoRoot, "-AgentDir", $AgentDir, "-SkillsDir", $SkillsDir)
  $psExe = if (Get-Command "pwsh" -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }
  $result = Invoke-External $psExe $args
  $doctorText = $result.text
  try {
    $parsed = $doctorText | ConvertFrom-Json
    return [ordered]@{
      skipped = $false
      exitCode = $result.exitCode
      schemaVersion = $parsed.schemaVersion
      schemaId = $parsed.schemaId
      generatedBy = $parsed.generatedBy
      result = $parsed.result
      counts = $parsed.counts
      checks = $parsed.checks
    }
  } catch {
    return [ordered]@{
      skipped = $false
      exitCode = $result.exitCode
      parseError = $_.Exception.Message
    }
  }
}

if ($DryRun) {
  Write-Host ("DRY-RUN write report: {0}" -f $Output)
  exit 0
}

$package = Read-JsonFile (Join-Path $RepoRoot "package.json")
$version = Read-Text (Join-Path $RepoRoot "VERSION")
$packageVersion = if ($package) { $package.version } else { $null }
$installMode = Detect-InstallMode
$dirtyText = Get-GitText @("status", "--porcelain=v1", "--untracked-files=all")
$remote = Get-GitText @("remote", "get-url", "origin")

$report = [ordered]@{
  schemaVersion = 2
  schemaId = "pi67-report/v2"
  generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  generatedBy = "scripts/pi67-report.ps1"
  operation = $Operation
  pi67Version = $version
  packageVersion = $packageVersion
  pi67 = [ordered]@{
    version = $version
    packageVersion = $packageVersion
  }
  reportPolicy = [ordered]@{
    currentFileOverwritten = $true
    historicalReports = $false
    retention = "single-current-file"
  }
  diagnostics = [ordered]@{
    doctorTimeoutMs = 0
    doctorDeepMcp = $false
    mcpTimeoutMs = 0
    powershell = Get-PowerShellVersionText
  }
  installMode = $installMode
  repository = [ordered]@{
    root = $RepoRoot
    branch = Get-GitText @("rev-parse", "--abbrev-ref", "HEAD")
    commit = Get-GitText @("rev-parse", "HEAD")
    shortCommit = Get-GitText @("rev-parse", "--short", "HEAD")
    dirty = [bool]$dirtyText
    remote = $remote
  }
  sharedSkillsRoot = $SkillsDir
  sharedSkills = Get-SharedSkillsSummary
  sharedSkillPacks = Get-SharedSkillPacksStatus
  externalPackages = @()
  agent = [ordered]@{
    dir = $AgentDir
    installMode = $installMode
    reportPath = $Output
    files = [ordered]@{
      settings = Get-FileState (Join-Path $AgentDir "settings.json") "settings.json"
      agents = Get-FileState (Join-Path $AgentDir "AGENTS.md") "AGENTS.md"
      rules = Get-FileState (Join-Path $AgentDir "rules") "rules"
      prompts = Get-FileState (Join-Path $AgentDir "prompts") "prompts"
      sharedSkillsSource = Get-FileState (Join-Path $AgentDir "shared-skills") "shared-skills"
      legacyAgentSkills = Get-FileState (Join-Path $AgentDir "skills") "skills"
      scripts = Get-FileState (Join-Path $AgentDir "scripts") "scripts"
      models = Get-FileState (Join-Path $AgentDir "models.json") "models.json"
      mcp = Get-FileState (Join-Path $AgentDir "mcp.json") "mcp.json"
      auth = Get-FileState (Join-Path $AgentDir "auth.json") "auth.json"
      imageGen = Get-FileState (Join-Path $AgentDir "image-gen.json") "image-gen.json"
    }
  }
  runtime = [ordered]@{
    platform = [System.Environment]::OSVersion.Platform.ToString()
    arch = Get-OSArchitectureText
    hostname = [System.Net.Dns]::GetHostName()
    node = Get-CommandVersion "node" @("-v")
    npm = Get-CommandVersion "npm" @("-v")
    pi = Get-CommandVersion "pi" @("--version")
  }
  doctor = Invoke-DoctorJson
}

$outputDir = Split-Path -Parent $Output
if ($outputDir) {
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}
$tmp = "{0}.tmp-{1}" -f $Output, ([Guid]::NewGuid().ToString("N"))
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $tmp -Encoding UTF8
Move-Item -LiteralPath $tmp -Destination $Output -Force

try {
  $acl = Get-Acl -LiteralPath $Output
  if ($null -ne $acl) {
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "Allow")
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Output -AclObject $acl
  }
} catch {
}

Write-Host ("PASS report written: {0}" -f $Output) -ForegroundColor Green
if ($report.doctor -and $report.doctor.skipped -ne $true) {
  Write-Host ("INFO doctor: {0}" -f $report.doctor.result)
}
