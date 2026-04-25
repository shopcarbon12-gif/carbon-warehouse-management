#!/usr/bin/env bash
# Release APK on Linux build host (Flutter at /home/carbondev/development/flutter or PATH).
# Usage:
#   export PATH="/home/carbondev/development/flutter/bin:$PATH"
#   bash mobile/carbon_wms/scripts/build-release.sh
#
# Optional: RELEASE_ROOT (default ~/CarbonWmsRelease), RUN_FLUTTER_TESTS=1 to run tests first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RELEASE_ROOT="${RELEASE_ROOT:-$HOME/CarbonWmsRelease}"
FLUTTER_BIN="${FLUTTER_BIN:-flutter}"
if ! command -v "$FLUTTER_BIN" >/dev/null 2>&1; then
  echo "error: flutter not on PATH (e.g. export PATH=\"/home/carbondev/development/flutter/bin:\$PATH\")" >&2
  exit 1
fi

"$FLUTTER_BIN" pub get
if [[ "${RUN_FLUTTER_TESTS:-}" == "1" ]]; then
  "$FLUTTER_BIN" test
fi
"$FLUTTER_BIN" build apk --release

APK="$ROOT/build/app/outputs/flutter-apk/app-release.apk"
if [[ ! -f "$APK" ]]; then
  echo "error: expected APK missing: $APK" >&2
  exit 1
fi

mkdir -p "$RELEASE_ROOT"
cp -f "$APK" "$RELEASE_ROOT/app-release.apk"
sha1=$(sha1sum "$APK" | awk '{print $1}')
printf '%s\n' "$sha1" > "$RELEASE_ROOT/app-release.apk.sha1"

FULL_VERSION=""
if [[ -f pubspec.yaml ]]; then
  FULL_VERSION=$(grep -E '^version:' pubspec.yaml | head -1 | sed -E 's/^version:[[:space:]]+//;s/[[:space:]]+$//;s/^["'\'']//;s/["'\'']$//')
fi
VERSION="${FULL_VERSION%%+*}"
if [[ -n "$VERSION" ]]; then
  VNAME="CarbonWMS V${VERSION}.apk"
  cp -f "$APK" "$RELEASE_ROOT/$VNAME"
  printf '%s\n' "$sha1" > "$RELEASE_ROOT/${VNAME}.sha1"
  echo "Versioned drop: $RELEASE_ROOT/$VNAME"
fi

echo "Built: $APK"
ls -la "$APK" "$RELEASE_ROOT/app-release.apk"

# Sanity-print the computed Android versionCode (extracted from the AndroidManifest
# inside the APK). Helps catch regressions in app/build.gradle.kts:computeVersionCode
# before sideloading on a handheld that already has an older build.
if command -v "$ANDROID_HOME/build-tools"/*/aapt2 >/dev/null 2>&1; then
  AAPT2=$(ls "$ANDROID_HOME/build-tools"/*/aapt2 2>/dev/null | sort -V | tail -1)
elif command -v aapt2 >/dev/null 2>&1; then
  AAPT2=$(command -v aapt2)
fi
if [[ -n "${AAPT2:-}" ]]; then
  CODE=$("$AAPT2" dump badging "$APK" 2>/dev/null | sed -nE "s/^package: name='[^']+' versionCode='([0-9]+)' versionName='[^']+'.*/\\1/p" | head -1)
  NAME=$("$AAPT2" dump badging "$APK" 2>/dev/null | sed -nE "s/^package: name='[^']+' versionCode='[0-9]+' versionName='([^']+)'.*/\\1/p" | head -1)
  if [[ -n "$CODE" && -n "$NAME" ]]; then
    echo "Android: versionName=$NAME versionCode=$CODE"
  fi
fi
