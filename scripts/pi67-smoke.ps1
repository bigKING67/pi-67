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
. (Join-Path $ScriptDir "pi67-json-utils.ps1")
$Pi67GitPathInit = Initialize-Pi67GitPath
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
  return Read-Pi67JsonFile $Path
}

function Join-ByteArrays {
  param([object[]]$Parts)
  $length = 0
  foreach ($part in $Parts) {
    $length += $part.Length
  }
  $result = New-Object byte[] $length
  $offset = 0
  foreach ($part in $Parts) {
    [Array]::Copy($part, 0, $result, $offset, $part.Length)
    $offset += $part.Length
  }
  return $result
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
$PiAvailable = Test-CommandExists "pi"

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
  if ($Pi67GitPathInit.AddedToPath) {
    Pass ("git found via installed Git path: {0}" -f $Pi67GitPathInit.Source)
  } else {
    Pass "git found"
  }
} else {
  Warn "git not found; skipped Git-only checks" "install Git for Windows with: winget install --id Git.Git -e --source winget"
}

if ($PiAvailable) {
  Pass "upstream pi found"
} else {
  Warn "upstream pi not found; skipped real extension-load check" "repair the independent Pi installation, then rerun this smoke"
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
  ".gitattributes",
  "AGENTS.md",
  "rules/pi67-product-boundary.md",
  "settings.example.json",
  "models.example.json",
  "mcp.example.json",
  "auth.example.json",
  "image-gen.example.json",
  "README.md",
  "shared-skill-packs.json",
  "shared-skill-packs.lock.json",
  "docs/full-install.md",
  "docs/release.md",
  "docs/troubleshooting.md",
  "docs/windows-fresh-install.md",
  "docs/xtalpi-pi-tools.md",
  "docs/hy-memory.md",
  "tsconfig.hy-memory.json",
  "scripts/pi67-bootstrap.ps1",
  "scripts/pi67-doctor.ps1",
  "scripts/pi67-report.ps1",
  "scripts/pi67-smoke.ps1",
  "scripts/pi67-update.ps1",
  "scripts/pi67-windows-acceptance.ps1",
  "scripts/pi67-json-utils.ps1",
  "scripts/pi67-json-utils.cjs",
  "scripts/pi67-mcp-config-utils.cjs",
  "scripts/pi67-prompt-governance-check.mjs",
  "scripts/pi67-provider-status.mjs",
  "scripts/pi67-shared-skill-packs-status.mjs",
  "scripts/pi67-release-check.sh",
  "scripts/pi67-zero-key-startup-probe.ts",
  "scripts/pi67-zero-key-startup-smoke.ps1",
  "scripts/pi67-xtalpi-pi-tools.ps1",
  "scripts/pi67-xtalpi-pi-tools-smoke.ps1",
  "scripts/pi67-xtalpi-smoke-status-core.cjs",
  "scripts/pi67-xtalpi-smoke-plan.mjs",
  "scripts/pi67-xtalpi-provider-health.mjs",
  "scripts/pi67-xtalpi-provider-capability-probe.mjs",
  "scripts/pi67-validate-xtalpi-provider-error-contract.mjs",
  "scripts/pi67-fuzz-xtalpi-parser.mjs",
  "scripts/pi67-patch-pi-until-done-runtime-queue.mjs",
  "scripts/pi67-patch-pi-until-done-runtime-queue.sh",
  "scripts/pi67-patch-pi-until-done-runtime-queue.ps1",
  "scripts/pi67-patch-pi-smart-fetch-charset.mjs",
  "scripts/pi67-shared-skills-inventory.sh",
  "scripts/pi67-sync-commerce-growth-os.sh",
  "scripts/pi67-sync-commerce-skill-pack.sh",
  "scripts/pi67-sync-commerce-skill-pack.mjs",
  "packages/pi67-cli/package.json",
  "packages/pi67-cli/bin/pi-67.mjs",
  "packages/pi67-cli/src/cli.mjs",
  "packages/pi67-cli/src/commands/backups.mjs",
  "packages/pi67-cli/src/commands/extensions.mjs",
  "packages/pi67-cli/src/commands/manifest.mjs",
  "packages/pi67-cli/src/commands/memory.mjs",
  "packages/pi67-cli/src/commands/self-update.mjs",
  "packages/pi67-cli/src/commands/skills.mjs",
  "packages/pi67-cli/src/data/distro-manifest.json",
  "packages/pi67-cli/src/data/extension-registry.json",
  "packages/pi67-cli/src/lib/distro-manifest.mjs",
  "packages/pi67-cli/src/lib/extension-registry.mjs",
  "packages/pi67-cli/src/lib/memory-runtime.mjs",
  "packages/pi67-cli/src/lib/update-safety.mjs",
  "packages/pi67-cli/src/lib/npm-registry.mjs",
  "packages/pi67-cli/src/lib/skill-policy.mjs",
  "packages/pi67-cli/src/lib/skill-pack-integrity.mjs",
  "packages/pi67-cli/src/lib/settings-runtime-clean.mjs",
  "packages/pi67-cli/src/lib/settings-runtime-state.mjs",
  "packages/pi67-cli/src/lib/xtalpi-config.mjs",
  "packages/pi67-cli/src/tools/settings-runtime-state-filter.mjs",
  "packages/pi67-cli/schemas/pi67-distro-manifest.schema.json",
  "packages/pi67-cli/schemas/pi67-extension-registry.schema.json",
  "packages/pi67-cli/schemas/pi67-state.schema.json",
  "packages/pi67-cli/schemas/pi67-update-plan.schema.json",
  "extensions/xtalpi-pi-tools/json-file.ts",
  "extensions/xtalpi-pi-tools/json-action-protocol.ts",
  "extensions/xtalpi-pi-tools/runtime-config.ts",
  "extensions/xtalpi-pi-tools/vision-bridge.ts",
  "extensions/xtalpi-pi-tools/browser-bridge.ts",
  "extensions/pi-vision-bridge/index.ts",
  "extensions/pi-hy-memory/index.ts",
  "extensions/pi-hy-memory/service.py",
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
  "settings.example.json",
  "auth.example.json",
  "image-gen.example.json",
  "models.example.json",
  "mcp.example.json",
  "package.json",
  "shared-skill-packs.json",
  "shared-skill-packs.lock.json",
  "packages/pi67-cli/package.json",
  "packages/pi67-cli/src/data/distro-manifest.json",
  "packages/pi67-cli/src/data/extension-registry.json",
  "packages/pi67-cli/schemas/pi67-distro-manifest.schema.json",
  "packages/pi67-cli/schemas/pi67-extension-registry.schema.json",
  "packages/pi67-cli/schemas/pi67-state.schema.json",
  "packages/pi67-cli/schemas/pi67-update-plan.schema.json",
  "extensions/xtalpi-pi-tools/fixtures/replay-cases.json",
  "extensions/xtalpi-pi-tools/provider-error-contract.json"
)

