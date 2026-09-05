// One document model, THIRTY reports, two output formats.
//
// WHY A GENERIC SHAPER AND NOT THIRTY HAND-WRITTEN LAYOUTS. Spec 10 requires
// every report to be exportable. Thirty bespoke mappers would be thirty places
// for a column to be dropped, a rupiah to be rounded, or a partner name to
// reach a cell without passing the sanitiser -- and the drift would be
// invisible, because nobody diffs an export against a screen. So the export
// derives its tables FROM THE ENGINE'S OWN RESULT: the same object the screen
// renders, tabulated by rules stated once, here.
//
// The consequence is the property that actually matters, and it is stronger
// than any layout: AN EXPORT CANNOT SHOW A FIGURE THE SCREEN DOES NOT. There
// is no second query, no recomputation, no "export mode" in any engine. The
// route calls the identical engine method with the identical filter, and this
// file reshapes the answer. A closed period exported through here is read from
// the frozen `saldo_akun_periode` for exactly the same reason the screen is:
// the engine decided, and this layer never sees the choice.
//
// THE SEVEN SHAPING RULES
//
//   1. `header` becomes the document header, never a table. Spec 10 puts the
//      same six facts on every report and they are not data columns.
//   2. Every other ARRAY property becomes a sheet.
//   3. Every other OBJECT property becomes rows in one "Ringkasan" sheet,
//      flattened one level, so `total.outstanding.nilai` reads as a labelled
//      figure rather than as a column with a single row under it.
//   4. An `Angka` (`{ nilai, tampil }`) becomes a MONEY CELL carrying `nilai`,
//      the exact decimal string. `tampil` is a formatted display string and is
//      deliberately discarded: a spreadsheet formats numbers itself, and a
//      column of pre-formatted text is a column nobody can sum.
//   5. TEMPLATE MACHINERY IS NOT A COLUMN. See `KOLOM_MESIN`.
//   6. NESTING AND WEIGHT ARE LAYOUT, NOT DATA. See `tataDariBaris`.
//   7. A TABLE THAT ONLY REPEATS ANOTHER IS NOT EMITTED. See `sudahTerbit`.
//
// ID COLUMNS ARE KEPT AND MOVED TO THE END. A UUID is how a figure is traced
// back to its row (spec 11: "angka yang tidak bisa ditelusuri asalnya tidak
// dipercaya user"), so dropping it would remove the audit trail from the
// artefact most likely to be filed as evidence. Putting it first would make an
// accountant read past 36 hex characters to reach the name. So it travels, at
// the right-hand end.
//
// -------------------------------------------------------------------------
// WHAT SPEC 16 SCENARIO 20 ASKED, AND WHAT RULES 5 TO 7 ANSWER
// -------------------------------------------------------------------------
// The scenario does not stop at "the file downloads": it says "buka hasilnya,
// konfirmasi formatnya layak diserahkan ke manajemen". Opened, a statement of
// financial position printed nine columns before it printed a figure --
// `Baris Laporan Id` (a raw UUID per caption), `Parent Kode`, `Urutan`,
// `Level`, `Tipe Baris`, `Seksi`, `Tanda`, `Cetak Tebal` -- and then printed
// the same rows three more times under `Baris Aset`, `Baris Liabilitas` and
// `Baris Aset Neto`. That is the template's schema handed to a reader who
// asked for a balance sheet, and it is the remaining half of why the export
// was not fit to send upward.
//
// The rules below are stated generically and apply to all thirty reports,
// because thirty exceptions is how the first version of this problem was made.
import {
  KOSONG,
  angka as selAngka,
  lebarOtomatis,
  persen as selPersen,
  tanggal as selTanggal,
  teks as selTeks,
  uang as selUang,
  type Lembar,
  type Sel,
} from "../xlsx/tulis";

