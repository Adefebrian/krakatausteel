// The .xlsx front end of the import, and nothing more than a front end.
//
// ./contract.ts used to say: "CSV, NOT XLSX, AND THAT IS A REPORTED GAP RATHER
// THAN A DESIGN CHOICE ... an xlsx front end is a parser swapped in front of
// `parseCsv` and nothing else." This is that parser, and it is exactly that:
// the workbook becomes the SAME matrix a CSV parse produces and goes through
// `dariMatriks`, so the column contract, the header check, the blank-row rule,
// the ragged-row rejection and every per-field validation downstream are
// literally the same code. There is no second definition of a valid file.
//
// ---------------------------------------------------------------------------
// THE PART THAT IS NOT A CONVENIENCE
// ---------------------------------------------------------------------------
// Accepting a CSV is accepting text. Accepting an .xlsx is accepting an
// ATTACKER-CONTROLLED ZIP FULL OF ATTACKER-CONTROLLED XML from anyone holding
// `tools.import`, and the threat model is different in kind:
//
//   a 50 KB upload that decompresses to gigabytes and kills the process;
//   `<!ENTITY xxe SYSTEM "file:///etc/passwd">` inside a cell;
//   ten nested entity declarations that expand without any network at all;
//   an entry named `../../etc/passwd`;
//   a password-protected sheet that would otherwise import as empty.
//
// Every one of those is refused by core/xlsx, whose caps are declared in
// core/xlsx/batas.ts and fired by CRAFTED archives in
// core/xlsx/xlsx-batas.test.ts. This file's job is to APPLY those caps at this
// module's own numbers and to translate the refusal into this module's
// vocabulary, so an operator gets a sentence about their spreadsheet rather
// than one about ZIP central directories.
//
// ---------------------------------------------------------------------------
// LINE NUMBERS ARE THE SPREADSHEET'S OWN
// ---------------------------------------------------------------------------
// A rejection says "baris 14", and row 14 in the operator's Excel window is
// the row they must fix. The reader returns rows in sheet order and this
// numbers them 1-based INCLUDING the header, matching the CSV path exactly.
// Excel's own row numbers are not carried through: a sheet with a gap at row 7
// would otherwise report a row number that does not match the position in the
// list, and the list is what the preview shows.
import { bacaTabelXlsx, type BatasBaca } from "../../core/xlsx/baca";
import { BATAS_BACA_BAWAAN } from "../../core/xlsx/baca";
import { KesalahanXlsx } from "../../core/xlsx/batas";
import { dariMatriks, type HasilCsv } from "./csv";
import { MAKS_BARIS, MAKS_ISI_BYTE } from "./contract";

/**
 * This module's own caps, tighter than core's defaults where this module has a
 * reason to be tighter.
 *
 * The file cap is `MAKS_ISI_BYTE`, the SAME 512 KB the CSV path uses, so the
 * two upload paths cannot disagree about how big a file is allowed to be. The
 * row cap is `MAKS_BARIS` + 1 for the header, so "too many rows" fires here
 * with this module's number rather than at core's much larger one.
 */
export const BATAS_IMPOR_XLSX: BatasBaca = {
  ...BATAS_BACA_BAWAAN,
  maksBerkasByte: MAKS_ISI_BYTE,
  maksBaris: MAKS_BARIS + 1,
  // A spreadsheet an operator filled in has the columns of the contract plus a
  // few strays, not sixty-four. Narrowing it here bounds the matrix before
  // `dariMatriks` builds one object per row.
  maksKolom: 64,
  // The longest legitimate value in either column contract is an address.
  maksKarakterSel: 4_000,
};

export { KesalahanXlsx };

/**
 * Base64 -> bytes, WITH THE SIZE CHECKED ON THE DECODED LENGTH.
 *
 * The transport is JSON (see ./routes.ts: the body carries the file, not a
 * multipart stream), so an .xlsx arrives base64 encoded and is 4/3 of its real
 * size on the wire. Checking the STRING length would let a 683 KB body through
 * as a 512 KB file, which is the wrong side of the cap; checking after
 * decoding is what makes `MAKS_ISI_BYTE` mean what it says.
 */
export function dariBase64(b64: string): Uint8Array {
  // `atob` throws on anything that is not base64, which is the right answer:
  // the caller reports it as a bad upload rather than guessing.
  const biner = atob(b64);
  const keluar = new Uint8Array(biner.length);
  for (let i = 0; i < biner.length; i += 1) keluar[i] = biner.charCodeAt(i);
  return keluar;
}

/**
 * The first worksheet of an uploaded workbook, in `parseCsv`'s own shape.
 *
 * Throws `KesalahanXlsx` -- never an `ImporError` -- for the reason
 * `KesalahanCsv` does: this is a parse failure with no HTTP meaning of its
 * own, and the single call site in ./service.ts translates it.
 */
export function parseXlsx(data: Uint8Array, batas: BatasBaca = BATAS_IMPOR_XLSX): HasilCsv {
  const tabel = bacaTabelXlsx(data, batas);
  if (tabel.baris.length === 0) return dariMatriks([]);

  // THE HEADER DECIDES THE WIDTH, and rows are squared to it. A spreadsheet is
  // not a CSV: a row does not have "too few cells", it has EMPTY ones, and a
  // file whose two optional trailing columns are blank on row 12 must not be
  // rejected as ragged. So a short row is PADDED.
  //
  // A row with content BEYOND the header width is still ragged and still
  // refused with its line number, which is the case that matters: a value in
  // an unnamed column is a value nobody will import and nobody will notice.
  const lebarHeader = panjangTerpakai(tabel.baris[0]!);
  const mentah = tabel.baris.map((sel, i) => {
    const terpakai = panjangTerpakai(sel);
    const lebar = terpakai > lebarHeader ? terpakai : lebarHeader;
    const baris = sel.slice(0, lebar).map((v) => v ?? "");
    while (baris.length < lebar) baris.push("");
    return { nomorBaris: i + 1, sel: baris };
  });
  return dariMatriks(mentah);
}

/** Index just past the last cell with anything in it. */
function panjangTerpakai(sel: readonly string[]): number {
  let akhir = sel.length;
  while (akhir > 0 && (sel[akhir - 1] ?? "").trim() === "") akhir -= 1;
  return akhir;
}
