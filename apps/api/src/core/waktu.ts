// "Today", as the person reading the screen would say it.
//
// WHY THIS EXISTS. Every stamp in this system was `toISOString().slice(0, 10)`,
// which is the date in UTC. The product serves one country, on UTC+7, so
// between midnight and 07:00 Jakarta time that string is YESTERDAY. Found by
// deploying locally at 00:38 WIB and reading a statement whose "Tanggal cetak"
// said the fifth on the sixth.
//
// It is not only cosmetic. `hariIni()` is what ageing counts from, so for seven
// hours of every day an overdue count was one day short, and a schedule row
// sitting exactly on a kolektibilitas boundary would be classified into the
// gentler class.
//
// STORED dates stay UTC and must: the rest of the codebase computes date
// boundaries in UTC precisely so a period end cannot slide a day under a
// conversion (see `modules/impor/saldo-awal.ts` and `seed/demo-dunia/acak.ts`).
// This function is only for turning an INSTANT into the calendar day a reader
// is living in, which is a different question from where a boundary falls.
//
// `sv-SE` is not a language choice: its date format is ISO, so the formatter
// yields `YYYY-MM-DD` without hand-assembling parts.

/** IANA zone the entity operates in. One place to change it. */
export const ZONA_WAKTU_ENTITAS = process.env.TZ_ENTITAS ?? "Asia/Jakarta";

const FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  timeZone: ZONA_WAKTU_ENTITAS,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `YYYY-MM-DD` for the calendar day `saat` falls on, in the entity's zone. */
export function tanggalLokal(saat: Date): string {
  return FORMATTER.format(saat);
}
