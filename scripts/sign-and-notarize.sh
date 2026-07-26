#!/usr/bin/env bash
# Sign, notarize, and staple the DOLLY .app / .dmg (BUILD_PLAN §8). macOS only.
#
# The critical ordering (§8): sign the embedded `dollyd` sidecar FIRST with the same
# Developer ID + hardened runtime, THEN sign the enclosing bundle. `codesign --deep` is
# unreliable with embedded executables, so we sign explicitly rather than relying on it.
#
# Required environment (injected by CI secrets; never hard-code):
#   DEV_ID_APP        e.g. "Developer ID Application: Your Name (TEAMID)"
#   APP_PATH          path to DOLLY.app
#   DMG_PATH          path to the built .dmg (optional; notarized/stapled if set)
#   ENTITLEMENTS      path to entitlements.plist (defaults to the app's)
#   NOTARY_PROFILE    a notarytool keychain profile name (xcrun notarytool store-credentials)
set -euo pipefail

: "${DEV_ID_APP:?set DEV_ID_APP to your Developer ID Application identity}"
: "${APP_PATH:?set APP_PATH to the built DOLLY.app}"
: "${NOTARY_PROFILE:?set NOTARY_PROFILE to your notarytool credential profile}"
ENTITLEMENTS="${ENTITLEMENTS:-apps/desktop/src-tauri/entitlements.plist}"

sidecar="$APP_PATH/Contents/MacOS/dollyd"
[[ -f "$sidecar" ]] || sidecar="$APP_PATH/Contents/Resources/dollyd"

echo "==> 1/5 sign sidecar first (§8)"
codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$DEV_ID_APP" \
  "$sidecar"

echo "==> 2/5 sign the app bundle"
codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --sign "$DEV_ID_APP" \
  "$APP_PATH"

echo "==> 3/5 verify signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "==> 4/5 notarize (--wait)"
tmpzip="$(mktemp -d)/DOLLY.zip"
ditto -c -k --keepParent "$APP_PATH" "$tmpzip"
xcrun notarytool submit "$tmpzip" --keychain-profile "$NOTARY_PROFILE" --wait

echo "==> 5/5 staple + gatekeeper assessment"
xcrun stapler staple "$APP_PATH"
spctl -a -vvv -t install "$APP_PATH"

if [[ -n "${DMG_PATH:-}" ]]; then
  echo "==> notarize + staple DMG"
  xcrun notarytool submit "$DMG_PATH" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG_PATH"
  spctl -a -vvv -t install "$DMG_PATH" || true
fi

echo "Done. $APP_PATH is signed, notarized, and stapled."
