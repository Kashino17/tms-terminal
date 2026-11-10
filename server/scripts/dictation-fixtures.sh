#!/bin/bash
# Builds German test dictations with a known text (macOS `say` + ffmpeg) for
# scripts/dictation-e2e.ts:  <dir>/d10.m4a d45.m4a d180.m4a d360.m4a + .txt
# Sentences are separated by short pauses, some by a long thinking pause.
#
#   scripts/dictation-fixtures.sh /private/tmp/tms-dictation-fixtures
set -euo pipefail
OUT="${1:?usage: dictation-fixtures.sh <output dir>}"
VOICE="${VOICE:-Anna}"
mkdir -p "$OUT"

SENTENCES=(
  "Schau dir bitte an, warum die Tastenleiste beim Wechsel zwischen zwei Terminals kurz verschwindet."
  "Ich glaube, das liegt an der Brücke zwischen der Seite und der App, nicht an der Seite selbst."
  "Wenn du die Ursache gefunden hast, schreib zuerst einen Test, der den Fehler zeigt."
  "Danach behebst du den Fehler und prüfst im Emulator, ob die Leiste stehen bleibt."
  "Wichtig ist mir, dass die Punkte unter dem Terminal immer sichtbar sind, auch wenn die Tastatur offen ist."
  "Die Verbindung läuft über das private Netz, deshalb brauchen wir keine eigene Verschlüsselung."
  "Bitte ändere nichts an der Anmeldung, die funktioniert und soll so bleiben."
  "Wenn der Server neu startet, müssen alle offenen Terminals weiterlaufen und ihren Verlauf behalten."
  "Miss vorher und nachher, wie lange es dauert, bis der Text nach dem Stopp erscheint."
  "Erst wenn die Zahlen besser sind als heute, darf die Änderung in die nächste Version."
  "Und schreib am Ende kurz auf, was du gemacht hast und was noch offen ist."
  "Falls etwas unklar ist, entscheide selbst und nenne mir deine Entscheidung im Bericht."
)

build() { # name, number of sentences
  local name="$1" count="$2" speak="" truth="" i s
  for ((i = 0; i < count; i++)); do
    s="${SENTENCES[$(( (i * 5 + i / 12) % ${#SENTENCES[@]} ))]}"
    truth+="$s "
    if (( i % 7 == 6 )); then speak+="$s [[slnc 2500]] "; else speak+="$s [[slnc 450]] "; fi
  done
  say -v "$VOICE" -o "$OUT/$name.aiff" "$speak"
  ffmpeg -nostdin -loglevel error -y -i "$OUT/$name.aiff" -ac 1 -ar 16000 -c:a aac -b:a 96k "$OUT/$name.m4a"
  rm "$OUT/$name.aiff"
  printf '%s\n' "$truth" > "$OUT/$name.txt"
  printf '%s: %ss\n' "$name" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$name.m4a" | cut -d. -f1)"
}

build d10 2
build d45 8
build d180 30
build d360 60
