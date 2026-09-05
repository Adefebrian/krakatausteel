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
// THE FOUR SHAPING RULES
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
//
// ID COLUMNS ARE KEPT AND MOVED TO THE END. A UUID is how a figure is traced
// back to its row (spec 11: "angka yang tidak bisa ditelusuri asalnya tidak
// dipercaya user"), so dropping it would remove the audit trail from the
// artefact most likely to be filed as evidence. Putting it first would make an
// accountant read past 36 hex characters to reach the name. So it travels, at
// the right-hand end.
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
    if (Array.isArray(v)) {
      anak.push({ kunci: k, isi: v });
      continue;
    }
    if (objekBiasa(v)) {
      for (const [k2, v2] of Object.entries(v)) {
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

function tabelDariArray(judul: string, isi: readonly unknown[]): TabelDokumen[] {
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

  const rata = (isi as Record<string, unknown>[]).map(ratakan);
  const kolom = kolomDari(rata.map((r) => r.nilai));
  const baris = rata.map((r) => kolom.map((k) => selDariNilai(k, r.nilai[k])));

  const tabel: TabelDokumen[] = [{ judul, kolom: kolom.map(judulDariKunci), baris }];

  // Child arrays, one table per child key, each row prefixed with the parent's
  // first non-id column so the two can be joined by eye.
  const kunciPengait = kolom.find((k) => !kunciId(k)) ?? kolom[0] ?? "";
  const anakPerKunci = new Map<string, Sel[][]>();
  const kolomAnak = new Map<string, string[]>();
  rata.forEach((r) => {
    for (const a of r.anak) {
      if (a.isi.length === 0) continue;
      const rataAnak = a.isi.filter(objekBiasa).map(ratakan);
      if (rataAnak.length === 0) continue;
      const kk = kolomAnak.get(a.kunci) ?? kolomDari(rataAnak.map((x) => x.nilai));
      kolomAnak.set(a.kunci, kk);
      const kumpul = anakPerKunci.get(a.kunci) ?? [];
      for (const x of rataAnak) {
        kumpul.push([
          selDariNilai(kunciPengait, r.nilai[kunciPengait]),
          ...kk.map((k) => selDariNilai(k, x.nilai[k])),
        ]);
      }
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

  for (const [k, v] of Object.entries(hasil)) {
    if (KUNCI_HEADER.has(k)) continue;
    if (Array.isArray(v)) {
      const judul = k === "baris" ? namaTabelUtama : judulDariKunci(k);
      tabel.push(...tabelDariArray(judul, v));
      continue;
    }
    if (objekBiasa(v)) {
      const { nilai } = ratakan(v as Record<string, unknown>);
      for (const [k2, v2] of Object.entries(nilai)) {
        ringkasan.push([selTeks(judulDariKunci(`${k}.${k2}`)), selDariNilai(k2, v2)]);
      }
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
