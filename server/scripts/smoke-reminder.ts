/**
 * Creates a reminder two minutes from now, to verify the alarm path end to end.
 *
 * Deliberately does NOT set process.env.TZ. The unit tests pin the timezone so
 * the DST cases stay reproducible, but this script has to agree with the SERVER,
 * and the server reads wall-clock time in the machine's own timezone. Pinning
 * Berlin here would write a time the server then reads in a different zone.
 */
import { addAgendaItem, loadAgenda } from '../src/manager/agenda/agenda.store';

const inTwoMinutes = new Date(Date.now() + 2 * 60_000);
const p = (n: number): string => String(n).padStart(2, '0');
const at = `${inTwoMinutes.getFullYear()}-${p(inTwoMinutes.getMonth() + 1)}-${p(inTwoMinutes.getDate())}`
  + `T${p(inTwoMinutes.getHours())}:${p(inTwoMinutes.getMinutes())}`;

const item = addAgendaItem({
  title: 'Rauchtest', at, note: 'Wenn du das siehst, funktioniert der Wecker.',
  reminderOffsets: [0], source: 'user',
});

console.log(`Termin angelegt für ${at} (ID ${item.id}).`);
console.log(`Maschinen-Zeitzone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
console.log(`Jetzt ist es lokal: ${new Date().toLocaleString('de-DE')}`);
console.log(`Insgesamt ${loadAgenda().length} Termine.`);
