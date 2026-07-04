#!/usr/bin/env pwsh
# PowerShell-native targeted xtalpi-pi-tools live smoke for Windows users.
# This runner intentionally covers only low-risk extension cases; the Bash
# runner remains the full-suite gate.

[CmdletBinding()]
param(
  [string[]]$Case = @(),
  [switch]$ListCases,
  [switch]$SelfTest,
  [switch]$Json,
  [switch]$NoPreflight,
  [switch]$Help,
  [string]$Provider = "",
  [string]$Model = "",
  [string]$PiBin = "",
  [string]$AgentDir = "",
  [string]$OutDir = "",
  [int]$CaseTimeoutSeconds = 0,
  [int]$RequestTimeoutMs = 0,
  [int]$MaxOutputTokens = 0,
  [int]$PreflightTimeoutMs = 0,
  [int]$PreflightAttempts = 0,
  [int]$PreflightRetryDelayMs = 0,
  [string]$SummaryFile = ""
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
pi67-xtalpi-pi-tools-smoke.ps1 runs low-risk xtalpi live smoke cases from
PowerShell without Bash.

Usage:
  .\scripts\pi67-xtalpi-pi-tools-smoke.ps1 [-Case "mcp-status,subagent-list"]
  .\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -ListCases
  .\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -SelfTest

Supported cases:
  mcp-status
  subagent-list
  recall-not-found

Options:
  -Case NAME[,NAME]       Target cases. Defaults to all supported cases.
  -ListCases              Print supported case names.
  -SelfTest               Run offline parser/summary self-test.
  -NoPreflight            Skip xtalpi provider-health preflight.
  -Json                   Print final summary JSON only.
  -Provider ID            Provider id. Default: xtalpi-pi-tools.
  -Model ID               Model id. Default: deepseek-v4-pro.
  -PiBin PATH             Pi executable. Default: PI_BIN env or pi on PATH.
  -AgentDir PATH          Agent/repo root. Default: PI_AGENT_DIR env or repo root.
  -OutDir PATH            Artifact dir. Default: OUT_DIR env or temp dir.
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
$ScriptDir = Split-Path -Parent $ScriptPath
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$ArtifactCorePath = Join-Path $ScriptDir "pi67-xtalpi-smoke-artifact-core.cjs"
$ProviderHealthScript = Join-Path $ScriptDir "pi67-xtalpi-provider-health.mjs"

$AvailableCases = @("mcp-status", "subagent-list", "recall-not-found")
$CaseDefinitions = @{
  "mcp-status" = [ordered]@{
    tool = "mcp"
    expectedTools = @("mcp")
    requiredFinalText = @("EXTENSION_SMOKE_MCP_STATUS_OK", "MCP")
    prompt = "This is targeted extension smoke. Use only the mcp tool to inspect MCP gateway/status. Arguments must be an empty object {}. Do not connect, auth, or call any MCP server/tool. Do not call read, bash, web_fetch, or any other tool. Final answer must include EXTENSION_SMOKE_MCP_STATUS_OK and MCP."
  }
  "subagent-list" = [ordered]@{
    tool = "subagent"
    expectedTools = @("subagent")
    requiredFinalText = @("EXTENSION_SMOKE_SUBAGENT_LIST_OK")
    prompt = "This is targeted extension smoke. Use only the subagent tool for the read-only management action list. Arguments must be {`"action`":`"list`"}. Do not execute agent, task, chain, tasks, parallel, resume, interrupt, or append-step. Do not start child agents. Do not call read, bash, web_fetch, or any other tool. Final answer must include EXTENSION_SMOKE_SUBAGENT_LIST_OK."
  }
  "recall-not-found" = [ordered]@{
    tool = "recall"
    expectedTools = @("recall")
    requiredFinalText = @("EXTENSION_SMOKE_RECALL_NOT_FOUND_OK")
    prompt = "This is targeted extension smoke. Use only the recall tool to query observation id `"deadbeef0000`". This id is a smoke sentinel and may return not found. Do not call read, bash, web_fetch, or any other tool. Do not search other memory. Final answer must include EXTENSION_SMOKE_RECALL_NOT_FOUND_OK."
  }
}

function Env-OrDefault {
  param([string]$Name, [string]$Default)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value
}

function Int-OrDefault {
  param([int]$Value, [string]$EnvName, [int]$Default)
  if ($Value -gt 0) { return $Value }
  $envValue = [Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrWhiteSpace($envValue)) {
    $parsed = 0
    if ([int]::TryParse($envValue, [ref]$parsed) -and $parsed -gt 0) {
      return $parsed
    }
  }
  return $Default
}

function Resolve-PiBin {
  param([string]$Candidate)
  if (-not [string]::IsNullOrWhiteSpace($Candidate)) { return $Candidate }
  $fromEnv = [Environment]::GetEnvironmentVariable("PI_BIN")
  if (-not [string]::IsNullOrWhiteSpace($fromEnv)) { return $fromEnv }
  $command = Get-Command "pi" -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return ""
}

function Parse-CaseList {
  param([string[]]$RawCases)
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($raw in $RawCases) {
    if ([string]::IsNullOrWhiteSpace($raw)) { continue }
    foreach ($part in ($raw -split ",")) {
      $trimmed = $part.Trim()
      if (-not [string]::IsNullOrWhiteSpace($trimmed) -and -not $items.Contains($trimmed)) {
        $items.Add($trimmed)
      }
    }
  }
  return @($items)
}

function Read-JsonlEvents {
  param([string]$Path)
  $events = @()
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $events }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      $events += ($line | ConvertFrom-Json)
    } catch {
      $events += [pscustomobject]@{ type = "parse_error"; raw = $line.Substring(0, [Math]::Min(200, $line.Length)) }
    }
  }
  return $events
}

function Write-JsonFile {
  param([string]$Path, [object]$Value)
  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Contains-RawPiToolMarkup {
  param([string]$Text)
  return [regex]::IsMatch([string]$Text, '(?:</?pi_tool_(?:call_history|call|result)\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|\[/?previous_pi_tool_call\])', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Get-FinalAssistantText {
  param([object[]]$Events)
  $agentEvents = @($Events | Where-Object { $_.type -eq "agent_end" })
  if ($agentEvents.Count -eq 0) { return "" }
  $agent = $agentEvents[$agentEvents.Count - 1]
  $messages = @($agent.messages)
  $assistantMessages = @($messages | Where-Object { $_.role -eq "assistant" })
  if ($assistantMessages.Count -eq 0) { return "" }
  $message = $assistantMessages[$assistantMessages.Count - 1]
  if ($message.content -is [string]) { return [string]$message.content }
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($block in @($message.content)) {
    if ($block.type -eq "text" -and $null -ne $block.text) {
      $parts.Add([string]$block.text)
    }
  }
  return ($parts -join "`n")
}

function Summarize-CaseArtifact {
  param(
    [string]$CaseName,
    [object]$Definition,
    [string]$OutFile,
    [string]$ErrFile,
    [string]$DebugFile,
    [int]$ExitStatus,
    [int]$ElapsedSeconds,
    [bool]$TimedOut
  )

  $events = @(Read-JsonlEvents $OutFile)
  $debugEvents = @(Read-JsonlEvents $DebugFile)
  $toolStarts = @($events | Where-Object { $_.type -eq "tool_execution_start" })
  $actualToolNames = @($toolStarts | ForEach-Object { [string]$_.toolName } | Where-Object { $_ })
  $expectedTools = @($Definition.expectedTools)
  $unexpectedTools = @($actualToolNames | Where-Object { $expectedTools -notcontains $_ } | Select-Object -Unique)
  $missingTools = @($expectedTools | Where-Object { $actualToolNames -notcontains $_ })
  $finalText = Get-FinalAssistantText $events
  $missingFinalText = @($Definition.requiredFinalText | Where-Object { -not $finalText.Contains($_) })
  $errors = @($events | Where-Object { $_.type -eq "error" -or $_.message.stopReason -eq "error" -or $_.message.errorMessage })
  $debugTelemetryOk = $debugEvents.Count -gt 0
  if ($debugTelemetryOk) {
    foreach ($event in $debugEvents) {
      if ($event.type -eq "parse_error") { $debugTelemetryOk = $false }
      if ($event.schema -ne "xtalpi-pi-tools.debug.v1" -or -not $event.event) { $debugTelemetryOk = $false }
    }
  }
  $rawMarkup = Contains-RawPiToolMarkup $finalText
  $finalAnswerOk = $finalText.Trim().Length -gt 0 -and -not $rawMarkup -and $missingFinalText.Count -eq 0
  $toolExpectationOk = $missingTools.Count -eq 0 -and $unexpectedTools.Count -eq 0
  $ok = $ExitStatus -eq 0 -and -not $TimedOut -and $toolExpectationOk -and $finalAnswerOk -and $errors.Count -eq 0 -and $debugTelemetryOk

  return [ordered]@{
    schema = "xtalpi-pi-tools.powershell-case-summary.v1"
    caseName = $CaseName
    ok = $ok
    exitStatus = $ExitStatus
    elapsedSeconds = $ElapsedSeconds
    timedOutByWatchdog = $TimedOut
    expectedTools = $expectedTools
    actualToolNames = $actualToolNames
    missingTools = $missingTools
    unexpectedTools = $unexpectedTools
    toolStarts = @($toolStarts | ForEach-Object { "{0}:{1}" -f $_.toolName, ($_.args | ConvertTo-Json -Compress -Depth 8) })
    debugTelemetryOk = $debugTelemetryOk
    debugEventCount = $debugEvents.Count
    requiredFinalText = @($Definition.requiredFinalText)
    missingFinalText = $missingFinalText
    finalAnswerQualityOk = $finalAnswerOk
    finalAnswerRawToolMarkup = $rawMarkup
    errors = @($errors | ForEach-Object { if ($_.message.errorMessage) { $_.message.errorMessage } elseif ($_.error) { $_.error } else { $_.message } })
    stdoutFile = $OutFile
    stderrFile = $ErrFile
    debugFile = $DebugFile
    finalText = if ($finalText.Length -gt 500) { $finalText.Substring(0, 500) } else { $finalText }
  }
}

function Invoke-PiCase {
  param(
    [string]$CaseName,
    [object]$Definition,
    [string]$Stamp,
    [string]$ResolvedPiBin,
    [string]$ResolvedAgentDir,
    [string]$ResolvedOutDir,
    [int]$ResolvedCaseTimeoutSeconds,
    [int]$ResolvedRequestTimeoutMs,
    [int]$ResolvedMaxOutputTokens,
    [string]$ResolvedProvider,
    [string]$ResolvedModel
  )

  $outFile = Join-Path $ResolvedOutDir ("{0}-{1}.jsonl" -f $Stamp, $CaseName)
  $errFile = Join-Path $ResolvedOutDir ("{0}-{1}.stderr" -f $Stamp, $CaseName)
  $debugFile = Join-Path $ResolvedOutDir ("{0}-{1}.debug.jsonl" -f $Stamp, $CaseName)
  $exitFile = Join-Path $ResolvedOutDir ("{0}-{1}.exit" -f $Stamp, $CaseName)

  $args = @(
    "--provider", $ResolvedProvider,
    "--model", $ResolvedModel,
    "--thinking", "off",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--mode", "json",
    "--no-session",
    "--tools", [string]$Definition.tool
  )

  $envMap = @{
    XTALPI_PI_TOOLS_TIMEOUT_MS = [string]$ResolvedRequestTimeoutMs
    XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS = [string]$ResolvedMaxOutputTokens
    XTALPI_PI_TOOLS_DEBUG = "1"
    XTALPI_PI_TOOLS_DEBUG_PATH = $debugFile
  }

  $startedAt = Get-Date
  $job = Start-Job -ScriptBlock {
    param($PiBinArg, $PiArgs, $PromptArg, $WorkingDir, $StdoutPath, $StderrPath, $ExitPath, $EnvValues)
    try {
      Set-Location -LiteralPath $WorkingDir
      foreach ($key in $EnvValues.Keys) {
        Set-Item -Path ("Env:{0}" -f $key) -Value ([string]$EnvValues[$key])
      }
      & $PiBinArg @PiArgs -p $PromptArg > $StdoutPath 2> $StderrPath
      $code = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
      Set-Content -LiteralPath $ExitPath -Value ([string]$code) -Encoding ASCII
    } catch {
      $_.Exception.Message | Set-Content -LiteralPath $StderrPath -Encoding UTF8
      Set-Content -LiteralPath $ExitPath -Value "1" -Encoding ASCII
    }
  } -ArgumentList $ResolvedPiBin, $args, ([string]$Definition.prompt), $ResolvedAgentDir, $outFile, $errFile, $exitFile, $envMap

  $completed = Wait-Job $job -Timeout $ResolvedCaseTimeoutSeconds
  $timedOut = $false
  $exitStatus = 1
  if ($null -eq $completed) {
    $timedOut = $true
    Stop-Job $job -ErrorAction SilentlyContinue
    $exitStatus = 124
  } else {
    Receive-Job $job -ErrorAction SilentlyContinue | Out-Null
    if (Test-Path -LiteralPath $exitFile -PathType Leaf) {
      $rawExit = (Get-Content -LiteralPath $exitFile -Raw).Trim()
      $parsedExit = 1
      if ([int]::TryParse($rawExit, [ref]$parsedExit)) {
        $exitStatus = $parsedExit
      }
    }
  }
  Remove-Job $job -Force -ErrorAction SilentlyContinue
  $elapsedSeconds = [int][Math]::Ceiling(((Get-Date) - $startedAt).TotalSeconds)

  return Summarize-CaseArtifact `
    -CaseName $CaseName `
    -Definition $Definition `
    -OutFile $outFile `
    -ErrFile $errFile `
    -DebugFile $debugFile `
    -ExitStatus $exitStatus `
    -ElapsedSeconds $elapsedSeconds `
    -TimedOut $timedOut
}

function Run-SelfTest {
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pi67-xtalpi-pwsh-self-test-{0}" -f ([Guid]::NewGuid().ToString("N")))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $out = Join-Path $tmp "good.jsonl"
    $debug = Join-Path $tmp "good.debug.jsonl"
    $err = Join-Path $tmp "good.stderr"
    @(
      @{ type = "tool_execution_start"; toolName = "mcp"; args = @{} },
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = "EXTENSION_SMOKE_MCP_STATUS_OK MCP" }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $out -Encoding UTF8
    @{ schema = "xtalpi-pi-tools.debug.v1"; event = "turn.start"; event_category = "turn" } | ConvertTo-Json -Compress | Set-Content -LiteralPath $debug -Encoding UTF8
    "" | Set-Content -LiteralPath $err -Encoding UTF8
    $summary = Summarize-CaseArtifact "mcp-status" $CaseDefinitions["mcp-status"] $out $err $debug 0 1 $false
    if ($summary.ok -ne $true) { throw "expected good fixture to pass" }

    $badOut = Join-Path $tmp "bad.jsonl"
    @(
      @{ type = "tool_execution_start"; toolName = "bash"; args = @{ command = "pwd" } },
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = "EXTENSION_SMOKE_MCP_STATUS_OK MCP" }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $badOut -Encoding UTF8
    $bad = Summarize-CaseArtifact "mcp-status" $CaseDefinitions["mcp-status"] $badOut $err $debug 0 1 $false
    if ($bad.ok -eq $true) { throw "expected unexpected tool fixture to fail" }

    $markupOut = Join-Path $tmp "markup.jsonl"
    @(
      @{ type = "tool_execution_start"; toolName = "mcp"; args = @{} },
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = "<pi_tool_call>{}</pi_tool_call> EXTENSION_SMOKE_MCP_STATUS_OK MCP" }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $markupOut -Encoding UTF8
    $markup = Summarize-CaseArtifact "mcp-status" $CaseDefinitions["mcp-status"] $markupOut $err $debug 0 1 $false
    if ($markup.ok -eq $true) { throw "expected raw markup fixture to fail" }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not $Json) {
    Write-Host "xtalpi-pi-tools PowerShell smoke self-test passed" -ForegroundColor Green
  }
}

