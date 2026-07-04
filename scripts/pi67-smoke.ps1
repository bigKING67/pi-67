#!/usr/bin/env pwsh
# PowerShell-native repository smoke for Windows users.
# This intentionally avoids Bash and only uses cross-platform tools such as
# PowerShell, Node.js, and Git.

[CmdletBinding()]
param(
  [switch]$Ci,
  [switch]$Json,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
pi67-smoke.ps1 validates this repository from PowerShell without touching the
real Pi config.

Usage:
  .\scripts\pi67-smoke.ps1 [options]

Options:
  -Ci      CI-friendly mode label.
  -Json    Print a machine-readable summary instead of human output.
  -Help    Show this help.
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
$ScriptDir = Split-Path -Parent $ScriptPath
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path

$script:PassCount = 0
$script:WarnCount = 0
$script:FailCount = 0
$script:Checks = @()

function Add-Check {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("PASS", "WARN", "FAIL")][string]$Level,
    [Parameter(Mandatory = $true)][string]$Message,
    [string]$Details = ""
  )

  switch ($Level) {
    "PASS" { $script:PassCount += 1 }
    "WARN" { $script:WarnCount += 1 }
    "FAIL" { $script:FailCount += 1 }
  }

  $script:Checks += [ordered]@{
    level = $Level
    message = $Message
    details = $Details
  }

  if (-not $Json) {
    $color = switch ($Level) {
      "PASS" { "Green" }
      "WARN" { "Yellow" }
      "FAIL" { "Red" }
    }
    $line = "  {0} {1}" -f $Level, $Message
    if ($Details) {
      $line = "{0}: {1}" -f $line, $Details
    }
    Write-Host $line -ForegroundColor $color
  }
}

function Pass {
  param([string]$Message)
  Add-Check -Level "PASS" -Message $Message
}

function Warn {
  param([string]$Message, [string]$Details = "")
  Add-Check -Level "WARN" -Message $Message -Details $Details
}

function Fail {
  param([string]$Message, [string]$Details = "")
  Add-Check -Level "FAIL" -Message $Message -Details $Details
}

function Section {
  param([string]$Name)
  if (-not $Json) {
    Write-Host ""
    Write-Host ("--- {0} ---" -f $Name) -ForegroundColor Cyan
  }
}

function RepoPath {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Parts)
  $path = $RepoRoot
  foreach ($part in $Parts) {
    $path = Join-Path $path $part
  }
  return $path
}

function Test-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  $output = & $FilePath @Arguments 2>&1
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  if ($exitCode -ne 0) {
    $excerpt = ($output | Select-Object -First 20) -join "`n"
    throw ("command failed with exit {0}: {1} {2}`n{3}" -f $exitCode, $FilePath, ($Arguments -join " "), $excerpt)
  }
  return $output
}

function Run-Check {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [Parameter(Mandatory = $true)][scriptblock]$Body
  )

  try {
    & $Body
    Pass $Message
  } catch {
    Fail $Message $_.Exception.Message
  }
}

function Read-JsonFile {
  param([string]$Path)
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Assert-FileExists {
  param([string]$RelativePath)
  $path = RepoPath $RelativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "missing file: $RelativePath"
  }
}

function Assert-ContentContains {
  param([string]$Path, [string]$Needle)
  $content = Get-Content -LiteralPath $Path -Raw
  if (-not $content.Contains($Needle)) {
    throw "expected content not found: $Needle"
  }
}

function Assert-ContentNotContains {
  param([string]$Path, [string]$Needle)
  $content = Get-Content -LiteralPath $Path -Raw
  if ($content.Contains($Needle)) {
    throw "unexpected content found: $Needle"
  }
}

if (-not $Json) {
  Write-Host ""
  Write-Host "pi-67 PowerShell smoke" -ForegroundColor Cyan
  Write-Host ("Repository: {0}" -f $RepoRoot)
  if ($Ci) {
    Write-Host "Mode      : CI"
  }
}

$NodeAvailable = Test-CommandExists "node"
$GitAvailable = Test-CommandExists "git"

Section "Required tools"
if ($NodeAvailable) {
  try {
    $nodeVersion = (Invoke-External "node" @("-v") | Select-Object -First 1)
    Pass "node found: $nodeVersion"
  } catch {
    Fail "node found but failed to run" $_.Exception.Message
  }
} else {
  Fail "node is required"
}

if ($GitAvailable) {
  Pass "git found"
} else {
  Warn "git not found; skipped Git-only checks"
}

Section "Release metadata"
$Version = ""
Run-Check "VERSION is semver-like" {
  $versionPath = RepoPath "VERSION"
  Assert-FileExists "VERSION"
  $script:Version = (Get-Content -LiteralPath $versionPath -Raw).Trim()
  if ($script:Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') {
    throw "invalid VERSION: $script:Version"
  }
}

