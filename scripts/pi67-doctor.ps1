#!/usr/bin/env pwsh
# PowerShell-native pi-67 readiness diagnostics for Windows users.
# This intentionally avoids Bash and does not print secrets.

[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$AgentDir,
  [string]$SkillsDir,
  [switch]$Json,
  [switch]$Quiet,
  [switch]$PiList,
  [int]$PiListTimeoutSeconds = 0,
  [switch]$SkillList,
  [int]$SkillListTimeoutSeconds = 60,
  [switch]$StrictSharedSkills,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList @($false)
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
} catch {
  # Encoding setup is best-effort for Windows console readability.
}

function Show-Usage {
  @"
pi67-doctor.ps1 checks whether a PowerShell pi-67 installation is ready.

Usage:
  .\scripts\pi67-doctor.ps1 [options]

Options:
  -RepoRoot DIR        pi-67 checkout. Defaults to this script's repo.
  -AgentDir DIR        Pi agent dir. Defaults to `$HOME\.pi\agent.
  -SkillsDir DIR       Shared skills dir. Defaults to `$HOME\.agents\skills.
  -Json                Print machine-readable JSON only.
  -Quiet               Print only summary in text mode.
  -PiList              Run the non-interactive `pi list --no-approve` package probe.
  -PiListTimeoutSeconds
                       Timeout for `pi list --no-approve`. Defaults to 60.
  -SkillList           Deprecated alias for -PiList.
  -SkillListTimeoutSeconds
                       Deprecated timeout alias for -PiListTimeoutSeconds.
  -StrictSharedSkills  Treat missing/different shared skills and Skill Packs as FAIL.
  -Help                Show this help.

The PowerShell doctor does not start MCP servers. Use the Bash doctor
--deep-mcp path when deep stdio MCP probing is required.
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

$NpmDir = Join-Path $AgentDir "npm"
$script:PassCount = 0
$script:WarnCount = 0
$script:FailCount = 0
$script:Checks = @()
$UpstreamPiStatus = $null

function Add-Check {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("PASS", "WARN", "FAIL")][string]$Level,
    [Parameter(Mandatory = $true)][string]$Message
  )

  switch ($Level) {
    "PASS" { $script:PassCount += 1 }
    "WARN" { $script:WarnCount += 1 }
    "FAIL" { $script:FailCount += 1 }
  }

  $script:Checks += [ordered]@{
    level = $Level
    message = $Message
  }

  if (-not $Json -and -not $Quiet) {
    $color = switch ($Level) {
      "PASS" { "Green" }
      "WARN" { "Yellow" }
      "FAIL" { "Red" }
    }
    Write-Host ("  {0} {1}" -f $Level, $Message) -ForegroundColor $color
  }
}

function Pass { param([string]$Message) Add-Check -Level "PASS" -Message $Message }
function Warn { param([string]$Message) Add-Check -Level "WARN" -Message $Message }
function Fail { param([string]$Message) Add-Check -Level "FAIL" -Message $Message }

function Section {
  param([string]$Name)
  if (-not $Json -and -not $Quiet) {
    Write-Host ""
    Write-Host ("--- {0} ---" -f $Name) -ForegroundColor Cyan
  }
}

function Test-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
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

function Invoke-ExternalWithTimeout {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = $RepoRoot,
    [int]$TimeoutSeconds = 30
  )

  $resolved = Get-Command $FilePath -ErrorAction SilentlyContinue
  $exe = if ($resolved) { $resolved.Source } else { $FilePath }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  foreach ($arg in $Arguments) {
    [void]$psi.ArgumentList.Add($arg)
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $timedOut = $false
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit([Math]::Max(1, $TimeoutSeconds) * 1000)) {
      $timedOut = $true
      try { $process.Kill($true) } catch { try { $process.Kill() } catch {} }
      try { $process.WaitForExit(1500) | Out-Null } catch {}
    }
    try { $stdoutTask.Wait(1500) | Out-Null } catch {}
    try { $stderrTask.Wait(1500) | Out-Null } catch {}
    $stdout = if ($stdoutTask.IsCompleted) { $stdoutTask.Result } else { "" }
    $stderr = if ($stderrTask.IsCompleted) { $stderrTask.Result } else { "" }
    $text = (($stdout, $stderr) -join "")
    $lines = @($text -split "`r?`n" | Where-Object { $_ -ne "" })
    return [ordered]@{
      exitCode = if ($timedOut) { 124 } else { [int]$process.ExitCode }
      timedOut = $timedOut
      output = $lines
      text = ($lines -join "`n")
    }
  } catch {
    return [ordered]@{
      exitCode = 127
      timedOut = $false
      output = @($_.Exception.Message)
      text = $_.Exception.Message
    }
  } finally {
    try { $process.Dispose() } catch {}
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

function AgentPath {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Parts)
  $path = $AgentDir
  foreach ($part in $Parts) {
    $path = Join-Path $path $part
  }
  return $path
}

