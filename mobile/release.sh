#!/bin/bash
# TMS Terminal — Build Release APK + Create GitHub Release
# Usage: ./release.sh [patch|minor|major]
#   Default: patch (1.0.0 → 1.0.1)

set -e
cd "$(dirname "$0")"

# ── Version bump ─────────────────────────────────────────────
BUMP="${1:-patch}"
CURRENT=$(node -e "console.log(require('./app.json').expo.version)")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: $0 [patch|minor|major]"; exit 1 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
NEW_CODE=$((MAJOR * 10000 + MINOR * 100 + PATCH))
TAG="v${NEW_VERSION}"

echo "📦 Version: ${CURRENT} → ${NEW_VERSION} (code: ${NEW_CODE})"

# Update app.json
node -e "
  const fs = require('fs');
  const f = './app.json';
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.expo.version = '${NEW_VERSION}';
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
"

# Update build.gradle versionCode + versionName
sed -i '' "s/versionCode [0-9]*/versionCode ${NEW_CODE}/" android/app/build.gradle
sed -i '' "s/versionName \"[^\"]*\"/versionName \"${NEW_VERSION}\"/" android/app/build.gradle

echo "⚡ Building release APK..."
cd android && ./gradlew clean -q && ./gradlew assembleRelease -q && cd ..

APK="android/app/build/outputs/apk/release/app-release.apk"
DEST="$HOME/Desktop/TMS-Terminal-${TAG}.apk"
cp "$APK" "$DEST"
# Also keep a generic name for easy access
cp "$APK" "$HOME/Desktop/TMS-Terminal.apk"

echo "✅ APK: ~/Desktop/TMS-Terminal-${TAG}.apk"

# ── Git tag + GitHub Release ─────────────────────────────────
read -p "🚀 Create GitHub release ${TAG}? (y/n) " CONFIRM
if [ "$CONFIRM" = "y" ]; then
  git add app.json android/app/build.gradle
  git commit -m "release: ${TAG}"
  git tag "$TAG"
  git push && git push --tags

  # Create GitHub release with APK attached
  if command -v gh &>/dev/null; then
    gh release create "$TAG" "$DEST" \
      --title "TMS Terminal ${TAG}" \
      --notes "Release ${NEW_VERSION}" \
      --latest
    echo "✅ GitHub release created: ${TAG}"
  else
    echo "⚠️  'gh' CLI not installed. Create release manually at:"
    echo "   https://github.com/${GITHUB_REPO}/releases/new?tag=${TAG}"
  fi
fi

echo "🎉 Done!"
