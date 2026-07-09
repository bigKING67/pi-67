# Shared JSON helpers for pi-67 PowerShell entrypoints.
# These helpers intentionally avoid printing JSON content because local config
# files can contain API keys.

function Get-Pi67FirstBytesHex {
  param(
    [byte[]]$Bytes,
    [int]$MaxBytes = 16
  )

  if ($null -eq $Bytes -or $Bytes.Length -eq 0) {
    return ""
  }

  $limit = [Math]::Min($Bytes.Length, $MaxBytes)
  $parts = @()
  for ($i = 0; $i -lt $limit; $i++) {
    $parts += ("{0:x2}" -f $Bytes[$i])
  }
  return ($parts -join " ")
}

function Get-Pi67Utf16NulPattern {
  param([byte[]]$Bytes)

  $pairLimit = [Math]::Min([Math]::Floor($Bytes.Length / 2), 128)
  $oddNuls = 0
  $evenNuls = 0
  for ($pair = 0; $pair -lt $pairLimit; $pair++) {
    if ($Bytes[$pair * 2] -eq 0) {
      $evenNuls += 1
    }
    if ($Bytes[($pair * 2) + 1] -eq 0) {
      $oddNuls += 1
    }
  }

  return [pscustomobject]@{
    PairLimit = $pairLimit
    OddNuls = $oddNuls
    EvenNuls = $evenNuls
  }
}

function Test-Pi67LooksUtf16Le {
  param([byte[]]$Bytes)
  if ($Bytes.Length -lt 4) {
    return $false
  }
  $pattern = Get-Pi67Utf16NulPattern $Bytes
  return ($pattern.PairLimit -ge 2 -and
    $pattern.OddNuls -ge [Math]::Ceiling($pattern.PairLimit * 0.3) -and
    $pattern.OddNuls -gt ($pattern.EvenNuls * 2))
}

function Test-Pi67LooksUtf16Be {
  param([byte[]]$Bytes)
  if ($Bytes.Length -lt 4) {
    return $false
  }
  $pattern = Get-Pi67Utf16NulPattern $Bytes
  return ($pattern.PairLimit -ge 2 -and
    $pattern.EvenNuls -ge [Math]::Ceiling($pattern.PairLimit * 0.3) -and
    $pattern.EvenNuls -gt ($pattern.OddNuls * 2))
}

function Get-Pi67SubBytes {
  param(
    [byte[]]$Bytes,
    [int]$Start
  )

  if ($Start -le 0) {
    return $Bytes
  }
  if ($Start -ge $Bytes.Length) {
    return [byte[]]@()
  }

  $length = $Bytes.Length - $Start
  $result = New-Object byte[] $length
  [Array]::Copy($Bytes, $Start, $result, 0, $length)
  return $result
}

function Get-Pi67JsonTextInfo {
  param([Parameter(Mandatory = $true)][string]$Path)

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $utf8Strict = New-Object System.Text.UTF8Encoding -ArgumentList @($false, $true)
  $utf16LeStrict = New-Object System.Text.UnicodeEncoding -ArgumentList @($false, $true, $true)
  $utf16BeStrict = New-Object System.Text.UnicodeEncoding -ArgumentList @($true, $true, $true)

  $encodingName = "utf8"
  $hadBom = $false
  $hadNulByte = [Array]::IndexOf($bytes, [byte]0) -ge 0
  $decodeBytes = $bytes

  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) {
    $encodingName = "utf8-bom"
    $hadBom = $true
    $decodeBytes = Get-Pi67SubBytes $bytes 3
    $text = $utf8Strict.GetString($decodeBytes)
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xff -and $bytes[1] -eq 0xfe) {
    $encodingName = "utf16le-bom"
    $hadBom = $true
    $decodeBytes = Get-Pi67SubBytes $bytes 2
    $text = $utf16LeStrict.GetString($decodeBytes)
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xfe -and $bytes[1] -eq 0xff) {
    $encodingName = "utf16be-bom"
    $hadBom = $true
    $decodeBytes = Get-Pi67SubBytes $bytes 2
    $text = $utf16BeStrict.GetString($decodeBytes)
  } elseif (Test-Pi67LooksUtf16Le $bytes) {
    $encodingName = "utf16le"
    $text = $utf16LeStrict.GetString($bytes)
  } elseif (Test-Pi67LooksUtf16Be $bytes) {
    $encodingName = "utf16be"
    $text = $utf16BeStrict.GetString($bytes)
  } else {
    $text = $utf8Strict.GetString($bytes)
  }

  $cleaned = $text.TrimStart(([char[]]@([char]0xFEFF, [char]0x0000)))
  $leadingNoiseRemoved = $cleaned.Length -ne $text.Length
  $needsNormalization = ($encodingName -ne "utf8" -or $hadBom -or $hadNulByte -or $leadingNoiseRemoved)

  return [pscustomobject]@{
    Text = $cleaned
    EncodingName = $encodingName
    HadBom = $hadBom
    HadNulByte = $hadNulByte
    LeadingNoiseRemoved = $leadingNoiseRemoved
    NeedsNormalization = $needsNormalization
    FirstBytesHex = Get-Pi67FirstBytesHex $bytes
  }
}