function Read-JsonFile {
  param([string]$Path)
  return Read-Pi67JsonFile $Path
}

function Test-JsonFile {
  param([string]$Path, [string]$Label)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Fail ("missing JSON: {0}" -f $Label)
    return $false
  }
  try {
    $info = Get-Pi67JsonTextInfo $Path
    $info.Text | ConvertFrom-Json | Out-Null
    if ($info.NeedsNormalization) {
      Warn ("valid JSON after compatibility decode: {0}; run pi67-update.ps1 to rewrite UTF-8 without BOM" -f $Label)
    } else {
      Pass ("valid JSON: {0}" -f $Label)
    }
    return $true
  } catch {
    Fail ("invalid JSON: {0}: {1}" -f $Label, $_.Exception.Message)
    return $false
  }
}

function Get-FileHashValue {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return "missing"
  }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-JsonPropertyValue {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $prop = $Object.PSObject.Properties[$Name]
  if ($prop) { return $prop.Value }
  return $null
}

function Test-Placeholder {
  param([object]$Value)
  if ($null -eq $Value) { return $true }
  $text = [string]$Value
  return ($text -eq "" -or $text.Contains("YOUR_") -or $text.Contains("REPLACE_") -or $text -eq "changeme")
}

function ConvertTo-Semver {
  param([string]$Value)
  if (-not $Value) { return $null }
  $text = $Value.Trim()
  if ($text.StartsWith("v")) { $text = $text.Substring(1) }
  $m = [regex]::Match($text, '([0-9]+)\.([0-9]+)\.([0-9]+)')
  if (-not $m.Success) { return $null }
  return New-Object System.Version -ArgumentList @([int]$m.Groups[1].Value, [int]$m.Groups[2].Value, [int]$m.Groups[3].Value)
}

function Test-NodeEngine {
  param([string]$CurrentNodeVersion, [string]$EngineRange)
  $current = ConvertTo-Semver $CurrentNodeVersion
  if (-not $current -or -not $EngineRange) { return $true }

  $matches = [regex]::Matches($EngineRange, '>=\s*([0-9]+\.[0-9]+\.[0-9]+)')
  foreach ($match in $matches) {
    $required = ConvertTo-Semver $match.Groups[1].Value
    if ($required -and $current.CompareTo($required) -lt 0) {
      return $false
    }
  }
  return $true
}

