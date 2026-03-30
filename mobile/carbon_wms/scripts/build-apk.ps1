#Requires -Version 5.1
<#
  Build a release APK for Carbon WMS.
  Prerequisites: Flutter SDK + Android SDK on D:; repo root on D: (junction D:\cwm if needed).

  Usage (PowerShell):
    cd D:\cwm\mobile\carbon_wms
    .\scripts\build-apk.ps1

  Optional:
    $env:FLUTTER_ROOT = "D:\path\to\flutter"
    $env:ANDROID_HOME = "D:\path\to\Android\sdk"
    .\scripts\build-apk.ps1 -ReleaseRoot "D:\CarbonWmsRelease"

  TEMP, Pub, Gradle, JVM tmpdir, and XDG cache roots are forced under <repo>\.tools\ (not C:).
  After success, copies app-release.apk and app-release.apk.sha1 to D:\CarbonWmsRelease (override with -ReleaseRoot).

  Runs `flutter test` before the release APK build.

  If the repo path has spaces, use a no-space junction and android/local.properties — README.md.
#>
param(
  [string] $ReleaseRoot = "D:\CarbonWmsRelease"
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
  foreach ($p in @(
      "D:\flutter\bin\flutter.bat",
      "D:\src\flutter\bin\flutter.bat",
      "$env:USERPROFILE\flutter\bin\flutter.bat"
    )) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$flutter = Find-FlutterBin
if (-not $flutter) {
  Write-Error @"
Could not find Flutter. Put the SDK on drive D under <repo>\.tools\flutter, or set
FLUTTER_ROOT to a Flutter folder on drive D (must contain bin\flutter.bat).
Android Studio: Settings → Languages & Frameworks → Flutter → Flutter SDK path.
"@
}

$flutterSdkRoot = (Resolve-Path (Join-Path (Split-Path $flutter -Parent) "..")).Path
if ((Get-CarbonWmsPathDriveLetter $flutterSdkRoot) -ne 'D:') {
  Write-Error "Flutter SDK must be on D: (no new tooling files on C:). Current SDK: $flutterSdkRoot"
}
$env:FLUTTER_ROOT = $flutterSdkRoot

if ($here -match "\s") {
  Write-Warning @"
Project path contains spaces. If the build fails inside native-asset hooks (objective_c),
use directory junctions without spaces and android/local.properties — see README.md in this folder.
"@
}

$localProps = Join-Path $here "android\local.properties"
if (Test-Path $localProps) {
  foreach ($line in Get-Content -LiteralPath $localProps) {
    if ($line -match '^\s*sdk\.dir\s*=\s*(.+)\s*$') {
      $sdkDir = $matches[1].Trim() -replace '\\\\', '\' -replace '/', '\'
      if ($sdkDir) {
        try { $sdkDir = (Resolve-Path -LiteralPath $sdkDir -ErrorAction Stop).Path } catch { }
        if (-not (Test-Path $sdkDir)) {
          Write-Error "android/local.properties sdk.dir not found: $sdkDir"
        }
        if ((Get-CarbonWmsPathDriveLetter $sdkDir) -ne 'D:') {
          Write-Error "Android SDK must be on D:. sdk.dir=$sdkDir"
        }
        $env:ANDROID_HOME = $sdkDir
        $env:ANDROID_SDK_ROOT = $sdkDir
      }
      break
    }
  }
}
if (-not $env:ANDROID_HOME) {
  Write-Error "No Android SDK. Set sdk.dir in android/local.properties (D: path, e.g. D:/asdk) or set ANDROID_HOME."
}

Write-Host "Using: $flutter"
Write-Host "ANDROID_HOME=$env:ANDROID_HOME"
Write-Host "PUB_CACHE=$env:PUB_CACHE"
Write-Host "GRADLE_USER_HOME=$env:GRADLE_USER_HOME"
Write-Host "TEMP=$env:TEMP"
& $flutter --version

$androidGradle = Join-Path $here "android\app\build.gradle.kts"
if (-not (Test-Path $androidGradle)) {
  Write-Host "Scaffolding platforms (first run)..."
  & $flutter create . --project-name carbon_wms
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $flutter pub get
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Running flutter test..."
& $flutter test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $flutter build apk --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$apk = Join-Path $here "build\app\outputs\flutter-apk\app-release.apk"
Write-Host ""
Write-Host "APK: $apk"
if (-not (Test-Path -LiteralPath $apk)) {
  Write-Error "Expected APK missing: $apk"
}
Get-Item -LiteralPath $apk | Format-List FullName, Length, LastWriteTime

if ($ReleaseRoot) {
  $destDir = $ReleaseRoot.TrimEnd('\', '/')
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  $destApk = Join-Path $destDir "app-release.apk"
  $destSha = Join-Path $destDir "app-release.apk.sha1"
  Copy-Item -LiteralPath $apk -Destination $destApk -Force
  $sha1 = (Get-FileHash -Algorithm SHA1 -LiteralPath $apk).Hash.ToLowerInvariant()
  [System.IO.File]::WriteAllText($destSha, $sha1)
  Write-Host ""
  Write-Host "Copied release to D: drop folder:"
  Write-Host "  $destApk"
  Write-Host "  $destSha"
  Get-Item -LiteralPath $destApk | Format-List FullName, Length, LastWriteTime
}
