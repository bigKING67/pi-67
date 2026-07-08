#!/usr/bin/env pwsh
# Stable xtalpi launcher that lets Pi own the tool protocol locally on Windows.

[CmdletBinding()]
param(
  [string]$Provider = $(if ($env:PROVIDER) { $env:PROVIDER } else { "xtalpi-pi-tools" }),
  [string]$Model = $(if ($env:MODEL) { $env:MODEL } else { "deepseek-v4-pro" }),
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList @($false)
  [Console]::OutputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
} catch {
  # Encoding setup is best-effort; launcher behavior should not depend on it.
}

function Set-EnvDefault {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) {
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
  }
}

Set-EnvDefault "XTALPI_PI_TOOLS_MAX_TOOLS" "24"
Set-EnvDefault "XTALPI_PI_TOOLS_MAX_TOOL_RESULT_CHARS" "20000"
Set-EnvDefault "XTALPI_PI_TOOLS_MAX_EMPTY_RETRIES" "2"
Set-EnvDefault "XTALPI_PI_TOOLS_MAX_REPAIR_RETRIES" "2"
Set-EnvDefault "XTALPI_PI_TOOLS_MAX_TOTAL_RECOVERIES" "4"
Set-EnvDefault "XTALPI_PI_TOOLS_MAX_OUTPUT_TOKENS" "8192"
Set-EnvDefault "XTALPI_PI_TOOLS_TIMEOUT_MS" "180000"
Set-EnvDefault "PI_OBSERVATIONAL_MEMORY_PASSIVE" "true"

& pi --provider $Provider --model $Model --thinking off @RemainingArgs
exit $LASTEXITCODE
