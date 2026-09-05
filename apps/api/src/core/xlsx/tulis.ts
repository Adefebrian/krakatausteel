// The workbook writer: a real .xlsx, several sheets, column widths, number
// formats, and two guarantees a library would not have given us.
//
// ---------------------------------------------------------------------------
// GUARANTEE 1: A RUPIAH NEVER BECOMES A FLOAT
// ---------------------------------------------------------------------------
// Money in this system is BigInt sen internally and a decimal STRING at every
// boundary (`Angka.nilai`, `^-?\d+\.\d{2}$`). An .xlsx numeric cell is
// `<v>1234.56</v>` -- DECIMAL TEXT inside XML, which the spreadsheet parses
// itself. So `uang("1234.56")` copies those exact characters into the file and
// no JavaScript number is constructed anywhere on the path. Every library in
// this space takes a `number`, which would mean `Number("0.1")+Number("0.2")`
// arithmetic somewhere behind us and a rupiah arriving as
// 0.30000000000000004: the same defect as a float in the ledger, one layer
// further out, and invisible until an accountant foots a column.
//
// The pattern is checked (`POLA_DESIMAL`). A value that does not match is
// written as TEXT rather than injected into `<v>`, because an unparsable
// numeric cell is a workbook no spreadsheet will open at all -- a formatting
// bug must not become a corrupt file.
//
// ---------------------------------------------------------------------------
// GUARANTEE 2: NO CELL IN A FILE THIS WRITER PRODUCES CAN BE A FORMULA
// ---------------------------------------------------------------------------
// There is no `<f>` element anywhere in this file and no API through which a
// caller could ask for one. Combined with ./sanitasi.ts's neutralisation of
// every text cell, an export cannot execute in Excel, cannot execute in
// LibreOffice, and cannot execute after somebody saves it back out as CSV.
//
// ---------------------------------------------------------------------------
// DATES ARE INTEGERS, COMPUTED WITH INTEGER ARITHMETIC
// ---------------------------------------------------------------------------
// A spreadsheet date is a serial day number. It is derived here from the civil
// calendar with `hariDariTanggal` -- pure integer arithmetic, no `Date`, no
// division by 86 400 000 -- because a report is printed in Asia/Jakarta and a
// serial computed through a UTC timestamp lands on the previous day for half
// the country half the year.
//
// ---------------------------------------------------------------------------
// THE FILE IS BYTE-REPRODUCIBLE
// ---------------------------------------------------------------------------
// ./zip.ts writes a constant DOS timestamp and nothing here writes a
// `dcterms:created`, so exporting the same closed period twice produces the
// same bytes. A reviewer can hash the workbook they were sent and compare it
// with the one that was signed. The date the report was printed is IN the
// report (`header.tanggalCetak`, from the engine's injected clock), which is
// where a reader looks for it.
import { netralkanFormula } from "./sanitasi";
import { loloskanXml } from "./xml";
import { tulisZip, type BerkasZip } from "./zip";

/** Exactly what an `<v>` may contain: an optional sign, digits, optional dot. */
const POLA_DESIMAL = /^-?\d+(\.\d+)?$/;
const POLA_TANGGAL_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Excel's own ceiling, and the reason a report with more rows is paginated. */
export const MAKS_BARIS_TULIS = 1_048_576;
export const MAKS_KOLOM_TULIS = 16_384;

// ---------------------------------------------------------------------------
// The cell model
// ---------------------------------------------------------------------------

export type JenisSel = "kosong" | "teks" | "uang" | "angka" | "persen" | "tanggal";

export interface Sel {
  jenis: JenisSel;
  /** Text cells only. Neutralised on the way out; never stored pre-escaped. */
  teks?: string;
  /** Numeric cells only. A DECIMAL STRING, copied verbatim into `<v>`. */
  desimal?: string;
  tebal?: boolean;
}

export const KOSONG: Sel = { jenis: "kosong" };

