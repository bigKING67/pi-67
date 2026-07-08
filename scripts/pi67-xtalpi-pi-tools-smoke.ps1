#!/usr/bin/env pwsh
# PowerShell-native targeted xtalpi-pi-tools live smoke for Windows users.
# This runner intentionally covers only low-risk targeted cases; the Bash runner
# remains the full-suite gate.

[CmdletBinding()]
param(
  [string[]]$Case = @(),
  [string[]]$Profile = @(),
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
  [int]$CaseRetries = -1,
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
  .\scripts\pi67-xtalpi-pi-tools-smoke.ps1 [-Case "read-package,plan-mode-contract,fffind-package"]
  .\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -Profile extension-low-risk
  .\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -ListCases
  .\scripts\pi67-xtalpi-pi-tools-smoke.ps1 -SelfTest

Supported cases:
  read-package
  plan-mode-contract
  until-done-continuation
  fffind-package
  ffgrep-package
  batch-web-fetch-example
  seq-thinking-status
  mcp-status
  subagent-list
  recall-not-found

Options:
  -Case NAME[,NAME]       Target cases. Defaults to all supported cases.
  -Profile NAME[,NAME]    quick, full-suite, extension-low-risk, or extension-expanded.
  -ListCases              Print supported case names.
  -SelfTest               Run offline parser/summary self-test.
  -NoPreflight            Skip xtalpi provider-health preflight.
  -Json                   Print final summary JSON only.
  -Provider ID            Provider id. Default: xtalpi-pi-tools.
  -Model ID               Model id. Default: deepseek-v4-pro.
  -PiBin PATH             Pi executable. Default: PI_BIN env or pi on PATH.
  -AgentDir PATH          Agent/repo root. Default: PI_AGENT_DIR env or repo root.
  -OutDir PATH            Artifact dir. Default: OUT_DIR env or temp dir.
  -CaseRetries N          Retry final-answer-only transient case failures. Default: 1.

Environment:
  XTALPI_PI_TOOLS_SMOKE_OBSERVATIONAL_MEMORY_PASSIVE
                         Set PI_OBSERVATIONAL_MEMORY_PASSIVE=true for smoke child
                         processes unless explicitly set to 0/false/no/off.
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
$ProtocolBoundaryCorePath = Join-Path $ScriptDir "pi67-xtalpi-protocol-boundary-core.cjs"
$ProviderHealthScript = Join-Path $ScriptDir "pi67-xtalpi-provider-health.mjs"

$AvailableCases = @(
  "read-package",
  "plan-mode-contract",
  "until-done-continuation",
  "fffind-package",
  "ffgrep-package",
  "batch-web-fetch-example",
  "seq-thinking-status",
  "mcp-status",
  "subagent-list",
  "recall-not-found"
)
$AvailableProfiles = @(
  "quick",
  "full-suite",
  "extension-low-risk",
  "extension-expanded"
)
$ProfileCaseMap = @{
  "quick" = @("read-package")
  "full-suite" = $AvailableCases
  "extension-low-risk" = @("mcp-status", "subagent-list", "recall-not-found")
  "extension-expanded" = @(
    "fffind-package",
    "ffgrep-package",
    "batch-web-fetch-example",
    "seq-thinking-status",
    "mcp-status",
    "subagent-list",
    "recall-not-found"
  )
}
$CaseDefinitions = @{
  "read-package" = [ordered]@{
    tool = "read"
    expectedTools = @("read")
    requiredFinalText = @("EXTENSION_SMOKE_READ_PACKAGE_OK", "pi-extensions")
    argCheck = "read-package"
    prompt = "This is targeted portability smoke. Use only the read tool to read the current workspace relative path package.json. The read path argument must be exactly `"package.json`"; do not use any absolute path. Do not call bash, web_fetch, fffind, ffgrep, or any other tool. Final answer must include EXTENSION_SMOKE_READ_PACKAGE_OK and pi-extensions."
  }
  "plan-mode-contract" = [ordered]@{
    tool = "read"
    expectedTools = @()
    requiredFinalText = @("<proposed_plan>", "</proposed_plan>")
    prompt = "Plan mode: planning`nProduce a <proposed_plan> block.`n`nThis is targeted plan-mode smoke. Do not call any tool. The final answer must be exactly one complete <proposed_plan>...</proposed_plan> block with 2-3 steps: inspect real state, propose minimal change, verify result. Do not echo Pi protocol, tool history, or tool-selection instructions."
  }
  "until-done-continuation" = [ordered]@{
    tool = "read,bash,web_fetch"
    expectedTools = @("read")
    requiredFinalText = @("UNTIL_DONE_SMOKE_OK", "pi-extensions")
    argCheck = "read-package"
    continuation = $true
    maxTools = 1
    setupPrompt = "This is the first turn of /until-done continuation smoke. Do not call tools. Reply only that the task is recorded. On the next turn, when the user only says continue, you must continue the task instead of saying you will continue: use the read tool to read current workspace relative path package.json; the read path argument must be exactly `"package.json`"; do not use any absolute path. Final answer must include UNTIL_DONE_SMOKE_OK and pi-extensions exactly."
    continuationPrompt = "继续"
    prompt = "This case is run as a two-turn session by the PowerShell smoke runner."
  }
  "fffind-package" = [ordered]@{
    tool = "fffind"
    expectedTools = @("fffind")
    requiredFinalText = @("EXTENSION_SMOKE_FFFIND_OK", "package.json")
    envKind = "fff"
    argCheck = "fffind-package"
    prompt = "This is targeted extension smoke. Use only the fffind tool to find package.json in the current workspace. The fffind pattern argument must be exactly `"package.json`"; limit must not exceed 5. Do not call read, bash, ffgrep, web_fetch, or any other tool. Final answer must include EXTENSION_SMOKE_FFFIND_OK and package.json."
  }
  "ffgrep-package" = [ordered]@{
    tool = "ffgrep"
    expectedTools = @("ffgrep")
    requiredFinalText = @("EXTENSION_SMOKE_FFGREP_OK", "pi-extensions")
    envKind = "fff"
    argCheck = "ffgrep-package"
    prompt = "This is targeted extension smoke. Use only the ffgrep tool to search for pi-extensions in the current workspace relative path package.json. The ffgrep pattern argument must be exactly `"pi-extensions`"; path must be exactly `"package.json`"; limit must not exceed 5. Do not call read, bash, fffind, web_fetch, or any other tool. Final answer must include EXTENSION_SMOKE_FFGREP_OK and pi-extensions."
  }
  "batch-web-fetch-example" = [ordered]@{
    tool = "batch_web_fetch"
    expectedTools = @("batch_web_fetch")
    requiredFinalText = @("EXTENSION_SMOKE_BATCH_FETCH_OK", "Example Domain")
    argCheck = "batch-web-fetch-example"
    prompt = "This is targeted extension smoke. First use only the batch_web_fetch tool to read https://example.com/. The requests array must contain only this URL, with maxChars 1000 and timeoutMs 20000 on that request. Do not call web_fetch, read, bash, or any other tool. After the tool result is returned, write a final assistant answer containing exactly EXTENSION_SMOKE_BATCH_FETCH_OK and Example Domain. Do not stop after the tool call."
  }
  "seq-thinking-status" = [ordered]@{
    tool = "get_thinking_status"
    expectedTools = @("get_thinking_status")
    requiredFinalText = @("EXTENSION_SMOKE_SEQ_STATUS_OK")
    envKind = "seq-thinking"
    prompt = "This is targeted extension smoke. Use only the get_thinking_status tool to read the sequential-thinking storage status. Do not call process_thought, sequential_think, get_thinking_history, read, bash, or any other tool. Final answer must include EXTENSION_SMOKE_SEQ_STATUS_OK."
  }
  "mcp-status" = [ordered]@{
    tool = "mcp"
    expectedTools = @("mcp")
    requiredFinalText = @("EXTENSION_SMOKE_MCP_STATUS_OK", "MCP")
    argCheck = "mcp-status"
    prompt = "This is targeted extension smoke. Use only the mcp tool to inspect MCP gateway/status. Arguments must be an empty object {}. Do not connect, auth, or call any MCP server/tool. Do not call read, bash, web_fetch, or any other tool. Final answer must include EXTENSION_SMOKE_MCP_STATUS_OK and MCP."
  }
  "subagent-list" = [ordered]@{
    tool = "subagent"
    expectedTools = @("subagent")
    requiredFinalText = @("EXTENSION_SMOKE_SUBAGENT_LIST_OK")
    argCheck = "subagent-list"
    prompt = "This is targeted extension smoke. Use only the subagent tool for the read-only management action list. Arguments must be {`"action`":`"list`"}. Do not execute agent, task, chain, tasks, parallel, resume, interrupt, or append-step. Do not start child agents. Do not call read, bash, web_fetch, or any other tool. Final answer must include EXTENSION_SMOKE_SUBAGENT_LIST_OK."
  }
  "recall-not-found" = [ordered]@{
    tool = "recall"
    expectedTools = @("recall")
    requiredFinalText = @("EXTENSION_SMOKE_RECALL_NOT_FOUND_OK")
    argCheck = "recall-not-found"
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

function Int-OrDefaultAllowZero {
  param([int]$Value, [string]$EnvName, [int]$Default)
  if ($Value -ge 0) { return $Value }
  $envValue = [Environment]::GetEnvironmentVariable($EnvName)
  if (-not [string]::IsNullOrWhiteSpace($envValue)) {
    $parsed = 0
    if ([int]::TryParse($envValue, [ref]$parsed) -and $parsed -ge 0) {
      return $parsed
    }
  }
  return $Default
}

function Get-PackageVersion {
  param([string]$PackageJsonPath)
  try {
    $data = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
    return [string]$data.version
  } catch {
    return ""
  }
}

function Get-ForbiddenFinalTextMarkers {
  param([string]$Text)
  $markers = New-Object System.Collections.Generic.List[string]
  $checks = @(
    @{ label = "UNKNOWN_SIMULATED"; pattern = '\bUNKNOWN_SIMULATED\b' },
    @{ label = "SIMULATED"; pattern = '\bSIMULATED\b' },
    @{ label = "PLACEHOLDER"; pattern = '\bPLACEHOLDER\b' },
    @{ label = "MOCK"; pattern = '\bMOCK\b' },
    @{ label = "UNKNOWN_*"; pattern = '\bUNKNOWN_[A-Z0-9_]+\b' }
  )
  foreach ($check in $checks) {
    if ([regex]::IsMatch($Text, [string]$check.pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
      $markers.Add([string]$check.label)
    }
  }
  return @($markers)
}

function Test-PackageVersionRequiredCase {
  param([string]$CaseName)
  return @(
    "read-package",
    "until-done-continuation"
  ) -contains $CaseName
}

function Test-SmokeObservationalMemoryPassive {
  $raw = $env:XTALPI_PI_TOOLS_SMOKE_OBSERVATIONAL_MEMORY_PASSIVE
  if ([string]::IsNullOrWhiteSpace($raw)) { return $true }
  return @("1", "true", "yes", "on") -contains $raw.Trim().ToLowerInvariant()
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

function Add-UniqueCase {
  param(
    [System.Collections.Generic.List[string]]$Items,
    [string]$Name
  )
  if (-not [string]::IsNullOrWhiteSpace($Name) -and -not $Items.Contains($Name)) {
    $Items.Add($Name)
  }
}

function Resolve-ProfileCases {
  param([string[]]$RawProfiles)
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($profile in (Parse-CaseList $RawProfiles)) {
    if ($AvailableProfiles -notcontains $profile) {
      [Console]::Error.WriteLine(("unknown xtalpi-pi-tools PowerShell smoke profile: {0}. Available: {1}" -f $profile, ($AvailableProfiles -join ", ")))
      exit 2
    }
    foreach ($caseName in @($ProfileCaseMap[$profile])) {
      Add-UniqueCase $items $caseName
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
  return [regex]::IsMatch([string]$Text, '(?:</?pi_tool_(?:call_history|call|result)\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|</?previous_pi_tool_call\b(?:[^<>\r\n]*>|[^<>\r\n]*(?:$|\r?\n))|\[/?previous_pi_tool_call\])', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Get-ProtocolBoundaryFinding {
  param([string]$Text, [string[]]$ToolNames = @())
  $payload = [ordered]@{
    text = [string]$Text
    selectedToolNames = @($ToolNames | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  } | ConvertTo-Json -Compress -Depth 8
  $nodeScript = "const fs=require('node:fs');const core=require(process.argv[1]);const input=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(core.detectToolCallLikeFinal(input)));"
  try {
    $output = $payload | & node -e $nodeScript $ProtocolBoundaryCorePath
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($output)) {
      return [pscustomobject]@{ ok = $false; code = "protocol_boundary_helper_failed"; matchedShape = "node_helper" }
    }
    return ($output | ConvertFrom-Json)
  } catch {
    return [pscustomobject]@{ ok = $false; code = "protocol_boundary_helper_failed"; matchedShape = "node_helper" }
  }
}

function Contains-ToolCallLikeJsonArray {
  param([string]$Text, [string[]]$ToolNames = @())
  $finding = Get-ProtocolBoundaryFinding $Text $ToolNames
  return $finding.ok -eq $false
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

function Get-ObjectValue {
  param([object]$Value, [string]$Name)
  if ($null -eq $Value) { return $null }
  if ($Value -is [System.Collections.IDictionary]) {
    if ($Value.Contains($Name)) { return $Value[$Name] }
    return $null
  }
  $property = $Value.PSObject.Properties[$Name]
  if ($null -ne $property) { return $property.Value }
  return $null
}

function Get-ToolStartByName {
  param([object[]]$ToolStarts, [string]$ToolName)
  $matches = @($ToolStarts | Where-Object { $_.toolName -eq $ToolName })
  if ($matches.Count -eq 0) { return $null }
  return $matches[0]
}

function Get-PropertyCount {
  param([object]$Value)
  if ($null -eq $Value) { return 0 }
  if ($Value -is [System.Collections.IDictionary]) { return $Value.Count }
  return @($Value.PSObject.Properties).Count
}

function Test-LimitAtMost {
  param([object]$ArgsValue, [int]$Max, [string]$Label, [System.Collections.Generic.List[string]]$Failures)
  $limitValue = Get-ObjectValue $ArgsValue "limit"
  if ($null -eq $limitValue -or [string]::IsNullOrWhiteSpace([string]$limitValue)) { return }
  $limit = 0
  if (-not [int]::TryParse([string]$limitValue, [ref]$limit) -or $limit -gt $Max) {
    $Failures.Add(("{0} limit must be <= {1}, got {2}" -f $Label, $Max, ($limitValue | ConvertTo-Json -Compress -Depth 4)))
  }
}

function Test-CaseToolArgs {
  param([string]$CaseName, [object[]]$ToolStarts)
  $failures = New-Object System.Collections.Generic.List[string]

  switch ($CaseName) {
    "read-package" {
      $event = Get-ToolStartByName $ToolStarts "read"
      $path = Get-ObjectValue $event.args "path"
      if ($path -ne "package.json") { $failures.Add(("read.path must equal package.json, got {0}" -f ($path | ConvertTo-Json -Compress -Depth 4))) }
    }
    "fffind-package" {
      $event = Get-ToolStartByName $ToolStarts "fffind"
      $pattern = Get-ObjectValue $event.args "pattern"
      if ($pattern -ne "package.json") { $failures.Add(("fffind.pattern must equal package.json, got {0}" -f ($pattern | ConvertTo-Json -Compress -Depth 4))) }
      Test-LimitAtMost $event.args 5 "fffind" $failures
    }
    "ffgrep-package" {
      $event = Get-ToolStartByName $ToolStarts "ffgrep"
      $pattern = Get-ObjectValue $event.args "pattern"
      $path = Get-ObjectValue $event.args "path"
      if ($pattern -ne "pi-extensions") { $failures.Add(("ffgrep.pattern must equal pi-extensions, got {0}" -f ($pattern | ConvertTo-Json -Compress -Depth 4))) }
      if ($path -ne "package.json") { $failures.Add(("ffgrep.path must equal package.json, got {0}" -f ($path | ConvertTo-Json -Compress -Depth 4))) }
      Test-LimitAtMost $event.args 5 "ffgrep" $failures
    }
    "batch-web-fetch-example" {
      $event = Get-ToolStartByName $ToolStarts "batch_web_fetch"
      $rawRequests = Get-ObjectValue $event.args "requests"
      if ($null -eq $rawRequests) {
        $failures.Add("batch_web_fetch.requests must be present")
      } else {
        $requests = @($rawRequests)
        if ($requests.Count -ne 1) {
          $failures.Add(("batch_web_fetch.requests must contain exactly one request, got {0}" -f $requests.Count))
        } else {
          $request = $requests[0]
          $url = Get-ObjectValue $request "url"
          $maxChars = Get-ObjectValue $request "maxChars"
          $timeoutMs = Get-ObjectValue $request "timeoutMs"
          if ($url -ne "https://example.com/") { $failures.Add(("batch_web_fetch request url must equal https://example.com/, got {0}" -f ($url | ConvertTo-Json -Compress -Depth 4))) }
          if ([string]$maxChars -ne "1000") { $failures.Add(("batch_web_fetch maxChars must equal 1000, got {0}" -f ($maxChars | ConvertTo-Json -Compress -Depth 4))) }
          if ([string]$timeoutMs -ne "20000") { $failures.Add(("batch_web_fetch timeoutMs must equal 20000, got {0}" -f ($timeoutMs | ConvertTo-Json -Compress -Depth 4))) }
        }
      }
    }
    "mcp-status" {
      $event = Get-ToolStartByName $ToolStarts "mcp"
      if ((Get-PropertyCount $event.args) -ne 0) { $failures.Add(("mcp args must be empty object, got {0}" -f ($event.args | ConvertTo-Json -Compress -Depth 6))) }
    }
    "subagent-list" {
      $event = Get-ToolStartByName $ToolStarts "subagent"
      $action = Get-ObjectValue $event.args "action"
      if ($action -ne "list") { $failures.Add(("subagent.action must equal list, got {0}" -f ($action | ConvertTo-Json -Compress -Depth 4))) }
    }
    "recall-not-found" {
      $event = Get-ToolStartByName $ToolStarts "recall"
      $id = Get-ObjectValue $event.args "id"
      if ($id -ne "deadbeef0000") { $failures.Add(("recall.id must equal deadbeef0000, got {0}" -f ($id | ConvertTo-Json -Compress -Depth 4))) }
    }
  }

  return [ordered]@{
    ok = $failures.Count -eq 0
    failures = @($failures)
  }
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
    [bool]$TimedOut,
    [int]$Attempt = 1
  )

  $events = @(Read-JsonlEvents $OutFile)
  $debugEvents = @(Read-JsonlEvents $DebugFile)
  $toolStarts = @($events | Where-Object { $_.type -eq "tool_execution_start" })
  $actualToolNames = @($toolStarts | ForEach-Object { [string]$_.toolName } | Where-Object { $_ })
  $expectedTools = @($Definition.expectedTools)
  $unexpectedTools = @($actualToolNames | Where-Object { $expectedTools -notcontains $_ } | Select-Object -Unique)
  $missingTools = @($expectedTools | Where-Object { $actualToolNames -notcontains $_ })
  $argExpectation = Test-CaseToolArgs ([string]$Definition.argCheck) $toolStarts
  $finalText = Get-FinalAssistantText $events
  $requiredFinalText = New-Object System.Collections.Generic.List[string]
  foreach ($marker in @($Definition.requiredFinalText)) { $requiredFinalText.Add([string]$marker) }
  if ((Test-PackageVersionRequiredCase $CaseName) -and -not [string]::IsNullOrWhiteSpace($Script:ExpectedPackageVersion)) {
    $requiredFinalText.Add($Script:ExpectedPackageVersion)
  }
  $missingFinalText = @($requiredFinalText | Where-Object { -not $finalText.Contains($_) })
  $forbiddenFinalText = @(Get-ForbiddenFinalTextMarkers $finalText)
  $errors = @($events | Where-Object { $_.type -eq "error" -or $_.message.stopReason -eq "error" -or $_.message.errorMessage })
  $debugTelemetryOk = $debugEvents.Count -gt 0
  if ($debugTelemetryOk) {
    foreach ($event in $debugEvents) {
      if ($event.type -eq "parse_error") { $debugTelemetryOk = $false }
      if ($event.schema -ne "xtalpi-pi-tools.debug.v1" -or -not $event.event) { $debugTelemetryOk = $false }
    }
  }
  $rawMarkup = Contains-RawPiToolMarkup $finalText
  $protocolBoundaryNames = @($actualToolNames + $expectedTools | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
  $toolCallLikeFinding = Get-ProtocolBoundaryFinding $finalText $protocolBoundaryNames
  $toolCallLikeJson = $toolCallLikeFinding.ok -eq $false
  $finalAnswerOk = $finalText.Trim().Length -gt 0 -and -not $rawMarkup -and -not $toolCallLikeJson -and $forbiddenFinalText.Count -eq 0 -and $missingFinalText.Count -eq 0
  $toolExpectationOk = $missingTools.Count -eq 0 -and $unexpectedTools.Count -eq 0
  $failureReasons = New-Object System.Collections.Generic.List[string]
  if ($ExitStatus -ne 0) { $failureReasons.Add(("exit_status_{0}" -f $ExitStatus)) }
  if ($TimedOut) { $failureReasons.Add("timed_out_by_watchdog") }
  foreach ($tool in $missingTools) { $failureReasons.Add(("missing_tool:{0}" -f $tool)) }
  foreach ($tool in $unexpectedTools) { $failureReasons.Add(("unexpected_tool:{0}" -f $tool)) }
  foreach ($failure in @($argExpectation.failures)) { $failureReasons.Add(("arg_expectation:{0}" -f $failure)) }
  if (-not $debugTelemetryOk) { $failureReasons.Add("debug_telemetry_missing_or_invalid") }
  foreach ($errorText in @($errors | ForEach-Object { if ($_.message.errorMessage) { $_.message.errorMessage } elseif ($_.error) { $_.error } else { $_.message } })) {
    $failureReasons.Add(("runtime_error:{0}" -f $errorText))
  }
  if ($rawMarkup) { $failureReasons.Add("final_answer_contains_raw_tool_markup") }
  if ($toolCallLikeJson) { $failureReasons.Add("final_answer_contains_tool_call_like_json") }
  foreach ($marker in $forbiddenFinalText) { $failureReasons.Add(("final_answer_contains_forbidden_marker:{0}" -f $marker)) }
  if ($finalText.Trim().Length -eq 0) {
    $failureReasons.Add("missing_final_assistant_text")
  } else {
    foreach ($marker in $missingFinalText) { $failureReasons.Add(("missing_final_text:{0}" -f $marker)) }
  }
  $ok = $ExitStatus -eq 0 -and -not $TimedOut -and $toolExpectationOk -and $argExpectation.ok -and $finalAnswerOk -and $errors.Count -eq 0 -and $debugTelemetryOk

  return [ordered]@{
    schema = "xtalpi-pi-tools.powershell-case-summary.v1"
    caseName = $CaseName
    attempt = $Attempt
    ok = $ok
    failureReasons = @($failureReasons)
    exitStatus = $ExitStatus
    elapsedSeconds = $ElapsedSeconds
    timedOutByWatchdog = $TimedOut
    expectedTools = $expectedTools
    actualToolNames = $actualToolNames
    missingTools = $missingTools
    unexpectedTools = $unexpectedTools
    toolStarts = @($toolStarts | ForEach-Object { "{0}:{1}" -f $_.toolName, ($_.args | ConvertTo-Json -Compress -Depth 8) })
    argExpectationOk = $argExpectation.ok
    argExpectationFailures = @($argExpectation.failures)
    debugTelemetryOk = $debugTelemetryOk
    debugEventCount = $debugEvents.Count
    requiredFinalText = @($requiredFinalText)
    missingFinalText = $missingFinalText
    forbiddenFinalText = $forbiddenFinalText
    finalAnswerQualityOk = $finalAnswerOk
    finalAnswerRawToolMarkup = $rawMarkup
    finalAnswerToolCallLikeJson = $toolCallLikeJson
    finalAnswerToolCallLikeShape = if ($toolCallLikeJson) { $toolCallLikeFinding.matchedShape } else { $null }
    finalAnswerToolCallLikeCode = if ($toolCallLikeJson) { $toolCallLikeFinding.code } else { $null }
    finalAnswerToolCallLikeName = if ($toolCallLikeJson) { $toolCallLikeFinding.matchedToolName } else { $null }
    errors = @($errors | ForEach-Object { if ($_.message.errorMessage) { $_.message.errorMessage } elseif ($_.error) { $_.error } else { $_.message } })
    stdoutFile = $OutFile
    stderrFile = $ErrFile
    debugFile = $DebugFile
    finalText = if ($finalText.Length -gt 500) { $finalText.Substring(0, 500) } else { $finalText }
  }
}

function Should-RetryCase {
  param([object]$Summary)
  if ($Summary.ok -eq $true) { return $false }
  if ($Summary.exitStatus -ne 0 -or $Summary.timedOutByWatchdog -eq $true) { return $false }
  if ($Summary.debugTelemetryOk -ne $true) { return $false }
  if ($Summary.argExpectationOk -ne $true) { return $false }
  if (@($Summary.errors).Count -gt 0) { return $false }
  if (@($Summary.missingTools).Count -gt 0 -or @($Summary.unexpectedTools).Count -gt 0) { return $false }
  if (@($Summary.failureReasons) -contains "missing_final_assistant_text") { return $true }
  return $false
}

function Invoke-PiProcessWithWatchdog {
  param(
    [string]$PiBin,
    [object[]]$PiArgs,
    [string]$Prompt,
    [string]$WorkingDir,
    [string]$StdoutPath,
    [string]$StderrPath,
    [string]$ExitPath,
    [hashtable]$EnvValues,
    [int]$TimeoutSeconds
  )

  $startedAt = Get-Date
  $job = Start-Job -ScriptBlock {
    param($PiBinArg, $PiArgsArg, $PromptArg, $WorkingDirArg, $StdoutPathArg, $StderrPathArg, $ExitPathArg, $EnvValuesArg)
    try {
      Set-Location -LiteralPath $WorkingDirArg
      foreach ($key in $EnvValuesArg.Keys) {
        Set-Item -Path ("Env:{0}" -f $key) -Value ([string]$EnvValuesArg[$key])
      }
      & $PiBinArg @PiArgsArg -p $PromptArg > $StdoutPathArg 2> $StderrPathArg
      $code = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
      Set-Content -LiteralPath $ExitPathArg -Value ([string]$code) -Encoding ASCII
    } catch {
      $_.Exception.Message | Set-Content -LiteralPath $StderrPathArg -Encoding UTF8
      Set-Content -LiteralPath $ExitPathArg -Value "1" -Encoding ASCII
    }
  } -ArgumentList $PiBin, $PiArgs, $Prompt, $WorkingDir, $StdoutPath, $StderrPath, $ExitPath, $EnvValues

  $completed = Wait-Job $job -Timeout $TimeoutSeconds
  $timedOut = $false
  $exitStatus = 1
  if ($null -eq $completed) {
    $timedOut = $true
    Stop-Job $job -ErrorAction SilentlyContinue
    $exitStatus = 124
  } else {
    Receive-Job $job -ErrorAction SilentlyContinue | Out-Null
    if (Test-Path -LiteralPath $ExitPath -PathType Leaf) {
      $rawExit = (Get-Content -LiteralPath $ExitPath -Raw).Trim()
      $parsedExit = 1
      if ([int]::TryParse($rawExit, [ref]$parsedExit)) {
        $exitStatus = $parsedExit
      }
    }
  }
  Remove-Job $job -Force -ErrorAction SilentlyContinue

  return [ordered]@{
    exitStatus = $exitStatus
    timedOut = $timedOut
    elapsedSeconds = [int][Math]::Ceiling(((Get-Date) - $startedAt).TotalSeconds)
  }
}

function Join-ExistingTextFiles {
  param([string]$TargetPath, [string[]]$SourcePaths)
  "" | Set-Content -LiteralPath $TargetPath -Encoding UTF8
  foreach ($source in $SourcePaths) {
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      Get-Content -LiteralPath $source -Raw | Add-Content -LiteralPath $TargetPath -Encoding UTF8
    }
  }
}

function Invoke-PiCase {
  param(
    [string]$CaseName,
    [object]$Definition,
    [string]$Stamp,
    [int]$Attempt = 1,
    [string]$ResolvedPiBin,
    [string]$ResolvedAgentDir,
    [string]$ResolvedOutDir,
    [int]$ResolvedCaseTimeoutSeconds,
    [int]$ResolvedRequestTimeoutMs,
    [int]$ResolvedMaxOutputTokens,
    [string]$ResolvedProvider,
    [string]$ResolvedModel
  )

  $artifactCaseName = if ($Attempt -gt 1) { "{0}-retry{1}" -f $CaseName, $Attempt } else { $CaseName }
  $outFile = Join-Path $ResolvedOutDir ("{0}-{1}.jsonl" -f $Stamp, $artifactCaseName)
  $errFile = Join-Path $ResolvedOutDir ("{0}-{1}.stderr" -f $Stamp, $artifactCaseName)
  $debugFile = Join-Path $ResolvedOutDir ("{0}-{1}.debug.jsonl" -f $Stamp, $artifactCaseName)
  $exitFile = Join-Path $ResolvedOutDir ("{0}-{1}.exit" -f $Stamp, $artifactCaseName)

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
  if (Test-SmokeObservationalMemoryPassive) {
    $envMap["PI_OBSERVATIONAL_MEMORY_PASSIVE"] = "true"
  }
  switch ([string]$Definition.envKind) {
    "fff" {
      $envMap["PI_FFF_MODE"] = "tools-only"
      $envMap["FFF_FRECENCY_DB"] = Join-Path $ResolvedOutDir ("{0}-fff-frecency.db" -f $Stamp)
      $envMap["FFF_HISTORY_DB"] = Join-Path $ResolvedOutDir ("{0}-fff-history.db" -f $Stamp)
    }
    "seq-thinking" {
      $storageDir = Join-Path $ResolvedOutDir ("{0}-seq-thinking-status-storage" -f $Stamp)
      New-Item -ItemType Directory -Force -Path $storageDir | Out-Null
      $envMap["MCP_STORAGE_DIR"] = $storageDir
      $envMap["SEQ_THINK_MAX_BYTES"] = "51200"
      $envMap["SEQ_THINK_MAX_LINES"] = "2000"
    }
  }

  $result = Invoke-PiProcessWithWatchdog `
    -PiBin $ResolvedPiBin `
    -PiArgs $args `
    -Prompt ([string]$Definition.prompt) `
    -WorkingDir $ResolvedAgentDir `
    -StdoutPath $outFile `
    -StderrPath $errFile `
    -ExitPath $exitFile `
    -EnvValues $envMap `
    -TimeoutSeconds $ResolvedCaseTimeoutSeconds

  return Summarize-CaseArtifact `
    -CaseName $CaseName `
    -Definition $Definition `
    -OutFile $outFile `
    -ErrFile $errFile `
    -DebugFile $debugFile `
    -ExitStatus ([int]$result.exitStatus) `
    -ElapsedSeconds ([int]$result.elapsedSeconds) `
    -TimedOut ([bool]$result.timedOut) `
    -Attempt $Attempt
}

function Invoke-PiContinuationCase {
  param(
    [string]$CaseName,
    [object]$Definition,
    [string]$Stamp,
    [int]$Attempt = 1,
    [string]$ResolvedPiBin,
    [string]$ResolvedAgentDir,
    [string]$ResolvedOutDir,
    [int]$ResolvedCaseTimeoutSeconds,
    [int]$ResolvedRequestTimeoutMs,
    [int]$ResolvedMaxOutputTokens,
    [string]$ResolvedProvider,
    [string]$ResolvedModel
  )

  $artifactCaseName = if ($Attempt -gt 1) { "{0}-retry{1}" -f $CaseName, $Attempt } else { $CaseName }
  $outFile = Join-Path $ResolvedOutDir ("{0}-{1}.jsonl" -f $Stamp, $artifactCaseName)
  $errFile = Join-Path $ResolvedOutDir ("{0}-{1}.stderr" -f $Stamp, $artifactCaseName)
  $debugFile = Join-Path $ResolvedOutDir ("{0}-{1}.debug.jsonl" -f $Stamp, $artifactCaseName)
  $setupOutFile = Join-Path $ResolvedOutDir ("{0}-{1}.setup.jsonl" -f $Stamp, $artifactCaseName)
  $setupErrFile = Join-Path $ResolvedOutDir ("{0}-{1}.setup.stderr" -f $Stamp, $artifactCaseName)
  $setupExitFile = Join-Path $ResolvedOutDir ("{0}-{1}.setup.exit" -f $Stamp, $artifactCaseName)
  $continuationOutFile = Join-Path $ResolvedOutDir ("{0}-{1}.continuation.jsonl" -f $Stamp, $artifactCaseName)
  $continuationErrFile = Join-Path $ResolvedOutDir ("{0}-{1}.continuation.stderr" -f $Stamp, $artifactCaseName)
  $continuationExitFile = Join-Path $ResolvedOutDir ("{0}-{1}.continuation.exit" -f $Stamp, $artifactCaseName)
  $sessionDir = Join-Path $ResolvedOutDir ("{0}-{1}.sessions" -f $Stamp, $artifactCaseName)
  $sessionId = "xtalpi-smoke-{0}-{1}" -f $Stamp, $artifactCaseName
  New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null

  $baseArgs = @(
    "--provider", $ResolvedProvider,
    "--model", $ResolvedModel,
    "--thinking", "off",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--mode", "json",
    "--session-dir", $sessionDir,
    "--session-id", $sessionId
  )
  $setupArgs = @($baseArgs + @("--no-tools"))
  $continuationArgs = @($baseArgs + @("--tools", [string]$Definition.tool))
  $envMap = @{
    XTALPI_PI_TOOLS_TIMEOUT_MS = [string]$ResolvedRequestTimeoutMs
    XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS = [string]$ResolvedMaxOutputTokens
    XTALPI_PI_TOOLS_DEBUG = "1"
    XTALPI_PI_TOOLS_DEBUG_PATH = $debugFile
  }
  if (Test-SmokeObservationalMemoryPassive) {
    $envMap["PI_OBSERVATIONAL_MEMORY_PASSIVE"] = "true"
  }
  if ($Definition.maxTools) {
    $envMap["XTALPI_PI_TOOLS_CASE_MAX_TOOLS"] = [string]$Definition.maxTools
  }

  $startedAt = Get-Date
  $setupResult = Invoke-PiProcessWithWatchdog `
    -PiBin $ResolvedPiBin `
    -PiArgs $setupArgs `
    -Prompt ([string]$Definition.setupPrompt) `
    -WorkingDir $ResolvedAgentDir `
    -StdoutPath $setupOutFile `
    -StderrPath $setupErrFile `
    -ExitPath $setupExitFile `
    -EnvValues $envMap `
    -TimeoutSeconds $ResolvedCaseTimeoutSeconds

  $continuationResult = [ordered]@{ exitStatus = 1; timedOut = $false; elapsedSeconds = 0 }
  if ([int]$setupResult.exitStatus -eq 0 -and -not [bool]$setupResult.timedOut) {
    $continuationResult = Invoke-PiProcessWithWatchdog `
      -PiBin $ResolvedPiBin `
      -PiArgs $continuationArgs `
      -Prompt ([string]$Definition.continuationPrompt) `
      -WorkingDir $ResolvedAgentDir `
      -StdoutPath $continuationOutFile `
      -StderrPath $continuationErrFile `
      -ExitPath $continuationExitFile `
      -EnvValues $envMap `
      -TimeoutSeconds $ResolvedCaseTimeoutSeconds
  }

  Join-ExistingTextFiles $outFile @($setupOutFile, $continuationOutFile)
  Join-ExistingTextFiles $errFile @($setupErrFile, $continuationErrFile)

  $exitStatus = if ([int]$setupResult.exitStatus -ne 0) { [int]$setupResult.exitStatus } else { [int]$continuationResult.exitStatus }
  $timedOut = [bool]$setupResult.timedOut -or [bool]$continuationResult.timedOut
  $elapsedSeconds = [int][Math]::Ceiling(((Get-Date) - $startedAt).TotalSeconds)

  return Summarize-CaseArtifact `
    -CaseName $CaseName `
    -Definition $Definition `
    -OutFile $outFile `
    -ErrFile $errFile `
    -DebugFile $debugFile `
    -ExitStatus $exitStatus `
    -ElapsedSeconds $elapsedSeconds `
    -TimedOut $timedOut `
    -Attempt $Attempt
}

function Run-SelfTest {
  $Script:ExpectedPackageVersion = Get-PackageVersion (Join-Path $RepoRoot "package.json")
  if ([string]::IsNullOrWhiteSpace($Script:ExpectedPackageVersion)) {
    $Script:ExpectedPackageVersion = "0.0.0-self-test"
  }
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

    $fixtures = @(
      @{ name = "read-package"; tool = "read"; args = @{ path = "package.json" }; final = ("EXTENSION_SMOKE_READ_PACKAGE_OK pi-extensions {0}" -f $Script:ExpectedPackageVersion) },
      @{ name = "until-done-continuation"; tool = "read"; args = @{ path = "package.json" }; final = ("UNTIL_DONE_SMOKE_OK pi-extensions {0}" -f $Script:ExpectedPackageVersion) },
      @{ name = "fffind-package"; tool = "fffind"; args = @{ pattern = "package.json"; limit = 5 }; final = "EXTENSION_SMOKE_FFFIND_OK package.json" },
      @{ name = "ffgrep-package"; tool = "ffgrep"; args = @{ pattern = "pi-extensions"; path = "package.json"; limit = 5 }; final = "EXTENSION_SMOKE_FFGREP_OK pi-extensions" },
      @{ name = "batch-web-fetch-example"; tool = "batch_web_fetch"; args = @{ requests = @(@{ url = "https://example.com/"; maxChars = 1000; timeoutMs = 20000 }) }; final = "EXTENSION_SMOKE_BATCH_FETCH_OK Example Domain" },
      @{ name = "seq-thinking-status"; tool = "get_thinking_status"; args = @{}; final = "EXTENSION_SMOKE_SEQ_STATUS_OK" },
      @{ name = "subagent-list"; tool = "subagent"; args = @{ action = "list" }; final = "EXTENSION_SMOKE_SUBAGENT_LIST_OK" },
      @{ name = "recall-not-found"; tool = "recall"; args = @{ id = "deadbeef0000" }; final = "EXTENSION_SMOKE_RECALL_NOT_FOUND_OK" }
    )
    foreach ($fixture in $fixtures) {
      $fixtureOut = Join-Path $tmp ("{0}.jsonl" -f $fixture.name)
      @(
        @{ type = "tool_execution_start"; toolName = $fixture.tool; args = $fixture.args },
        @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = $fixture.final }) }) }
      ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 12 } | Set-Content -LiteralPath $fixtureOut -Encoding UTF8
      $fixtureSummary = Summarize-CaseArtifact $fixture.name $CaseDefinitions[$fixture.name] $fixtureOut $err $debug 0 1 $false
      if ($fixtureSummary.ok -ne $true) { throw ("expected fixture {0} to pass" -f $fixture.name) }
    }

    $planOut = Join-Path $tmp "plan-mode-contract.jsonl"
    @(
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = "<proposed_plan>`n1. Inspect real state.`n2. Verify result.`n</proposed_plan>" }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $planOut -Encoding UTF8
    $planSummary = Summarize-CaseArtifact "plan-mode-contract" $CaseDefinitions["plan-mode-contract"] $planOut $err $debug 0 1 $false
    if ($planSummary.ok -ne $true) { throw "expected plan-mode-contract fixture to pass" }

    $lowRiskProfile = Resolve-ProfileCases @("extension-low-risk")
    if (($lowRiskProfile -join ",") -ne "mcp-status,subagent-list,recall-not-found") {
      throw "extension-low-risk profile mapping drifted"
    }
    $expandedProfile = Resolve-ProfileCases @("extension-expanded")
    if (($expandedProfile -join ",") -ne "fffind-package,ffgrep-package,batch-web-fetch-example,seq-thinking-status,mcp-status,subagent-list,recall-not-found") {
      throw "extension-expanded profile mapping drifted"
    }
    $quickProfile = Resolve-ProfileCases @("quick")
    if (($quickProfile -join ",") -ne "read-package") {
      throw "quick profile mapping drifted"
    }

    $badOut = Join-Path $tmp "bad.jsonl"
    @(
      @{ type = "tool_execution_start"; toolName = "bash"; args = @{ command = "pwd" } },
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = "EXTENSION_SMOKE_MCP_STATUS_OK MCP" }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $badOut -Encoding UTF8
    $bad = Summarize-CaseArtifact "mcp-status" $CaseDefinitions["mcp-status"] $badOut $err $debug 0 1 $false
    if ($bad.ok -eq $true) { throw "expected unexpected tool fixture to fail" }
    if (Should-RetryCase $bad) { throw "unexpected tool fixture must not be retried" }

    $emptyFinalOut = Join-Path $tmp "empty-final.jsonl"
    @(
      @{ type = "tool_execution_start"; toolName = "mcp"; args = @{} }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $emptyFinalOut -Encoding UTF8
    $emptyFinal = Summarize-CaseArtifact "mcp-status" $CaseDefinitions["mcp-status"] $emptyFinalOut $err $debug 0 1 $false
    if ($emptyFinal.ok -eq $true) { throw "expected empty final fixture to fail" }
    if (-not (Should-RetryCase $emptyFinal)) { throw "empty final fixture should be retried" }
    if (@($emptyFinal.failureReasons) -notcontains "missing_final_assistant_text") {
      throw "empty final fixture should report missing_final_assistant_text"
    }

    $markupOut = Join-Path $tmp "markup.jsonl"
    @(
      @{ type = "tool_execution_start"; toolName = "mcp"; args = @{} },
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = "<pi_tool_call>{}</pi_tool_call> EXTENSION_SMOKE_MCP_STATUS_OK MCP" }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $markupOut -Encoding UTF8
    $markup = Summarize-CaseArtifact "mcp-status" $CaseDefinitions["mcp-status"] $markupOut $err $debug 0 1 $false
    if ($markup.ok -eq $true) { throw "expected raw markup fixture to fail" }

    $forbiddenOut = Join-Path $tmp "forbidden-marker.jsonl"
    @(
      @{ type = "tool_execution_start"; toolName = "read"; args = @{ path = "package.json" } },
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = ("EXTENSION_SMOKE_READ_PACKAGE_OK pi-extensions {0} UNKNOWN_SIMULATED" -f $Script:ExpectedPackageVersion) }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $forbiddenOut -Encoding UTF8
    $forbidden = Summarize-CaseArtifact "read-package" $CaseDefinitions["read-package"] $forbiddenOut $err $debug 0 1 $false
    if ($forbidden.ok -eq $true) { throw "expected forbidden final marker fixture to fail" }
    if (@($forbidden.failureReasons) -notcontains "final_answer_contains_forbidden_marker:UNKNOWN_SIMULATED") {
      throw "forbidden marker fixture should report UNKNOWN_SIMULATED"
    }

    $pseudoJsonOut = Join-Path $tmp "pseudo-json-tool-array.jsonl"
    @(
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = '阶段：ANALYSIS | T-003 [{"id":"pi_tool_until_done_task_update_mra0pzuf_done","name":"until_done_task_update","arguments":{"id":"T-003","patch":{"status":"in_progress"}}}] EXTENSION_SMOKE_MCP_STATUS_OK MCP' }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 12 } | Set-Content -LiteralPath $pseudoJsonOut -Encoding UTF8
    $pseudoJson = Summarize-CaseArtifact "mcp-status" $CaseDefinitions["mcp-status"] $pseudoJsonOut $err $debug 0 1 $false
    if ($pseudoJson.ok -eq $true) { throw "expected pseudo JSON tool-call array fixture to fail" }
    if (@($pseudoJson.failureReasons) -notcontains "final_answer_contains_tool_call_like_json") {
      throw "pseudo JSON tool-call array fixture should report final_answer_contains_tool_call_like_json"
    }
    if (-not (Contains-ToolCallLikeJsonArray 'prefix {"name":"mcp","arguments":{}}' @("mcp"))) {
      throw "pseudo JSON tool-call object fixture should be detected"
    }
    if (-not (Contains-ToolCallLikeJsonArray '{"tool_calls":[{"id":"call_x","type":"function","function":{"name":"subagent","arguments":"{\"action\":\"list\"}"}}]}' @("subagent"))) {
      throw "pseudo OpenAI tool_calls fixture should be detected"
    }
    if (-not (Contains-ToolCallLikeJsonArray '{"function_call":{"name":"custom_dynamic_tool","arguments":{"foo":"bar"}}}' @("custom_dynamic_tool"))) {
      throw "pseudo dynamic function_call fixture should be detected"
    }
    if (Contains-ToolCallLikeJsonArray '[{"name":"普通商品","arguments":{"销量":12}}]' @("read")) {
      throw "business JSON fixture should not be detected as a tool call"
    }

    $angleMarkupOut = Join-Path $tmp "angle-markup.jsonl"
    @(
      @{ type = "tool_execution_start"; toolName = "mcp"; args = @{} },
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = "<previous_pi_tool_call>`nid: call_1`n</previous_pi_tool_call> EXTENSION_SMOKE_MCP_STATUS_OK MCP" }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $angleMarkupOut -Encoding UTF8
    $angleMarkup = Summarize-CaseArtifact "mcp-status" $CaseDefinitions["mcp-status"] $angleMarkupOut $err $debug 0 1 $false
    if ($angleMarkup.ok -eq $true) { throw "expected angle history markup fixture to fail" }

    $badArgsOut = Join-Path $tmp "bad-args.jsonl"
    @(
      @{ type = "tool_execution_start"; toolName = "read"; args = @{ path = "$HOME/.pi/agent/package.json" } },
      @{ type = "agent_end"; messages = @(@{ role = "assistant"; content = @(@{ type = "text"; text = ("EXTENSION_SMOKE_READ_PACKAGE_OK pi-extensions {0}" -f $Script:ExpectedPackageVersion) }) }) }
    ) | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 8 } | Set-Content -LiteralPath $badArgsOut -Encoding UTF8
    $badArgs = Summarize-CaseArtifact "read-package" $CaseDefinitions["read-package"] $badArgsOut $err $debug 0 1 $false
    if ($badArgs.ok -eq $true) { throw "expected bad read.path fixture to fail" }
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
$ResolvedCaseRetries = Int-OrDefaultAllowZero $CaseRetries "XTALPI_PI_TOOLS_SMOKE_CASE_RETRIES" 1
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
$profileEnv = [Environment]::GetEnvironmentVariable("XTALPI_PI_TOOLS_SMOKE_PROFILE")
$selectedCases = Resolve-ProfileCases (@($Profile) + @($profileEnv))
foreach ($caseName in (Parse-CaseList (@($Case) + @($caseEnv)))) {
  if (-not [string]::IsNullOrWhiteSpace($caseName) -and $selectedCases -notcontains $caseName) {
    $selectedCases += $caseName
  }
}
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
$Script:ExpectedPackageVersion = Get-PackageVersion (Join-Path $ResolvedAgentDir "package.json")
if (-not (Test-Path -LiteralPath $ArtifactCorePath -PathType Leaf)) {
  [Console]::Error.WriteLine("missing artifact core helper: $ArtifactCorePath")
  exit 2
}
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine("node is required for provider preflight and release parity checks")
  exit 2
}

New-Item -ItemType Directory -Force -Path $ResolvedOutDir | Out-Null
$Stamp = Env-OrDefault "XTALPI_PI_TOOLS_SMOKE_STAMP" ("{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $PID)
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
    $attempt = 1
    $previousAttemptFailureReasons = @()
    while ($true) {
      if (-not $Json) {
        if ($attempt -eq 1) {
          Write-Host ("===== {0} =====" -f $name) -ForegroundColor Cyan
        } else {
          Write-Host ("===== {0} retry {1}/{2} =====" -f $name, ($attempt - 1), $ResolvedCaseRetries) -ForegroundColor Yellow
        }
      }
      if ($CaseDefinitions[$name].continuation -eq $true) {
        $summary = Invoke-PiContinuationCase `
          -CaseName $name `
          -Definition $CaseDefinitions[$name] `
          -Stamp $Stamp `
          -Attempt $attempt `
          -ResolvedPiBin $ResolvedPiBin `
          -ResolvedAgentDir $ResolvedAgentDir `
          -ResolvedOutDir $ResolvedOutDir `
          -ResolvedCaseTimeoutSeconds $ResolvedCaseTimeoutSeconds `
          -ResolvedRequestTimeoutMs $ResolvedRequestTimeoutMs `
          -ResolvedMaxOutputTokens $ResolvedMaxOutputTokens `
          -ResolvedProvider $ResolvedProvider `
          -ResolvedModel $ResolvedModel
      } else {
        $summary = Invoke-PiCase `
          -CaseName $name `
          -Definition $CaseDefinitions[$name] `
          -Stamp $Stamp `
          -Attempt $attempt `
          -ResolvedPiBin $ResolvedPiBin `
          -ResolvedAgentDir $ResolvedAgentDir `
          -ResolvedOutDir $ResolvedOutDir `
          -ResolvedCaseTimeoutSeconds $ResolvedCaseTimeoutSeconds `
          -ResolvedRequestTimeoutMs $ResolvedRequestTimeoutMs `
          -ResolvedMaxOutputTokens $ResolvedMaxOutputTokens `
          -ResolvedProvider $ResolvedProvider `
          -ResolvedModel $ResolvedModel
      }
      if (-not $Json) {
        $summary | ConvertTo-Json -Depth 10
      }
      if ($summary.ok -or $attempt -gt $ResolvedCaseRetries -or -not (Should-RetryCase $summary)) {
        break
      }
      $previousAttemptFailureReasons += ("attempt {0}: {1}" -f $attempt, (@($summary.failureReasons) -join "; "))
      $attempt += 1
    }
    $summary["attemptCount"] = $attempt
    $summary["retried"] = $attempt -gt 1
    $summary["previousAttemptFailureReasons"] = @($previousAttemptFailureReasons)
    $caseSummaries += [pscustomobject]$summary
    if (-not $summary.ok) { $failures += 1 }
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
  caseRetries = $ResolvedCaseRetries
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
