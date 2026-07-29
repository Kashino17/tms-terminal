# Harness-Aufnahmen

Rohe PTY-Byte-Ströme echter AI-Harnesse, während sie einen Prompt zeigen.
Format: JSONL, je Zeile `{"t": <ms seit Start>, "d": "<base64 der Bytes>"}`.

`src/notifications/prompt.replay.test.ts` spielt jede im `manifest.json`
gelistete Aufnahme durch einen echten `SessionMirror` und prüft die Einstufung
des Klassifikators. Ändert eine neue Harness-Version ihr Layout, fällt hier ein
Test — statt dass es am Handy auffällt.

## Warum echte Aufnahmen

Auf dem ANSI-gestrippten Byte-Strom liefert der alte Weg (`chooseApprovalKey`)
für `claude-permission-40.jsonl` und `codex-permission-40.jsonl` jeweils `null`,
drückt also kein Enter — genau der gemeldete Fehler. Über den Spiegel ergeben
dieselben Bytes `permission` + Enter. Handgeschriebene Bildschirme hätten das
nie gezeigt.

## Neue Aufnahme anlegen

```bash
cd server
mkdir -p /tmp/harness-cap && echo hello > /tmp/harness-cap/note.txt

CAPTURE_CWD=/tmp/harness-cap \
STEPS='[{"at":15000,"in":"Fuehre den Befehl curl -sI https://example.com aus"},{"at":18000,"in":"\r"}]' \
node tools/capture-harness.js /tmp/harness-cap/neu.jsonl 40 75000 "$(command -v codex)"
```

Danach den Bildschirm **ansehen**, bevor die Aufnahme ins Manifest kommt:

```bash
node --require ts-node/register -e '
const fs=require("fs");
const {SessionMirror}=require("./src/terminal/emulator.mirror");
const {classifyScreen}=require("./src/notifications/prompt.classifier");
const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const m=new SessionMirror(Number(process.argv[2]),30);
for(const r of rows) m.feed(Buffer.from(r.d,"base64").toString("utf8"));
m.flushed().then(()=>{const v=m.screen();v.rows.forEach((l,i)=>console.log(String(i).padStart(2)+" | "+l));console.log(classifyScreen(v));});
' /tmp/harness-cap/neu.jsonl 40
```

Wartet keine Box auf dem Bild, war der Harness zu langsam oder nicht
eingerichtet — Aufnahme verwerfen, `at`-Zeiten und `totalMs` erhöhen.

## Was Freigaben auslöst

Nicht jeder Befehl fragt nach. Belegt beim Aufnehmen:

- **Claude Code** — eine Datei **außerhalb** des Arbeitsordners lesen.
- **Codex** — ein Befehl, der aus der Sandbox ausbricht: **Netzwerkzugriff**
  (`curl`) fragt nach, ein lesendes `ls -la /etc` läuft ohne Rückfrage durch.

## Fehlende Harnesse (Stand 2026-07-29)

Beide scheiterten am Kontozustand, nicht am Code — nachzuholen, sobald die
Anmeldung wieder geht:

- **Gemini CLI** — Anmeldung abgelehnt: „This client is no longer supported for
  Gemini Code Assist for individuals. To continue using Gemini, please migrate
  to the Antigravity suite of products."
- **Kimi** — „Membership expired, please renew your plan."

Die Optionstexte beider Harnesse sind aus ihren Programmdateien belegt und in
`prompt.classifier.test.ts` als handgeschriebene Bildschirme abgedeckt
(Gemini nutzt eine Radioliste ohne Nummern) — eine echte Aufnahme ersetzt das
aber nicht.