Run-Check "package.json version matches VERSION" {
  $package = Read-JsonFile (RepoPath "package.json")
  if (-not $package.version) {
    throw "package.json missing version"
  }
  if ($package.version -ne $script:Version) {
    throw ("package.json version {0} does not match VERSION {1}" -f $package.version, $script:Version)
  }
}

Run-Check "CHANGELOG has current version entry" {
  $changelog = Get-Content -LiteralPath (RepoPath "CHANGELOG.md") -Raw
  if (-not $changelog.Contains("## [$script:Version]")) {
    throw "CHANGELOG.md missing entry for $script:Version"
  }
}

Section "Required files"
$RequiredFiles = @(
  "AGENTS.md",
  "settings.json",
  "models.example.json",
  "mcp.example.json",
  "auth.example.json",
  "image-gen.example.json",
  "README.md",
  "docs/full-install.md",
  "docs/release.md",
  "docs/troubleshooting.md",
  "docs/xtalpi-pi-tools.md",
  "scripts/pi67-doctor.ps1",
  "scripts/pi67-report.ps1",
  "scripts/pi67-smoke.ps1",
  "scripts/pi67-update.ps1",
  "scripts/pi67-release-check.sh",
  "scripts/pi67-xtalpi-pi-tools-smoke.ps1",
  "scripts/pi67-xtalpi-smoke-status-core.cjs",
  "scripts/pi67-xtalpi-provider-health.mjs",
  "scripts/pi67-validate-xtalpi-provider-error-contract.mjs",
  "extensions/xtalpi-pi-tools/runtime-config.ts",
  "extensions/xtalpi-pi-tools/fixtures/replay-cases.json",
  "extensions/xtalpi-pi-tools/provider-error-contract.json"
)

Run-Check "required release files exist" {
  foreach ($file in $RequiredFiles) {
    Assert-FileExists $file
  }
}

Section "JSON"
$JsonFiles = @(
  "settings.json",
  "auth.example.json",
  "image-gen.example.json",
  "models.example.json",
  "mcp.example.json",
  "package.json",
  "extensions/xtalpi-pi-tools/fixtures/replay-cases.json",
  "extensions/xtalpi-pi-tools/provider-error-contract.json"
)

foreach ($file in $JsonFiles) {
  Run-Check ("valid JSON: {0}" -f $file) {
    $null = Read-JsonFile (RepoPath $file)
  }
}

Section "Node helpers"
if ($NodeAvailable) {
  $NodeCheckFiles = @(
    "scripts/pi67-xtalpi-smoke-status-core.cjs",
    "scripts/pi67-xtalpi-smoke-artifact-core.cjs",
    "scripts/pi67-xtalpi-provider-health.mjs",
    "scripts/pi67-validate-xtalpi-provider-error-contract.mjs"
  )
  foreach ($file in $NodeCheckFiles) {
    Run-Check ("node --check: {0}" -f $file) {
      Invoke-External "node" @("--check", (RepoPath $file)) | Out-Null
    }
  }

  Run-Check "xtalpi provider health classifier self-test passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-xtalpi-provider-health.mjs"), "--self-test") | Out-Null
  }

  Run-Check "xtalpi provider error contract validator self-test passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-validate-xtalpi-provider-error-contract.mjs"), (RepoPath "extensions/xtalpi-pi-tools/provider-error-contract.json"), "--self-test") | Out-Null
  }

  Run-Check "xtalpi provider error contract validation passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-validate-xtalpi-provider-error-contract.mjs"), (RepoPath "extensions/xtalpi-pi-tools/provider-error-contract.json")) | Out-Null
  }
} else {
  Warn "skipped Node helper checks because node is missing"
}

Section "xtalpi endpoint contract"
Run-Check "xtalpi-pi-tools endpoint contract uses chat/completions" {
  $models = Read-JsonFile (RepoPath "models.example.json")
  $provider = $models.providers.'xtalpi-pi-tools'
  if (-not $provider) {
    throw "models.example.json missing providers.xtalpi-pi-tools"
  }
  if ($provider.api -ne "xtalpi-pi-tools") {
    throw "provider api must be xtalpi-pi-tools, got $($provider.api)"
  }
  if ($provider.baseUrl -ne "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1") {
    throw "baseUrl must be the OpenAI v1 root, got $($provider.baseUrl)"
  }

  $runtimeConfig = RepoPath "extensions/xtalpi-pi-tools/runtime-config.ts"
  $providerHealth = RepoPath "scripts/pi67-xtalpi-provider-health.mjs"
  Assert-ContentContains $runtimeConfig "/chat/completions"
  Assert-ContentContains $providerHealth "/chat/completions"
  Assert-ContentNotContains $runtimeConfig "/responses"
  Assert-ContentNotContains $providerHealth "/responses"
  Assert-ContentNotContains $runtimeConfig "/response/completions"
  Assert-ContentNotContains $providerHealth "/response/completions"
}

