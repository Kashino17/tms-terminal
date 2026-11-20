#!/usr/bin/env bash
# Compiles the remote access helper. Runs during setup and on every
# `tms-terminal update`, and is forgiving: if it fails, everything except
# remote access keeps working (and an already built helper stays in place).
#
# - Skips the build when the source has not changed (a hash stamp next to the
#   binary) — an update without helper changes costs nothing.
# - Builds next to the old binary and swaps atomically: a helper that is
#   running right now (a remote session in progress) keeps its old file.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(cd ../../../.. && pwd)/bin/tms-remote-helper"
STAMP="$OUT.src"
mkdir -p "$(dirname "$OUT")"
HASH="$(shasum -a 256 TmsRemoteHelper.swift | cut -d' ' -f1)"
if [ -x "$OUT" ] && [ "$(cat "$STAMP" 2>/dev/null || true)" = "$HASH" ]; then
  echo "Helfer ist aktuell: $OUT"
  exit 0
fi
TMP="$OUT.new.$$"
trap 'rm -f "$TMP"' EXIT
swiftc -O -framework ScreenCaptureKit -framework VideoToolbox -framework CoreGraphics -framework CoreAudio -framework AudioToolbox \
       -framework IOKit -framework AppKit \
       -o "$TMP" TmsRemoteHelper.swift
mv -f "$TMP" "$OUT"
echo "$HASH" > "$STAMP"
echo "Helfer gebaut: $OUT"
