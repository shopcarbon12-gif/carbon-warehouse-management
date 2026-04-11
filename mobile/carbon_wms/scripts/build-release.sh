#!/usr/bin/env bash
# Build a release APK for Carbon WMS on Linux.
# Copies to ~/CarbonWmsRelease and SCPs to D:\CarbonWmsRelease on Windows PC.
#
# Usage (from anywhere in the repo):
#   bash mobile/carbon_wms/scripts/build-release.sh
#
# Requirements:
#   - Flutter in PATH
#   - Keystore at ~/.android/carbon-wms-release.jks
#   - SSH access to Windows PC (Elior@192.168.1.2)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$MOBILE_DIR/../.." && pwd)"

# Keep all Gradle and Dart caches inside the repo's .tools/ — nothing in ~/.gradle or system dirs
export GRADLE_USER_HOME="$REPO_DIR/.tools/gradle-user-home"
export PUB_CACHE="$REPO_DIR/.tools/pub-cache"

cd "$MOBILE_DIR"

# Read version from pubspec.yaml
FULL_VERSION=$(grep '^version:' pubspec.yaml | awk '{print $2}')
SEM_VERSION="${FULL_VERSION%%+*}"
APK_NAME="CarbonWMS V${SEM_VERSION}.apk"

KEYSTORE="$HOME/.android/carbon-wms-release.jks"
KEY_PROPS="$MOBILE_DIR/android/key.properties"

cat > "$KEY_PROPS" << EOF
storePassword=CarbonWMS2026!
keyPassword=CarbonWMS2026!
keyAlias=carbon-wms
storeFile=$KEYSTORE
EOF

echo "Building CarbonWMS $FULL_VERSION (APK: $APK_NAME)..."

flutter build apk --release

APK_SRC="$MOBILE_DIR/build/app/outputs/flutter-apk/app-release.apk"
if [ ! -f "$APK_SRC" ]; then
  echo "ERROR: APK not found at $APK_SRC" >&2
  exit 1
fi

# Copy to Linux release folder
RELEASE_DIR="$HOME/CarbonWmsRelease"
mkdir -p "$RELEASE_DIR"
cp "$APK_SRC" "$RELEASE_DIR/$APK_NAME"
echo "Linux:   $RELEASE_DIR/$APK_NAME"

# SCP to Windows PC
WINDOWS_USER="Elior"
WINDOWS_IP="192.168.1.21"
WINDOWS_DEST="D:/CarbonWmsRelease"

echo "Copying to Windows $WINDOWS_IP:$WINDOWS_DEST ..."
scp -o StrictHostKeyChecking=no \
    "$RELEASE_DIR/$APK_NAME" \
    "${WINDOWS_USER}@${WINDOWS_IP}:/D:/CarbonWmsRelease/${APK_NAME}"

echo ""
echo "Done. Release APK: $APK_NAME"
echo "  Linux:   $RELEASE_DIR/$APK_NAME"
echo "  Windows: $WINDOWS_DEST\\$APK_NAME"
