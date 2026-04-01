#Requires -Version 5.1
<#
  Run Carbon WMS in Chrome for web debug with a stable URL port.

  Why: `flutter run -d chrome` normally picks a random free port each time.
  This script pins --web-port (default 50122) so bookmarks and DevTools stay consistent.

  Usage:
    cd D:\cwm\mobile\carbon_wms
    .\scripts\run-web-chrome.ps1

  Optional:
    .\scripts\run-web-chrome.ps1 -WebPort 8080

  Use junction D:\cwm (no spaces) if native-asset / objective_c hooks fail — see README.md.
#>
param(
  [int] $WebPort = 50122
)
$ErrorActionPreference = "Stop"
$here = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Set-Location $here

. (Join-Path $PSScriptRoot "_carbon_wms_d_env.ps1") -RepoRoot $repoRoot -RequireRepoOnDDrive

function Find-FlutterBin {
  $repoFlutter = Join-Path $repoRoot ".tools\flutter\bin\flutter.bat"
  if (Test-Path $repoFlutter) { return $repoFlutter }
  if ($env:FLUTTER_ROOT -and (Test-Path "$($env:FLUTTER_ROOT)\bin\flutter.bat")) {
    return "$($env:FLUTTER_ROOT)\bin\flutter.bat"
  }
  $cmd = Get-Command flutter -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$flutter = Find-FlutterBin
if (-not $flutter) {
  Write-Error "Could not find Flutter (.tools\flutter or FLUTTER_ROOT)."
}

if ($here -match "\s") {
  Write-Warning "Project path has spaces. Prefer: cd D:\cwm\mobile\carbon_wms"
}

Write-Host "Flutter web: http://localhost:$WebPort/"
Write-Host "Hot reload: r   Hot restart: R   Quit: q"
& $flutter run -d chrome --web-port=$WebPort
