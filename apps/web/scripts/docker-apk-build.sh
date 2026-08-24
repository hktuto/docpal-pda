#!/usr/bin/env bash
# Build the signed release APK inside Docker (image: apps/web/Dockerfile.apk).
# Mirrors the host-side apps/web/scripts/build-android-apk.mjs:
#   generate web assets → stamp the maintenance-page URL → keystore (persisted
#   in the /keystore volume) → versionCode increment → cap sync with server.url
#   → gradle assembleRelease → publish APK + version.json to /out.
set -euo pipefail

cd "$(dirname "$0")/.."   # apps/web

if [ -z "${PRODUCTION_URL:-}" ]; then
  echo "PRODUCTION_URL is not set — pass the production host (scheme + host, no port)." >&2
  exit 1
fi
case "$PRODUCTION_URL" in
  http://*|https://*) WEB_URL="$PRODUCTION_URL" ;;
  *)                  WEB_URL="https://$PRODUCTION_URL" ;;
esac
# The prod web container serves the PDA on host port 3000 (docker-compose.prod.yml).
APP_URL="${WEB_URL}:3000"
echo "App URL (WebView + maintenance page): $APP_URL"

# 1. Static web export.
pnpm generate

# 2. Stamp the bundled maintenance page's retry target (it cannot read
#    capacitor.config at runtime).
MARKER="var DEFAULT_URL = 'http://localhost:3103';"
FILE=.output/public/maintenance.html
grep -qF "$MARKER" "$FILE" || { echo "Default-URL marker not found in $FILE — update the marker or the page." >&2; exit 1; }
sed -i "s|var DEFAULT_URL = 'http://localhost:3103';|var DEFAULT_URL = '$APP_URL';|" "$FILE"

# 3. Keystore — persisted in the /keystore volume. NEVER delete that volume:
#    Android only treats a new APK as an in-place update when the signature
#    matches.
KS_DIR=/keystore
mkdir -p "$KS_DIR"
if [ ! -f "$KS_DIR/warehouse-release.keystore" ]; then
  STORE_PASS=$(openssl rand -hex 16)
  KEY_PASS=$(openssl rand -hex 16)
  keytool -genkeypair -v -storetype JKS \
    -keystore "$KS_DIR/warehouse-release.keystore" \
    -alias warehouse -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
    -dname "CN=Warehouse PDA, OU=IT, O=DocPal, L=Hong Kong, ST=HK, C=HK"
  printf 'storeFile=warehouse-release.keystore\nstorePassword=%s\nkeyAlias=warehouse\nkeyPassword=%s\n' \
    "$STORE_PASS" "$KEY_PASS" > "$KS_DIR/keystore.properties"
  echo "Generated a new release keystore in the apk-keystore volume — keep it safe."
fi
cp "$KS_DIR/warehouse-release.keystore" android/app/warehouse-release.keystore
cp "$KS_DIR/keystore.properties" android/keystore.properties

# 4. versionCode auto-increment — counter persisted in the /keystore volume so
#    it survives rebuilds without touching the git tree. Seeded from the last
#    host-built versionCode.
VC_FILE="$KS_DIR/version-code"
[ -f "$VC_FILE" ] || echo 12 > "$VC_FILE"
VC=$(( $(cat "$VC_FILE") + 1 ))
echo "$VC" > "$VC_FILE"
sed -i -E "s/versionCode [0-9]+/versionCode $VC/" android/app/build.gradle
VN=$(grep -oE 'versionName "[^"]+"' android/app/build.gradle | head -1 | cut -d'"' -f2)
VN=${VN:-1.0}
echo "Version: $VN (versionCode $VC)"

# 5. Capacitor sync with server.url pointed at the fixed web host so the
#    Capacitor bridge (hardware scanning, camera, back button) keeps working.
CAPACITOR_SERVER_URL="$APP_URL" pnpm exec cap sync android

# 6. Signed release APK.
(cd android && ./gradlew assembleRelease)

# 7. Publish for the backend's admin download route (GET /admin/app-download/file).
OUT=/out
mkdir -p "$OUT"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT/warehouse-pda.apk"
cat > "$OUT/version.json" <<EOF
{
  "versionName": "$VN",
  "versionCode": $VC,
  "webUrl": "$APP_URL",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "fileName": "warehouse-pda.apk"
}
EOF
echo "Published $OUT/warehouse-pda.apk — version $VN ($VC), WebView URL $APP_URL"