if ($ListCases) {
  $AvailableCases | ForEach-Object { Write-Output $_ }
  exit 0
}

if ($SelfTest) {
  Run-SelfTest
  exit 0
}

$ResolvedProvider = Env-OrDefault "PROVIDER" "xtalpi-pi-tools"
if (-not [string]::IsNullOrWhiteSpace($Provider)) { $ResolvedProvider = $Provider }
$ResolvedModel = Env-OrDefault "MODEL" "deepseek-v4-pro"
if (-not [string]::IsNullOrWhiteSpace($Model)) { $ResolvedModel = $Model }
$ResolvedPiBin = Resolve-PiBin $PiBin
$ResolvedAgentDir = Env-OrDefault "PI_AGENT_DIR" $RepoRoot
if (-not [string]::IsNullOrWhiteSpace($AgentDir)) { $ResolvedAgentDir = $AgentDir }
$ResolvedOutDir = Env-OrDefault "OUT_DIR" (Join-Path ([System.IO.Path]::GetTempPath()) "xtalpi-pi-tools-smoke")
if (-not [string]::IsNullOrWhiteSpace($OutDir)) { $ResolvedOutDir = $OutDir }
$ResolvedCaseTimeoutSeconds = Int-OrDefault $CaseTimeoutSeconds "CASE_TIMEOUT_SECONDS" 240
$ResolvedRequestTimeoutMs = Int-OrDefault $RequestTimeoutMs "XTALPI_PI_TOOLS_SMOKE_REQUEST_TIMEOUT_MS" 180000
$ResolvedMaxOutputTokens = Int-OrDefault $MaxOutputTokens "XTALPI_PI_TOOLS_SMOKE_MAX_OUTPUT_TOKENS" 1024
if ($RequestTimeoutMs -le 0 -and [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("XTALPI_PI_TOOLS_SMOKE_REQUEST_TIMEOUT_MS"))) {
  $ResolvedRequestTimeoutMs = Int-OrDefault 0 "XTALPI_PI_TOOLS_TIMEOUT_MS" $ResolvedRequestTimeoutMs
}
if ($MaxOutputTokens -le 0 -and [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable("XTALPI_PI_TOOLS_SMOKE_MAX_OUTPUT_TOKENS"))) {
  $ResolvedMaxOutputTokens = Int-OrDefault 0 "XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS" $ResolvedMaxOutputTokens
}
$ResolvedPreflightTimeoutMs = Int-OrDefault $PreflightTimeoutMs "XTALPI_PI_TOOLS_SMOKE_PREFLIGHT_TIMEOUT_MS" 30000
$ResolvedPreflightAttempts = Int-OrDefault $PreflightAttempts "XTALPI_PI_TOOLS_SMOKE_PREFLIGHT_ATTEMPTS" 2
$ResolvedPreflightRetryDelayMs = Int-OrDefault $PreflightRetryDelayMs "XTALPI_PI_TOOLS_SMOKE_PREFLIGHT_RETRY_DELAY_MS" 1000
$preflightEnv = Env-OrDefault "XTALPI_PI_TOOLS_SMOKE_PREFLIGHT" "1"
$PreflightEnabled = -not $NoPreflight -and $preflightEnv -notmatch '^(0|false|no|off)$'

