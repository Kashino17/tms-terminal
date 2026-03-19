#!/bin/bash
# TMS Terminal — Build & Deploy to Phone
# Usage: ./deploy.sh [adb]
#   No args  → builds APK to ~/Desktop/TMS-Terminal.apk
#   adb      → builds + installs directly via ADB

set -e
cd "$(dirname "$0")"

echo "⚡ Building release APK..."
cd android && ./gradlew assembleRelease -q && cd ..

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
