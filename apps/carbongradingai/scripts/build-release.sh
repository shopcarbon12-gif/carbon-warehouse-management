#!/usr/bin/env bash
# CarbonTools release APK (was CarbonGradingAI; Linux build host, no Flutter needed).
#   bash apps/carbongradingai/scripts/build-release.sh
# Output: ~/CarbonToolsRelease/CarbonTools V<version>.apk (+ .sha1)
# Optional: RELEASE_ROOT, GRADLE_USER_HOME, ANDROID_HOME. The signing key is created on first run
# (keys/carbongradingai-release.jks + key.properties, both gitignored) and copied to
# ~/CarbonGradingAIRelease/keys-backup/ — it must never change: app updates need the same key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
cd "$ROOT"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$REPO_ROOT/.tools/gradle-user-home}"
export TMPDIR="${TMPDIR:-$REPO_ROOT/.tools/tmp}"
mkdir -p "$GRADLE_USER_HOME" "$TMPDIR"
RELEASE_ROOT="${RELEASE_ROOT:-$HOME/CarbonToolsRelease}"
# The signing key and its backup keep their old names and place (~/CarbonGradingAIRelease/keys-backup/).
KEYS_BACKUP="${KEYS_BACKUP:-$HOME/CarbonGradingAIRelease/keys-backup}"

[[ -f local.properties ]] || echo "sdk.dir=$ANDROID_HOME" > local.properties

KEYS_DIR="$ROOT/keys"
KS="$KEYS_DIR/carbongradingai-release.jks"
if [[ ! -f key.properties ]]; then
  mkdir -p "$KEYS_DIR"
  if [[ ! -f "$KS" ]]; then
    PASS="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 28)"
    keytool -genkeypair -v -keystore "$KS" -alias carbongradingai -keyalg RSA -keysize 4096 -validity 10000 \
      -storepass "$PASS" -keypass "$PASS" \
      -dname "CN=CarbonGradingAI, O=Carbon, C=US" >/dev/null
    printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=carbongradingai\nkeyPassword=%s\n' "$KS" "$PASS" "$PASS" > key.properties
    chmod 600 key.properties
    mkdir -p "$KEYS_BACKUP"
    cp -f "$KS" key.properties "$KEYS_BACKUP/"
    chmod 600 "$KEYS_BACKUP/"*
    echo "!! NEW release keystore created: $KS — backed up to $KEYS_BACKUP/. Keep both safe."
  else
    echo "error: $KS exists but key.properties is missing — restore key.properties from $KEYS_BACKUP/." >&2
    exit 1
  fi
fi

./gradlew --quiet testDebugUnitTest assembleRelease

APK="$ROOT/app/build/outputs/apk/release/app-release.apk"
[[ -f "$APK" ]] || { echo "error: expected APK missing: $APK" >&2; exit 1; }

VERSION="$(sed -nE 's/^val appVersionName = "([^"]+)".*/\1/p' app/build.gradle.kts | head -1)"
mkdir -p "$RELEASE_ROOT"
sha1="$(sha1sum "$APK" | awk '{print $1}')"
VNAME="CarbonTools V${VERSION}.apk"
cp -f "$APK" "$RELEASE_ROOT/$VNAME"
printf '%s\n' "$sha1" > "$RELEASE_ROOT/${VNAME}.sha1"
echo "Built: $RELEASE_ROOT/$VNAME"
ls -la "$RELEASE_ROOT/$VNAME"

AAPT2="$(ls "$ANDROID_HOME/build-tools"/*/aapt2 2>/dev/null | sort -V | tail -1 || true)"
if [[ -n "${AAPT2:-}" ]]; then
  "$AAPT2" dump badging "$APK" 2>/dev/null | sed -nE "s/^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'.*/Android: package=\1 versionName=\3 versionCode=\2/p"
  "$AAPT2" dump badging "$APK" 2>/dev/null | grep -E "^(sdkVersion|targetSdkVersion)" | tr '\n' ' '; echo
fi