$caseEnv = [Environment]::GetEnvironmentVariable("XTALPI_PI_TOOLS_SMOKE_CASES")
$selectedCases = Parse-CaseList (@($Case) + @($caseEnv))
if ($selectedCases.Count -eq 0) {
  $selectedCases = $AvailableCases
}

foreach ($name in $selectedCases) {
  if ($AvailableCases -notcontains $name) {
    [Console]::Error.WriteLine(("unknown xtalpi-pi-tools PowerShell smoke case: {0}. Available: {1}" -f $name, ($AvailableCases -join ", ")))
    exit 2
  }
}

if ([string]::IsNullOrWhiteSpace($ResolvedPiBin)) {
  [Console]::Error.WriteLine("pi executable not found; set -PiBin or PI_BIN")
  exit 2
}
if (-not (Test-Path -LiteralPath $ResolvedAgentDir -PathType Container)) {
  [Console]::Error.WriteLine("AgentDir does not exist: $ResolvedAgentDir")
  exit 2
}
$ResolvedAgentDir = (Resolve-Path $ResolvedAgentDir).Path
if (-not (Test-Path -LiteralPath $ResolvedAgentDir -PathType Container)) {
  [Console]::Error.WriteLine("AgentDir does not exist: $ResolvedAgentDir")
  exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $ResolvedAgentDir "package.json") -PathType Leaf)) {
  [Console]::Error.WriteLine("package.json not found under AgentDir: $ResolvedAgentDir")
  exit 2
}
if (-not (Test-Path -LiteralPath $ArtifactCorePath -PathType Leaf)) {
  [Console]::Error.WriteLine("missing artifact core helper: $ArtifactCorePath")
  exit 2
}
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine("node is required for provider preflight and release parity checks")
  exit 2
}

