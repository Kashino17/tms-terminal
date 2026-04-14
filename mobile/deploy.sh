#!/bin/bash
# TMS Terminal — Build & Deploy to Phone
# Usage: ./deploy.sh [adb]
#   No args  → builds APK to ~/Desktop/TMS-Terminal.apk
#   adb      → builds + installs directly via ADB

set -e
cd "$(dirname "$0")"

# Kill any hanging processes (fast, no blocking)
echo "🧹 Cleaning..."
pkill -9 -f "GradleDaemon" 2>/dev/null || true
pkill -9 -f "expo-modules-autolinking" 2>/dev/null || true

# Pre-generate ExpoModulesPackageList (Gradle task hangs on this)
EXPO_PKG_TARGET="node_modules/expo/android/build/generated/expo/src/main/java/expo/modules/ExpoModulesPackageList.java"
mkdir -p "$(dirname "$EXPO_PKG_TARGET")"
node --no-warnings -e "require(require.resolve('expo-modules-autolinking', { paths: [require.resolve('expo')] }))(process.argv.slice(1))" \
  -- generate-package-list --platform android --namespace expo.modules --target "$EXPO_PKG_TARGET"

# Build arm64 only (Fold 7)
echo "⚡ Building release APK..."
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a -q && cd ..

APK="android/app/build/outputs/apk/release/app-release.apk"
DEST="$HOME/Desktop/TMS-Terminal.apk"
cp "$APK" "$DEST"

if [ "$1" = "adb" ]; then
  echo "📲 Installing via ADB..."
  adb install -r "$DEST"
  echo "✅ Installed!"
else
  echo "✅ APK ready: ~/Desktop/TMS-Terminal.apk"
fi
