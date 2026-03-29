#Requires -Version 5.1
<#
  Build a release APK for Carbon WMS.
  Prerequisites: Flutter SDK + Android SDK (e.g. via Android Studio).

  Usage (PowerShell):
    cd <repo>\mobile\carbon_wms
    .\scripts\build-apk.ps1
    # or:
    $env:FLUTTER_ROOT = "C:\path\to\flutter"
    .\scripts\build-apk.ps1
#>
$ErrorActionPreference = "Stop"
$here = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $here

function Find-FlutterBin {
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
Could not find Flutter. Install Flutter and either:
  - Add flutter to PATH, or
  - Set FLUTTER_ROOT to your SDK folder (containing bin\flutter.bat)
Android Studio: Settings → Languages & Frameworks → Flutter → Flutter SDK path.
"@
}

Write-Host "Using: $flutter"
& $flutter --version
& $flutter create . --project-name carbon_wms
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $flutter pub get
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $flutter build apk --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$apk = Join-Path $here "build\app\outputs\flutter-apk\app-release.apk"
Write-Host ""
Write-Host "APK: $apk"
if (Test-Path $apk) { Get-Item $apk | Format-List FullName, Length, LastWriteTime }