New-Item -ItemType Directory -Force -Path $ResolvedOutDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if ([string]::IsNullOrWhiteSpace($SummaryFile)) {
  $SummaryFile = Env-OrDefault "XTALPI_PI_TOOLS_SMOKE_SUMMARY_FILE" (Join-Path $ResolvedOutDir ("{0}-powershell-summary.json" -f $Stamp))
}
$ProviderHealthFile = Join-Path $ResolvedOutDir ("{0}-powershell-provider-health.json" -f $Stamp)

if (-not $Json) {
  Write-Host ""
  Write-Host "xtalpi-pi-tools PowerShell targeted smoke" -ForegroundColor Cyan
  Write-Host ("Repository: {0}" -f $ResolvedAgentDir)
  Write-Host ("Cases     : {0}" -f ($selectedCases -join ","))
}

$providerHealth = $null
$failures = 0
$stopReason = "none"

if ($PreflightEnabled) {
  if (-not $Json) { Write-Host "===== provider-health =====" -ForegroundColor Cyan }
  $healthArgs = @(
    $ProviderHealthScript,
    "--agent-dir", $ResolvedAgentDir,
    "--provider", $ResolvedProvider,
    "--model", $ResolvedModel,
    "--timeout-ms", [string]$ResolvedPreflightTimeoutMs,
    "--attempts", [string]$ResolvedPreflightAttempts,
    "--retry-delay-ms", [string]$ResolvedPreflightRetryDelayMs,
    "--output-file", $ProviderHealthFile
  )
  $healthOutput = & node @healthArgs 2>&1
  $healthStatus = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  if (-not $Json) {
    $healthOutput | ForEach-Object { Write-Output $_ }
  }
  if (Test-Path -LiteralPath $ProviderHealthFile -PathType Leaf) {
    $providerHealth = Get-Content -LiteralPath $ProviderHealthFile -Raw | ConvertFrom-Json
  }
  if ($healthStatus -ne 0) {
    $failures += 1
    $stopReason = "provider_health_failed"
  }
}

