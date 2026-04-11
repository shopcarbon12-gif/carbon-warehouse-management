#!/usr/bin/env bash
# Build a release APK for Carbon WMS on Linux, copy to ~/CarbonWmsRelease,
# and SCP to the Windows dev PC (Elior@192.168.1.2:D:/CarbonWmsRelease/).
#
# Usage (from anywhere in the repo):
#   bash mobile/carbon_wms/scripts/build-release.sh
#
# Requirements:
#   - Flutter in PATH
#   - SSH key from this machine added to C:\Users\Elior\.ssh\authorized_keys on Windows
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$MOBILE_DIR"

# Read version from pubspec.yaml, strip build number (e.g. 1.1.1+2 -> 1.1.1)
FULL_VERSION=$(grep '^version:' pubspec.yaml | awk '{print $2}')
SEM_VERSION="${FULL_VERSION%%+*}"
APK_NAME="CarbonWMS V${SEM_VERSION}.apk"

KEYSTORE="$HOME/.android/carbon-wms-release.jks"
KEY_PROPS="$MOBILE_DIR/android/key.properties"

# Ensure key.properties points to the Linux keystore
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
LINUX_RELEASE_DIR="$HOME/CarbonWmsRelease"
mkdir -p "$LINUX_RELEASE_DIR"
cp "$APK_SRC" "$LINUX_RELEASE_DIR/$APK_NAME"
echo "Copied to: $LINUX_RELEASE_DIR/$APK_NAME"

# SCP to Windows dev PC
WINDOWS_USER="Elior"
WINDOWS_IP="192.168.1.2"
WINDOWS_DEST="D:/CarbonWmsRelease"

echo "Copying to Windows $WINDOWS_IP:$WINDOWS_DEST/$APK_NAME ..."
scp -o StrictHostKeyChecking=no \
    "$LINUX_RELEASE_DIR/$APK_NAME" \
    "${WINDOWS_USER}@${WINDOWS_IP}:/D:/CarbonWmsRelease/${APK_NAME}"

echo ""
echo "Done. Release APK: $APK_NAME"
echo "  Linux:   $LINUX_RELEASE_DIR/$APK_NAME"
echo "  Windows: $WINDOWS_DEST\\$APK_NAME"