Section "PowerShell documentation"
Run-Check "PowerShell update/doctor/report/smoke entrypoints are documented" {
  Assert-ContentContains (RepoPath "README.md") "pi67-smoke.ps1"
  Assert-ContentContains (RepoPath "docs/full-install.md") "pi67-smoke.ps1"
  Assert-ContentContains (RepoPath "docs/release.md") "pi67-smoke.ps1"
  Assert-ContentContains (RepoPath "README.md") "pi67-update.ps1"
  Assert-ContentContains (RepoPath "docs/full-install.md") "pi67-update.ps1"
  Assert-ContentContains (RepoPath "docs/release.md") "pi67-update.ps1"
  Assert-ContentContains (RepoPath "README.md") "pi67-doctor.ps1"
  Assert-ContentContains (RepoPath "docs/full-install.md") "pi67-doctor.ps1"
  Assert-ContentContains (RepoPath "docs/release.md") "pi67-doctor.ps1"
  Assert-ContentContains (RepoPath "README.md") "pi67-report.ps1"
  Assert-ContentContains (RepoPath "docs/full-install.md") "pi67-report.ps1"
  Assert-ContentContains (RepoPath "docs/release.md") "pi67-report.ps1"
  Assert-ContentContains (RepoPath "README.md") "pi67-xtalpi-pi-tools-smoke.ps1"
  Assert-ContentContains (RepoPath "docs/full-install.md") "pi67-xtalpi-pi-tools-smoke.ps1"
  Assert-ContentContains (RepoPath "docs/release.md") "pi67-xtalpi-pi-tools-smoke.ps1"
  Assert-ContentContains (RepoPath "docs/xtalpi-pi-tools.md") "PowerShell"
}

Section "Portability"
if ($GitAvailable) {
  Run-Check "git diff --check passed" {
    Invoke-External "git" @("-C", $RepoRoot, "diff", "--check") | Out-Null
  }

  Run-Check "no personal machine paths in tracked content" {
    $personalPattern = ("/Use" + "rs/" + "gao" + "qian") + "|Documents/" + ("six" + "seven") + "|" + ("gao" + "qian")
    $output = & git -C $RepoRoot grep -n -E $personalPattern -- . 2>&1
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    if ($exitCode -eq 0) {
      throw (($output | Select-Object -First 20) -join "`n")
    }
    if ($exitCode -ne 1) {
      throw (($output | Select-Object -First 20) -join "`n")
    }
  }

  $TrackedFiles = @(
    "VERSION",
    "CHANGELOG.md",
    "README.md",
    "docs/full-install.md",
    "docs/release.md",
    "docs/troubleshooting.md",
    "docs/xtalpi-pi-tools.md",
    "scripts/pi67-doctor.ps1",
    "scripts/pi67-report.ps1",
    "scripts/pi67-smoke.ps1",
    "scripts/pi67-update.ps1",
    "scripts/pi67-release-check.sh",
    "scripts/pi67-xtalpi-pi-tools-smoke.ps1",
    ".github/workflows/ci.yml"
  )
  Run-Check "Windows smoke release files are tracked or staged" {
    Invoke-External "git" (@("-C", $RepoRoot, "ls-files", "--error-unmatch") + $TrackedFiles) | Out-Null
  }
} else {
  Warn "skipped portability Git checks because git is missing"
}

if (-not $Json) {
  Write-Host ""
  Write-Host "Summary" -ForegroundColor Cyan
  Write-Host ("  PASS: {0}" -f $script:PassCount)
  Write-Host ("  WARN: {0}" -f $script:WarnCount)
  Write-Host ("  FAIL: {0}" -f $script:FailCount)
}

$result = if ($script:FailCount -gt 0) {
  "FAIL"
} elseif ($script:WarnCount -gt 0) {
  "PASS_WITH_WARNINGS"
} else {
  "PASS"
}

if ($Json) {
  [ordered]@{
    schema = "pi67-smoke-powershell/v1"
    repository = $RepoRoot
    mode = if ($Ci) { "ci" } else { "local" }
    result = $result
    counts = [ordered]@{
      pass = $script:PassCount
      warn = $script:WarnCount
      fail = $script:FailCount
    }
    checks = $script:Checks
  } | ConvertTo-Json -Depth 8
} else {
  if ($result -eq "FAIL") {
    Write-Host "Result: FAIL" -ForegroundColor Red
  } elseif ($result -eq "PASS_WITH_WARNINGS") {
    Write-Host "Result: PASS WITH WARNINGS" -ForegroundColor Yellow
  } else {
    Write-Host "Result: PASS" -ForegroundColor Green
  }
}

if ($script:FailCount -gt 0) {
  exit 1
}
exit 0
