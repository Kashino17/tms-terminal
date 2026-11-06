#!/usr/bin/env bash
# Compiles the remote access helper. Runs during setup and is forgiving:
# if it fails, everything except remote access keeps working.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(cd ../../../.. && pwd)/bin/tms-remote-helper"
mkdir -p "$(dirname "$OUT")"
swiftc -O -framework ScreenCaptureKit -framework VideoToolbox -framework CoreGraphics \
       -framework IOKit -framework AppKit \
       -o "$OUT" TmsRemoteHelper.swift
echo "Helfer gebaut: $OUT"
