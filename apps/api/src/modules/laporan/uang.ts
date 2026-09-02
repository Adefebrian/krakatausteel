// apps/api/src/modules/laporan/uang.ts
//
// Money and the spec 10 rendering rule, for the report engine.
//
// BIGINT MINOR UNITS INTERNALLY, a decimal string with exactly two fractional
// digits at every boundary, never a JS float (spec invariant 7:
// NUMERIC(20,2) outruns Number.MAX_SAFE_INTEGER, so a report that added
// balances as numbers would be wrong on a large ledger and right on a small
// one, which is the worst way to be wrong).
//
// RE-DECLARED RATHER THAN IMPORTED, for the reason modules/closing/uang.ts
// records: `bun tools/check-boundaries.ts` forbids reaching past a sibling
// module's index.ts, and the same helpers are internal to modules/closing and
// modules/jurnal. The semantics must not drift; when a shared money package
// appears, all five copies collapse into it.
//
// THE RENDERING RULE LIVES HERE, NOT IN A UI HELPER. Spec 10: "Nilai nol
// ditampilkan sebagai `0,00` bukan kosong, karena tim akuntansi memakainya
// untuk cross check", and spec 10 also requires an Excel and a PDF export of
// every report. Three consumers, one rule: if the rule lived in a screen, the
// spreadsheet would get a second implementation of it and the PDF a third.
import { NOL_TAMPIL, POLA_UANG, type Angka, type Uang } from "./contract";

const POLA_SEN = /^(-?)(\d+)\.(\d{2})$/;

/** Minor units -> `Uang`. `sen(-150n)` === "-1.50". */
export function sen(minor: bigint): Uang {
  const negatif = minor < 0n;
  const abs = negatif ? -minor : minor;
  return `${negatif ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/** `Uang` -> minor units. Throws on anything that is not exactly two decimals. */
export function keSen(nilai: string): bigint {
  const m = POLA_SEN.exec(nilai);
  if (!m) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  const besar = BigInt(m[2]) * 100n + BigInt(m[3]);
  return m[1] === "-" ? -besar : besar;
}

/**
 * Normalises what Postgres handed back, and refuses anything that is not
 * `numeric(20,2)::text`.
 *
 * Driver fact, from modules/jurnal/repo.ts: `coalesce(sum(x), 0)` returns the
 * string '0', not '0.00'. Every aggregate in ./repo.ts casts `::numeric(20,2)`
 * BEFORE `::text`; this catches the one that did not, HERE, instead of three
 * layers away as a failed equality with no clue where it came from.
 */
export function uangDariDb(nilai: string | null | undefined): bigint {
  if (nilai === null || nilai === undefined) return 0n;
  if (!POLA_UANG.test(nilai)) {
    throw new Error(
      `modules/laporan: nilai uang dari database bukan numeric(20,2)::text: ${JSON.stringify(nilai)}. ` +
        "Cast ke ::numeric(20,2) SEBELUM ::text (lihat catatan driver di modules/jurnal/repo.ts).",
    );
  }
  return keSen(nilai);
}

/**
 * `Uang` -> the string a report prints (spec 10):
 *   - always exactly two fractional digits, decimal separator `,`;
 *   - thousands grouped with `.`;
 *   - negatives in parentheses, which is what an accountant reads as a
 *     deduction and which cannot be lost to a stray minus sign in a cell;
 *   - zero is exactly `0,00`, never blank and never a dash.
 */
export function formatTampil(nilai: Uang): string {
  if (!POLA_UANG.test(nilai)) throw new Error(`bukan Uang yang valid: ${JSON.stringify(nilai)}`);
  const minor = keSen(nilai);
  if (minor === 0n) return NOL_TAMPIL;
  const negatif = minor < 0n;
  const [utuh, pecahan] = (negatif ? nilai.slice(1) : nilai).split(".");
  const dikelompokkan = utuh.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const inti = `${dikelompokkan},${pecahan}`;
  return negatif ? `(${inti})` : inti;
}

/**
 * One rendered monetary cell. BOTH HALVES TRAVEL TOGETHER: `nilai` is what a
 * caller reconciles, `tampil` is what prints, and `tampil` is always derived
 * from `nilai` so the two can never disagree.
 */
export function angka(minor: bigint): Angka {
  const nilai = sen(minor);
  return { nilai, tampil: formatTampil(nilai) };
}

export function jumlah(...minor: bigint[]): bigint {
  return minor.reduce((t, n) => t + n, 0n);
}
