// Reading an .xlsx that ARRIVED FROM A BROWSER, which is the dangerous half.
//
// Writing a spreadsheet is arithmetic. Reading one is parsing an
// attacker-controlled ZIP full of attacker-controlled XML, and the caps that
// bound it are in ./batas.ts with the reasoning for each number. This file is
// the place they are all applied, in one order, with nothing between the
// bytes and the cells:
//
//   1. MAKS_BERKAS_BYTE      the upload itself, before anything is opened
//   2. MAKS_ENTRI            entry count, from the central directory
//   3. MAKS_ENTRI_DEKOMPRESI_BYTE / MAKS_TOTAL_DEKOMPRESI_BYTE
//                            what DEFLATE is allowed to PRODUCE, enforced by
//                            the decompressor, never by a header's claim
//   4. larangDeklarasi       no DTD, no entity declaration, in any part
//   5. MAKS_SHARED_STRING    the string table
//   6. MAKS_BARIS / MAKS_KOLOM / MAKS_KARAKTER_SEL   the sheet itself
//
// FOUR PARTS ARE READ AND NO OTHERS. `[Content_Types].xml` is not consulted,
// `docProps` is not read, no image, no VBA project, no external-workbook link,
// no `printerSettings.bin` is ever decompressed. An .xlsm with a macro in it
// imports as a spreadsheet and the macro is bytes this process never touches.
//
// NUMBERS COME OUT AS THE DECIMAL TEXT THE FILE HELD. `<v>1234.56</v>` becomes
// the string "1234.56", not `Number("1234.56")`, because the value on its way
// to `NUMERIC(20,2)` must never round-trip through a float. The one conversion
// this file does perform is a DATE serial, and that is integer arithmetic.
import {
  AnggaranDekompresi,
  bacaDirektoriZip,
  bacaEntriZip,
  type BatasZip,
  type EntriZip,
} from "./zip";
import {
  KODE_XLSX,
  KesalahanXlsx,
  MAKS_BARIS,
  MAKS_BERKAS_BYTE,
  MAKS_ENTRI,
  MAKS_ENTRI_DEKOMPRESI_BYTE,
  MAKS_KARAKTER_SEL,
  MAKS_KOLOM,
  MAKS_SHARED_STRING,
  MAKS_TOTAL_DEKOMPRESI_BYTE,
} from "./batas";
import { atribut, bacaTeksXml, isiTeks, larangDeklarasi, tagXml } from "./xml";
import { hariDariTanggal } from "./tulis";

export interface BatasBaca extends BatasZip {
  maksBerkasByte: number;
  maksBaris: number;
  maksKolom: number;
  maksKarakterSel: number;
  maksSharedString: number;
}

export const BATAS_BACA_BAWAAN: BatasBaca = {
  maksBerkasByte: MAKS_BERKAS_BYTE,
  maksEntri: MAKS_ENTRI,
  maksEntriDekompresiByte: MAKS_ENTRI_DEKOMPRESI_BYTE,
  maksTotalDekompresiByte: MAKS_TOTAL_DEKOMPRESI_BYTE,
  maksBaris: MAKS_BARIS,
  maksKolom: MAKS_KOLOM,
  maksKarakterSel: MAKS_KARAKTER_SEL,
  maksSharedString: MAKS_SHARED_STRING,
};

export interface TabelXlsx {
  namaLembar: string;
  /** A dense matrix: every row padded to the widest row, so a caller sees the
   *  same column count a spreadsheet shows and can refuse a ragged row itself. */
  baris: string[][];
}

const dec = new TextDecoder("utf-8", { fatal: false });

function cari(entri: readonly EntriZip[], nama: string): EntriZip | null {
  const target = nama.toLowerCase();
  return entri.find((e) => e.nama.toLowerCase() === target) ?? null;
}

function teksDari(
  data: Uint8Array,
  entri: EntriZip,
  anggaran: AnggaranDekompresi,
): string {
  const teks = dec.decode(bacaEntriZip(data, entri, anggaran));
  // EVERY part goes through this, not just the sheet: a DOCTYPE in
  // sharedStrings.xml is the same attack in a part people forget to check.
  larangDeklarasi(teks);
  return teks;
}

// ---------------------------------------------------------------------------
// sharedStrings.xml
// ---------------------------------------------------------------------------