export function teks(nilai: string | null | undefined, tebal = false): Sel {
  if (nilai === null || nilai === undefined || nilai === "") return tebal ? { jenis: "kosong", tebal } : KOSONG;
  return { jenis: "teks", teks: nilai, tebal };
}

/** A money cell. `desimal` is a decimal string; a `number` is not accepted. */
export function uang(nilai: string | null | undefined, tebal = false): Sel {
  if (nilai === null || nilai === undefined || nilai === "") return { jenis: "kosong", tebal };
  return { jenis: "uang", desimal: nilai, tebal };
}

/** A count. Accepts a `number` because a row count is not money. */
export function angka(nilai: number | string | null | undefined, tebal = false): Sel {
  if (nilai === null || nilai === undefined || nilai === "") return { jenis: "kosong", tebal };
  const s = typeof nilai === "number" ? String(nilai) : nilai;
  return { jenis: "angka", desimal: s, tebal };
}

/** `"12.34"` means 12.34 percent, stored as 12.34 and formatted with a `%`
 *  suffix. Deliberately NOT divided by 100 into Excel's own percent format:
 *  the division is the float this file exists to avoid. */
export function persen(nilai: string | null | undefined, tebal = false): Sel {
  if (nilai === null || nilai === undefined || nilai === "") return { jenis: "kosong", tebal };
  return { jenis: "persen", desimal: nilai, tebal };
}

export function tanggal(iso: string | null | undefined, tebal = false): Sel {
  if (!iso || !POLA_TANGGAL_ISO.test(iso)) return iso ? teks(iso, tebal) : { jenis: "kosong", tebal };
  return { jenis: "tanggal", teks: iso, tebal };
}

export interface KolomLembar {
  /** Column width in Excel's character units. */
  lebar: number;
}

export interface Lembar {
  /** Sanitised on write: Excel refuses `[]:*?/\`, 31 characters, and blanks. */
  nama: string;
  kolom?: KolomLembar[];
  baris: Sel[][];
  /** Rows to keep visible when scrolling. 1 = the header row. */
  bekukanBaris?: number;
}

// ---------------------------------------------------------------------------
// Serial dates, integer arithmetic only
// ---------------------------------------------------------------------------

/** Days since 1970-01-01 for a proleptic Gregorian date. Hinnant's algorithm. */
export function hariDariTanggal(tahun: number, bulan: number, hari: number): number {
  const y = tahun - (bulan <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (bulan + (bulan > 2 ? -3 : 9)) + 2) / 5) + hari - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 1899-12-30 is serial 0, which is what reproduces Excel's 1900 leap-year bug
 *  for every date after 1900-03-01 without implementing the bug. */
const SERIAL_EPOCH = hariDariTanggal(1899, 12, 30);