foreach ($file in $JsonFiles) {
  Run-Check ("valid JSON: {0}" -f $file) {
    $null = Read-JsonFile (RepoPath $file)
  }
}

Run-Check "JSON compatibility reader handles Windows encodings" {
  $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pi67-json-smoke-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null
  try {
    $sample = '{"probe":true,"value":67}'
    $utf8 = [System.Text.Encoding]::UTF8.GetBytes($sample)
    $utf16Le = [System.Text.Encoding]::Unicode.GetBytes($sample)
    $utf16BeEncoding = New-Object System.Text.UnicodeEncoding -ArgumentList @($true, $true, $true)
    $utf16Be = $utf16BeEncoding.GetBytes($sample)

    $cases = @(
      @("utf8-bom.json", (Join-ByteArrays -Parts @([byte[]]@(0xef, 0xbb, 0xbf), $utf8))),
      @("utf16le-bom.json", (Join-ByteArrays -Parts @([byte[]]@(0xff, 0xfe), $utf16Le))),
      @("utf16be-bom.json", (Join-ByteArrays -Parts @([byte[]]@(0xfe, 0xff), $utf16Be))),
      @("utf16le.json", $utf16Le),
      @("leading-nul.json", (Join-ByteArrays -Parts @([byte[]]@(0x00), $utf8)))
    )

    foreach ($case in $cases) {
      $path = Join-Path $tmpRoot $case[0]
      [System.IO.File]::WriteAllBytes($path, [byte[]]$case[1])
      $parsed = Read-Pi67JsonFile $path
      if ($parsed.value -ne 67) {
        throw "failed to parse $($case[0])"
      }
    }

    $repairPath = Join-Path $tmpRoot "repair.json"
    [System.IO.File]::WriteAllBytes($repairPath, (Join-ByteArrays -Parts @([byte[]]@(0xff, 0xfe), $utf16Le)))
    $repair = Repair-Pi67JsonFileEncoding -Path $repairPath -Label "repair.json"
    if (-not $repair.Changed -or -not (Test-Path -LiteralPath $repair.BackupPath -PathType Leaf)) {
      throw "encoding repair did not create a backup"
    }
    $bytes = [System.IO.File]::ReadAllBytes($repairPath)
    if (($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) -or [Array]::IndexOf($bytes, [byte]0) -ge 0) {
      throw "encoding repair did not write UTF-8 without BOM/NUL bytes"
    }
  } finally {
    if (Test-Path -LiteralPath $tmpRoot) {
      Remove-Item -LiteralPath $tmpRoot -Recurse -Force
    }
  }
}

Run-Check "settings.json is ignored runtime state with a tracked template" {
  $trackedSettings = @(& git -C $RepoRoot ls-files --error-unmatch settings.json 2>$null)
  if ($LASTEXITCODE -eq 0 -or $trackedSettings.Count -gt 0) {
    throw "settings.json must not be tracked"
  }
  & git -C $RepoRoot ls-files --error-unmatch settings.example.json *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "settings.example.json must be tracked"
  }
  & git -C $RepoRoot check-ignore -q settings.json
  if ($LASTEXITCODE -ne 0) {
    throw "settings.json must be ignored"
  }
  $attributes = Get-Content -LiteralPath (RepoPath ".gitattributes") -Raw
  if ($attributes.Contains("filter=pi67-settings-runtime-state")) {
    throw "legacy settings.json Git clean filter must not remain"
  }
}

