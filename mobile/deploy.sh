#!/bin/bash
# TMS Terminal — Build & Deploy to Phone
# Usage: ./deploy.sh [adb]
#   No args  → builds APK to ~/Desktop/TMS-Terminal.apk
#   adb      → builds + installs directly via ADB

set -e
cd "$(dirname "$0")"

# Kill any hanging node/gradle processes that might block the build
echo "🧹 Cleaning stale processes..."
pkill -f "node.*cli.*config" 2>/dev/null || true
pkill -f "node.*react-native.*config" 2>/dev/null || true
cd android && ./gradlew --stop 2>/dev/null || true
cd ..

# Reset watchman to prevent stale cache issues
watchman watch-del "$(dirname "$(pwd)")" 2>/dev/null || true
watchman watch-project "$(dirname "$(pwd)")" 2>/dev/null || true

# Only build arm64-v8a for dev speed (Fold 7 is arm64)
# Using --no-daemon to prevent Gradle daemon from caching stale Node processes
echo "⚡ Building release APK (arm64 only)..."
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon -q && cd ..

APK="android/app/build/outputs/apk/release/app-release.apk"
DEST="$HOME/Desktop/TMS-Terminal.apk"
cp "$APK" "$DEST"

if [ "$1" = "adb" ]; then
  echo "📲 Installing via ADB..."
  adb install -r "$DEST"
  echo "✅ Installed! App should update on your phone."
else
  echo "✅ APK ready: ~/Desktop/TMS-Terminal.apk"
  echo "   Tip: Run './deploy.sh adb' to install directly via USB."
fi