function serialTanggal(iso: string): number {
  const m = POLA_TANGGAL_ISO.exec(iso)!;
  return hariDariTanggal(Number(m[1]), Number(m[2]), Number(m[3])) - SERIAL_EPOCH;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
//
// Ten cell formats: five kinds x plain/bold. The index is arithmetic
// (`kind * 2 + bold`), so a new kind is one row in each of the two tables and
// cannot drift out of step with the numFmt it names.

const GAYA_URUT: JenisSel[] = ["kosong", "teks", "uang", "angka", "persen", "tanggal"];

function indeksGaya(sel: Sel): number {
  const i = GAYA_URUT.indexOf(sel.jenis);
  return (i < 0 ? 0 : i) * 2 + (sel.tebal ? 1 : 0);
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="4">' +
  // Negative money with a real minus sign rather than parentheses: an
  // Indonesian financial statement writes -1.234,56 and an accountant reading
  // a bracketed figure has to stop and decide which convention is in play.
  '<numFmt numFmtId="164" formatCode="#,##0.00;-#,##0.00"/>' +
  '<numFmt numFmtId="165" formatCode="#,##0;-#,##0"/>' +
  '<numFmt numFmtId="166" formatCode="0.00&quot;%&quot;"/>' +
  '<numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd"/>' +
  "</numFmts>" +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  "</fonts>" +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="12">' +
  // kosong
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  // teks
  '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  // uang
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  // angka
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  // persen
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="166" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  // tanggal
  '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="167" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

// ---------------------------------------------------------------------------
// Names and references
// ---------------------------------------------------------------------------

/** `1 -> A`, `27 -> AA`. One-based, matching a spreadsheet's own numbering. */
export function hurufKolom(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const sisa = (x - 1) % 26;
    s = String.fromCharCode(65 + sisa) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/**
 * A sheet name Excel will accept. The five refused characters plus the
 * apostrophe rule are Excel's, not ours, and a workbook carrying an illegal
 * one opens as "unreadable content" with no indication of which sheet.
 */
export function namaLembarAman(nama: string, dipakai: Set<string>): string {
  let s = nama.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim();
  if (s.startsWith("'")) s = s.slice(1);
  if (s.endsWith("'")) s = s.slice(0, -1);
  if (s.length === 0) s = "Lembar";
  if (s.length > 31) s = s.slice(0, 31).trim();
  let akhir = s;
  let n = 2;
  // Two sheets with one name is also a file Excel refuses, and the reports
  // here genuinely collide once truncated to 31 characters.
  while (dipakai.has(akhir.toLowerCase())) {
    const akhiran = ` (${n})`;
    akhir = `${s.slice(0, 31 - akhiran.length).trim()}${akhiran}`;
    n += 1;
  }
  dipakai.add(akhir.toLowerCase());
  return akhir;
}

// ---------------------------------------------------------------------------
// Sheet XML
// ---------------------------------------------------------------------------

function selXml(ref: string, sel: Sel): string {
  const s = indeksGaya(sel);
  if (sel.jenis === "kosong") return s === 0 ? "" : `<c r="${ref}" s="${s}"/>`;

  if (sel.jenis === "teks") {
    // THE ONE LINE THIS WHOLE FEATURE TURNS ON. Every text cell is neutralised
    // here, at the single place a string becomes a cell, so no caller can
    // forget and no future sheet builder can bypass it.
    const isi = loloskanXml(netralkanFormula(sel.teks ?? ""));
    const spasi = /^\s|\s$/.test(sel.teks ?? "") ? ' xml:space="preserve"' : "";
    return `<c r="${ref}" s="${s}" t="inlineStr"><is><t${spasi}>${isi}</t></is></c>`;
  }

  if (sel.jenis === "tanggal") {
    return `<c r="${ref}" s="${s}"><v>${serialTanggal(sel.teks!)}</v></c>`;
  }

  const d = sel.desimal ?? "";
  if (!POLA_DESIMAL.test(d)) {
    // A malformed figure becomes a TEXT cell rather than a corrupt workbook.
    // It is still neutralised: whatever produced it was not a number, and a
    // non-number that reached a money column is exactly the sort of value
    // worth not executing.
    const isi = loloskanXml(netralkanFormula(d));
    return `<c r="${ref}" s="${indeksGaya({ jenis: "teks", tebal: sel.tebal })}" t="inlineStr"><is><t>${isi}</t></is></c>`;
  }
  return `<c r="${ref}" s="${s}"><v>${d}</v></c>`;
}

function lembarXml(lembar: Lembar): string {
  const baris = lembar.baris;
  if (baris.length > MAKS_BARIS_TULIS) {
    throw new Error(`Lembar "${lembar.nama}" punya ${baris.length} baris, melebihi batas Excel.`);
  }

  const bagian: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  ];

  const beku = lembar.bekukanBaris ?? 0;
  if (beku > 0) {
    bagian.push(
      '<sheetViews><sheetView workbookViewId="0">' +
        `<pane ySplit="${beku}" topLeftCell="A${beku + 1}" activePane="bottomLeft" state="frozen"/>` +
        "</sheetView></sheetViews>",
    );
  }

  const kolom = lembar.kolom ?? [];
  if (kolom.length > 0) {
    const isi = kolom
      .map((k, i) => `<col min="${i + 1}" max="${i + 1}" width="${k.lebar}" customWidth="1"/>`)
      .join("");
    bagian.push(`<cols>${isi}</cols>`);
  }

  bagian.push("<sheetData>");
  baris.forEach((sel, i) => {
    if (sel.length > MAKS_KOLOM_TULIS) {
      throw new Error(`Lembar "${lembar.nama}" punya ${sel.length} kolom, melebihi batas Excel.`);
    }
    const r = i + 1;
    const isi = sel.map((s, j) => selXml(`${hurufKolom(j + 1)}${r}`, s)).join("");
    bagian.push(isi.length === 0 ? `<row r="${r}"/>` : `<row r="${r}">${isi}</row>`);
  });
  bagian.push("</sheetData></worksheet>");
  return bagian.join("");
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

/**
 * Column widths from the content, so a money column does not arrive as
 * `#######`. Measured on the DISPLAYED text (a formatted rupiah is wider than
 * its decimal string because of the thousands separators) and clamped, because
 * one 4000-character `keterangan` must not make a column nobody can scroll
 * past.
 */
export function lebarOtomatis(baris: readonly Sel[][], maks = 60, min = 8): KolomLembar[] {
  const lebar: number[] = [];
  for (const r of baris) {
    r.forEach((sel, j) => {
      let n = 0;
      if (sel.jenis === "teks") n = (sel.teks ?? "").length;
      else if (sel.jenis === "tanggal") n = 10;
      else if (sel.jenis === "kosong") n = 0;
      else {
        const d = sel.desimal ?? "";
        // One separator per three integer digits, plus the `%` on a percent.
        const utuh = d.replace("-", "").split(".")[0] ?? "";
        n = d.length + Math.max(0, Math.floor((utuh.length - 1) / 3)) + (sel.jenis === "persen" ? 1 : 0);
      }
      lebar[j] = Math.max(lebar[j] ?? 0, n);
    });
  }
  return lebar.map((n) => ({ lebar: Math.min(maks, Math.max(min, n + 2)) }));
}

const RELS_ROOT =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

/**
 * Builds the .xlsx.
 *
 * Deliberately buffered rather than streamed: everything this writes is a
 * report that already fits in memory as JSON, the ZIP central directory needs
 * every entry's size anyway, and a streaming writer would trade a bound we
 * have (`MAKS_BARIS_TULIS`, plus each report's own row cap) for one we would
 * have to invent.
 */
export function tulisXlsx(lembar: readonly Lembar[]): Uint8Array {
  if (lembar.length === 0) throw new Error("Sebuah workbook harus punya minimal satu lembar.");

  const dipakai = new Set<string>();
  const nama = lembar.map((l) => namaLembarAman(l.nama, dipakai));
  const enc = new TextEncoder();

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    lembar
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    "</Types>";

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    nama
      .map((n, i) => `<sheet name="${loloskanXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    "</sheets></workbook>";

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    lembar
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${lembar.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    "</Relationships>";

  const berkas: BerkasZip[] = [
    { nama: "[Content_Types].xml", isi: enc.encode(contentTypes) },
    { nama: "_rels/.rels", isi: enc.encode(RELS_ROOT) },
    { nama: "xl/workbook.xml", isi: enc.encode(workbook) },
    { nama: "xl/_rels/workbook.xml.rels", isi: enc.encode(workbookRels) },
    { nama: "xl/styles.xml", isi: enc.encode(STYLES_XML) },
    ...lembar.map((l, i) => ({
      nama: `xl/worksheets/sheet${i + 1}.xml`,
      isi: enc.encode(lembarXml(l)),
    })),
  ];
  return tulisZip(berkas);
}
