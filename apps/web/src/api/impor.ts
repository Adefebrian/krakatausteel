// Typed client for the bulk import surface, spec 9.6's writing half.
//
// TWO CALLS PER FILE, AND THE SPLIT IS THE PRODUCT. Spec 9.6: "preview hasil
// parsing, validasi per baris, tampilkan baris yang error dengan alasan, baru
// commit yang valid ... Jangan pernah commit sebagian tanpa laporan eksplisit
// ke user."
//
//   pratinjau  parses and validates and WRITES NOTHING. 200 even when rows are
//              rejected: the rejection report IS the successful result of a
//              preview, and it is what an operator fixes the spreadsheet from.
//   komit      all or nothing. If any row is bad, NOTHING is written and the
//              answer is a 400 carrying the same report.
//
// THAT 400 IS THE ONE ENDPOINT SHAPE IN THIS PRODUCT WHOSE REFUSAL IS DATA.
// `core/http.ts` deliberately keeps a domain error's `detail` out of the
// response body, so modules/impor answers the rejection list as an ordinary
// field (`laporan`) on the error envelope instead of throwing it. A client that
// only reads `message` would show "ada baris yang ditolak" and lose every line
// number, which is precisely the report the operator came for. `komit` below
// therefore returns a RESULT rather than throwing on that one code, and keeps
// throwing on every other refusal (a file already imported, a branch out of
// scope, an unreadable header), which are errors and not reports.
//
// LINE NUMBERS COUNT THE HEADER ROW. `nomorBaris` is the row number in the
// spreadsheet as the operator sees it in Excel, header included, so row 2 in
// the report is row 2 on their screen. Nothing in this file renumbers them.
import type {
  BarisDitolak,
  BarisDiterima,
  FormatImpor,
  HasilKomit,
  HasilPratinjau,
  JenisImpor,
  RingkasanSaldoAwal,
} from "@krakatausteel/api/src/modules/impor/contract";
import { ApiRequestError, apiPost, kodeDomain } from "./http";

export type {
  BarisDiterima,
  BarisDitolak,
  FormatImpor,
  HasilKomit,
  HasilPratinjau,
  JenisImpor,
  RingkasanSaldoAwal,
};

/** The module's own text cap, restated so the page can refuse before uploading. */
export const MAKS_ISI_BYTE = 512 * 1024;
/** The module's row ceiling per file. */
export const MAKS_BARIS_IMPOR = 2000;

/**
 * The domain codes a screen branches on. Everything else is shown as the
 * server's own sentence: this list is only the refusals that need DIFFERENT
 * WORDS on the page than the API's, and every one of them is here because the
 * generic sentence would send an operator looking in the wrong place.
 */
export const KODE_ADA_BARIS_DITOLAK = "ADA_BARIS_DITOLAK";
export const KODE_SALDO_AWAL_SUDAH_DIPOSTING = "SALDO_AWAL_SUDAH_DIPOSTING";
export const KODE_BERKAS_SUDAH_DIIMPOR = "BERKAS_SUDAH_DIIMPOR";

export interface PermintaanImporWeb {
  jenis: JenisImpor;
  namaFile: string;
  /** CSV text, or the base64 of an .xlsx. */
  isi: string;
  format: FormatImpor;
  cabangId?: string | null;
  /** SALDO_AWAL only: the cut-off date, which is a statement ABOUT the file. */
  saldoAwal?: { tanggalEfektif: string; keterangan: string | null } | null;
}

function badan(input: PermintaanImporWeb): Record<string, unknown> {
  return {
    namaFile: input.namaFile,
    isi: input.isi,
    format: input.format,
    ...(input.cabangId ? { cabangId: input.cabangId } : {}),
    ...(input.jenis === "SALDO_AWAL" && input.saldoAwal ? { saldoAwal: input.saldoAwal } : {}),
  };
}

/** Parses and validates. Writes nothing, not even the file record. */
export function pratinjauImpor(input: PermintaanImporWeb): Promise<HasilPratinjau> {
  return apiPost(`/impor/${encodeURIComponent(input.jenis)}/pratinjau`, badan(input));
}

/**
 * All or nothing. Two outcomes a caller must render differently, and neither
 * of them is a thrown error:
 *
 *   `{ ok: true }`   the whole file was written, in one transaction.
 *   `{ ok: false }`  at least one row was refused, so NOTHING was written, and
 *                    `laporan` is the same report `pratinjauImpor` answers.
 *
 * Every other refusal still throws, with the server's own sentence.
 */
export async function komitImpor(
  input: PermintaanImporWeb,
): Promise<{ ok: true; hasil: HasilKomit } | { ok: false; laporan: HasilPratinjau }> {
  try {
    const hasil = await apiPost<HasilKomit>(
      `/impor/${encodeURIComponent(input.jenis)}/komit`,
      badan(input),
    );
    return { ok: true, hasil };
  } catch (cause: unknown) {
    if (cause instanceof ApiRequestError && kodeDomain(cause) === KODE_ADA_BARIS_DITOLAK) {
      const laporan = (cause.body as { laporan?: HasilPratinjau } | null)?.laporan;
      // A report that did not arrive is NOT turned into an empty one: an empty
      // rejection list would read as "nothing was wrong", on the response that
      // exists to say something was. Rethrow, and the page shows the refusal.
      if (laporan) return { ok: false, laporan };
    }
    throw cause;
  }
}

/**
 * Reads a picked file into what the endpoint takes.
 *
 * `.xlsx` goes as base64 and everything else as text, because that is the
 * split `format` names and because an .xlsx read as text is a corrupted ZIP,
 * which the server would refuse with a message about the file rather than
 * about how it was sent.
 */
export async function bacaBerkas(file: File): Promise<{ isi: string; format: FormatImpor }> {
  const xlsx = /\.xlsx$/i.test(file.name);
  if (!xlsx) return { isi: await file.text(), format: "CSV" };
  const buffer = new Uint8Array(await file.arrayBuffer());
  let biner = "";
  // Chunked, because String.fromCharCode(...array) on a 512 KB file spreads
  // half a million arguments onto the stack and throws in every browser.
  const potong = 8192;
  for (let i = 0; i < buffer.length; i += potong) {
    biner += String.fromCharCode(...buffer.subarray(i, i + potong));
  }
  return { isi: btoa(biner), format: "XLSX" };
}