function Get-NpmPackageJsonPath {
  param([string]$PackageName)
  $parts = $PackageName -split "/"
  if ($parts.Count -eq 2 -and $PackageName.StartsWith("@")) {
    return Join-Path (Join-Path (Join-Path $NpmDir "node_modules") $parts[0]) (Join-Path $parts[1] "package.json")
  }
  return Join-Path (Join-Path (Join-Path $NpmDir "node_modules") $PackageName) "package.json"
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

$InstallMode = Detect-InstallMode

if (-not $Json) {
  Write-Host ""
  Write-Host "pi-67 PowerShell doctor" -ForegroundColor Cyan
  Write-Host ("Repository : {0}" -f $RepoRoot)
  Write-Host ("Agent dir  : {0}" -f $AgentDir)
  Write-Host ("Skills dir : {0}" -f $SkillsDir)
  Write-Host ("Mode       : {0}" -f $InstallMode)
}

Section "Required tools"
$NodeVersion = ""
if (Test-CommandExists "node") {
  $nodeResult = Invoke-External "node" @("-v")
  if ($nodeResult.exitCode -eq 0) {
    $NodeVersion = ($nodeResult.output | Select-Object -First 1)
    Pass ("node found: {0}" -f $NodeVersion)
  } else {
    Fail "node exists but failed to run"
  }
} else {
  Fail "node is required"
}

if (Test-CommandExists "npm") {
  $npmResult = Invoke-External "npm" @("-v")
  if ($npmResult.exitCode -eq 0) {
    Pass ("npm found: {0}" -f (($npmResult.output | Select-Object -First 1)))
  } else {
    Warn "npm exists but failed to run"
  }
} else {
  Warn "npm not found; dependency sync will not work"
}

if (Test-CommandExists "git") {
  if ($Pi67GitPathInit.AddedToPath) {
    Pass ("git found via installed Git path: {0}" -f $Pi67GitPathInit.Source)
  } else {
    Pass "git found"
  }
} else {
  Fail "git is required for update/status checks; install Git for Windows with: winget install --id Git.Git -e --source winget"
}

if ((Test-CommandExists "node") -and (Test-Path -LiteralPath (RepoPath "scripts" "pi67-upstream-pi-status.mjs") -PathType Leaf)) {
  $upstreamPiResult = Invoke-External "node" @(
    (RepoPath "scripts" "pi67-upstream-pi-status.mjs"),
    "--repo-root", $RepoRoot,
    "--agent-dir", $AgentDir,
    "--skills-dir", $SkillsDir,
    "--json",
    "--no-remote"
  )
  if ($upstreamPiResult.exitCode -eq 0) {
    try {
      $UpstreamPiStatus = $upstreamPiResult.text | ConvertFrom-Json
      switch ([string]$UpstreamPiStatus.check.level) {
        "PASS" { Pass ([string]$UpstreamPiStatus.check.message) }
        "WARN" { Warn ([string]$UpstreamPiStatus.check.message) }
        "FAIL" { Fail ([string]$UpstreamPiStatus.check.message) }
        default { Warn "upstream Pi compatibility checker returned an unknown result" }
      }
    } catch {
      Warn ("could not parse upstream Pi compatibility status: {0}" -f $_.Exception.Message)
    }
  } else {
    Warn "could not inspect upstream Pi release compatibility"
  }
} elseif (Test-CommandExists "pi") {
  $piVersion = Invoke-External "pi" @("--version")
  $versionText = if ($piVersion.exitCode -eq 0) { ($piVersion.output | Select-Object -First 1) } else { "unknown" }
  Warn ("upstream Pi compatibility checker missing; pi found: {0}" -f $versionText)
} else {
  Warn "pi command not found on PATH"
}

Section "Repository"
if (Test-Path -LiteralPath (RepoPath ".git")) {
  Pass "repository is a git checkout"
} else {
  Fail "repository .git directory missing"
}

$versionPath = RepoPath "VERSION"
$packagePath = RepoPath "package.json"
$version = ""
if (Test-Path -LiteralPath $versionPath -PathType Leaf) {
  $version = (Get-Content -LiteralPath $versionPath -Raw).Trim()
  if ($version -match '^[0-9]+\.[0-9]+\.[0-9]+') {
    Pass ("VERSION is semver-like: {0}" -f $version)
  } else {
    Warn ("VERSION is not semver-like: {0}" -f $version)
  }
} else {
  Fail "VERSION missing"
}

if (Test-JsonFile $packagePath "package.json") {
  $pkg = Read-JsonFile $packagePath
  if ($pkg.version -eq $version) {
    Pass "package.json version matches VERSION"
  } else {
    Fail ("package.json version {0} does not match VERSION {1}" -f $pkg.version, $version)
  }
}

Section "Tracked assets"
$requiredFiles = @(
  "AGENTS.md",
  "settings.json",
  "models.example.json",
  "mcp.example.json",
  "auth.example.json",
  "image-gen.example.json",
  "scripts/pi67-update.ps1",
  "scripts/pi67-doctor.ps1",
  "scripts/pi67-report.ps1",
  "scripts/pi67-smoke.ps1",
  "scripts/pi67-json-utils.ps1",
  "scripts/pi67-json-utils.cjs",
  "scripts/pi67-mcp-config-utils.cjs",
  "scripts/pi67-upstream-pi-status.mjs",
  "scripts/pi67-provider-status.mjs",
  "scripts/pi67-shared-skill-packs-status.mjs",
  "scripts/pi67-xtalpi-pi-tools-smoke.ps1",
  "extensions/xtalpi-pi-tools/json-file.ts",
  "extensions/xtalpi-pi-tools/runtime-config.ts",
  "extensions/xtalpi-pi-tools/vision-bridge.ts",
  "extensions/pi-vision-bridge/index.ts"
)
foreach ($file in $requiredFiles) {
  if (Test-Path -LiteralPath (RepoPath $file) -PathType Leaf) {
    Pass ("required file exists: {0}" -f $file)
  } else {
    Fail ("required file missing: {0}" -f $file)
  }
}

Section "Local config"
$localJson = @(
  @("models.json", (AgentPath "models.json")),
  @("mcp.json", (AgentPath "mcp.json")),
  @("auth.json", (AgentPath "auth.json")),
  @("image-gen.json", (AgentPath "image-gen.json")),
  @("settings.json", (AgentPath "settings.json"))
)
foreach ($entry in $localJson) {
  Test-JsonFile $entry[1] $entry[0] | Out-Null
}

$mcpNormalizer = RepoPath "scripts/pi67-mcp-config-utils.cjs"
$mcpPath = AgentPath "mcp.json"
if ((Test-Path -LiteralPath $mcpNormalizer -PathType Leaf) -and (Test-Path -LiteralPath $mcpPath -PathType Leaf) -and (Test-CommandExists "node")) {
  try {
    $mcpRuntimeOutput = Invoke-External "node" @($mcpNormalizer, "--inspect-runtime", "--file", $mcpPath, "--agent-dir", $AgentDir, "--json")
    $mcpRuntime = ($mcpRuntimeOutput -join "`n") | ConvertFrom-Json
    if ($mcpRuntime.issues.Count -eq 0) {
      Pass "mcp.json runtime paths are adapter-compatible"
    } else {
      foreach ($issue in @($mcpRuntime.issues)) {
        Warn ("MCP {0}.{1} uses unsupported runtime placeholder: {2}" -f $issue.server, $issue.field, $issue.value)
      }
    }
  } catch {
    Warn ("could not inspect mcp.json runtime path compatibility: {0}" -f $_.Exception.Message)
  }
} else {
  Warn "skipped mcp.json runtime path compatibility check"
}

$settingsPath = AgentPath "settings.json"
$activeProvider = ""
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
  try {
    $settings = Read-JsonFile $settingsPath
    $activeProvider = [string](Get-JsonPropertyValue $settings "defaultProvider")
  } catch {
    Fail ("could not inspect settings.json: {0}" -f $_.Exception.Message)
  }
}