Section "PowerShell doctor regression"
if ($NodeAvailable -and $PiAvailable) {
  Run-Check "immutable doctor parses helper JSON and avoids legacy npm sync advice" {
    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pi67-doctor-regression-" + [guid]::NewGuid().ToString("N"))
    $immutableRoot = Join-Path $tmpRoot "agent"
    $bundleRoot = RepoPath "packages" "pi67-cli" "distro"
    $buildBundle = RepoPath "packages" "pi67-cli" "scripts" "build-distro-bundle.mjs"
    $cleanBundle = RepoPath "packages" "pi67-cli" "scripts" "clean-distro-bundle.mjs"
    $oldXtalpiKey = [Environment]::GetEnvironmentVariable("XTALPI_PI_TOOLS_API_KEY", "Process")
    try {
      Invoke-External "node" @($buildBundle) | Out-Null
      Copy-Item -LiteralPath $bundleRoot -Destination $immutableRoot -Recurse -Force
      foreach ($name in @("settings", "models", "mcp", "auth", "image-gen")) {
        Copy-Item -LiteralPath (Join-Path $immutableRoot "$name.example.json") -Destination (Join-Path $immutableRoot "$name.json") -Force
      }

      $env:XTALPI_PI_TOOLS_API_KEY = "pi67-doctor-regression-fixture"
      $powerShellExe = (Get-Process -Id $PID).Path
      $raw = @(& $powerShellExe -NoLogo -NoProfile -File (Join-Path $immutableRoot "scripts" "pi67-doctor.ps1") `
        -RepoRoot $immutableRoot `
        -AgentDir $immutableRoot `
        -SkillsDir (Join-Path $immutableRoot "shared-skills") `
        -Json 2>&1)
      $exitCode = $LASTEXITCODE
      $jsonText = ($raw -join "`n")
      $doctor = $jsonText | ConvertFrom-Json
      $messages = (@($doctor.checks | ForEach-Object { [string]$_.message }) -join "`n")

      if ($exitCode -ne 0 -or $doctor.counts.fail -ne 0) {
        throw "immutable doctor returned exit=$exitCode fail=$($doctor.counts.fail): $messages"
      }
      if ($doctor.installMode -ne "immutable-release") {
        throw "expected immutable-release, got $($doctor.installMode)"
      }
      if (-not $messages.Contains("mcp.json runtime paths are adapter-compatible")) {
        throw "MCP runtime helper JSON was not parsed"
      }
      if (-not $messages.Contains("selected custom provider/model exists: xtalpi-pi-tools/deepseek-v4-pro")) {
        throw "provider status helper JSON was not parsed"
      }
      if (-not $messages.Contains("immutable npm runtime does not require source manifest byte equality")) {
        throw "immutable npm manifest policy was not applied"
      }
      if ($jsonText.Contains("Unexpected character encountered while parsing value: S")) {
        throw "doctor regressed to parsing the Invoke-External result object instead of its text"
      }
      if ($messages.Contains("pi67-update.ps1")) {
        throw "immutable doctor recommended the deprecated PowerShell updater"
      }
    } finally {
      if ($null -eq $oldXtalpiKey) {
        Remove-Item "Env:XTALPI_PI_TOOLS_API_KEY" -ErrorAction SilentlyContinue
      } else {
        $env:XTALPI_PI_TOOLS_API_KEY = $oldXtalpiKey
      }
      if (Test-Path -LiteralPath $tmpRoot) {
        Remove-Item -LiteralPath $tmpRoot -Recurse -Force
      }
      if (Test-Path -LiteralPath $cleanBundle -PathType Leaf) {
        Invoke-External "node" @($cleanBundle) | Out-Null
      }
    }
  }
} else {
  Warn "immutable PowerShell doctor regression skipped" "node and upstream pi are required"
}

Section "Zero-credential Pi startup"
if ($PiAvailable) {
  Run-Check "real Pi registers xtalpi-pi-tools and starts with no provider key" {
    $raw = @(& (RepoPath "scripts" "pi67-zero-key-startup-smoke.ps1") -RepoRoot $RepoRoot -PiBin "pi" -Json)
    $payload = ($raw -join "`n") | ConvertFrom-Json
    if (
      $payload.schema -ne "pi67-zero-key-startup-smoke/v1" -or
      $payload.providerRegistrationReady -ne $true -or
      $payload.zeroCredentialStartupReady -ne $true -or
      $payload.sessionReason -ne "startup" -or
      $payload.ok -ne $true
    ) {
      throw "unexpected zero-key startup smoke contract"
    }
  }
} else {
  Warn "zero-credential Pi startup check skipped" "upstream pi is not installed"
}

