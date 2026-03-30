#Requires -Version 5.1
<#
  Clears safe-to-regenerate Android Studio data under LocalAppData\Google\AndroidStudio*
  (caches, logs, tmp, search index). Frees space on C:; IDE re-downloads/reindexes on next open.
  Close Android Studio before running. Does not touch Roaming (settings/plugins) or Chrome.
#>
$ErrorActionPreference = "SilentlyContinue"
$roots = Get-ChildItem "$env:LOCALAPPDATA\Google" -Directory -Filter "AndroidStudio*"
foreach ($root in $roots) {
  foreach ($sub in @("caches", "log", "tmp", "index", "gmaven.index")) {
    $p = Join-Path $root.FullName $sub
    if (Test-Path $p) {
      Remove-Item "$p\*" -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "Cleared $p"
    }
  }
}
Write-Host "Done. Reopen Android Studio and let indexing finish."