$caseSummaries = @()
if ($failures -eq 0) {
  foreach ($name in $selectedCases) {
    if (-not $Json) { Write-Host ("===== {0} =====" -f $name) -ForegroundColor Cyan }
    $summary = Invoke-PiCase `
      -CaseName $name `
      -Definition $CaseDefinitions[$name] `
      -Stamp $Stamp `
      -ResolvedPiBin $ResolvedPiBin `
      -ResolvedAgentDir $ResolvedAgentDir `
      -ResolvedOutDir $ResolvedOutDir `
      -ResolvedCaseTimeoutSeconds $ResolvedCaseTimeoutSeconds `
      -ResolvedRequestTimeoutMs $ResolvedRequestTimeoutMs `
      -ResolvedMaxOutputTokens $ResolvedMaxOutputTokens `
      -ResolvedProvider $ResolvedProvider `
      -ResolvedModel $ResolvedModel
    $caseSummaries += [pscustomobject]$summary
    if (-not $summary.ok) { $failures += 1 }
    if (-not $Json) {
      $summary | ConvertTo-Json -Depth 10
    }
  }
}

$result = [ordered]@{
  schema = "xtalpi-pi-tools.powershell-smoke-summary.v1"
  createdAt = (Get-Date).ToUniversalTime().ToString("o")
  provider = $ResolvedProvider
  model = $ResolvedModel
  stamp = $Stamp
  runKind = "targeted"
  platform = "powershell"
  repository = $ResolvedAgentDir
  outDir = $ResolvedOutDir
  selectedCases = $selectedCases
  caseTimeoutSeconds = $ResolvedCaseTimeoutSeconds
  requestTimeoutMs = $ResolvedRequestTimeoutMs
  maxOutputTokens = $ResolvedMaxOutputTokens
  providerHealthPreflight = $PreflightEnabled
  providerHealth = $providerHealth
  stopReason = $stopReason
  failures = $failures
  ok = $failures -eq 0
  cases = $caseSummaries
}

Write-JsonFile $SummaryFile ([pscustomobject]$result)

if ($Json) {
  Get-Content -LiteralPath $SummaryFile -Raw
} else {
  Write-Host "===== summary =====" -ForegroundColor Cyan
  Write-Host ("provider={0} model={1} out_dir={2} stamp={3} selected_cases={4} failures={5}" -f $ResolvedProvider, $ResolvedModel, $ResolvedOutDir, $Stamp, ($selectedCases -join ","), $failures)
  Write-Host ("summary_json={0}" -f $SummaryFile)
  if ($failures -eq 0) {
    Write-Host "Result: PASS" -ForegroundColor Green
  } else {
    Write-Host "Result: FAIL" -ForegroundColor Red
  }
}

if ($failures -gt 0) {
  exit 1
}
exit 0