Section "Node helpers"
if ($NodeAvailable) {
  $NodeCheckFiles = @(
    "scripts/pi67-json-utils.cjs",
    "scripts/pi67-mcp-config-utils.cjs",
    "scripts/pi67-prompt-governance-check.mjs",
    "scripts/pi67-xtalpi-smoke-status-core.cjs",
    "scripts/pi67-xtalpi-smoke-artifact-core.cjs",
    "scripts/pi67-xtalpi-smoke-plan.mjs",
    "scripts/pi67-xtalpi-provider-health.mjs",
    "scripts/pi67-xtalpi-provider-capability-probe.mjs",
    "scripts/pi67-validate-xtalpi-provider-error-contract.mjs",
    "scripts/pi67-fuzz-xtalpi-parser.mjs",
    "scripts/pi67-patch-pi-until-done-runtime-queue.mjs",
    "packages/pi67-cli/scripts/check.mjs",
    "packages/pi67-cli/bin/pi-67.mjs",
    "packages/pi67-cli/src/cli.mjs",
    "packages/pi67-cli/src/commands/doctor.mjs",
    "packages/pi67-cli/src/commands/external.mjs",
    "packages/pi67-cli/src/commands/extensions.mjs",
    "packages/pi67-cli/src/commands/install.mjs",
    "packages/pi67-cli/src/commands/manifest.mjs",
    "packages/pi67-cli/src/commands/memory.mjs",
    "packages/pi67-cli/src/commands/publish-check.mjs",
    "packages/pi67-cli/src/commands/report.mjs",
    "packages/pi67-cli/src/commands/self-update.mjs",
    "packages/pi67-cli/src/commands/skills.mjs",
    "packages/pi67-cli/src/commands/smoke.mjs",
    "packages/pi67-cli/src/commands/status.mjs",
    "packages/pi67-cli/src/commands/themes.mjs",
    "packages/pi67-cli/src/commands/update.mjs",
    "packages/pi67-cli/src/commands/version.mjs",
    "packages/pi67-cli/src/commands/xtalpi.mjs",
    "packages/pi67-cli/src/lib/distro-manifest.mjs",
    "packages/pi67-cli/src/lib/extension-registry.mjs",
    "packages/pi67-cli/src/lib/memory-runtime.mjs",
    "packages/pi67-cli/src/lib/update-safety.mjs",
    "packages/pi67-cli/src/lib/npm-registry.mjs",
    "packages/pi67-cli/src/lib/xtalpi-config.mjs"
  )
  foreach ($file in $NodeCheckFiles) {
    Run-Check ("node --check: {0}" -f $file) {
      Invoke-External "node" @("--check", (RepoPath $file)) | Out-Null
    }
  }

  Run-Check "Pi prompt governance check passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-prompt-governance-check.mjs"), "--repo-root", $RepoRoot) | Out-Null
  }

  Run-Check "xtalpi provider health classifier self-test passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-xtalpi-provider-health.mjs"), "--self-test") | Out-Null
  }

  Run-Check "xtalpi provider capability probe self-test passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-xtalpi-provider-capability-probe.mjs"), "--self-test") | Out-Null
  }

  Run-Check "Windows one-command acceptance self-test passed" {
    $psExe = ""
    if (Test-CommandExists "pwsh") {
      $psExe = "pwsh"
    } elseif (Test-CommandExists "powershell") {
      $psExe = "powershell"
    } else {
      throw "no child PowerShell executable found"
    }
    Invoke-External $psExe @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      (RepoPath "scripts/pi67-windows-acceptance.ps1"),
      "-SelfTest"
    ) | Out-Null
  }

  Run-Check "Windows pi-67 manager/workspace bootstrap self-test passed" {
    $psExe = ""
    if (Test-CommandExists "pwsh") {
      $psExe = "pwsh"
    } elseif (Test-CommandExists "powershell") {
      $psExe = "powershell"
    } else {
      throw "no child PowerShell executable found"
    }
    Invoke-External $psExe @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      (RepoPath "scripts/pi67-bootstrap.ps1"),
      "-SelfTest"
    ) | Out-Null
  }

  Run-Check "JSON utility self-test passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-json-utils.cjs"), "--self-test") | Out-Null
  }

  Run-Check "MCP example uses adapter-compatible browser67 cwd" {
    $mcp = Read-JsonFile (RepoPath "mcp.example.json")
    $tmwd = $mcp.mcpServers.tmwd_browser
    $jsReverse = $mcp.mcpServers.'js-reverse'
    if ($null -ne $mcp.mcpServers.agent_memory) {
      throw "mcp.example.json must not distribute the user-specific agent_memory MCP"
    }
    if ($tmwd.args[0] -ne "src/mcp/browser/server.mjs") {
      throw ("tmwd_browser args must be cwd-relative, got {0}" -f $tmwd.args[0])
    }
    if ($jsReverse.args[0] -ne "src/mcp/js-reverse/server.mjs") {
      throw ("js-reverse args must be cwd-relative, got {0}" -f $jsReverse.args[0])
    }
    if ($tmwd.cwd -ne "~/.agents/packages/browser67" -or $jsReverse.cwd -ne "~/.agents/packages/browser67") {
      throw "browser67 MCP examples must use adapter-supported cwd"
    }
    $raw = Get-Content -LiteralPath (RepoPath "mcp.example.json") -Raw
    if ($raw.Contains('$HOME/') -or $raw.Contains('${HOME}/') -or $raw.Contains('%USERPROFILE%')) {
      throw "mcp.example.json must not put home placeholders in command/args"
    }
  }

  Run-Check "MCP normalizer keeps browser67 args cwd-relative" {
    $script = @'
const path = require("path");
const repoRoot = process.argv[1];
const { normalizeMcpConfig } = require(path.join(repoRoot, "scripts", "pi67-mcp-config-utils.cjs"));
const browser67Root = path.join(repoRoot, "fixtures", "browser67-root");
const runtime = { mcpServers: {} };
normalizeMcpConfig(runtime, { agentDir: repoRoot, browser67Root });
const tmwd = runtime.mcpServers.tmwd_browser || {};
const jsReverse = runtime.mcpServers["js-reverse"] || {};
if (tmwd.cwd !== browser67Root || jsReverse.cwd !== browser67Root) {
  throw new Error("browser67Root normalization should write absolute cwd");
}
if (tmwd.args?.[0] !== "src/mcp/browser/server.mjs") {
  throw new Error(`tmwd args should be cwd-relative, got ${tmwd.args?.[0]}`);
}
if (jsReverse.args?.[0] !== "src/mcp/js-reverse/server.mjs") {
  throw new Error(`js-reverse args should be cwd-relative, got ${jsReverse.args?.[0]}`);
}
if (String(tmwd.args?.[0] || "").includes(browser67Root) || String(jsReverse.args?.[0] || "").includes(browser67Root)) {
  throw new Error("browser67Root normalization must not duplicate absolute paths into args");
}
'@
    Invoke-External "node" @("-e", $script, $RepoRoot) | Out-Null
  }

  Run-Check "xtalpi provider error contract validator self-test passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-validate-xtalpi-provider-error-contract.mjs"), (RepoPath "extensions/xtalpi-pi-tools/provider-error-contract.json"), "--self-test") | Out-Null
  }

  Run-Check "xtalpi provider error contract validation passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-validate-xtalpi-provider-error-contract.mjs"), (RepoPath "extensions/xtalpi-pi-tools/provider-error-contract.json")) | Out-Null
  }

  Run-Check "xtalpi parser matrix regression passed" {
    Invoke-External "node" @("--no-warnings", (RepoPath "scripts/pi67-fuzz-xtalpi-parser.mjs"), $RepoRoot) | Out-Null
  }

  Run-Check "pi-until-done runtime queue/progress patch self-test passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-patch-pi-until-done-runtime-queue.mjs"), "--self-test") | Out-Null
  }

  Run-Check "pi-smart-fetch charset patch self-test passed" {
    Invoke-External "node" @((RepoPath "scripts/pi67-patch-pi-smart-fetch-charset.mjs"), "--self-test") | Out-Null
  }

  Run-Check "pi-67 npm CLI syntax suite passed" {
    Invoke-External "node" @((RepoPath "packages/pi67-cli/scripts/check.mjs")) | Out-Null
  }

  Run-Check "Hy-Memory extension typecheck passed" {
    Invoke-External "npm" @("--prefix", $RepoRoot, "run", "-s", "typecheck:hy-memory") | Out-Null
  }

  Run-Check "Hy-Memory extension tests passed" {
    Invoke-External "npm" @("--prefix", $RepoRoot, "run", "-s", "test:hy-memory") | Out-Null
  }

  Run-Check "shared Skill Pack status helper passed" {
    $raw = Invoke-External "node" @(
      (RepoPath "scripts/pi67-shared-skill-packs-status.mjs"),
      "--repo-root", $RepoRoot,
      "--skills-dir", (RepoPath "shared-skills"),
      "--json"
    )
    $payload = ($raw -join "`n") | ConvertFrom-Json
    if ($payload.schemaId -ne "pi67-shared-skill-packs-status/v1") {
      throw "unexpected shared Skill Pack status schema"
    }
    if (-not $payload.registry.valid -or -not $payload.lock.valid -or $payload.summary.attention -ne 0) {
      throw "vendored shared Skill Pack should be consistent against itself"
    }
  }

  Run-Check "pi-67 npm CLI smoke passed" {
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--help") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--agent-dir", $RepoRoot, "--repo-root", $RepoRoot, "version", "--json") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--agent-dir", $RepoRoot, "--repo-root", $RepoRoot, "manifest", "--json") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--agent-dir", $RepoRoot, "--repo-root", $RepoRoot, "extensions", "doctor", "--json", "--no-remote") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--agent-dir", $RepoRoot, "--repo-root", $RepoRoot, "update", "--check", "--json", "--no-remote") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--agent-dir", $RepoRoot, "--repo-root", $RepoRoot, "update", "--check", "--json", "--no-remote", "--strict-shared-skills") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--agent-dir", $RepoRoot, "--repo-root", $RepoRoot, "publish-check", "--json", "--no-remote") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--agent-dir", $RepoRoot, "--repo-root", $RepoRoot, "themes", "current", "--json") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--agent-dir", $RepoRoot, "--repo-root", $RepoRoot, "backups", "list", "--json") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "memory", "--help") | Out-Null
    Invoke-External "node" @((RepoPath "packages/pi67-cli/bin/pi-67.mjs"), "--dry-run", "self-update") | Out-Null
  }

  Run-Check "pi-67 xtalpi configure dry-run passed" {
    $tmpAgent = Join-Path ([System.IO.Path]::GetTempPath()) ("pi67-xtalpi-config-{0}-{1}" -f $PID, [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmpAgent | Out-Null
    try {
      $raw = Invoke-External "node" @(
        (RepoPath "packages/pi67-cli/bin/pi-67.mjs"),
        "--agent-dir", $tmpAgent,
        "--repo-root", $RepoRoot,
        "xtalpi", "configure", "--dry-run", "--no-prompt", "--json"
      )
      $payload = (($raw -join "`n") | ConvertFrom-Json)
      if ($payload.schema -ne "pi67-xtalpi-config/v1" -or $payload.provider -ne "xtalpi-pi-tools" -or $payload.model -ne "deepseek-v4-pro") {
        throw "unexpected xtalpi configure dry-run contract"
      }
      if ($payload.configured -eq $true -or $payload.changed -eq $true -or $payload.skipped -ne $true -or $payload.dryRun -ne $true) {
        throw "fresh dry-run must be an unconfigured, skipped no-op and report dryRun=true"
      }
      foreach ($file in @("models.json", "settings.json", "auth.json")) {
        if (Test-Path -LiteralPath (Join-Path $tmpAgent $file)) {
          throw "fresh missing-key dry-run must not create $file"
        }
      }
    } finally {
      if (Test-Path -LiteralPath $tmpAgent) {
        Remove-Item -LiteralPath $tmpAgent -Recurse -Force
      }
    }
  }

  Run-Check "PowerShell updater final settings runtime marker cleanup passed" {
    if (-not $GitAvailable) {
      throw "git not found"
    }
    $psExe = ""
    if (Test-CommandExists "pwsh") {
      $psExe = "pwsh"
    } elseif (Test-CommandExists "powershell") {
      $psExe = "powershell"
    } else {
      throw "no child PowerShell executable found"
    }

    $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("pi67-smoke-pwsh-update-" + [Guid]::NewGuid().ToString("N"))
    $tmpRepo = Join-Path $tmpRoot "repo"
    $tmpHome = Join-Path $tmpRoot "home"
    $tmpSkills = Join-Path $tmpRoot "skills"
    $oldUserProfile = $env:USERPROFILE
    $oldHome = $env:HOME
    try {
      New-Item -ItemType Directory -Force -Path $tmpRoot, $tmpHome, $tmpSkills | Out-Null
      Invoke-External "git" @("clone", $RepoRoot, $tmpRepo) | Out-Null
      Invoke-External "git" @("-C", $tmpRepo, "config", "user.email", "pi67-smoke@example.invalid") | Out-Null
      Invoke-External "git" @("-C", $tmpRepo, "config", "user.name", "pi67-smoke") | Out-Null

      $fixture = @'
param(
  [string]$RepoRoot,
  [string]$AgentDir,
  [string]$SkillsDir,
  [string]$Operation,
  [switch]$NoDoctor
)

$settingsPath = Join-Path $AgentDir "settings.json"
$reportPath = Join-Path $AgentDir "pi67-report.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$settings | Add-Member -NotePropertyName "lastChangelogVersion" -NotePropertyValue "pi67-smoke-final-marker" -Force
[System.IO.File]::WriteAllText($settingsPath, (($settings | ConvertTo-Json -Depth 50) + "`n"), $utf8NoBom)
$report = [ordered]@{
  schemaVersion = 2
  generatedAt = "1970-01-01T00:00:00.000Z"
  pi67Version = "smoke"
  repository = [ordered]@{
    shortCommit = "smoke"
    dirty = $true
  }
}
[System.IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 10) + "`n"), $utf8NoBom)
'@
      $fixturePath = Join-Path (Join-Path $tmpRepo "scripts") "pi67-report.ps1"
      $utf8 = New-Object System.Text.UTF8Encoding $false
      [System.IO.File]::WriteAllText($fixturePath, $fixture, $utf8)
      Invoke-External "git" @("-C", $tmpRepo, "add", "scripts/pi67-report.ps1") | Out-Null
      & git -C $tmpRepo diff --cached --quiet
      $diffExit = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
      if ($diffExit -ne 0) {
        Invoke-External "git" @("-C", $tmpRepo, "commit", "-q", "-m", "smoke final-marker report fixture") | Out-Null
      }

      $env:USERPROFILE = $tmpHome
      $env:HOME = $tmpHome
      $output = Invoke-External $psExe @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        (RepoPath "scripts/pi67-update.ps1"),
        "-RepoRoot",
        $tmpRepo,
        "-AgentDir",
        $tmpRepo,
        "-SkillsDir",
        $tmpSkills,
        "-NoNpm",
        "-NoConfigure",
        "-NoSmoke",
        "-NoDoctor"
      )
      $joined = $output -join "`n"
      if (-not $joined.Contains("settings runtime state (final)")) {
        throw "final settings runtime migration did not run"
      }

      $settingsAfter = Read-JsonFile (Join-Path $tmpRepo "settings.json")
      if ($settingsAfter.PSObject.Properties["lastChangelogVersion"]) {
        throw "settings.json still contains final runtime marker"
      }
      $statePath = Join-Path (Join-Path (Join-Path $tmpHome ".pi") "pi67") "state.json"
      $state = Read-JsonFile $statePath
      if ($state.runtimeMarkers.lastChangelogVersion.value -ne "pi67-smoke-final-marker") {
        throw "state.json did not preserve final runtime marker"
      }
      Invoke-External "git" @("-C", $tmpRepo, "diff", "--quiet", "--", "settings.json") | Out-Null
    } finally {
      $env:USERPROFILE = $oldUserProfile
      $env:HOME = $oldHome
      if (Test-Path -LiteralPath $tmpRoot) {
        Remove-Item -LiteralPath $tmpRoot -Recurse -Force
      }
    }
  }

  Run-Check "xtalpi extension smoke plan validation passed" {
    $raw = Invoke-External "node" @((RepoPath "scripts/pi67-xtalpi-smoke-plan.mjs"), "--repo-root", $RepoRoot, "--agent-dir", $RepoRoot, "--json")
    $plan = ($raw -join "`n") | ConvertFrom-Json
    if ($plan.schemaId -ne "pi67-xtalpi-smoke-plan/v1") {
      throw "unexpected smoke plan schema: $($plan.schemaId)"
    }
    if (-not $plan.summary -or $plan.summary.packages -lt 1 -or $plan.summary.installed -lt 1) {
      throw "smoke plan summary is empty"
    }
    if ($plan.summary.unknownPolicyPackages -ne 0) {
      throw "smoke plan has unknown policy packages"
    }
    if (-not $plan.recommendedCommands -or -not $plan.recommendedCommands.windowsExpanded.Contains("extension-expanded")) {
      throw "smoke plan missing Windows expanded command"
    }
    $smartFetch = $plan.packages | Where-Object { $_.spec -eq "npm:pi-smart-fetch" } | Select-Object -First 1
    if (-not $smartFetch) {
      throw "smoke plan missing smart-fetch entry"
    }
    if ($smartFetch.installed) {
      if ($smartFetch.windowsCoveredTools -notcontains "batch_web_fetch") {
        throw "smoke plan did not cover batch_web_fetch"
      }
    } elseif ($smartFetch.status -ne "missing_package") {
      throw "unexpected smart-fetch status: $($smartFetch.status)"
    }
    $rulesLoader = $plan.packages | Where-Object { $_.spec -eq "local:extensions/pi-rules-loader" } | Select-Object -First 1
    if (-not $rulesLoader -or $rulesLoader.status -ne "not_model_callable") {
      throw "smoke plan did not classify pi-rules-loader"
    }
    $visionBridge = $plan.packages | Where-Object { $_.spec -eq "local:extensions/pi-vision-bridge" } | Select-Object -First 1
    if (-not $visionBridge -or $visionBridge.smokePolicy -ne "manual_artifact") {
      throw "smoke plan did not classify pi-vision-bridge"
    }
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
  $jsonActionProtocol = RepoPath "extensions/xtalpi-pi-tools/json-action-protocol.ts"
  $chatClient = RepoPath "extensions/xtalpi-pi-tools/chat-client.ts"
  $providerTurn = RepoPath "extensions/xtalpi-pi-tools/provider-turn.ts"
  $responseNormalizer = RepoPath "extensions/xtalpi-pi-tools/response-normalizer.ts"
  $providerHealth = RepoPath "scripts/pi67-xtalpi-provider-health.mjs"
  $capabilityProbe = RepoPath "scripts/pi67-xtalpi-provider-capability-probe.mjs"
  Assert-ContentContains $runtimeConfig "/chat/completions"
  Assert-ContentContains $providerHealth "/chat/completions"
  Assert-ContentContains $capabilityProbe "/chat/completions"
  Assert-ContentNotContains $runtimeConfig "/responses"
  Assert-ContentNotContains $providerHealth "/responses"
  Assert-ContentNotContains $capabilityProbe "/responses"
  Assert-ContentNotContains $runtimeConfig "/response/completions"
  Assert-ContentNotContains $providerHealth "/response/completions"
  Assert-ContentNotContains $capabilityProbe "/response/completions"
  Assert-ContentContains $jsonActionProtocol "JSON_ACTION_PROTOCOL"
  Assert-ContentContains $jsonActionProtocol "jsonActionSystemPrompt"
  Assert-ContentContains $jsonActionProtocol "jsonActionResponseFormat"
  Assert-ContentContains $chatClient "JSON_ACTION_PROTOCOL"
  Assert-ContentNotContains $chatClient 'actionProtocol?:'
  Assert-ContentNotContains $responseNormalizer "actionProtocol"
  Assert-ContentContains $providerTurn "parseJsonAction"
  Assert-ContentNotContains $providerTurn (@("parseToolCall", "ForProtocol") -join "")

  $forbiddenFragments = @(
    (@("legacy", "_text") -join ""),
    (@("XTALPI_PI_TOOLS_ACTION", "_PROTOCOL") -join ""),
    (@("parseToolCall", "ForProtocol") -join ""),
    (@("resolveAction", "Protocol") -join ""),
    (@("createLocalAction", "Adapter") -join ""),
    (@("LocalAction", "Adapter") -join ""),
    (@("XtalpiAction", "Protocol") -join ""),
    (@("responseFormat", "ForProtocol") -join ""),
    (@("protocolSystem", "Prompt") -join ""),
    (@("protocolVersion", "For") -join ""),
    (@("wrapAssistantHistory", "ForProtocol") -join ""),
    (@("shouldReplayRawAssistant", "ForRepair") -join ""),
    (@("local_text", "_protocol") -join "")
  )
  $contractFiles = @(
    (RepoPath "README.md"),
    (RepoPath "CHANGELOG.md"),
    (RepoPath "docs/troubleshooting.md"),
    (RepoPath "docs/xtalpi-pi-tools.md"),
    $runtimeConfig,
    $capabilityProbe,
    $jsonActionProtocol,
    $chatClient,
    $providerTurn,
    $responseNormalizer
  )
  foreach ($file in $contractFiles) {
    foreach ($fragment in $forbiddenFragments) {
      Assert-ContentNotContains $file $fragment
    }
  }
}

