/**
 * Große Texte aus der Eingabezeile der App (Diktat, Zwischenablage) kamen als
 * rohe Tastendrücke in der PTY an. macOS reicht einem Raw-Mode-Leser höchstens
 * 1024 Bytes pro read() weiter, und Claude Code hält jedes Häppchen für einen
 * eigenen Einfügevorgang: ein 2,5k-Diktat stand da als
 * "[Pasted text #1][Pasted text #2]425 w426 …" — zwei Platzhalter plus der Rest,
 * mitten im Wort geschnitten. Für den Nutzer sah das aus wie "nur der letzte
 * Teil ist angekommen".
 *
 * Ein Desktop-Terminal verpackt Eingefügtes in Bracketed-Paste-Marker, sobald
 * das Programm das per DECSET 2004 verlangt hat. Genau das hier: dann nimmt
 * Claude Code (und auch zsh) den Text als EINEN Block, egal wie ihn der Kernel
 * zerteilt.
 */

/** Ab dieser Größe zerteilt der macOS-PTY-Lesepfad den Text. Darunter bleibt
 *  alles Tastendruck wie bisher — Tippen, Wortvorschlag, kurze Antworten. */
export const PASTE_MIN_BYTES = 1024;

// Alles außer Tab und Zeilenumbruch: Enter (\r), Escape-Folgen, Strg-Kombis.
// Solche Eingaben sind Tastenbedienung, kein Text zum Einfügen.
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/;

/**
 * Verpackt den Textteil einer Eingabe als Einfügeblock, wenn das Programm
 * Bracketed Paste eingeschaltet hat und der Text groß genug ist, um zerteilt
 * zu werden. Führende Rückschritte (die Eingabezeile schickt die Differenz zum
 * vorigen Inhalt) bleiben davor als echte Tastendrücke stehen.
 */
export function asPaste(data: string, bracketedPaste: boolean): string {
  if (!bracketedPaste) return data;
  let i = 0;
  while (i < data.length && data[i] === '\x7f') i++;
  const text = data.slice(i);
  if (Buffer.byteLength(text, 'utf8') < PASTE_MIN_BYTES) return data;
  if (CONTROL_CHARS.test(text)) return data;
  return data.slice(0, i) + '\x1b[200~' + text + '\x1b[201~';
}
