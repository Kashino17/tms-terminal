#!/bin/zsh
export HOME=/Users/ayysir

# Homebrew avdmanager erwartet das SDK neben den cmdline-tools
BREW_SDK=/opt/homebrew/share/android-commandlinetools
OUR_SDK=/Users/ayysir/Library/Android/sdk

export ANDROID_HOME=$BREW_SDK
export ANDROID_SDK_ROOT=$BREW_SDK
export ANDROID_AVD_HOME=/Users/ayysir/.android/avd
export PATH=$OUR_SDK/platform-tools:$OUR_SDK/emulator:$PATH

mkdir -p /Users/ayysir/.android/avd

echo "=== Android Emulator Setup ==="

# System Image in Homebrew-SDK installieren
SYSIMG="$BREW_SDK/system-images/android-34/google_apis/arm64-v8a"
if [ ! -d "$SYSIMG" ]; then
  echo "Installiere System Image nach $BREW_SDK..."
  yes | sdkmanager --sdk_root=$BREW_SDK "system-images;android-34;google_apis;arm64-v8a"
else
  echo "System Image schon vorhanden."
fi

# Emulator binary: aus unserem SDK
if [ ! -f "$OUR_SDK/emulator/emulator" ]; then
  echo "Installiere Emulator..."
  yes | sdkmanager --sdk_root=$OUR_SDK "emulator"
fi

# AVD erstellen
echo "Erstelle AVD..."
echo "no" | avdmanager create avd \
  -n TMS_Phone \
  -k "system-images;android-34;google_apis;arm64-v8a" \
  -d "pixel_6" \
  --force

echo ""
echo "AVDs:"
avdmanager list avd | grep "Name:"

echo ""
echo "Starte Emulator..."
$OUR_SDK/emulator/emulator -avd TMS_Phone -no-snapshot-load -noaudio &

echo "Emulator startet (~30 Sek). Dann in neuem Tab:"
echo "  cd ~/Desktop/TMS\\ Terminal/mobile && npx expo run:android"
