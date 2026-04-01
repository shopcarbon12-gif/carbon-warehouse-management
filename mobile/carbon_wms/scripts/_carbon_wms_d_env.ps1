# Dot-sourced by build-apk.ps1 and env-d-drive.ps1 — keeps build temp/caches off C:.
param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [switch]$RequireRepoOnDDrive
)

function Get-CarbonWmsPathDriveLetter([string]$LiteralPath) {
  $resolved = try { (Resolve-Path -LiteralPath $LiteralPath -ErrorAction Stop).ProviderPath } catch { $LiteralPath }
  $q = Split-Path $resolved -Qualifier
  if (-not $q) { return $null }
  return $q.TrimEnd('\').ToUpperInvariant()
}

if ($RequireRepoOnDDrive) {
  $drive = Get-CarbonWmsPathDriveLetter $RepoRoot
  if ($drive -ne 'D:') {
    throw @"
Repo must be on D: so tooling stays off C:. Use a junction, e.g.:
  mklink /J D:\cwm "<full path to carbon-warehouse-management>"
Then open D:\cwm\mobile\carbon_wms. Current repo: $RepoRoot
"@
  }
}

$resolvedRepo = try { (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).ProviderPath } catch { $RepoRoot }
$driveRoot = Split-Path $resolvedRepo -Qualifier
# Native-asset hooks (e.g. objective_c) invoke batch steps that break on spaces in PUB_CACHE paths.
if ($resolvedRepo -match '\s' -and $driveRoot) {
  $extTools = Join-Path $driveRoot 'CarbonWmsTooling'
  $toolPub = Join-Path $extTools 'pub-cache'
  $toolGradle = Join-Path $extTools 'gradle-user-home'
  $toolTmp = Join-Path $extTools 'tmp'
  $xdgCache = Join-Path $extTools 'xdg-cache'
  $xdgConfig = Join-Path $extTools 'xdg-config'
} else {
  $toolPub = Join-Path $RepoRoot ".tools\pub-cache"
  $toolGradle = Join-Path $RepoRoot ".tools\gradle-user-home"
  $toolTmp = Join-Path $RepoRoot ".tools\tmp"
  $xdgCache = Join-Path $RepoRoot ".tools\xdg-cache"
  $xdgConfig = Join-Path $RepoRoot ".tools\xdg-config"
}
New-Item -ItemType Directory -Force -Path $toolPub, $toolGradle, $toolTmp, $xdgCache, $xdgConfig | Out-Null

$env:PUB_CACHE = $toolPub
$env:GRADLE_USER_HOME = $toolGradle
$env:TEMP = $toolTmp
$env:TMP = $toolTmp
$env:TMPDIR = $toolTmp
# Some Dart/Flutter tooling respects XDG on Windows when set (keeps cache off C:).
$env:XDG_CACHE_HOME = $xdgCache
$env:XDG_CONFIG_HOME = $xdgConfig

# Gradle / Android Kotlin compiler use JVM temp (quoted for spaces in paths)
$tmpArg = '-Djava.io.tmpdir="' + ($toolTmp -replace '\\', '/') + '"'
$prev = $env:JAVA_TOOL_OPTIONS
if ($prev) {
  if ($prev -notmatch 'java\.io\.tmpdir') {
    $env:JAVA_TOOL_OPTIONS = "$prev $tmpArg"
  }
} else {
  $env:JAVA_TOOL_OPTIONS = $tmpArg
}