function bacaSharedStrings(teks: string, batas: BatasBaca): string[] {
  const keluar: string[] = [];
  let dalamSi = false;
  let buf = "";
  for (const tag of tagXml(teks)) {
    if (tag.nama === "si") {
      if (tag.jenis === "buka") {
        dalamSi = true;
        buf = "";
      } else if (tag.jenis === "tutup") {
        dalamSi = false;
        if (keluar.length >= batas.maksSharedString) {
          throw new KesalahanXlsx(
            KODE_XLSX.TERLALU_BANYAK_SHARED_STRING,
            `Tabel teks berkas melebihi ${batas.maksSharedString} entri.`,
            batas.maksSharedString,
          );
        }
        keluar.push(potong(buf, batas));
      } else {
        keluar.push("");
      }
      continue;
    }
    // `<rPh>` is a Japanese phonetic hint that duplicates the run text; it is
    // NOT skipped here because the readers that matter here never emit it, and
    // a skip would need a nesting counter this scanner deliberately has not.
    if (dalamSi && tag.nama === "t" && tag.jenis === "buka") {
      buf += isiTeks(teks, tag.akhir, "t");
      if (buf.length > batas.maksKarakterSel) potong(buf, batas);
    }
  }
  return keluar;
}

function potong(nilai: string, batas: BatasBaca): string {
  if (nilai.length > batas.maksKarakterSel) {
    throw new KesalahanXlsx(
      KODE_XLSX.SEL_TERLALU_PANJANG,
      `Ada sel yang melebihi ${batas.maksKarakterSel} karakter.`,
      batas.maksKarakterSel,
    );
  }
  return nilai;
}

// ---------------------------------------------------------------------------
// styles.xml, read for ONE question: is this cell a date?
// ---------------------------------------------------------------------------
//
// A date typed into Excel is stored as a serial NUMBER; only the cell's number
// FORMAT says it is a date. Skipping this would make every `tanggal` column an
// operator filled in arrive as "45292", which the import would reject row by
// row with a message about the date pattern -- correct, and useless.

/** Built-in numFmtIds that are dates or times (ECMA-376 18.8.30). */
const FORMAT_TANGGAL_BAWAAN = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

interface GayaXlsx {
  /** cellXfs index -> true when that format displays a date. */
  tanggal: boolean[];
}

function bacaStyles(teks: string): GayaXlsx {
  const custom = new Map<number, boolean>();
  for (const tag of tagXml(teks)) {
    if (tag.nama !== "numFmt") continue;
    const id = Number(atribut(tag.atributMentah, "numFmtId") ?? "");
    const kode = atribut(tag.atributMentah, "formatCode") ?? "";
    if (!Number.isInteger(id)) continue;
    // Literal text in a format string is quoted or backslash-escaped; strip
    // both before looking for date tokens, so `#,##0" hari"` is not a date.
    const telanjang = kode.replace(/"[^"]*"/g, "").replace(/\\./g, "");
    custom.set(id, /[ymdhs]/i.test(telanjang));
  }

  const tanggal: boolean[] = [];
  let dalamCellXfs = false;
  for (const tag of tagXml(teks)) {
    if (tag.nama === "cellXfs") {
      dalamCellXfs = tag.jenis !== "tutup";
      continue;
    }
    if (!dalamCellXfs || tag.nama !== "xf" || tag.jenis === "tutup") continue;
    const id = Number(atribut(tag.atributMentah, "numFmtId") ?? "0");
    tanggal.push(FORMAT_TANGGAL_BAWAAN.has(id) || (custom.get(id) ?? false));
  }
  return { tanggal };
}

