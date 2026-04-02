#Requires -Version 5.1
<#
  Download Android SDK command-line tools (sdkmanager) into <SdkRoot>\cmdline-tools\latest.
  Use when `flutter doctor` reports cmdline-tools missing.

  Default SdkRoot: D:\asdk (override with -SdkRoot if your local.properties differs).

  Requires: BITS (Start-BitsTransfer) — built into Windows.

  Usage (Administrator not required):
    .\scripts\install-android-cmdline-tools.ps1
    .\scripts\install-android-cmdline-tools.ps1 -SdkRoot "D:\Android\Sdk"
#>
param(
  [string] $SdkRoot = "D:\asdk"
)

$ErrorActionPreference = "Stop"

$repoXml = "https://dl.google.com/android/repository/repository2-1.xml"
$tmpRoot = "D:\CarbonWmsTooling\tmp"
$zipPath = Join-Path $tmpRoot "commandlinetools-win-latest.zip"
$stage = Join-Path $tmpRoot "cmdline-tools-stage"
$dest = Join-Path $SdkRoot "cmdline-tools\latest"

New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

Write-Host "Resolving latest commandlinetools-win zip from Google repository index..."
$xmlPath = Join-Path $tmpRoot "repo2-1.xml"
Invoke-WebRequest -Uri $repoXml -OutFile $xmlPath -UseBasicParsing -TimeoutSec 120
$content = Get-Content -LiteralPath $xmlPath -Raw
$matches = [regex]::Matches($content, 'commandlinetools-win-(\d+)_latest\.zip')
if ($matches.Count -eq 0) { throw "Could not find commandlinetools-win zip in repository2-1.xml" }
$best = ($matches | ForEach-Object { [int]$_.Groups[1].Value } | Sort-Object -Descending | Select-Object -First 1)
$zipName = "commandlinetools-win-${best}_latest.zip"
$zipUrl = "https://dl.google.com/android/repository/$zipName"
Write-Host "Using: $zipUrl"

if (Test-Path $zipPath) { Remove-Item $zipPath -Force -ErrorAction SilentlyContinue }
Write-Host "Downloading (BITS)..."
Start-BitsTransfer -Source $zipUrl -Destination $zipPath -DisplayName "Android cmdline-tools" -Priority High
while ($true) {
  $j = Get-BitsTransfer -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "Android cmdline-tools" }
  if (-not $j) { break }
  if ($j.JobState -in @("Transferred", "Error")) { break }
  Start-Sleep -Seconds 2
}
Get-BitsTransfer -ErrorAction SilentlyContinue | Complete-BitsTransfer -ErrorAction SilentlyContinue

$expected = (Invoke-WebRequest -Uri $zipUrl -Method Head -UseBasicParsing -TimeoutSec 30).Headers["Content-Length"]
$got = (Get-Item $zipPath).Length
if ($expected -and [long]$expected -ne $got) {
  throw "Download size mismatch: got $got expected $expected"
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Expand-Archive -LiteralPath $zipPath -DestinationPath $stage -Force
$inner = Join-Path $stage "cmdline-tools"
if (-not (Test-Path $inner)) { throw "Unexpected zip layout: missing cmdline-tools folder" }

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $SdkRoot "cmdline-tools") | Out-Null
Move-Item -LiteralPath $inner -Destination $dest

Write-Host "Installed: $(Join-Path $dest 'bin\sdkmanager.bat')"
& (Join-Path $dest "bin\sdkmanager.bat") --version
Write-Host ""
Write-Host "Next: set ANDROID_HOME and accept licenses:"
Write-Host "  `$env:ANDROID_HOME='$SdkRoot'"
Write-Host "  flutter doctor --android-licenses"
Write-Host "  (or pipe y into: sdkmanager.bat --licenses)"
