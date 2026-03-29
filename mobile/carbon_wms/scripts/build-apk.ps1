#Requires -Version 5.1
<#
  Build a release APK for Carbon WMS.
  Prerequisites: Flutter SDK + Android SDK (Android Studio).

  Usage (PowerShell):
    cd <repo>\mobile\carbon_wms
    .\scripts\build-apk.ps1

  Optional:
    $env:FLUTTER_ROOT = "C:\path\to\flutter"
    $env:ANDROID_HOME = "C:\path\to\Android\sdk"
    .\scripts\build-apk.ps1

  If the repo lives under a path with spaces (e.g. "My project"), some Dart native-asset
  hooks can fail. Fix: create junctions without spaces and point android/local.properties
  at them, then build from the junction path (see mobile/carbon_wms/README.md).
#>
$ErrorActionPreference = "Stop"
$here = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
Set-Location $here

function Find-FlutterBin {
  $repoFlutter = Join-Path $repoRoot ".tools\flutter\bin\flutter.bat"
  if (Test-Path $repoFlutter) { return $repoFlutter }
  if ($env:FLUTTER_ROOT -and (Test-Path "$($env:FLUTTER_ROOT)\bin\flutter.bat")) {
    return "$($env:FLUTTER_ROOT)\bin\flutter.bat"
  }
  $cmd = Get-Command flutter -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
      "$env:USERPROFILE\flutter\bin\flutter.bat",
      "C:\src\flutter\bin\flutter.bat",
      "C:\flutter\bin\flutter.bat"
    )) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$flutter = Find-FlutterBin
if (-not $flutter) {
  Write-Error @"
Could not find Flutter. Either extract the SDK to <repo>\.tools\flutter, or:
  - Add flutter to PATH, or
  - Set FLUTTER_ROOT to your SDK folder (containing bin\flutter.bat)
Android Studio: Settings → Languages & Frameworks → Flutter → Flutter SDK path.
"@
}

if ($here -match "\s") {
  Write-Warning @"
Project path contains spaces. If the build fails inside native-asset hooks (objective_c),
use directory junctions without spaces and android/local.properties — see README.md in this folder.
"@
}

# Prefer caches on the same drive as the repo to avoid C: full-disk issues.
$toolPub = Join-Path $repoRoot ".tools\pub-cache"
$toolGradle = Join-Path $repoRoot ".tools\gradle-user-home"
New-Item -ItemType Directory -Force -Path $toolPub, $toolGradle | Out-Null
$env:PUB_CACHE = $toolPub
$env:GRADLE_USER_HOME = $toolGradle

Write-Host "Using: $flutter"
& $flutter --version

$androidGradle = Join-Path $here "android\app\build.gradle.kts"
if (-not (Test-Path $androidGradle)) {
  Write-Host "Scaffolding platforms (first run)..."
  & $flutter create . --project-name carbon_wms
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $flutter pub get
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $flutter build apk --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$apk = Join-Path $here "build\app\outputs\flutter-apk\app-release.apk"
Write-Host ""
Write-Host "APK: $apk"
if (Test-Path $apk) { Get-Item $apk | Format-List FullName, Length, LastWriteTime }