$providerStatusScript = RepoPath "scripts/pi67-provider-status.mjs"
if ((Test-Path -LiteralPath $providerStatusScript -PathType Leaf) -and (Test-CommandExists "node")) {
  try {
    $providerStatusOutput = Invoke-External "node" @(
      $providerStatusScript,
      "--repo-root", $RepoRoot,
      "--agent-dir", $AgentDir,
      "--json"
    )
    $providerStatus = ($providerStatusOutput -join "`n") | ConvertFrom-Json
    foreach ($check in @($providerStatus.checks)) {
      switch ([string]$check.level) {
        "PASS" { Pass ([string]$check.message) }
        "WARN" { Warn ([string]$check.message) }
        "FAIL" { Fail ([string]$check.message) }
        default { Warn ("provider status returned unknown level {0}: {1}" -f $check.level, $check.message) }
      }
    }
  } catch {
    Fail ("could not inspect active provider readiness: {0}" -f $_.Exception.Message)
  }
} else {
  Fail "provider status checker or node is missing"
}

$modelsPath = AgentPath "models.json"
if (Test-Path -LiteralPath $modelsPath -PathType Leaf) {
  try {
    $models = Read-JsonFile $modelsPath
    $xtalpiProvider = Get-JsonPropertyValue $models.providers "xtalpi-pi-tools"
    if ($xtalpiProvider) {
      Pass "models.json has provider xtalpi-pi-tools"
      $api = Get-JsonPropertyValue $xtalpiProvider "api"
      if ($api -eq "xtalpi-pi-tools") {
        Pass "xtalpi-pi-tools api field is correct"
      } else {
        Fail ("xtalpi-pi-tools api field is {0}" -f $api)
      }
      $baseUrl = Get-JsonPropertyValue $xtalpiProvider "baseUrl"
      if ($baseUrl -eq "https://sciencetoken-api.xtalpi.xyz/proxy/openai/v1") {
        Pass "xtalpi-pi-tools baseUrl is OpenAI v1 root"
      } else {
        Warn ("xtalpi-pi-tools baseUrl differs: {0}" -f $baseUrl)
      }
      # Credential readiness is reported by pi67-provider-status.mjs above,
      # which also understands auth.json and environment-based credentials.
      # A missing xtalpi key must never be treated as a Pi startup failure.
    } else {
      if ($activeProvider -eq "xtalpi-pi-tools") {
        Fail "models.json missing active provider xtalpi-pi-tools"
      } else {
        Warn "models.json missing optional provider xtalpi-pi-tools"
      }
    }

    $codexProvider = Get-JsonPropertyValue $models.providers "codex"
    if ($codexProvider) {
      $codexModels = Get-JsonPropertyValue $codexProvider "models"
      $imageModel = $null
      if ($codexModels -is [System.Array]) {
        foreach ($model in $codexModels) {
          $inputTypes = Get-JsonPropertyValue $model "input"
          if (($inputTypes -is [System.Array]) -and ($inputTypes -contains "image")) {
            $imageModel = $model
            break
          }
        }
      }
      if ($imageModel) {
        Pass ("vision_read default image model exists under codex: {0}" -f (Get-JsonPropertyValue $imageModel "id"))
      } else {
        Warn "vision_read default provider codex has no image-input model"
      }
      $codexApiKey = Get-JsonPropertyValue $codexProvider "apiKey"
      if (Test-Placeholder $codexApiKey) {
        Warn "vision_read codex apiKey is missing or placeholder"
      } else {
        Pass "vision_read codex apiKey is configured"
      }
    } else {
      Warn "vision_read default provider codex is missing from models.json"
    }
  } catch {
    Fail ("could not inspect models.json: {0}" -f $_.Exception.Message)
  }
}

