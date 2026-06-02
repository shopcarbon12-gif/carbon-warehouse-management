#!/usr/bin/env bash
# Upload a built release APK to WMS → Settings → Updates (the OTA channel) and
# mark it the active release. Called automatically at the end of
# mobile/carbon_wms/scripts/build-release.sh; can also be run standalone.
#
# Usage:
#   bash scripts/upload-apk-ota.sh [version]
#     version  — e.g. 1.2.110 (defaults to mobile/carbon_wms/pubspec.yaml)
#
# Env:
#   WMS_BASE          (default https://wms.shopcarbon.com)
#   RELEASE_ROOT      (default ~/CarbonWmsRelease)
#   OTA_ADMIN_EMAIL   (default admin@example.com)
#   Admin password is read from .env.agent-secrets (SEED_ADMIN_PASSWORD).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WMS_BASE="${WMS_BASE:-https://wms.shopcarbon.com}"
RELEASE_ROOT="${RELEASE_ROOT:-$HOME/CarbonWmsRelease}"
ADMIN_EMAIL="${OTA_ADMIN_EMAIL:-admin@example.com}"

VERSION="${1:-}"
if [[ -z "$VERSION" && -f "$REPO_ROOT/mobile/carbon_wms/pubspec.yaml" ]]; then
  VERSION=$(grep -E '^version:' "$REPO_ROOT/mobile/carbon_wms/pubspec.yaml" | head -1 \
    | sed -E 's/^version:[[:space:]]+//;s/[[:space:]]+$//;s/^["'\'']//;s/["'\'']$//')
  VERSION="${VERSION%%+*}"
fi
[[ -z "$VERSION" ]] && { echo "ota: no version given/derivable" >&2; exit 1; }

APK="$RELEASE_ROOT/CarbonWMS V${VERSION}.apk"
[[ -f "$APK" ]] || { echo "ota: APK not found: $APK" >&2; exit 1; }

PW=$(grep -E "^SEED_ADMIN_PASSWORD=" "$REPO_ROOT/.env.agent-secrets" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\''')
[[ -z "$PW" ]] && { echo "ota: SEED_ADMIN_PASSWORD missing in .env.agent-secrets" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ota: python3 required for safe JSON" >&2; exit 1; }

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

export OTA_PW="$PW" OTA_EMAIL="$ADMIN_EMAIL"
LOGIN_JSON=$(python3 -c "import json,os;print(json.dumps({'email':os.environ['OTA_EMAIL'],'password':os.environ['OTA_PW']}))")
lc=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 -c "$JAR" \
  -H "Content-Type: application/json" -X POST "$WMS_BASE/api/auth/login" --data "$LOGIN_JSON")
[[ "$lc" == "200" ]] || { echo "ota: login HTTP $lc" >&2; exit 1; }

echo "ota: uploading $VERSION ($(du -h "$APK" | cut -f1)) → $WMS_BASE/settings/updates"
RESP=$(curl -s --max-time 300 -b "$JAR" -X POST "$WMS_BASE/api/mobile/upload-apk" \
  -F "versionLabel=${VERSION}" \
  -F "apk=@${APK};type=application/vnd.android.package-archive")
echo "ota: $RESP"
echo "$RESP" | grep -q '"ok":true' || { echo "ota: upload did not report ok" >&2; exit 1; }
echo "ota: done — $VERSION is the active OTA release."