Section "PowerShell documentation"
Run-Check "PowerShell update/doctor/report/smoke entrypoints are documented" {
  foreach ($name in @("pi67-bootstrap.ps1", "pi67-doctor.ps1", "pi67-smoke.ps1", "pi67-windows-acceptance.ps1")) {
    Assert-ContentContains (RepoPath "README.md") $name
    Assert-ContentContains (RepoPath "docs/windows-fresh-install.md") $name
  }
  Assert-ContentContains (RepoPath "docs/xtalpi-pi-tools.md") "PowerShell"
}

Run-Check "Windows manual fresh-install product contract is documented" {
  $freshInstall = RepoPath "docs/windows-fresh-install.md"
  Assert-ContentContains $freshInstall "Node.js 24 LTS"
  Assert-ContentContains $freshInstall "Node.js 22.19+"
  Assert-ContentContains $freshInstall ("npm install --global @bigking67/pi-67@{0}" -f $script:Version)
  Assert-ContentContains $freshInstall "pi67-bootstrap.ps1"
  Assert-ContentContains $freshInstall "pi-67 migrate --check --json"
  Assert-ContentContains $freshInstall "pi-67 update --check --json"
  Assert-ContentContains $freshInstall "never downgrade"
  Assert-ContentContains $freshInstall "27 个 Lark Skills"
  Assert-ContentContains $freshInstall "session compression"
  Assert-ContentContains $freshInstall "cross-session long-term memory"
  Assert-ContentContains $freshInstall "pi-67 xtalpi configure --verify"
  Assert-ContentNotContains $freshInstall "@earendil-works/pi-coding-agent@latest"
  Assert-ContentNotContains $freshInstall "git clone https://github.com/bigKING67/pi-67"
}