if ($activeProvider) {
  Pass ("settings.json active provider: {0}" -f $activeProvider)
}

Section "npm sync"
$agentPackage = Join-Path $NpmDir "package.json"
if ((Get-FileHashValue $packagePath) -eq (Get-FileHashValue $agentPackage)) {
  Pass "npm package.json already synced"
} else {
  Warn "npm package.json differs; run pi67-update.ps1 without -NoNpm"
}

if (Test-Path -LiteralPath $packagePath -PathType Leaf) {
  $repoPkg = Read-JsonFile $packagePath
  $dependencies = @()
  if ($repoPkg.dependencies) {
    $dependencies = @($repoPkg.dependencies.PSObject.Properties | ForEach-Object { $_.Name })
  }
  $missing = @()
  $engineWarnings = @()
  foreach ($dep in $dependencies) {
    $depPackageJson = Get-NpmPackageJsonPath $dep
    if (-not (Test-Path -LiteralPath $depPackageJson -PathType Leaf)) {
      $missing += $dep
      continue
    }
    try {
      $depPkg = Read-JsonFile $depPackageJson
      $engineNode = Get-JsonPropertyValue $depPkg.engines "node"
      if ($engineNode -and $NodeVersion -and -not (Test-NodeEngine $NodeVersion $engineNode)) {
        $engineWarnings += ("{0} requires node {1}" -f $dep, $engineNode)
      }
    } catch {
      $missing += $dep
    }
  }
  if ($missing.Count -eq 0) {
    Pass ("npm dependencies installed: {0}/{0}" -f $dependencies.Count)
  } else {
    Warn ("missing npm dependencies: {0}" -f (($missing | Select-Object -First 12) -join ", "))
  }
  if ($engineWarnings.Count -eq 0) {
    Pass "installed npm dependency node engines are satisfied"
  } else {
    foreach ($warning in ($engineWarnings | Select-Object -First 8)) {
      Warn ("node engine warning: {0}; current {1}" -f $warning, $NodeVersion)
    }
  }
}

