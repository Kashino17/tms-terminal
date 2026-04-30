#!/bin/bash
# TMS Terminal iOS — Build unsigned IPA for SideStore sideloading
# Usage: ./ios-release.sh [--fresh]
#   --fresh: regenerate ios/ from scratch (slower, 2-5 min extra)
# Default: incremental build (uses existing ios/ if present)

set -e
cd "$(dirname "$0")"

POD="/opt/homebrew/bin/pod"
if [ ! -x "$POD" ]; then
  POD="$(command -v pod || true)"
fi
if [ -z "$POD" ]; then
  echo "❌ CocoaPods not found. Run: brew install cocoapods"
  exit 1
fi

# ── Prebuild (regenerate ios/ if missing or --fresh requested) ──
if [ "$1" = "--fresh" ] || [ ! -d "ios" ]; then
  echo "📦 Running expo prebuild..."
  npx expo prebuild --platform ios --clean
fi

# ── Patch Podfile: Firebase static-link compat ──
# expo prebuild always regenerates Podfile, so we re-apply the fix every time.
PODFILE="ios/Podfile"
if ! grep -q "use_modular_headers!" "$PODFILE"; then
  echo "🔧 Patching Podfile for Firebase static-libs..."
  /usr/bin/sed -i '' "/use_native_modules!/a\\
\\
  # Firebase static-library + Swift compatibility:\\
  use_modular_headers!
" "$PODFILE"
fi

# ── Patch React Native Hermes script: quote tarball path ──
# RN 0.73 hermes script doesn't quote paths → fails on dirs with spaces
# (e.g. "TMS Terminal"). Patch survives npm install only via this script.
HERMES_JS="node_modules/react-native/sdks/hermes-engine/utils/replace_hermes_version.js"
if [ -f "$HERMES_JS" ] && grep -q 'tar -xf ${tarballURLPath} -C ${finalLocation}' "$HERMES_JS"; then
  echo "🔧 Patching Hermes tar command (path-with-spaces fix)..."
  /usr/bin/sed -i '' 's|tar -xf ${tarballURLPath} -C ${finalLocation}|tar -xf "${tarballURLPath}" -C "${finalLocation}"|' "$HERMES_JS"
fi

# ── Patch React Native script_phases.rb: same path-with-spaces bug ──
# /bin/sh -c "$WITH_ENVIRONMENT $SCRIPT_PHASES_SCRIPT" tokenizes by whitespace.
# Drop the sh -c wrapper so parent shell quoting handles the path. Pod install
# below regenerates the build-phase scripts that bake in this template.
SCRIPT_PHASES_RB="node_modules/react-native/scripts/react_native_pods_utils/script_phases.rb"
if [ -f "$SCRIPT_PHASES_RB" ] && grep -q '/bin/sh -c "\$WITH_ENVIRONMENT \$SCRIPT_PHASES_SCRIPT"' "$SCRIPT_PHASES_RB"; then
  echo "🔧 Patching script_phases.rb (path-with-spaces fix)..."
  /usr/bin/sed -i '' 's|/bin/sh -c "\$WITH_ENVIRONMENT \$SCRIPT_PHASES_SCRIPT"|"$WITH_ENVIRONMENT" "$SCRIPT_PHASES_SCRIPT"|' "$SCRIPT_PHASES_RB"
fi

# ── Patch with-environment.sh: $1 → "$1" for paths with spaces ──
WITH_ENV_SH="node_modules/react-native/scripts/xcode/with-environment.sh"
if [ -f "$WITH_ENV_SH" ] && grep -qE '^  \$1$' "$WITH_ENV_SH"; then
  echo "🔧 Patching with-environment.sh (path-with-spaces fix)..."
  /usr/bin/sed -i '' 's|^  \$1$|  "$1"|' "$WITH_ENV_SH"
fi

# ── Pod install (idempotent) ──
echo "📦 Installing pods..."
(cd ios && "$POD" install)

# ── Detect workspace + scheme ──
# .xcworkspace is a directory; use -d so ls returns the directory itself,
# not its contents.
WORKSPACE=$(/bin/ls -d ios/*.xcworkspace 2>/dev/null | head -1)
if [ -z "$WORKSPACE" ] || [ ! -d "$WORKSPACE" ]; then
  echo "❌ No .xcworkspace in ios/"
  exit 1
fi
SCHEME=$(basename "$WORKSPACE" .xcworkspace)
echo "🔨 Building scheme: $SCHEME"

# ── Clean previous artifacts ──
rm -rf ios/build

# ── Archive without code signing — SideStore re-signs on device ──
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "ios/build/$SCHEME.xcarchive" \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=NO \
  archive

# ── Pack .app into Payload/ → .ipa (SideStore-compatible) ──
APP_PATH="ios/build/$SCHEME.xcarchive/Products/Applications/$SCHEME.app"
if [ ! -d "$APP_PATH" ]; then
  echo "❌ .app not found at $APP_PATH"
  exit 1
fi

mkdir -p ios/build/Payload
cp -R "$APP_PATH" ios/build/Payload/
(cd ios/build && zip -qr TMS-Terminal.ipa Payload)
rm -rf ios/build/Payload

DEST="$HOME/Desktop/TMS-Terminal.ipa"
cp ios/build/TMS-Terminal.ipa "$DEST"
SIZE=$(du -h "$DEST" | cut -f1)
echo ""
echo "✅ IPA: $DEST ($SIZE)"
echo "Next: Sideload via SideStore on iPad."