Run-Check "independent Pi and immutable pi-67 lifecycle ownership is enforced" {
  $updateCommand = RepoPath "packages/pi67-cli/src/commands/update.mjs"
  $manifest = RepoPath "packages/pi67-cli/src/data/distro-manifest.json"
  Assert-ContentNotContains $updateCommand 'runCommand("pi"'
  Assert-ContentNotContains $updateCommand 'captureCommand("pi"'
  Assert-ContentNotContains $manifest '"upstreamPi"'
  Assert-ContentContains $manifest '"policy": "manager-bundled-immutable-distro-no-github-main-clone-or-pull"'
  Assert-ContentContains $manifest '"policy": "minimum-baseline-install-missing-upgrade-safe-behind-preserve-ahead-and-diverged"'
  Assert-ContentContains (RepoPath "README.md") "Pi 与 pi-67 是两个独立产品"
  Assert-ContentContains (RepoPath "packages/pi67-cli/README.md") "never installs, updates, compares, recommends, or constrains"
  Assert-ContentContains (RepoPath "scripts/pi67-report.ps1") '[string]$StateDir'
  Assert-ContentContains (RepoPath "scripts/pi67-report.ps1") '"workspaces"'
  Assert-ContentNotContains (RepoPath "scripts/pi67-report.ps1") 'Get-CommandVersion "pi"'
  Assert-ContentNotContains (RepoPath "scripts/pi67-bootstrap.ps1") 'pi-version'
  Assert-ContentNotContains (RepoPath "README.md") "pi-67 update --repair --yes"
  Assert-ContentNotContains (RepoPath "packages/pi67-cli/README.md") "pi-67 update --repair --yes"
  Assert-ContentNotContains (RepoPath "docs/windows-fresh-install.md") "pi-67 update --repair --yes"
}