function Read-Pi67JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  $info = Get-Pi67JsonTextInfo $Path
  try {
    return $info.Text | ConvertFrom-Json
  } catch {
    throw ("cannot parse JSON {0}: {1}; detectedEncoding={2}; firstBytes={3}" -f $Path, $_.Exception.Message, $info.EncodingName, $info.FirstBytesHex)
  }
}

function Save-Pi67JsonFileUtf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Data
  )

  $json = ($Data | ConvertTo-Json -Depth 80) + "`n"
  $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList @($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Repair-Pi67JsonFileEncoding {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Label = "",
    [switch]$DryRun
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [pscustomobject]@{
      Status = "missing"
      Path = $Path
      Label = $Label
      Changed = $false
      EncodingName = ""
      BackupPath = ""
      FirstBytesHex = ""
    }
  }

  $info = Get-Pi67JsonTextInfo $Path
  try {
    $data = $info.Text | ConvertFrom-Json
  } catch {
    $displayLabel = $Path
    if ($Label) {
      $displayLabel = $Label
    }
    throw ("invalid JSON: {0}: {1}; detectedEncoding={2}; firstBytes={3}" -f $displayLabel, $_.Exception.Message, $info.EncodingName, $info.FirstBytesHex)
  }

  if (-not $info.NeedsNormalization) {
    return [pscustomobject]@{
      Status = "unchanged"
      Path = $Path
      Label = $Label
      Changed = $false
      EncodingName = $info.EncodingName
      BackupPath = ""
      FirstBytesHex = $info.FirstBytesHex
    }
  }

  $backupPath = ""
  if (-not $DryRun) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "{0}.bak-{1}-encoding" -f $Path, $stamp
    Copy-Item -LiteralPath $Path -Destination $backupPath -Force
    Save-Pi67JsonFileUtf8NoBom $Path $data
  }

  $status = "normalized"
  if ($DryRun) {
    $status = "would-normalize"
  }

  return [pscustomobject]@{
    Status = $status
    Path = $Path
    Label = $Label
    Changed = $true
    EncodingName = $info.EncodingName
    BackupPath = $backupPath
    FirstBytesHex = $info.FirstBytesHex
  }
}

function Get-Pi67GitCandidatePaths {
  $candidates = @()
  if ($env:PI67_GIT_EXE) {
    $candidates += $env:PI67_GIT_EXE
  }
  foreach ($root in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($root) {
      $candidates += (Join-Path (Join-Path $root "Git") "cmd\git.exe")
      $candidates += (Join-Path (Join-Path $root "Git") "bin\git.exe")
    }
  }
  $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:LocalAppData }
  if ($localAppData) {
    $candidates += (Join-Path (Join-Path (Join-Path $localAppData "Programs") "Git") "cmd\git.exe")
  }
  $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
  if ($userHome) {
    $candidates += (Join-Path (Join-Path (Join-Path (Join-Path $userHome "scoop") "apps") "git") "current\cmd\git.exe")
  }
  if ($env:ChocolateyInstall) {
    $candidates += (Join-Path (Join-Path $env:ChocolateyInstall "bin") "git.exe")
  }

  $seen = @{}
  $result = @()
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $key = $candidate.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $result += $candidate
  }
  return $result
}

function Find-Pi67GitExecutable {
  $existing = Get-Command "git" -ErrorAction SilentlyContinue
  if ($existing) {
    return [pscustomobject]@{
      Source = $existing.Source
      AlreadyOnPath = $true
      AddedToPath = $false
    }
  }

  foreach ($candidate in (Get-Pi67GitCandidatePaths)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return [pscustomobject]@{
        Source = $candidate
        AlreadyOnPath = $false
        AddedToPath = $false
      }
    }
  }

  return [pscustomobject]@{
    Source = ""
    AlreadyOnPath = $false
    AddedToPath = $false
  }
}

function Test-Pi67PathContainsDirectory {
  param([Parameter(Mandatory = $true)][string]$Directory)
  $pathValue = if ($env:Path) { $env:Path } else { "" }
  $separator = [string][System.IO.Path]::PathSeparator
  $target = $Directory.TrimEnd('\', '/').ToLowerInvariant()
  foreach ($segment in @($pathValue -split [Regex]::Escape($separator))) {
    if (-not $segment) { continue }
    if ($segment.TrimEnd('\', '/').ToLowerInvariant() -eq $target) {
      return $true
    }
  }
  return $false
}

function Initialize-Pi67GitPath {
  $found = Find-Pi67GitExecutable
  if (-not $found.Source -or $found.AlreadyOnPath) {
    return $found
  }

  $gitDir = Split-Path -Parent $found.Source
  if (-not (Test-Pi67PathContainsDirectory $gitDir)) {
    $separator = [string][System.IO.Path]::PathSeparator
    if ($env:Path) {
      $env:Path = "{0}{1}{2}" -f $gitDir, $separator, $env:Path
    } else {
      $env:Path = $gitDir
    }
    $found.AddedToPath = $true
  }
  return $found
}