Section "Shared skills"
$sourceSkillsRoot = RepoPath "shared-skills"
if (-not (Test-Path -LiteralPath $sourceSkillsRoot -PathType Container)) {
  Fail "shared-skills source directory missing"
} else {
  $sourceSkills = @(Get-ChildItem -LiteralPath $sourceSkillsRoot -Directory)
  Pass ("shared skill sources found: {0}" -f $sourceSkills.Count)
  $missingSkills = @()
  foreach ($skill in $sourceSkills) {
    $target = Join-Path $SkillsDir $skill.Name
    if (-not (Test-Path -LiteralPath (Join-Path $target "SKILL.md") -PathType Leaf)) {
      $missingSkills += $skill.Name
    }
  }
  if ($missingSkills.Count -eq 0) {
    Pass "all bundled shared skills have installed copies"
  } else {
    $message = "missing installed shared skills: {0}" -f (($missingSkills | Select-Object -First 12) -join ", ")
    if ($StrictSharedSkills) { Fail $message } else { Warn $message }
  }
}

$skillPackStatusScript = RepoPath "scripts" "pi67-shared-skill-packs-status.mjs"
if (-not (Test-CommandExists "node")) {
  Fail "node not found; cannot inspect shared Skill Packs"
} elseif (-not (Test-Path -LiteralPath $skillPackStatusScript -PathType Leaf)) {
  Fail "shared Skill Pack status helper missing"
} else {
  $skillPackResult = Invoke-External "node" @(
    $skillPackStatusScript,
    "--repo-root", $RepoRoot,
    "--skills-dir", $SkillsDir,
    "--json"
  ) $RepoRoot
  try {
    $skillPackStatus = $skillPackResult.text | ConvertFrom-Json
    if ($skillPackStatus.schemaId -ne "pi67-shared-skill-packs-status/v1") {
      Fail ("unexpected shared Skill Pack status schema: {0}" -f $skillPackStatus.schemaId)
    } elseif (-not $skillPackStatus.registry.valid) {
      Fail ("shared Skill Pack registry invalid: {0}" -f (@($skillPackStatus.errors) -join "; "))
    } elseif (-not $skillPackStatus.lock.valid) {
      Fail ("shared Skill Pack provenance lock invalid: {0}" -f (@($skillPackStatus.errors) -join "; "))
    } elseif (@($skillPackStatus.packs).Count -eq 0) {
      Warn "shared Skill Pack registry has no registered packs"
    } else {
      foreach ($pack in @($skillPackStatus.packs)) {
        if ($pack.consistent) {
          $sourceCommit = if ($pack.provenance.sourceCommit) { $pack.provenance.sourceCommit.Substring(0, [Math]::Min(12, $pack.provenance.sourceCommit.Length)) } else { "unknown" }
          Pass ("shared Skill Pack consistent: {0}@{1} ({2} skills, source {3})" -f $pack.name, $pack.version, $pack.skills, $sourceCommit)
        } else {
          $message = "shared Skill Pack differs: {0}@{1}; missing={2}, conflicts={3}; run pi-67 skills packs; preview: {4}" -f $pack.name, $pack.version, $pack.missing, $pack.conflicts, $pack.commands.preview
          if ($StrictSharedSkills) { Fail $message } else { Warn $message }
        }
      }
    }
  } catch {
    Fail ("could not inspect shared Skill Packs: {0}" -f $_.Exception.Message)
  }
}

Section "Extension runtime compatibility"
$untilDoneQueueChecker = RepoPath "scripts/pi67-patch-pi-until-done-runtime-queue.mjs"
if (-not (Test-CommandExists "node")) {
  Warn "node not found; skipped pi-until-done runtime queue/progress compatibility check"
} elseif (-not (Test-Path -LiteralPath $untilDoneQueueChecker -PathType Leaf)) {
  Warn "pi-until-done runtime queue checker missing"
} else {
  $queueResult = Invoke-External "node" @($untilDoneQueueChecker, "--check", "--agent-dir", $AgentDir, "--json") $RepoRoot
  try {
    $queue = $queueResult.text | ConvertFrom-Json
    if ($queueResult.exitCode -eq 0) {
      if ($queue.status -eq "missing") {
        Warn $queue.message
      } else {
        Pass $queue.message
      }
    } elseif ($queue.status -eq "review_required") {
      Warn $queue.message
    } else {
      Fail $queue.message
    }
  } catch {
    if ($queueResult.exitCode -eq 0) {
      Pass "pi-until-done runtime queue/progress compatibility check completed"
    } else {
      Fail "pi-until-done runtime queue/progress compatibility check failed"
    }
  }
}

