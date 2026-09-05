// Spec 10's "ekspor ke Excel dan PDF", for all thirty reports this module
// answers.
//
// ---------------------------------------------------------------------------
// AN EXPORT IS A READ, AND IT IS THE SAME READ
// ---------------------------------------------------------------------------
// There is no export query, no export mode and no second code path to any
// figure. `hasilUntukEkspor` in ./routes.ts calls the IDENTICAL engine method
// with the IDENTICAL filter the screen's own route calls, and everything below
// only reshapes what comes back. Three consequences, and all three are the
// point:
//
//   BRANCH SCOPE. The engine compares the requested branch against the
//   session's and REFUSES one outside it (spec 16 scenario 24). An export
//   inherits that unchanged, because it never gets to see the decision.
//
//   FROZEN VERSUS LIVE. A CLOSED period is read from the frozen
//   `saldo_akun_periode`, an OPEN one from `v_ledger_baris`; the engine picks
//   from the period's own status and reports which in `header.sumberData`. An
//   export that recomputed a closed month from today's ledger would hand
//   somebody a signed-looking PDF that disagrees with the statements, and it
//   would be undetectable from the page. There is nothing here that could:
//   the parameter does not exist on either route.
//
//   REFUSALS. `LaporanError` travels out of here untouched, so an export of a
//   report that refuses to print (`LAPORAN_TIDAK_BALANCE`,
//   `SALDO_PERIODE_BELUM_DIBEKUKAN`) refuses with the same code and the same
//   DITOLAK audit row, instead of producing a workbook of a statement the
//   system will not show on screen.
//
// ---------------------------------------------------------------------------
// THREE FORMATS, AND WHY THE HTML ONE IS NOT A LEFTOVER
// ---------------------------------------------------------------------------
//   xlsx  a real workbook: one sheet per table, column widths, number formats,
//         money as exact decimal, every text cell inert. core/xlsx.
//   html  the print-ready document, self-contained, no script and no external
//         reference. The operator prints it to PDF from their own browser.
//   pdf   the same html rendered server side. Needs a browser binary on the
//         host; where there is none it is a 503 that says to use `html`.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------------
// It does not write an audit row. modules/laporan has no audit port and no
// journal port AT ALL -- ./index.ts calls that structural rather than
// disciplined, and spec 16 scenario 23 rests on it -- so recording "who
// exported what" would mean giving a read-only module its first write
// capability. That is a decision for the repository owner, not a convenience
// this pass takes; it is reported as a gap. Refusals are still recorded, by
// core/http.ts, because those go through the error handler.
import { dokumenDariLaporan, lembarDariDokumen } from "../../core/ekspor/dokumen";
import { htmlDariDokumen } from "../../core/ekspor/html";
import { tulisXlsx } from "../../core/xlsx/tulis";
import { KesalahanPdf, type PdfPort } from "../../core/ports/pdf";
import { KODE_LAPORAN, LaporanError } from "./contract";

export const FORMAT_EKSPOR = ["xlsx", "html", "pdf"] as const;
export type FormatEkspor = (typeof FORMAT_EKSPOR)[number];

export const TIPE_KONTEN: Readonly<Record<FormatEkspor, string>> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html; charset=utf-8",
  pdf: "application/pdf",
};

/**
 * A `filename` a header can carry.
 *
 * HEADER INJECTION IS THE RISK HERE, not aesthetics. `namaLaporan` and
 * `namaCabang` come from the database and a branch called
 * `Jakarta"\r\nSet-Cookie: x=y` would otherwise split the response. So this is
 * an ALLOWLIST -- letters, digits, space, dot, hyphen, underscore -- and
 * everything else becomes a hyphen. There is no escaping scheme here to get
 * subtly wrong.
 */
export function namaBerkasEkspor(
  namaLaporan: string,
  periodeLabel: string,
  namaCabang: string,
  format: FormatEkspor,
): string {
  const bersih = (s: string): string =>
    s
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9 ._-]/g, "-")
      .replace(/[\s-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  const bagian = [bersih(namaLaporan), bersih(periodeLabel), bersih(namaCabang)].filter(
    (s) => s.length > 0,
  );
  return `${bagian.join("_") || "Laporan"}.${format}`;
}

export interface BerkasEkspor {
  isi: Uint8Array | string;
  tipeKonten: string;
  namaFile: string;
}

export interface EksporDeps {
  /** Absent means this deployment has no server-side PDF at all. */
  pdf?: PdfPort | null;
}

/**
 * Turns one report result into one downloadable file.
 *
 * `namaTabelUtama` names the sheet holding the report's main array, and it is
 * the report's own name from `NAMA_LAPORAN` / `NAMA_LAPORAN_OPERASIONAL` so
 * the workbook, the header and the screen cannot drift apart.
 */
export async function berkasEkspor(
  hasil: unknown,
  namaTabelUtama: string,
  format: FormatEkspor,
  deps: EksporDeps = {},
): Promise<BerkasEkspor> {
  const dok = dokumenDariLaporan(hasil, namaTabelUtama);
  const namaFile = namaBerkasEkspor(
    dok.header.namaLaporan,
    dok.header.periodeLabel,
    dok.header.namaCabang,
    format,
  );

  if (format === "xlsx") {
    return {
      isi: tulisXlsx(lembarDariDokumen(dok)),
      tipeKonten: TIPE_KONTEN.xlsx,
      namaFile,
    };
  }

  const html = htmlDariDokumen(dok);
  if (format === "html") {
    return { isi: html, tipeKonten: TIPE_KONTEN.html, namaFile };
  }

  const pdf = deps.pdf;
  if (!pdf || !pdf.tersedia()) {
    throw new LaporanError(
      KODE_LAPORAN.EKSPOR_PDF_TIDAK_TERSEDIA,
      "Server ini belum dipasangi browser untuk mencetak PDF. Gunakan ekspor HTML " +
        "lalu cetak ke PDF dari browser Anda, atau ekspor Excel.",
    );
  }
  try {
    return { isi: await pdf.dariHtml(html), tipeKonten: TIPE_KONTEN.pdf, namaFile };
  } catch (err) {
    if (err instanceof KesalahanPdf) {
      // Translated at the ONE call site, exactly as modules/impor translates
      // `KesalahanCsv`: an infrastructure failure has no HTTP meaning of its
      // own, and letting it reach the handler unnamed is the anonymous 500
      // this repo has shipped four times.
      throw new LaporanError(
        err.sebab === "TIDAK_TERSEDIA"
          ? KODE_LAPORAN.EKSPOR_PDF_TIDAK_TERSEDIA
          : KODE_LAPORAN.EKSPOR_PDF_GAGAL,
        err.message,
      );
    }
    throw err;
  }
}