Run-Check "PowerShell xtalpi targeted smoke expanded cases are documented" {
  $expandedCaseSet = "read-package,read-enoent-recovery,plan-mode-contract,plan-mode-accepted-continuation,until-done-continuation,fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found"
  Assert-ContentContains (RepoPath "scripts/pi67-xtalpi-pi-tools-smoke.ps1") "read-package"
  Assert-ContentContains (RepoPath "scripts/pi67-xtalpi-pi-tools-smoke.ps1") "read-enoent-recovery"
  Assert-ContentContains (RepoPath "scripts/pi67-xtalpi-pi-tools-smoke.ps1") "fffind-package"
  Assert-ContentContains (RepoPath "scripts/pi67-xtalpi-pi-tools-smoke.ps1") "batch-web-fetch-example"
  Assert-ContentContains (RepoPath "scripts/pi67-xtalpi-pi-tools-smoke.ps1") "seq-thinking-status"
  Assert-ContentContains (RepoPath "docs/xtalpi-pi-tools.md") $expandedCaseSet
}

Section "Portability"
if ($GitAvailable) {
  Run-Check "git diff --check passed" {
    Invoke-External "git" @("-C", $RepoRoot, "diff", "--check") | Out-Null
  }

  Run-Check "no personal machine paths in tracked content" {
    $personalPattern = ("/Use" + "rs/" + "gao" + "qian") + "|Documents/" + ("six" + "seven") + "|" + ("gao" + "qian")
    $output = & git -C $RepoRoot grep -n -E $personalPattern "--" "." 2>&1
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
    "shared-skill-packs.json",
    "shared-skill-packs.lock.json",
    "docs/full-install.md",
    "docs/doctor-schema.md",
    "docs/report-schema.md",
    "docs/release.md",
    "docs/skill-governance.md",
    "docs/status.md",
    "docs/troubleshooting.md",
    "docs/windows-fresh-install.md",
    "docs/xtalpi-pi-tools.md",
    "docs/hy-memory.md",
    "tsconfig.hy-memory.json",
    "scripts/pi67-bootstrap.ps1",
    "scripts/pi67-doctor.ps1",
    "scripts/pi67-report.ps1",
    "scripts/pi67-smoke.ps1",
    "scripts/pi67-update.ps1",
    "scripts/pi67-windows-acceptance.ps1",
    "scripts/pi67-json-utils.ps1",
    "scripts/pi67-json-utils.cjs",
    "scripts/pi67-release-check.sh",
    "scripts/pi67-shared-skill-packs-status.mjs",
    "scripts/pi67-zero-key-startup-probe.ts",
    "scripts/pi67-zero-key-startup-smoke.ps1",
    "scripts/pi67-sync-commerce-growth-os.sh",
    "scripts/pi67-sync-commerce-skill-pack.sh",
    "scripts/pi67-sync-commerce-skill-pack.mjs",
    "packages/pi67-cli/package.json",
    "packages/pi67-cli/README.md",
    "packages/pi67-cli/CHANGELOG.md",
    "packages/pi67-cli/bin/pi-67.mjs",
    "packages/pi67-cli/scripts/build-distro-bundle.mjs",
    "packages/pi67-cli/scripts/clean-distro-bundle.mjs",
    "packages/pi67-cli/src/cli.mjs",
    "packages/pi67-cli/src/commands/migrate.mjs",
    "packages/pi67-cli/src/commands/rollback.mjs",
    "packages/pi67-cli/src/commands/self-update.mjs",
    "packages/pi67-cli/src/commands/skills.mjs",
    "packages/pi67-cli/src/commands/memory.mjs",
    "packages/pi67-cli/src/lib/memory-runtime.mjs",
    "packages/pi67-cli/src/data/managed-extension-baselines.json",
    "packages/pi67-cli/src/lib/managed-extensions.mjs",
    "packages/pi67-cli/src/lib/npm-registry.mjs",
    "packages/pi67-cli/src/lib/release-store.mjs",
    "packages/pi67-cli/src/lib/skill-policy.mjs",
    "packages/pi67-cli/src/lib/skill-pack-integrity.mjs",
    "packages/pi67-cli/src/lib/settings-runtime-clean.mjs",
    "packages/pi67-cli/src/lib/settings-runtime-state.mjs",
    "packages/pi67-cli/src/lib/xtalpi-config.mjs",
    "packages/pi67-cli/src/tools/settings-runtime-state-filter.mjs",
    "packages/pi67-cli/schemas/pi67-state.schema.json",
    "packages/pi67-cli/schemas/pi67-distro-manifest.schema.json",
    "packages/pi67-cli/schemas/pi67-update-plan.schema.json",
    "shared-skills/lark-apps/SKILL.md",
    "shared-skills/lark-note/SKILL.md",
    "scripts/pi67-xtalpi-pi-tools-smoke.ps1",
    "scripts/pi67-xtalpi-smoke-plan.mjs",
    "scripts/pi67-fuzz-xtalpi-parser.mjs",
    "scripts/pi67-shared-skills-inventory.sh",
    "extensions/xtalpi-pi-tools/json-file.ts",
    "extensions/xtalpi-pi-tools/json-action-protocol.ts",
    "extensions/xtalpi-pi-tools/vision-bridge.ts",
    "extensions/xtalpi-pi-tools/browser-bridge.ts",
    "extensions/pi-vision-bridge/index.ts",
    "extensions/pi-hy-memory/index.ts",
    "extensions/pi-hy-memory/service.py",
    ".gitattributes",
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