/** Inverse of `hariDariTanggal`: serial day -> `YYYY-MM-DD`. Integers only. */
export function tanggalDariSerial(serial: number): string {
  // 1899-12-30 is serial 0. Excel's phantom 1900-02-29 sits at serial 60; a
  // real file cannot contain it, and treating it as 1900-02-28 (which is what
  // this arithmetic does) is better than refusing to import the row.
  const z = Math.trunc(serial) + hariDariTanggal(1899, 12, 30) + 719468;
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const tahun = y + (m <= 2 ? 1 : 0);
  return `${String(tahun).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// The worksheet
// ---------------------------------------------------------------------------

/** `"BC12"` -> 55. Zero-based, and bounded before it is used as an index. */
function indeksKolom(ref: string, batas: BatasBaca): number {
  let n = 0;
  for (const ch of ref) {
    const kode = ch.charCodeAt(0);
    if (kode >= 65 && kode <= 90) n = n * 26 + (kode - 64);
    else if (kode >= 97 && kode <= 122) n = n * 26 + (kode - 96);
    else break;
    if (n > batas.maksKolom) {
      throw new KesalahanXlsx(
        KODE_XLSX.TERLALU_BANYAK_KOLOM,
        `Berkas memakai lebih dari ${batas.maksKolom} kolom.`,
        batas.maksKolom,
      );
    }
  }
  return n - 1;
}

function bacaLembar(
  teks: string,
  shared: readonly string[],
  gaya: GayaXlsx,
  batas: BatasBaca,
): string[][] {
  const baris: string[][] = [];
  let sekarang: string[] | null = null;
  let kolomBerjalan = 0;

  // Per-cell state.
  let jenis = "";
  let indeksGaya = 0;
  let kolom = 0;
  let nilaiV: string | null = null;
  let bufT = "";
  let dalamSel = false;

  const tutupSel = (): void => {
    if (!dalamSel || sekarang === null) return;
    dalamSel = false;
    let hasil: string;
    if (jenis === "s") {
      const i = Number(nilaiV ?? "");
      hasil = Number.isInteger(i) && i >= 0 && i < shared.length ? shared[i]! : "";
    } else if (jenis === "inlineStr" || jenis === "str") {
      hasil = jenis === "inlineStr" ? bufT : (nilaiV ?? "");
    } else if (jenis === "b") {
      hasil = nilaiV === "1" ? "TRUE" : "FALSE";
    } else if (jenis === "e") {
      // `#REF!`, `#DIV/0!`. Imported as the literal error text so a row that
      // depended on a broken formula is REFUSED downstream with a visible
      // reason, rather than arriving as an empty cell.
      hasil = nilaiV ?? "";
    } else {
      const mentah = nilaiV ?? "";
      hasil =
        mentah !== "" && gaya.tanggal[indeksGaya] === true && /^-?\d+(\.\d+)?$/.test(mentah)
          ? tanggalDariSerial(Number(mentah.split(".")[0]))
          : mentah;
    }
    potong(hasil, batas);
    while (sekarang.length < kolom) sekarang.push("");
    sekarang[kolom] = hasil;
  };

  for (const tag of tagXml(teks)) {
    if (tag.nama === "row") {
      if (tag.jenis === "buka" || tag.jenis === "kosong") {
        tutupSel();
        if (baris.length >= batas.maksBaris) {
          throw new KesalahanXlsx(
            KODE_XLSX.TERLALU_BANYAK_BARIS,
            `Berkas melebihi ${batas.maksBaris} baris.`,
            batas.maksBaris,
          );
        }
        sekarang = [];
        kolomBerjalan = 0;
        baris.push(sekarang);
      } else {
        tutupSel();
        sekarang = null;
      }
      continue;
    }

    if (tag.nama === "c") {
      if (tag.jenis === "tutup") {
        tutupSel();
        continue;
      }
      tutupSel();
      if (sekarang === null) {
        sekarang = [];
        kolomBerjalan = 0;
        baris.push(sekarang);
      }
      const ref = atribut(tag.atributMentah, "r");
      kolom = ref ? indeksKolom(ref, batas) : kolomBerjalan;
      if (kolom < 0) kolom = kolomBerjalan;
      if (kolom >= batas.maksKolom) {
        throw new KesalahanXlsx(
          KODE_XLSX.TERLALU_BANYAK_KOLOM,
          `Berkas memakai lebih dari ${batas.maksKolom} kolom.`,
          batas.maksKolom,
        );
      }
      kolomBerjalan = kolom + 1;
      jenis = atribut(tag.atributMentah, "t") ?? "n";
      indeksGaya = Number(atribut(tag.atributMentah, "s") ?? "0") || 0;
      nilaiV = null;
      bufT = "";
      dalamSel = true;
      if (tag.jenis === "kosong") tutupSel();
      continue;
    }

    if (!dalamSel) continue;
    if (tag.nama === "v" && tag.jenis === "buka") {
      nilaiV = isiTeks(teks, tag.akhir, "v");
      potong(nilaiV, batas);
    } else if (tag.nama === "t" && tag.jenis === "buka") {
      bufT += isiTeks(teks, tag.akhir, "t");
      potong(bufT, batas);
    } else if (tag.nama === "f") {
      // A FORMULA IS NEVER EVALUATED AND NEVER READ. `<f>` is skipped and the
      // cached `<v>` beside it is what the import sees, so an uploaded
      // workbook cannot make this process compute anything.
      continue;
    }
  }
  tutupSel();

  const lebar = baris.reduce((n, r) => Math.max(n, r.length), 0);
  return baris.map((r) => {
    const padat = r.slice();
    while (padat.length < lebar) padat.push("");
    for (let i = 0; i < padat.length; i += 1) padat[i] ??= "";
    return padat as string[];
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The first worksheet of an uploaded workbook, as a dense matrix of strings.
 *
 * ONLY THE FIRST SHEET, deliberately. An import is a file with one table in
 * it; reading every sheet would multiply the row cap by the sheet count and
 * would make "which sheet did my data come from" a question the operator
 * cannot answer from the rejection report. Which sheet is FIRST is read from
 * `xl/workbook.xml`'s `<sheets>` order and resolved through the relationship
 * id, never by assuming `sheet1.xml`: Excel renumbers parts when sheets are
 * deleted, so the first sheet of a real workbook is frequently `sheet3.xml`.
 */
export function bacaTabelXlsx(data: Uint8Array, batas: BatasBaca = BATAS_BACA_BAWAAN): TabelXlsx {
  if (data.length === 0) {
    throw new KesalahanXlsx(KODE_XLSX.BUKAN_ZIP, "Berkas kosong.");
  }
  if (data.length > batas.maksBerkasByte) {
    throw new KesalahanXlsx(
      KODE_XLSX.BERKAS_TERLALU_BESAR,
      `Berkas ${data.length} byte melebihi batas ${batas.maksBerkasByte} byte.`,
      batas.maksBerkasByte,
    );
  }
  // The local-header signature, checked before the ZIP is walked so a .csv or
  // a .xls renamed to .xlsx gets a sentence about the file rather than one
  // about archive structure.
  if (!(data[0] === 0x50 && data[1] === 0x4b)) {
    throw new KesalahanXlsx(
      KODE_XLSX.BUKAN_ZIP,
      "Berkas ini bukan .xlsx. Simpan ulang dari Excel sebagai Excel Workbook (.xlsx).",
    );
  }

  const entri = bacaDirektoriZip(data, batas);
  const anggaran = new AnggaranDekompresi(batas);

  const eWorkbook = cari(entri, "xl/workbook.xml");
  if (!eWorkbook) {
    throw new KesalahanXlsx(
      KODE_XLSX.BUKAN_XLSX,
      "Arsip ini tidak berisi buku kerja Excel (xl/workbook.xml tidak ada).",
    );
  }

  const workbook = teksDari(data, eWorkbook, anggaran);
  let namaLembar = "";
  let rid: string | null = null;
  for (const tag of tagXml(workbook)) {
    if (tag.nama !== "sheet" || tag.jenis === "tutup") continue;
    namaLembar = atribut(tag.atributMentah, "name") ?? "";
    rid = atribut(tag.atributMentah, "id");
    break;
  }
  if (rid === null) {
    throw new KesalahanXlsx(KODE_XLSX.BUKAN_XLSX, "Buku kerja ini tidak punya lembar apa pun.");
  }

  const eRels = cari(entri, "xl/_rels/workbook.xml.rels");
  let target: string | null = null;
  if (eRels) {
    const rels = teksDari(data, eRels, anggaran);
    for (const tag of tagXml(rels)) {
      if (tag.nama !== "Relationship" || tag.jenis === "tutup") continue;
      if (atribut(tag.atributMentah, "Id") !== rid) continue;
      target = atribut(tag.atributMentah, "Target");
      break;
    }
  }
  const jalur = target
    ? target.startsWith("/")
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, "")}`
    : "xl/worksheets/sheet1.xml";
  const eLembar = cari(entri, jalur) ?? cari(entri, "xl/worksheets/sheet1.xml");
  if (!eLembar) {
    throw new KesalahanXlsx(KODE_XLSX.BUKAN_XLSX, "Lembar pertama buku kerja tidak ditemukan.");
  }

  const eShared = cari(entri, "xl/sharedStrings.xml");
  const shared = eShared ? bacaSharedStrings(teksDari(data, eShared, anggaran), batas) : [];

  const eStyles = cari(entri, "xl/styles.xml");
  const gaya = eStyles ? bacaStyles(teksDari(data, eStyles, anggaran)) : { tanggal: [] };

  const baris = bacaLembar(teksDari(data, eLembar, anggaran), shared, gaya, batas);
  return { namaLembar, baris };
}

export { KesalahanXlsx, KODE_XLSX } from "./batas";
export type { KodeXlsx } from "./batas";
export { bacaTeksXml };
