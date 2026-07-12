#!/usr/bin/env pwsh

[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$PiBin = "pi",
  [switch]$Json,
  [switch]$SelfTest,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
pi67-zero-key-startup-smoke.ps1 verifies two separate upstream Pi contracts:

1. xtalpi-pi-tools registers its models when a non-secret fixture credential is present.
2. Pi reaches session_start with no provider credential configured.

Usage:
  .\scripts\pi67-zero-key-startup-smoke.ps1 [options]

Options:
  -RepoRoot DIR  pi-67 checkout. Defaults to this script's repo.
  -PiBin PATH    Upstream Pi command. Defaults to pi.
  -Json          Print a machine-readable result.
  -SelfTest      Validate the offline smoke assets without running Pi.
  -Help          Show this help.
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
$ScriptDir = Split-Path -Parent $ScriptPath
. (Join-Path $ScriptDir "pi67-json-utils.ps1")

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
} else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}

$Provider = "xtalpi-pi-tools"
$Model = "deepseek-v4-pro"
$ProbeExtension = Join-Path $ScriptDir "pi67-zero-key-startup-probe.ts"
$SourceExtension = Join-Path $RepoRoot "extensions\xtalpi-pi-tools"
$SourceModels = Join-Path $RepoRoot "models.example.json"

foreach ($path in @($ProbeExtension, $SourceModels)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "required file not found: $path"
  }
}
if (-not (Test-Path -LiteralPath $SourceExtension -PathType Container)) {
  throw "required extension directory not found: $SourceExtension"
}

if ($SelfTest) {
  $probeText = Get-Content -LiteralPath $ProbeExtension -Raw
  foreach ($required in @("PI67_STARTUP_PROBE_MARKER", "session_start", "pi67-startup-probe/v1", "ctx.shutdown()")) {
    if (-not $probeText.Contains($required)) {
      throw "startup probe is missing required contract: $required"
    }
  }
  if ($Json) {
    [pscustomobject][ordered]@{
      schema = "pi67-zero-key-startup-smoke/v1"
      selfTest = $true
      ok = $true
    } | ConvertTo-Json -Depth 10
  } else {
    Write-Host "PASS pi-67 zero-key startup smoke self-test"
  }
  exit 0
}

if (-not (Get-Command $PiBin -ErrorAction SilentlyContinue)) {
  throw "upstream Pi command not found: $PiBin"
}

$TempAgent = Join-Path ([System.IO.Path]::GetTempPath()) ("pi67-zero-key-startup-{0}" -f [Guid]::NewGuid().ToString("N"))
$MarkerPath = Join-Path $TempAgent "session-start.json"
$EnvironmentNames = @(
  "PI_CODING_AGENT_DIR",
  "PI_AGENT_DIR",
  "PI_OFFLINE",
  "PI67_STARTUP_PROBE_MARKER",
  "DEEPSEEK_API_KEY",
  "XTALPI_PI_TOOLS_API_KEY",
  "XTALPI_API_KEY",
  "PI67_XTALPI_PI_TOOLS_API_KEY",
  "PI67_XTALPI_API_KEY"
)
$PreviousEnvironment = @{}
foreach ($name in $EnvironmentNames) {
  $PreviousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $TempAgent "extensions") | Out-Null
  Copy-Item $SourceExtension (Join-Path $TempAgent "extensions\xtalpi-pi-tools") -Recurse -Force
  Copy-Item $SourceModels (Join-Path $TempAgent "models.json") -Force
  Save-Pi67JsonFileUtf8NoBom (Join-Path $TempAgent "settings.json") ([pscustomobject][ordered]@{
    defaultProvider = $Provider
    defaultModel = $Model
    packages = @()
  })
  Save-Pi67JsonFileUtf8NoBom (Join-Path $TempAgent "auth.json") ([pscustomobject]@{})

  $env:PI_CODING_AGENT_DIR = $TempAgent
  $env:PI_AGENT_DIR = $TempAgent
  $env:PI_OFFLINE = "1"
  foreach ($name in $EnvironmentNames | Where-Object { $_ -notin @("PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_OFFLINE") }) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }

  # Pi 0.80.6 hides provider models until a credential resolves. This fixture
  # validates registration only; it is never sent to the provider endpoint.
  $env:XTALPI_PI_TOOLS_API_KEY = "pi67-model-discovery-only"
  Push-Location $TempAgent
  try {
    $modelOutput = @(& $PiBin --offline --list-models $Provider 2>&1)
    $modelExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } finally {
    Pop-Location
  }
  Remove-Item "Env:XTALPI_PI_TOOLS_API_KEY" -ErrorAction SilentlyContinue
  $modelText = $modelOutput -join "`n"
  if ($modelExitCode -ne 0 -or $modelText -notmatch "(?m)^$([regex]::Escape($Provider))\s+$([regex]::Escape($Model))\s+") {
    throw "xtalpi-pi-tools registration check failed: $modelText"
  }

  $env:PI67_STARTUP_PROBE_MARKER = $MarkerPath
  Push-Location $TempAgent
  try {
    $startupOutput = @(& $PiBin --offline --no-session --no-tools --no-skills --no-prompt-templates --no-themes --no-context-files --extension $ProbeExtension 2>&1)
    $startupExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  } finally {
    Pop-Location
  }
  $startupText = $startupOutput -join "`n"
  if ($startupExitCode -ne 0) {
    throw "zero-credential Pi startup exited with $startupExitCode`: $startupText"
  }
  if ($startupText.Contains('"apiKey" or "oauth" is required when defining models')) {
    throw "zero-credential Pi startup hit the provider registration credential gate"
  }
  if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
    throw "zero-credential Pi did not reach session_start"
  }

  $marker = Read-Pi67JsonFile $MarkerPath
  if ($marker.schema -ne "pi67-startup-probe/v1" -or $marker.reason -ne "startup") {
    throw "unexpected startup probe marker contract"
  }

  $result = [pscustomobject][ordered]@{
    schema = "pi67-zero-key-startup-smoke/v1"
    provider = $Provider
    model = $Model
    providerRegistrationReady = $true
    zeroCredentialStartupReady = $true
    sessionReason = [string]$marker.reason
    ok = $true
  }
  if ($Json) {
    $result | ConvertTo-Json -Depth 10
  } else {
    Write-Host "PASS xtalpi-pi-tools provider registration"
    Write-Host "PASS real Pi reached session_start with no provider credential"
  }
} finally {
  foreach ($name in $EnvironmentNames) {
    $previous = $PreviousEnvironment[$name]
    if ($null -eq $previous) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$name" $previous
    }
  }
  if (Test-Path -LiteralPath $TempAgent) {
    Remove-Item -LiteralPath $TempAgent -Recurse -Force
  }
}
