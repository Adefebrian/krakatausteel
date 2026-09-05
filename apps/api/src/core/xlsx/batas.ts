// EVERY CAP THAT BOUNDS AN UNTRUSTED .xlsx, IN ONE FILE, AS CONSTANTS.
//
// An .xlsx is a ZIP full of XML. Accepting one from a browser upload means
// accepting an attacker-controlled archive and then handing its contents to a
// parser, which is a different threat model from accepting CSV text, and the
// difference is not theoretical:
//
//   A ZIP BOMB IS A SMALL UPLOAD. 512 KB of deflated zeroes expands to
//   gigabytes; the request passes every byte-size check the HTTP layer has,
//   and the process dies allocating. The only honest defence is a cap on the
//   DECOMPRESSED size, enforced by the decompressor itself and never derived
//   from the archive's own headers -- a central directory can claim any
//   `uncompressed size` it likes, and a reader that trusts that field has
//   built a check the attacker fills in.
//
//   AN XML PARSER RESOLVES ENTITIES UNLESS TOLD NOT TO. `<!DOCTYPE x [<!ENTITY
//   e SYSTEM "file:///etc/passwd">]>` inside `xl/worksheets/sheet1.xml` reads a
//   server file into a cell; `<!ENTITY lol "lolol...">` nested ten deep is a
//   billion laughs. ./xml.ts answers both by REFUSING any document that
//   declares anything at all: there is no resolver in this codebase to
//   configure, because there is no DTD support to begin with.
//
// WHY THE NUMBERS ARE WHAT THEY ARE. The input cap is deliberately the same
// order as modules/impor's existing text cap: the import body is JSON with the
// file in it and the global body cap is 1 MB (core/hardening.ts), so a base64
// payload of a 512 KB workbook (~683 KB) is the largest thing that can arrive
// at all. Everything downstream is then bounded as a MULTIPLE of that, so the
// worst case a single request can cost is arithmetic rather than a guess:
// at most `MAKS_TOTAL_DEKOMPRESI_BYTE` of memory, from at most
// `MAKS_ENTRI` entries, from at most `MAKS_BERKAS_BYTE` of upload.
//
// Every one of these is proved by a CRAFTED archive in
// apps/api/src/core/xlsx/xlsx-batas.test.ts, not by a happy-path assertion:
// a cap nobody has seen fire is a comment.

/** The .xlsx itself, in bytes, before anything is decompressed. */
export const MAKS_BERKAS_BYTE = 512 * 1024;

/**
 * ZIP entries. A real workbook has about ten
 * (`[Content_Types].xml`, two rels, workbook, styles, sharedStrings, and a
 * sheet or three). Sixty-four leaves generous room for a many-sheet template
 * and still refuses an archive whose only purpose is entry count.
 */
export const MAKS_ENTRI = 64;

/** Total bytes produced by decompressing everything this reader touches. */
export const MAKS_TOTAL_DEKOMPRESI_BYTE = 24 * 1024 * 1024;

/**
 * Bytes produced by decompressing ONE entry. Lower than the total on purpose:
 * a single `sheet1.xml` that inflates past this is not a spreadsheet anyone
 * typed, and catching it per entry means the total cap is never the first
 * thing to fire on a one-entry bomb.
 */
export const MAKS_ENTRI_DEKOMPRESI_BYTE = 12 * 1024 * 1024;

/** Characters in a ZIP entry name. Also bounds what a refusal message quotes. */
export const MAKS_PANJANG_NAMA_ENTRI = 200;

/** Rows read from a worksheet, header included. */
export const MAKS_BARIS = 20_000;

/** Columns read from a worksheet. Excel's own limit is 16384; this is a sheet
 *  an operator filled in, not a generated matrix. */
export const MAKS_KOLOM = 256;

/** Characters in one cell. Excel's own limit is 32767. */
export const MAKS_KARAKTER_SEL = 32_767;

/** Entries in `sharedStrings.xml`. Bounds the string table a sheet can point
 *  into, independently of the sheet's own row and column caps. */
export const MAKS_SHARED_STRING = 200_000;

/**
 * Why every cap has its own code: an operator who uploaded a 3 MB file and an
 * attacker who uploaded a bomb must not get the same sentence, because the
 * first one needs to know what to do next.
 */
export const KODE_XLSX = {
  BUKAN_ZIP: "BUKAN_ZIP",
  BERKAS_TERLALU_BESAR: "BERKAS_TERLALU_BESAR",
  TERLALU_BANYAK_ENTRI: "TERLALU_BANYAK_ENTRI",
  ENTRI_TERLALU_BESAR: "ENTRI_TERLALU_BESAR",
  TOTAL_DEKOMPRESI_TERLALU_BESAR: "TOTAL_DEKOMPRESI_TERLALU_BESAR",
  NAMA_ENTRI_TIDAK_AMAN: "NAMA_ENTRI_TIDAK_AMAN",
  KOMPRESI_TIDAK_DIDUKUNG: "KOMPRESI_TIDAK_DIDUKUNG",
  ZIP_TERENKRIPSI: "ZIP_TERENKRIPSI",
  ZIP64_TIDAK_DIDUKUNG: "ZIP64_TIDAK_DIDUKUNG",
  ZIP_RUSAK: "ZIP_RUSAK",
  /** A DTD, an entity declaration or a processing instruction we do not read. */
  XML_DEKLARASI_DILARANG: "XML_DEKLARASI_DILARANG",
  XML_ENTITAS_TIDAK_DIKENAL: "XML_ENTITAS_TIDAK_DIKENAL",
  XML_RUSAK: "XML_RUSAK",
  BUKAN_XLSX: "BUKAN_XLSX",
  TERLALU_BANYAK_BARIS: "TERLALU_BANYAK_BARIS",
  TERLALU_BANYAK_KOLOM: "TERLALU_BANYAK_KOLOM",
  SEL_TERLALU_PANJANG: "SEL_TERLALU_PANJANG",
  TERLALU_BANYAK_SHARED_STRING: "TERLALU_BANYAK_SHARED_STRING",
} as const;

export type KodeXlsx = (typeof KODE_XLSX)[keyof typeof KODE_XLSX];

/**
 * NOT named `*Error`, deliberately, and for the reason
 * modules/impor/csv.ts's `KesalahanCsv` gives: core/http.ts recognises a
 * domain error by an ALLOWLIST of class names and
 * modules/closing/closing-rute-kesalahan.test.ts sweeps every
 * `export class *Error extends Error` under apps/api/src/modules to make sure
 * each one is on it. This one carries no HTTP meaning of its own -- a bad
 * upload is the IMPORT module's refusal to report, in the import module's own
 * vocabulary -- so the single call site translates it and this class never
 * reaches the error handler.
 */
export class KesalahanXlsx extends Error {
  readonly kode: KodeXlsx;
  readonly batas?: number | undefined;

  constructor(kode: KodeXlsx, message: string, batas?: number) {
    super(message);
    this.name = "KesalahanXlsx";
    this.kode = kode;
    this.batas = batas;
  }
}