const POLA_TANGGAL_ISO = /^\d{4}-\d{2}-\d{2}$/;
const POLA_DESIMAL_DUA = /^-?\d+\.\d{2}$/;
const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `{ nilai, tampil }`: the money shape every report in this system returns. */
function adalahAngka(v: unknown): v is { nilai: string; tampil: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { nilai?: unknown }).nilai === "string" &&
    typeof (v as { tampil?: unknown }).tampil === "string"
  );
}

function objekBiasa(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !adalahAngka(v);
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface HeaderDokumen {
  namaBumn: string;
  namaLaporan: string;
  periodeLabel: string;
  namaCabang: string;
  tanggalCetak: string;
  dicetakOleh: string;
  /**
   * Spec 10's two data paths, printed. `SNAPSHOT_PERIODE` means the figures
   * came from the frozen balances of a closed month, `LEDGER_LIVE` means they
   * were computed from the ledger as it stands right now. A reader holding a
   * printout of a closed period must be able to see which, or the page is a
   * claim rather than a statement.
   */
  sumberData: string;
  statusPeriode: string | null;
  /** Free-form extra facts (the report's own `mode`, its bases, its filters). */
  tambahan: Array<{ label: string; nilai: string }>;
}

export interface TabelDokumen {
  judul: string;
  kolom: string[];
  baris: Sel[][];
}

export interface DokumenEkspor {
  header: HeaderDokumen;
  tabel: TabelDokumen[];
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** `jumlahPenyaluran` -> `Jumlah Penyaluran`; `perBucket` -> `Per Bucket`. */
export function judulDariKunci(kunci: string): string {
  const kata = kunci
    .replace(/\./g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
  return kata
    .split(/\s+/)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function kunciId(kunci: string): boolean {
  const akhir = kunci.split(".").pop() ?? kunci;
  return /Id$/.test(akhir) || akhir === "id";
}

function kunciPersen(kunci: string): boolean {
  return /persen/i.test(kunci);
}

// ---------------------------------------------------------------------------
// Rule 5: template machinery is not a column
// ---------------------------------------------------------------------------

/**
 * Fields that exist so the ENGINE can lay a statement out, and that say nothing
 * to the person reading it. Dropped from every table, in every report.
 *
 * WHAT MAKES A FIELD MACHINERY, so this stays a rule rather than a list that
 * grows by taste: it describes the TEMPLATE ROW, not the entity the report is
 * about. `baris_laporan` is a layout table -- captions, their order, their
 * nesting and their arithmetic sign -- and every one of these is a column of
 * it:
 *
 *   `barisLaporanId`  the uuid of a CAPTION. Not an audit trail: the figure it
 *                     labels is traced through `akunKode`, and the caption is
 *                     traced by reading it. This is the one id in the system
 *                     that the "ids travel at the right-hand end" rule above
 *                     does not earn its place under.
 *   `parentKode`      the tree edge. The rows already arrive in template order
 *                     with the parent above its children, so the edge is
 *                     printed as position and does not need a column too.
 *   `urutan`          the sort key the rows are ALREADY sorted by.
 *   `seksi`, `tipeBaris`   which block a line belongs to and whether it is a
 *                     heading, a detail or a total. Both are visible on the
 *                     face of a correctly laid-out statement.
 *   `tanda`           already APPLIED. `modules/laporan/contract.ts` says so at
 *                     `BarisStatement`: the figures are returned with the sign
 *                     in them, and the field is kept on the row so a developer
 *                     can see why. Printing it invites a reader to apply it a
 *                     second time.
 *   `level`, `cetakTebal`  see `tataDariBaris`: these are layout, and they now
 *                     SHAPE the document instead of appearing in it.
 *   `parentId`        report 16's tree edge, same argument as `parentKode`.
 */
const KOLOM_MESIN: ReadonlySet<string> = new Set([
  "barisLaporanId",
  "parentKode",
  "parentId",
  "urutan",
  "level",
  "tipeBaris",
  "seksi",
  "tanda",
  "cetakTebal",
]);

function kolomMesin(kunci: string): boolean {
  return KOLOM_MESIN.has(kunci.split(".").pop() ?? kunci);
}

// ---------------------------------------------------------------------------
// Rule 6: nesting and weight are layout
// ---------------------------------------------------------------------------

/**
 * The two layout facts a statement row carries, lifted off the row before its
 * columns are built.
 *
 * `level` and `cetakTebal` were printed as COLUMNS, which is the clearest sign
 * that nobody had opened the file: a balance sheet whose second column reads
 * `1, 2, 2, 1` and whose third reads `Ya, Tidak, Tidak, Ya` is a dump of the
 * template, not a statement. They are how the statement should LOOK:
 *
 *   `level`       indents the caption, so the tree that `parentKode` describes
 *                 is visible as shape instead of as an edge list;
 *   `cetakTebal`  makes the whole row bold, which is what a total line is.
 *
 * Both survive into the .xlsx and the HTML, because `Sel.tebal` is carried by
 * both writers and the indent is part of the caption text.
 */
interface TataBaris {
  level: number;
  tebal: boolean;
}

function tataDariBaris(baris: Record<string, unknown>): TataBaris {
  const level = typeof baris.level === "number" && Number.isFinite(baris.level) ? baris.level : 0;
  return {
    // Capped: a malformed `level` must not turn one caption into a kilobyte of
    // padding, and no statement template in this system nests past a handful.
    level: Math.max(0, Math.min(8, Math.trunc(level))),
    tebal: baris.cetakTebal === true,
  };
}

/**
 * NON-BREAKING SPACES, not ordinary ones, and not a `Sel.indent` field.
 *
 * An ordinary leading space is collapsed by HTML and trimmed by several
 * spreadsheet importers, so the indentation would survive in the .xlsx and
 * vanish from the printed page -- which is the copy that goes to management. A
 * U+00A0 survives both, is not one of the five characters `loloskanHtml`
 * escapes, and is not one of the six characters `netralkanFormula` guards, so
 * an indented caption is neither mangled nor prefixed with an apostrophe.
 *
 * The alternative was a new field on `Sel` plus alignment handling in the
 * workbook writer and a CSS class in the HTML renderer: three files changed to
 * express something the caption text can carry itself.
 */
const SATU_INDENT = "\u00a0\u00a0\u00a0";

/**
 * The column an indent is applied to: the CAPTION. `nama` in every statement
 * and in the chart of accounts, `uraian` in the cash-flow report; `kode` is the
 * fallback because a statement with neither still has a line code, and the
 * first column is the last resort. Never a figure column: indenting a number
 * would break its right alignment for no gain.
 */
const KUNCI_KETERANGAN = ["nama", "uraian", "keterangan", "kode"];

function kunciUntukIndent(kolom: readonly string[]): string | null {
  for (const kandidat of KUNCI_KETERANGAN) {
    if (kolom.includes(kandidat)) return kandidat;
  }
  return kolom[0] ?? null;
}

function indentkan(sel: Sel, level: number): Sel {
  if (level <= 0 || sel.jenis !== "teks" || sel.teks === undefined) return sel;
  return { ...sel, teks: SATU_INDENT.repeat(level) + sel.teks };
}

/**
 * INDENTATION IS RELATIVE, so a table is indented from its own shallowest row.
 *
 * `baris_laporan.level` is 1-based in the shipped seed (apps/api/src/seed/
 * coa-inti.ts writes a literal `1` for every core line), so an absolute reading
 * would put a three-space margin on every row of a statement that has no
 * nesting at all -- an indent that indents nothing relative to anything, which
 * is worse than none. Subtracting the table's own minimum makes a flat template
 * flat and a nested one nested, without this file having an opinion about
 * whether anybody's `level` starts at 0 or 1.
 */
function levelDasar(tata: readonly TataBaris[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const t of tata) min = Math.min(min, t.level);
  return Number.isFinite(min) ? min : 0;
}

// ---------------------------------------------------------------------------
// Value -> cell
// ---------------------------------------------------------------------------

export function selDariNilai(kunci: string, v: unknown, tebal = false): Sel {
  if (v === null || v === undefined) return tebal ? { ...KOSONG, tebal } : KOSONG;
  if (adalahAngka(v)) return selUang(v.nilai, tebal);
  if (typeof v === "number") return selAngka(v, tebal);
  if (typeof v === "boolean") return selTeks(v ? "Ya" : "Tidak", tebal);
  if (typeof v === "bigint") return selAngka(v.toString(), tebal);
  if (typeof v === "string") {
    // A UUID is an identifier, not a date and not a number, and must stay text
    // even though it is all hex: a spreadsheet that decided otherwise would
    // mangle it.
    if (POLA_UUID.test(v)) return selTeks(v, tebal);
    if (POLA_TANGGAL_ISO.test(v)) return selTanggal(v, tebal);
    if (kunciPersen(kunci) && POLA_DESIMAL_DUA.test(v)) return selPersen(v, tebal);
    return selTeks(v, tebal);
  }
  // An array or an object that got this far is a shape this file does not
  // flatten. It becomes text rather than being dropped: a column that silently
  // disappears from an export is worse than one that reads awkwardly.
  return selTeks(JSON.stringify(v), tebal);
}

// ---------------------------------------------------------------------------
// Flattening one row
// ---------------------------------------------------------------------------

/**
 * One level of nesting, dotted. `bucket: { LANCAR: Angka, ... }` becomes
 * `bucket.LANCAR`, which is how a bucket matrix has to arrive in a spreadsheet
 * if a reader is going to sum a column of it.
 *
 * A nested ARRAY is not flattened into the row: it becomes its own sheet (see
 * `tabelDariArray`). Squeezing a partner's whole instalment schedule into one
 * cell as JSON is how an export stops being usable.
 */
function ratakan(baris: Record<string, unknown>): {
  nilai: Record<string, unknown>;
  anak: Array<{ kunci: string; isi: unknown[] }>;
} {
  const nilai: Record<string, unknown> = {};
  const anak: Array<{ kunci: string; isi: unknown[] }> = [];
  for (const [k, v] of Object.entries(baris)) {
    // Rule 5. Dropped here rather than at the column list, so a machinery field
    // nested one level deep (`baris.level`) goes with it.
    if (kolomMesin(k)) continue;
    if (Array.isArray(v)) {
      // AN ARRAY OF SCALARS IS ONE CELL, NOT A CHILD TABLE. `akunKode` on a
      // statement line is the list of accounts that fed the figure -- the
      // drill-down spec 11 calls the difference between a number a user
      // believes and one they do not -- and it used to VANISH: it went into
      // `anak`, where `tabelDariArray` filters for objects, finds none, and
      // emits nothing. A comma-joined cell is how a list of codes belongs on a
      // printed line anyway.
      if (v.length === 0 || v.every((x) => x === null || typeof x !== "object")) {
        nilai[k] = v.length === 0 ? null : v.join(", ");
        continue;
      }
      anak.push({ kunci: k, isi: v });
      continue;
    }
    if (objekBiasa(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (kolomMesin(k2)) continue;
        nilai[`${k}.${k2}`] = Array.isArray(v2) || objekBiasa(v2) ? JSON.stringify(v2) : v2;
      }
      continue;
    }
    nilai[k] = v;
  }
  return { nilai, anak };
}

/** Union of keys in first-seen order, ids pushed to the end. */
function kolomDari(baris: readonly Record<string, unknown>[]): string[] {
  const urut: string[] = [];
  const lihat = new Set<string>();
  for (const b of baris) {
    for (const k of Object.keys(b)) {
      if (!lihat.has(k)) {
        lihat.add(k);
        urut.push(k);
      }
    }
  }
  return [...urut.filter((k) => !kunciId(k)), ...urut.filter(kunciId)];
}

// ---------------------------------------------------------------------------
// Array -> table (plus child tables)
// ---------------------------------------------------------------------------

function tabelDariArray(
  judul: string,
  isi: readonly unknown[],
  sudahTerbit: WeakSet<object>,
): TabelDokumen[] {
  if (isi.length === 0) {
    return [{ judul, kolom: ["(kosong)"], baris: [] }];
  }
  if (!objekBiasa(isi[0])) {
    // An array of scalars: one column, named after the table.
    return [
      {
        judul,
        kolom: [judul],
        baris: isi.map((v) => [selDariNilai(judul, v)]),
      },
    ];
  }

  const sumber = isi as Record<string, unknown>[];
  for (const b of sumber) sudahTerbit.add(b);
  const rata = sumber.map(ratakan);
  const tata = sumber.map(tataDariBaris);
  const kolom = kolomDari(rata.map((r) => r.nilai));
  const kunciIndent = kunciUntukIndent(kolom);
  const dasar = levelDasar(tata);
  // Rule 6, applied here and nowhere else: bold the whole row when the template
  // says the line is a total, and indent its caption by its nesting level.
  const baris = rata.map((r, i) => {
    const t = tata[i] ?? { level: 0, tebal: false };
    return kolom.map((k) => {
      const sel = selDariNilai(k, r.nilai[k], t.tebal);
      return k === kunciIndent ? indentkan(sel, t.level - dasar) : sel;
    });
  });

  const tabel: TabelDokumen[] = [{ judul, kolom: kolom.map(judulDariKunci), baris }];

  // Child arrays, one table per child key, each row prefixed with the parent's
  // first non-id column so the two can be joined by eye.
  const kunciPengait = kolom.find((k) => !kunciId(k)) ?? kolom[0] ?? "";
  const anakPerKunci = new Map<string, Sel[][]>();
  const kolomAnak = new Map<string, string[]>();
  rata.forEach((r) => {
    for (const a of r.anak) {
      if (a.isi.length === 0) continue;
      const objek = a.isi.filter(objekBiasa);
      // Rule 7, on a CHILD array. `LaporanAktivitas.seksi[].baris` is the same
      // `BarisStatement` objects the statement's own `baris` array holds, so
      // without this the sections would reprint the whole statement under a
      // second heading.
      if (objek.length > 0 && objek.every((b) => sudahTerbit.has(b))) continue;
      for (const b of objek) sudahTerbit.add(b);
      const rataAnak = objek.map(ratakan);
      const tataAnak = objek.map(tataDariBaris);
      if (rataAnak.length === 0) continue;
      const kk = kolomAnak.get(a.kunci) ?? kolomDari(rataAnak.map((x) => x.nilai));
      kolomAnak.set(a.kunci, kk);
      const kunciIndentAnak = kunciUntukIndent(kk);
      const dasarAnak = levelDasar(tataAnak);
      const kumpul = anakPerKunci.get(a.kunci) ?? [];
      rataAnak.forEach((x, i) => {
        const t = tataAnak[i] ?? { level: 0, tebal: false };
        kumpul.push([
          selDariNilai(kunciPengait, r.nilai[kunciPengait]),
          ...kk.map((k) => {
            const sel = selDariNilai(k, x.nilai[k], t.tebal);
            return k === kunciIndentAnak ? indentkan(sel, t.level - dasarAnak) : sel;
          }),
        ]);
      });
      anakPerKunci.set(a.kunci, kumpul);
    }
  });
  for (const [kunci, baris2] of anakPerKunci) {
    tabel.push({
      judul: `${judul} - ${judulDariKunci(kunci)}`,
      kolom: [judulDariKunci(kunciPengait), ...(kolomAnak.get(kunci) ?? []).map(judulDariKunci)],
      baris: baris2,
    });
  }
  return tabel;
}

// ---------------------------------------------------------------------------
// Report result -> document
// ---------------------------------------------------------------------------

const KUNCI_HEADER = new Set(["header"]);

/**
 * Turns any of the thirty report results into a document.
 *
 * `namaTabelUtama` is the report's own name, used for the sheet that holds
 * `baris` (or `kartu`, or `sel`): calling the main sheet "Baris" would be this
 * layer imposing its own vocabulary on every report in the system.
 */
export function dokumenDariLaporan(hasil: unknown, namaTabelUtama: string): DokumenEkspor {
  if (!objekBiasa(hasil)) {
    throw new Error("Hasil laporan bukan objek, tidak bisa diekspor.");
  }
  const h = objekBiasa(hasil.header) ? hasil.header : {};
  const tambahan: Array<{ label: string; nilai: string }> = [];
  const tabel: TabelDokumen[] = [];
  const ringkasan: Sel[][] = [];

  /**
   * RULE 7: A TABLE THAT ONLY REPEATS ANOTHER IS NOT EMITTED.
   *
   * Membership by OBJECT IDENTITY, which is exact rather than heuristic: a
   * report builds its subsets by filtering its own array
   * (`semuaBaris.filter((b) => b.seksi === SEKSI_ASET)` in
   * modules/laporan/service.ts), so the rows in `barisAset` ARE the rows in
   * `baris`, the same objects. Nothing that merely looks similar is suppressed,
   * and a genuinely different table with equal-looking contents is untouched.
   *
   * A partial overlap is NOT suppressed either: the test is "every row of this
   * array has already been printed", so an array that adds even one row still
   * gets its table and only the fully redundant repeats disappear.
   */
  const sudahTerbit = new WeakSet<object>();

  /**
   * THE MAIN TABLE IS BUILT FIRST, whatever order the result object happens to
   * declare its keys in, because rule 7 keeps whichever table is built FIRST
   * and every report's `baris` is the statement itself ("all lines in template
   * order, sections flattened, for a plain printer", per
   * `LaporanAktivitas.baris`). Left to key order, `LaporanAktivitas` would emit
   * `seksi` first and the statement would survive only as a child sheet called
   * "Seksi - Baris".
   */
  const kunciUrut = Object.keys(hasil).sort((a, b) => {
    if (a === b) return 0;
    if (a === "baris") return -1;
    if (b === "baris") return 1;
    return 0;
  });

  for (const k of kunciUrut) {
    const v = (hasil as Record<string, unknown>)[k];
    if (KUNCI_HEADER.has(k)) continue;
    if (Array.isArray(v)) {
      // Rule 7 at the top level: three subsets of one statement
      // (`barisAset`, `barisLiabilitas`, `barisAsetNeto`) printed the whole
      // balance sheet three more times under three headings.
      const objek = v.filter(objekBiasa);
      if (objek.length > 0 && objek.length === v.length && objek.every((b) => sudahTerbit.has(b))) {
        continue;
      }
      const judul = k === "baris" ? namaTabelUtama : judulDariKunci(k);
      tabel.push(...tabelDariArray(judul, v, sudahTerbit));
      continue;
    }
    if (objekBiasa(v)) {
      const { nilai } = ratakan(v as Record<string, unknown>);
      for (const [k2, v2] of Object.entries(nilai)) {
        ringkasan.push([selTeks(judulDariKunci(`${k}.${k2}`)), selDariNilai(k2, v2)]);
      }
      continue;
    }
    // AN `Angka` SITTING DIRECTLY ON THE RESULT IS A FIGURE, AND THE MOST
    // IMPORTANT ONE THERE IS. `objekBiasa` excludes `Angka` on purpose, so
    // without this branch a top-level money value fell past both the array
    // case and the object case and landed on `String(v)` below, which for
    // `{nilai, tampil}` is the string "[object Object]".
    //
    // That is what "Total Aset Tahun Ini" printed in the exported workbook,
    // the HTML and therefore the PDF, on the six statements an entity actually
    // hands upward: Aktivitas, Arus Kas, Posisi Keuangan, Perubahan Aset Neto,
    // Buku Besar and Perhitungan Penyisihan. A figure nested one level deeper
    // formatted correctly, which is why every test that read the engine's JSON
    // stayed green and only opening the file showed it.
    if (adalahAngka(v)) {
      ringkasan.push([selTeks(judulDariKunci(k)), selDariNilai(k, v)]);
      continue;
    }
    // A scalar at the top level is a fact about the report, not a figure in
    // it: `mode`, `dasarWilayah`, `basisPerhitungan`. It belongs in the header
    // where a reader looks for the terms the numbers were produced under.
    tambahan.push({ label: judulDariKunci(k), nilai: v === null || v === undefined ? "-" : String(v) });
  }

  if (ringkasan.length > 0) {
    tabel.push({ judul: "Ringkasan", kolom: ["Keterangan", "Nilai"], baris: ringkasan });
  }
  if (tabel.length === 0) {
    tabel.push({ judul: namaTabelUtama, kolom: ["(kosong)"], baris: [] });
  }

  const s = (kunci: string): string => (typeof h[kunci] === "string" ? (h[kunci] as string) : "");
  return {
    header: {
      namaBumn: s("namaBumn"),
      namaLaporan: s("namaLaporan") || namaTabelUtama,
      periodeLabel: s("periodeLabel"),
      namaCabang: s("namaCabang"),
      tanggalCetak: s("tanggalCetak"),
      dicetakOleh: s("dicetakOleh"),
      sumberData: s("sumberData"),
      statusPeriode: typeof h.statusPeriode === "string" ? h.statusPeriode : null,
      tambahan,
    },
    tabel,
  };
}

// ---------------------------------------------------------------------------
// Document -> workbook
// ---------------------------------------------------------------------------

/**
 * The header goes on its OWN first sheet rather than above every table.
 *
 * Two reasons, and the second is the one that decided it. A header block above
 * a table breaks sorting and filtering for every user who selects a column,
 * which is the first thing anybody does with an exported report. And a
 * multi-sheet workbook that repeated the header on each sheet would let two
 * copies of "tanggal cetak" drift if a sheet were ever built separately; one
 * copy cannot.
 */
export function lembarDariDokumen(dok: DokumenEkspor): Lembar[] {
  const h = dok.header;
  const kepala: Sel[][] = [
    [selTeks(h.namaBumn, true)],
    [selTeks(h.namaLaporan, true)],
    [],
    [selTeks("Periode"), selTeks(h.periodeLabel)],
    [selTeks("Cabang"), selTeks(h.namaCabang)],
    [selTeks("Status periode"), selTeks(h.statusPeriode ?? "-")],
    [selTeks("Sumber data"), selTeks(h.sumberData)],
    [selTeks("Tanggal cetak"), selTanggal(h.tanggalCetak)],
    [selTeks("Dicetak oleh"), selTeks(h.dicetakOleh)],
    ...h.tambahan.map((t) => [selTeks(t.label), selTeks(t.nilai)]),
    [],
    [selTeks("Isi berkas", true)],
    ...dok.tabel.map((t) => [selTeks(t.judul), selAngka(t.baris.length)]),
  ];

  const lembar: Lembar[] = [
    { nama: "Header", kolom: lebarOtomatis(kepala, 60, 14), baris: kepala },
  ];
  for (const t of dok.tabel) {
    const baris: Sel[][] = [t.kolom.map((k) => selTeks(k, true)), ...t.baris];
    lembar.push({
      nama: t.judul,
      kolom: lebarOtomatis(baris),
      baris,
      bekukanBaris: 1,
    });
  }
  return lembar;
}
