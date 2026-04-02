#Requires -Version 5.1
<#
  One-time (per user): set Windows USER environment variables so EVERY Flutter/Gradle/Dart
  process uses D: for temp and caches — not only when you run build-apk.ps1.

  Fixes: C: filling to 0 MB when Cursor/agent runs `flutter` without the build script;
         reduces surprise writes under %LOCALAPPDATA% and %TEMP% on C:.

  Run in PowerShell (your user account, no admin required for User scope):
    cd D:\cwm\mobile\carbon_wms
    .\scripts\install-user-build-env-on-d.ps1

  Then fully quit and reopen Cursor / terminals so new env vars apply.

  Data root default: D:\CarbonWmsTooling (flat on D:, no junction — Explorer sees real free space on D:).
#>
param(
  [string] $DataRoot = "D:\CarbonWmsTooling"
)

$ErrorActionPreference = "Stop"

$pub = Join-Path $DataRoot "pub-cache"
$gradle = Join-Path $DataRoot "gradle-user-home"
$tmp = Join-Path $DataRoot "tmp"
$xdgCache = Join-Path $DataRoot "xdg-cache"
$xdgConfig = Join-Path $DataRoot "xdg-config"

New-Item -ItemType Directory -Force -Path $pub, $gradle, $tmp, $xdgCache, $xdgConfig | Out-Null

function Set-UserEnv([string]$Name, [string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, "User")
  Write-Host "User $Name = $Value"
}

# Core: anything that respects TEMP/TMP (JVM, many tools) goes to D:
Set-UserEnv "TEMP" $tmp
Set-UserEnv "TMP" $tmp
Set-UserEnv "TMPDIR" $tmp

# Dart / Flutter packages
Set-UserEnv "PUB_CACHE" $pub

# Gradle (wrapper + daemon) — huge; must not live on C:
Set-UserEnv "GRADLE_USER_HOME" $gradle

# Optional: some Dart tooling
Set-UserEnv "XDG_CACHE_HOME" $xdgCache
Set-UserEnv "XDG_CONFIG_HOME" $xdgConfig

Write-Host ""
Write-Host 'Done. Restart Cursor and open a NEW PowerShell - verify:'
Write-Host '  echo $env:TEMP; echo $env:PUB_CACHE; echo $env:GRADLE_USER_HOME'
Write-Host ""
Write-Host 'Junction tip: Explorer can mis-count space when the repo is a junction to another drive.'
Write-Host 'Long-term: clone the repo directly under D:\ (no junction) if crashes persist.'