Section "xtalpi endpoint contract"
$runtimeConfig = RepoPath "extensions/xtalpi-pi-tools/runtime-config.ts"
$providerHealth = RepoPath "scripts/pi67-xtalpi-provider-health.mjs"
if ((Test-Path -LiteralPath $runtimeConfig -PathType Leaf) -and (Test-Path -LiteralPath $providerHealth -PathType Leaf)) {
  $runtimeText = Get-Content -LiteralPath $runtimeConfig -Raw
  $healthText = Get-Content -LiteralPath $providerHealth -Raw
  if ($runtimeText.Contains("/chat/completions") -and $healthText.Contains("/chat/completions")) {
    Pass "xtalpi-pi-tools uses /chat/completions"
  } else {
    Fail "xtalpi-pi-tools chat/completions endpoint marker missing"
  }
  if ($runtimeText.Contains("/responses") -or $healthText.Contains("/responses") -or $runtimeText.Contains("/response/completions") -or $healthText.Contains("/response/completions")) {
    Fail "xtalpi-pi-tools contains disallowed responses endpoint marker"
  } else {
    Pass "xtalpi-pi-tools does not use responses endpoint markers"
  }
}

$RunPiList = [bool]($PiList -or $SkillList)
$EffectivePiListTimeoutSeconds = if ($PiListTimeoutSeconds -gt 0) { $PiListTimeoutSeconds } else { $SkillListTimeoutSeconds }
if ($RunPiList) {
  Section "Pi package registry"
  if (Test-CommandExists "pi") {
    $piListResult = Invoke-ExternalWithTimeout "pi" @("list", "--no-approve") $AgentDir $EffectivePiListTimeoutSeconds
    if ($piListResult.exitCode -eq 0) {
      $text = $piListResult.text
      if ($text -match "(warning|error|duplicate|conflict|skipped)") {
        Warn "pi list reported package/resource warnings"
      } else {
        Pass "pi list completed without package/resource warnings"
      }
    } elseif ($piListResult.timedOut) {
      Warn ("pi list exceeded {0}s; skipped package registry check" -f $EffectivePiListTimeoutSeconds)
    } else {
      Warn "pi list failed"
    }
  } else {
    Warn "pi command not found; skipped pi list"
  }
}

$result = if ($script:FailCount -gt 0) {
  "NOT READY"
} elseif ($script:WarnCount -gt 0) {
  "READY WITH WARNINGS"
} else {
  "READY"
}

if ($Json) {
  [ordered]@{
    schemaVersion = 2
    schemaId = "pi67-doctor/v2"
    generatedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    generatedBy = "scripts/pi67-doctor.ps1"
    pi67 = [ordered]@{
      version = $version
    }
    upstreamPi = $UpstreamPiStatus
    diagnostics = [ordered]@{
      deepMcp = $false
      mcpTimeoutMs = 0
      piList = $RunPiList
      piListTimeoutSeconds = [int]$EffectivePiListTimeoutSeconds
      skillList = $RunPiList
      skillListTimeoutSeconds = [int]$EffectivePiListTimeoutSeconds
      strictSharedSkills = [bool]$StrictSharedSkills
    }
    installMode = $InstallMode
    repository = $RepoRoot
    agentDir = $AgentDir
    agent = [ordered]@{
      dir = $AgentDir
      installMode = $InstallMode
    }
    result = $result
    counts = [ordered]@{
      pass = $script:PassCount
      warn = $script:WarnCount
      fail = $script:FailCount
    }
    checks = $script:Checks
  } | ConvertTo-Json -Depth 8
} else {
  Write-Host ""
  Write-Host "Summary" -ForegroundColor Cyan
  Write-Host ("  PASS: {0}" -f $script:PassCount)
  Write-Host ("  WARN: {0}" -f $script:WarnCount)
  Write-Host ("  FAIL: {0}" -f $script:FailCount)
  $color = if ($result -eq "NOT READY") { "Red" } elseif ($result -eq "READY WITH WARNINGS") { "Yellow" } else { "Green" }
  Write-Host ("Result: {0}" -f $result) -ForegroundColor $color
}

if ($script:FailCount -gt 0) {
  exit 1
}
exit 0
