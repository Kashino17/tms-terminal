#!/usr/bin/env bash
# Uebersetzt den Fernzugriffs-Helfer. Laeuft beim Einrichten und ist gutmuetig:
# schlaegt es fehl, funktioniert alles ausser dem Fernzugriff weiterhin.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(cd ../../../.. && pwd)/bin/tms-remote-helper"
mkdir -p "$(dirname "$OUT")"
swiftc -O -framework ScreenCaptureKit -framework VideoToolbox -framework CoreGraphics \
       -framework IOKit \
       -o "$OUT" TmsRemoteHelper.swift
echo "Helfer gebaut: $OUT"
