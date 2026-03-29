#Requires -Version 5.1
<#
  Apply D:-only build environment for this session (no new TEMP/Gradle/Pub caches on C:).

  Usage (PowerShell), from mobile/carbon_wms or after cd there:
    . .\scripts\env-d-drive.ps1

  Then launch Android Studio from the same terminal, or run flutter/gradle commands here.
  Repo must live on D: (use D:\cwm junction if your clone path has spaces — see README.md).
#>
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
. (Join-Path $PSScriptRoot "_carbon_wms_d_env.ps1") -RepoRoot $repoRoot -RequireRepoOnDDrive

Write-Host "Carbon WMS build env (D: only):"
Write-Host "  PUB_CACHE        = $env:PUB_CACHE"
Write-Host "  GRADLE_USER_HOME = $env:GRADLE_USER_HOME"
Write-Host "  TEMP/TMP         = $env:TEMP"
Write-Host "  JAVA_TOOL_OPTIONS (tmpdir) applied for JVM builds."
