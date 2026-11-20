#!/bin/bash
# TMS Terminal — Build & Deploy to Phone
# Usage: ./deploy.sh [adb|dex]
#   No args  → builds APK to ~/Desktop/TMS-Terminal.apk
#   adb      → builds + installs directly via ADB + starts DeX USB Engine
#   dex      → activates One UI 8 Virtual DeX USB Engine on connected Fold 7 (no rebuild)

set -e
cd "$(dirname "$0")"

start_dex_engine() {
  echo "⚡ Activating TMS Samsung DeX USB Engine on Galaxy Fold 7..."
  adb shell settings put global force_allow_on_external 1 2>/dev/null || true
  adb shell settings put global enable_freeform_support 1 2>/dev/null || true
  adb shell settings put global force_desktop_mode_on_external_displays 1 2>/dev/null || true
  APK_PATH=$(adb shell pm path com.tms.terminal | head -1 | cut -d: -f2 | tr -d '\r')
  if [ -z "$APK_PATH" ]; then
    echo "❌ com.tms.terminal not installed on device yet."
    exit 1
  fi
  adb shell "pkill -f com.tms.terminal.dex.DeXShellServer 2>/dev/null || true"
  adb shell "CLASSPATH=\"$APK_PATH\" nohup app_process / com.tms.terminal.dex.DeXShellServer --port 8768 >/dev/null 2>&1 &"
  adb tcpip 5555 >/dev/null 2>&1 || true
  sleep 1
  echo "✅ DeX USB Engine active on port 8768! Plug Fold 7 via USB-C into iPad."
}

if [ "$1" = "dex" ]; then
  start_dex_engine
  exit 0
fi

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
  start_dex_engine
  echo "✅ Installed & DeX Engine ready!"
else
  echo "✅ APK ready: ~/Desktop/TMS-Terminal.apk"
fi
