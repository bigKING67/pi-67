#!/usr/bin/env pwsh
[CmdletBinding()]
param(
  [string]$AgentDir,
  [switch]$Check,
  [switch]$Apply,
  [switch]$Json,
  [switch]$SelfTest,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
pi67-patch-pi-until-done-runtime-queue patches/checks pi-until-done queue compatibility.

Usage:
  .\scripts\pi67-patch-pi-until-done-runtime-queue.ps1 [-Check] [-Apply] [-Json] [-AgentDir DIR]

Default mode is -Apply. The underlying patch is version-aware and only rewrites
known pi-until-done@0.2.2 sendUserMessage call sites.
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

function Test-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-CommandExists "node")) {
  Write-Host "FAIL node not found; cannot check pi-until-done runtime queue compatibility" -ForegroundColor Red
  exit 1
}

$ScriptPath = Resolve-ScriptPath
$ScriptDir = Split-Path -Parent $ScriptPath
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$NodeScript = Join-Path $ScriptDir "pi67-patch-pi-until-done-runtime-queue.mjs"

if (-not $AgentDir) {
  $AgentDir = Join-Path (Join-Path (Get-HomePath) ".pi") "agent"
}

$mode = "--apply"
if ($Check -and -not $Apply) {
  $mode = "--check"
}

$argsList = @($NodeScript)
if ($SelfTest) {
  $argsList += "--self-test"
} else {
  $argsList += $mode
  $argsList += "--agent-dir"
  $argsList += $AgentDir
  if ($Json) {
    $argsList += "--json"
  }
}

& node @argsList
exit $LASTEXITCODE
