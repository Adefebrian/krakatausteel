// apps/api/src/modules/laporan/contract.ts
//
// TYPE CONTRACT FOR THE CORE ACCOUNTING REPORTS (spec 10.3 reports 16, 17, 18,
// 19, 20, 22, 23). Written BEFORE the implementation: the tests in this folder
// are the specification and this file is the shape they were written against.
// ./service.ts throws from every method today. Nothing here may be widened or
// renamed to make an implementation fit more easily.
//
// SCOPE OF THIS PASS. Only the seven CORE accounting reports. Rekap Jurnal
// (21), RKA versus Realisasi (24), the eleven PUMK reports, the four Non PUMK
// reports and everything in 10.4 are a later pass, as are the Excel and PDF
// exports spec 10 requires of every report. Nothing here forecloses them: the
// header shape below is the one spec 10's preamble demands of all 31.
//
// ---------------------------------------------------------------------------
// THE THREE THINGS THIS MODULE MUST NOT GET WRONG
// ---------------------------------------------------------------------------
// 1. TOTAL ASET = TOTAL LIABILITAS + ASET NETO (spec 10.3 report 19, spec 16
//    scenario 14). The specification asks for this test by name. It is NOT
//    satisfied by summing the ASET_NETO accounts: this system posts no
//    year-end closing entry, so the surplus of every period since inception
//    still sits in PENDAPATAN and BEBAN. `totalAsetNeto` is therefore
//    ASET_NETO account balances PLUS cumulative (PENDAPATAN - BEBAN) up to the
//    cut-off. Any other definition breaks the identity the moment a single
//    revenue journal exists. See `LaporanPosisiKeuangan.totalAsetNeto`.
//
// 2. KAS AKHIR = SALDO AKUN is_kas DI POSISI KEUANGAN (report 18, scenario
//    15). Also asked for by name. Both reports must land on the same number
//    for the same period and the same branch scope, which is only true if the
//    cash-flow statement is derived from movements ON the `is_kas` accounts
//    rather than assembled from a list of captions.
//
// 3. NERACA LAJUR BALANCES IN ALL THREE COLUMN PAIRS (report 23, scenario 16).
//    Saldo Awal D = K, Mutasi D = K, Saldo Akhir D = K.
//
// All three hold trivially on an empty ledger, which is why every test that
// asserts them first asserts the totals are NON-ZERO. A report that returns
// nothing must fail those tests, not pass them.
//
// ---------------------------------------------------------------------------
// WHERE THE NUMBERS COME FROM: TWO PATHS, ONE ANSWER
// ---------------------------------------------------------------------------
// Spec 10 "Aturan teknis laporan", verbatim:
//   - "Laporan untuk periode CLOSED dibaca dari `saldo_akun_periode` dan
//      `kolektibilitas_snapshot`, bukan dihitung ulang."
//   - "Laporan untuk periode OPEN dihitung realtime dari ledger."
// That is invariant 14 (reproducibility) made operational, so every result
// here carries `sumberData` saying which path produced it, and a report may
// not choose. A CLOSED period whose `saldo_akun_periode` rows are missing is a
// REFUSAL (`SALDO_PERIODE_BELUM_DIBEKUKAN`), never a silent fall back to a
// live recomputation: a silent recomputation is exactly the thing invariant 14
// forbids, and it would be invisible.
//
// The two paths must AGREE at the moment a period closes. That agreement is
// what makes a frozen period trustworthy, and ./laporan-sumber-periode.test.ts
// asserts it directly: run every report on the OPEN period, freeze, close,
// run them again, compare field by field.
//
// ---------------------------------------------------------------------------
// ADR 0010: `v_ledger_baris`, NEVER `status = 'POSTED'` ALONE
// ---------------------------------------------------------------------------
// A live computation reads `v_ledger_baris`, whose predicate is
// `status IN ('POSTED','REVERSED')`. A reversal ADDS two lines and REMOVES
// none; marking the original REVERSED drops its lines out of a POSTED-only sum
// while the reversing journal keeps subtracting, so the correction is counted
// twice.
//
// THE ERROR IS INVISIBLE TO EVERY BALANCE CHECK IN THIS FILE. Both journals
// balance, so a POSTED-only Neraca Lajur STILL balances in all three pairs, a
// POSTED-only Posisi Keuangan STILL satisfies Aset = Liabilitas + Aset Neto,
// and a POSTED-only Arus Kas STILL ties to the balance sheet. Only an
// account-level comparison against the ledger predicate catches it, which is
// why ./laporan-sumber-periode.test.ts proves the two readings DIFFER before
// asserting which one the report used, and additionally asserts that the naive
// trial balance balances too.
//
// ---------------------------------------------------------------------------
// LAYOUT IS DATA, NOT CODE
// ---------------------------------------------------------------------------
// Spec 4.2: "Buat tabel referensi `baris_laporan` agar format laporan bisa
// diubah tanpa deploy", and `akun.klasifikasi_akun` is a real composite FK
// into the classification vocabulary that reaches those lines through
// `pemetaan_baris_laporan` (migrations/0005, split by 0028). Laporan Aktivitas
// and Laporan Posisi Keuangan
// therefore take their LINE STRUCTURE from `baris_laporan` rows, in `urutan`
// order, with `tanda` deciding contra presentation and `aktif` deciding
// whether a line prints at all. There is no list of captions in the
// implementation, and no `if (kode === 'ASET')`.
//
// This is the same mechanic as `event_jurnal_mapping` (ADR 0004), and it is
// what makes the PSAK 45 versus ISAK 335 question answerable later without a
// rewrite. docs/REGULASI.md finding 1 records that the specification's
// "Aset Neto Tidak Terikat / Terikat Temporer" wording was superseded by
// ISAK 335 ("tanpa pembatasan" / "dengan pembatasan"), and
// docs/BUILD-PLAN.md requires two templates to live side by side.
//
// NO TEST IN THIS FOLDER ASSERTS THAT EITHER READING IS CORRECT. Every test
// asserts the MECHANIC: edit a `baris_laporan` row and the report changes, add
// one and a line appears, deactivate one and it stops printing, repoint an
// account and its balance moves. Which captions are right is the client
// accounting team's decision (OPEN-QUESTIONS.md), and a report that reads its
// layout out of a table does not care what they decide.
//
// ---------------------------------------------------------------------------
// MONEY, AND WHY EVERY FIGURE IS RENDERED HERE RATHER THAN IN THE UI
// ---------------------------------------------------------------------------
// Spec 10: "Nilai nol ditampilkan sebagai `0,00` bukan kosong, karena tim
// akuntansi memakainya untuk cross check." That is a contract of the REPORT,
// not a styling preference of one screen: a blank cell in an exported
// spreadsheet and a blank cell on a page are the same defect, and the export
// and the screen must not each own their own answer. So every monetary cell in
// every result below is an `Angka`, carrying both the exact decimal and the
// string that gets printed, and `Angka.tampil` is never empty.
//
// `Uang` is a decimal string with exactly two fractional digits, the
// convention modules/jurnal fixed (invariant 7: never float, never double;
// NUMERIC(20,2) outruns Number.MAX_SAFE_INTEGER).
//
// At the SQL boundary remember driver fact: `coalesce(sum(x), 0)` returns the
// string '0', not '0.00'. Cast `::numeric(20,2)` BEFORE `::text` or the value
// fails `POLA_UANG` and every equality assertion against it.
import type { DbPort, QueryRunner } from "../../core/ports/db";
import { buatEngineLaporan } from "./service";

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Decimal string, exactly two fractional digits. Signed. */
export type Uang = string;

/** Matches a valid `Uang`, including the negative form. */
export const POLA_UANG = /^-?\d{1,18}\.\d{2}$/;

/** `YYYY-MM-DD`. */
export type TanggalIso = string;

export const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;

/** Mirrors the CHECK on `akun.tipe` (migrations/0005). */
export type TipeAkun = "ASET" | "LIABILITAS" | "ASET_NETO" | "PENDAPATAN" | "BEBAN";

/** Mirrors the CHECK on `akun.saldo_normal`. */
export type SaldoNormal = "D" | "K";

/** Mirrors the CHECK on `baris_laporan.laporan`. */
export type JenisLaporanBaris =
  | "POSISI_KEUANGAN"
  | "AKTIVITAS"
  | "ARUS_KAS"
  | "PERUBAHAN_ASET_NETO";

/** Mirrors the CHECK on `baris_laporan.tipe_baris`. */
export type TipeBaris = "HEADER" | "DETAIL" | "SUBTOTAL" | "TOTAL" | "FORMULA";

/** Mirrors the CHECK on `akun.klasifikasi_arus_kas`. */
export type KlasifikasiArusKas = "OPERASI" | "INVESTASI" | "PENDANAAN";

/** Mirrors the CHECK on `periode.status` (migrations/0007). */
export type StatusPeriode = "OPEN" | "CLOSING_IN_PROGRESS" | "CLOSED";

/**
 * WHICH OF THE TWO PATHS OF SPEC 10 PRODUCED THIS RESULT.
 *
 * Not decoration and not a debugging aid: it is the claim the report makes
 * about its own reproducibility, it is printed in the report header, and it is
 * the field ./laporan-sumber-periode.test.ts asserts on. A CLOSED period that
 * answers LEDGER_LIVE has recomputed history and broken invariant 14.
 */
export type SumberData = "LEDGER_LIVE" | "SNAPSHOT_PERIODE";

/**
 * WHICH TEMPLATE THE PRINTED LAYOUT CAME FROM, and how it was chosen.
 *
 * migrations/0028 made `template_laporan` EFFECTIVE DATED over the period being
 * reported on, so "which layout is in force for March 2026" has exactly one
 * answer and that answer can CHANGE. `periode.template_laporan_id`, written by
 * the closing engine at close, is what stops adopting a new template from
 * silently restating every statement already issued (ADR 0017, the failure it
 * names as having the widest blast radius).
 *
 *   TEMPLATE_PERIODE   the period carries a stamp and the report used it. The
 *                      reprint is the statement that was issued.
 *   TEMPLATE_BERLAKU   resolved by effective date. Correct and expected for an
 *                      OPEN period, which has no stamp by definition and must
 *                      not read one; it is a FALLBACK for a CLOSED period, one
 *                      closed before the column existed or closed when no
 *                      template was in force.
 *   TANPA_TEMPLATE     the report has no layout template at all. Buku Besar and
 *                      Neraca Lajur are per ACCOUNT, so no `baris_laporan` row
 *                      is involved and there is nothing to be reproducible
 *                      about; saying so is more honest than naming a template
 *                      the page did not use.
 *
 * CARRIED IN THE HEADER FOR THE SAME REASON `sumberData` IS. A NULL stamp is a
 * legitimate value rather than a refusal, so the fallback is a state a reader
 * will genuinely meet, and a fallback nobody can see is indistinguishable from
 * a reader that ignores the column. The two fields answer different questions
 * and are deliberately separate: `sumberData` is where the FIGURES came from,
 * this is where the LAYOUT came from.
 */
export type SumberTemplate = "TEMPLATE_PERIODE" | "TEMPLATE_BERLAKU" | "TANPA_TEMPLATE";

// ---------------------------------------------------------------------------
// The formatting contract (spec 10)
// ---------------------------------------------------------------------------

/** What a zero cell prints. Spec 10, verbatim, and never the empty string. */
export const NOL_TAMPIL = "0,00";

/**
 * Indonesian money formatting, fixed here so the screen, the Excel export and
 * the PDF export cannot each invent their own:
 *   - always exactly two fractional digits, decimal separator `,`;
 *   - thousands grouped with `.` (spec 10 "format angka ribuan");
 *   - negative values in parentheses, which is what an accountant reads as a
 *     credit-side or deducted figure, and which cannot be lost to a stray
 *     minus sign in a spreadsheet cell;
 *   - zero is exactly `0,00`, never blank, never `-`.
 *
 * Examples: `"1234567.89"` -> `"1.234.567,89"`, `"-18000000.00"` ->
 * `"(18.000.000,00)"`, `"0.00"` -> `"0,00"`.
 */
export const POLA_TAMPIL = /^\((?:\d{1,3}(?:\.\d{3})*),\d{2}\)$|^(?:\d{1,3}(?:\.\d{3})*),\d{2}$/;

/**
 * One monetary cell of a report.
 *
 * BOTH HALVES TRAVEL TOGETHER ON PURPOSE. `nilai` is what a caller compares,
 * sums and reconciles; `tampil` is what is printed, and it exists at this
 * boundary rather than in a UI helper because spec 10's zero rule is a
 * property of the report, and because the Excel export must not be a second
 * implementation of it. `tampil` must always be derivable from `nilai`, which
 * makes it round-trippable and therefore testable.
 */
export interface Angka {
  nilai: Uang;
  tampil: string;
}

// ---------------------------------------------------------------------------
// Permissions (spec 2, spec 16 scenario 23 and 24)
// ---------------------------------------------------------------------------

/**
 * The codes this engine checks, resolved against the SHIPPED catalogue in
 * modules/auth. A code ABSENT from that catalogue must make the operation FAIL
 * CLOSED with `IZIN_BELUM_TERDAFTAR` rather than be silently treated as
 * granted; that mechanism has already caught three real gaps in this repo
 * (`pumk.cluster`, `nonpumk.lpj.verifikasi`, `admin.closing.view`).
 *
 * `laporan.view` IS in the shipped catalogue and is granted to all six roles,
 * Auditor included, which is what spec 16 scenario 23 requires ("Login sebagai
 * Auditor, konfirmasi semua laporan terbuka"). ./laporan-otorisasi.test.ts
 * reads that grant out of the database via `permissionsForRole` rather than
 * restating it, so the day someone narrows the matrix the test says so.
 *
 * THERE IS DELIBERATELY NO SEPARATE READ CODE PER REPORT. Spec 2 gives one
 * reporting privilege, and inventing `laporan.posisi_keuangan.view` here would
 * be this module answering an authorisation question the specification already
 * answered.
 *
 * EXPORT IS NOT HERE. Spec 10 requires an Excel and a PDF button on every
 * report and the catalogue ships no `laporan.export`; that is a FINDING for
 * the export pass, not a code this module may invent while it has nothing to
 * export.
 */
export const PERMISSION_LAPORAN = {
  /** spec 2: every role's reporting privilege, Auditor included. */
  LIHAT: "laporan.view",
} as const;

export type PermissionLaporan = (typeof PERMISSION_LAPORAN)[keyof typeof PERMISSION_LAPORAN];

// ---------------------------------------------------------------------------
// Configuration this module READS. Never a hardcoded policy number.
// ---------------------------------------------------------------------------

/**
 * Resolved bumn-scoped first, then global (`bumn_id IS NULL`), the same
 * resolution every other engine here uses. In the SHIPPED catalogue
 * (modules/konfigurasi/katalog.ts); a MISSING row is still a refusal, because
 * "shipped" is a claim about the seed and an operator can soft-delete a row.
 */
export const KUNCI_KONFIGURASI_LAPORAN = {
  /**
   * spec 5.6. Decides where a financial year starts, and therefore the span of
   * Laporan Aktivitas (cumulative from the year's first day) and the cut-off
   * of the comparative column. NOT assumed to be January: a report that
   * hardcodes month 1 prints the wrong comparative for any client on a
   * non-calendar financial year and nothing detects it.
   */
  TAHUN_BUKU_MULAI_BULAN: { grup: "akuntansi", kunci: "tahun_buku_mulai_bulan" },
} as const;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const KODE_LAPORAN = {
  PERIODE_TIDAK_DITEMUKAN: "PERIODE_TIDAK_DITEMUKAN",
  CABANG_TIDAK_DITEMUKAN: "CABANG_TIDAK_DITEMUKAN",
  AKUN_TIDAK_DITEMUKAN: "AKUN_TIDAK_DITEMUKAN",
  /** Report 9 (Kartu Piutang) is the only report keyed on one partner. */
  MITRA_TIDAK_DITEMUKAN: "MITRA_TIDAK_DITEMUKAN",

  /**
   * Reports 8, 10, 11 and 28 are asked for a period whose Closing
   * Kolektibilitas (spec 8.1) has never run, so `kolektibilitas_snapshot`
   * carries no row for it.
   *
   * REFUSING IS THE POINT, and it is the same argument as
   * SALDO_PERIODE_BELUM_DIBEKUKAN one table over. Classification, days overdue
   * and the provision rate are produced by ONE run and recorded per akad with
   * the rate and the basis that produced them (ADR 0014). Recomputing them at
   * print time would be a second implementation of the provisioning engine, it
   * would disagree with the journal the period actually posted, and it would
   * make spec 16 scenario 17's reconciliation unfalsifiable. "Closing
   * Kolektibilitas belum dijalankan untuk periode ini" is a thing an operator
   * fixes in one click.
   *
   * A period whose portfolio is genuinely empty is NOT refused: with no akad
   * carrying an outstanding balance there is nothing to classify, and refusing
   * would make the first months of any go-live unreportable, exactly as it
   * would for the frozen trial balance.
   */
  SNAPSHOT_KOLEKTIBILITAS_BELUM_ADA: "SNAPSHOT_KOLEKTIBILITAS_BELUM_ADA",

  /**
   * The `baris_laporan` template for this statement has no active line. The
   * report REFUSES rather than falling back to a layout compiled into the
   * code, because a code fallback is precisely the thing spec 4.2's "tanpa
   * deploy" requirement exists to prevent, and because a statement printed
   * from a layout nobody configured is a statement nobody can correct.
   *
   * CHECKED BEFORE `AKUN_TIDAK_TERPETAKAN`. Deactivating a whole template
   * necessarily orphans every account on it, and "the template is empty" is
   * the diagnosis an operator can act on; a list of forty unmapped accounts is
   * not.
   */
  TEMPLATE_LAPORAN_KOSONG: "TEMPLATE_LAPORAN_KOSONG",

  /**
   * A `baris_laporan` row is unusable: a parent in a different statement, a
   * parent cycle, or a SUBTOTAL/TOTAL with no descendants. Refuse rather than
   * print a subtotal that sums nothing.
   */
  TEMPLATE_LAPORAN_TIDAK_VALID: "TEMPLATE_LAPORAN_TIDAK_VALID",

  /**
   * An account carrying a balance maps onto no ACTIVE line of the statement
   * being printed, so its balance would silently vanish and the statement
   * would not add up. `akun.klasifikasi_akun` is NOT NULL and is a real FK,
   * so this is reachable only by deactivating a line that accounts still point
   * at, which is exactly the operator mistake worth refusing on.
   */
  AKUN_TIDAK_TERPETAKAN: "AKUN_TIDAK_TERPETAKAN",

  /**
   * A cash movement's counter-account carries no `klasifikasi_arus_kas`, so
   * the direct-method statement cannot say whether it was operating,
   * investing or financing.
   *
   * REFUSING IS THE POINT. Dropping the movement into an "other" bucket, or
   * omitting it, breaks Kas Akhir, which is the one figure report 18 is
   * required to tie to the balance sheet. `detail` names the offending
   * accounts so the fix is a COA edit, not an investigation.
   */
  KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP: "KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP",

  /**
   * A net-asset movement cannot be attributed to a category: an AKTIVITAS
   * `baris_laporan` row whose `seksi` names no ASET_NETO line of the
   * POSISI_KEUANGAN template. See `LaporanPerubahanAsetNeto` for why `seksi`
   * is the only mapping the schema offers.
   */
  SEKSI_ASET_NETO_TIDAK_DIKENAL: "SEKSI_ASET_NETO_TIDAK_DIKENAL",

  /**
   * The period is CLOSED but `saldo_akun_periode` has no rows for it, so the
   * frozen figures spec 10 requires do not exist. Refuse; do NOT recompute
   * from the ledger. A silent recomputation is invariant 14's failure mode and
   * it would be undetectable from the output.
   *
   * PRECISELY: the period is CLOSED, it has no frozen rows, AND the ledger
   * carries at least one line dated on or before its end. The third clause
   * matters. A period that closed with an empty ledger legitimately freezes
   * nothing (modules/closing writes a row only where there is an opening
   * balance or a movement), and refusing on that would make the first months
   * of any go-live unreportable.
   */
  SALDO_PERIODE_BELUM_DIBEKUKAN: "SALDO_PERIODE_BELUM_DIBEKUKAN",

  /**
   * The statement does not add up: Total Aset != Total Liabilitas + Aset Neto,
   * or a Neraca Lajur column pair out of balance. A balance sheet that does
   * not balance is never printed, it is refused, with the discrepancy in
   * `detail`. Reachable when a frozen `saldo_akun_periode` was written
   * incorrectly, which is the case that survives every other check.
   */
  LAPORAN_TIDAK_BALANCE: "LAPORAN_TIDAK_BALANCE",

  KONFIGURASI_TIDAK_ADA: "KONFIGURASI_TIDAK_ADA",
  KONFIGURASI_TIDAK_VALID: "KONFIGURASI_TIDAK_VALID",

  TANGGAL_TIDAK_VALID: "TANGGAL_TIDAK_VALID",
  NILAI_BUKAN_DESIMAL: "NILAI_BUKAN_DESIMAL",

  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
  /** A permission this engine names is absent from the shipped catalogue. */
  IZIN_BELUM_TERDAFTAR: "IZIN_BELUM_TERDAFTAR",
} as const;

export type KodeLaporan = (typeof KODE_LAPORAN)[keyof typeof KODE_LAPORAN];

/**
 * The one error type this module throws across its boundary. Carries a stable
 * `kode` and Indonesian prose; `penyebabDb` is for the server log only and
 * never reaches a user.
 */
export class LaporanError extends Error {
  readonly kode: KodeLaporan;
  readonly detail?: unknown;
  readonly penyebabDb?: string;

  constructor(kode: KodeLaporan, pesan: string, opsi?: { detail?: unknown; penyebabDb?: string }) {
    super(pesan);
    this.name = "LaporanError";
    this.kode = kode;
    this.detail = opsi?.detail;
    this.penyebabDb = opsi?.penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// The report header spec 10's preamble requires of every report
// ---------------------------------------------------------------------------

/**
 * The printed titles, VERBATIM from the spec 10.3 catalogue, so the header, the
 * Excel sheet name and the PDF title cannot drift apart and so a test names a
 * report the way the contract does. Numbering is the specification's own.
 */
export const NAMA_LAPORAN = {
  /** 16 */ BAGAN_AKUN: "Bagan Akun",
  /** 17 */ AKTIVITAS: "Laporan Aktivitas",
  /** 18 */ ARUS_KAS: "Laporan Arus Kas",
  /** 19 */ POSISI_KEUANGAN: "Laporan Posisi Keuangan",
  /** 20 */ PERUBAHAN_ASET_NETO: "Laporan Perubahan Aset Neto",
  /** 22 */ BUKU_BESAR: "Buku Besar",
  /** 23 */ NERACA_LAJUR: "Neraca Lajur",
} as const;

/**
 * "header laporan yang berisi nama BUMN, nama laporan, periode, cabang,
 * tanggal cetak, dan nama pencetak" (spec 10, verbatim), plus the two fields
 * that make a printed page auditable years later: which of spec 10's two data
 * paths produced it, and what the period's status was at print time.
 */
export interface HeaderLaporan {
  namaBumn: string;
  namaLaporan: string;
  /** Human label, e.g. "Maret 2026" or "Januari - Maret 2026". */
  periodeLabel: string;
  periodeId: string | null;
  statusPeriode: StatusPeriode | null;
  /** Inclusive span the figures cover. Equal dates for a point-in-time report. */
  dariTanggal: TanggalIso | null;
  sampaiTanggal: TanggalIso | null;
  /** null = Semua Cabang (spec 10: the Admin Pusat option). */
  cabangId: string | null;
  namaCabang: string;
  /** From the injected clock, so a printed page is reproducible in a test. */
  tanggalCetak: TanggalIso;
  /** `app_user.nama` of `ctx.userId`, not the id: an accountant reads this. */
  dicetakOleh: string;
  sumberData: SumberData;
  /** The `template_laporan` the lines were read from. Null for a report that
   *  has no layout template (see `SumberTemplate.TANPA_TEMPLATE`). */
  templateLaporanId: string | null;
  sumberTemplate: SumberTemplate;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface FilterLaporan {
  periodeId: string;
  /**
   * null or absent = Semua Cabang. Requires cross-branch scope
   * (`ctx.cabangDalamScope`); spec 16 scenario 24 makes a branch user asking
   * for another branch a REFUSAL, not an empty result, "termasuk lewat
   * manipulasi ID di URL atau request API langsung".
   */
  cabangId?: string | null;
}

export interface FilterBukuBesar extends FilterLaporan {
  akunId: string;
}

export interface FilterBaganAkun {
  /** Default false: the tree shows inactive accounts with their status, which
   *  is the `status` column spec 10.3 report 16 asks for. */
  hanyaAktif?: boolean;
}

// ---------------------------------------------------------------------------
// 16. Bagan Akun
// ---------------------------------------------------------------------------

/**
 * spec 10.3 report 16: "Tree COA dengan kode, nama, tipe, saldo normal,
 * status".
 *
 * A FLAT LIST IN TREE ORDER, with `level` and `parentId`, rather than nested
 * children arrays. Both the screen and the Excel export print rows, the
 * indentation is `level`, and a flat list cannot disagree with itself about
 * ordering the way a nested structure plus a sort can.
 */
export interface BarisBaganAkun {
  akunId: string;
  kode: string;
  nama: string;
  parentId: string | null;
  level: number;
  tipe: TipeAkun;
  saldoNormal: SaldoNormal;
  isPostable: boolean;
  isKas: boolean;
  isKontra: boolean;
  klasifikasiArusKas: KlasifikasiArusKas | null;
  /** The `baris_laporan.kode` this account prints under. */
  klasifikasiLaporan: string;
  aktif: boolean;
  /** "Aktif" / "Nonaktif", the printed `status` column. */
  status: string;
}

export interface LaporanBaganAkun {
  header: HeaderLaporan;
  /** Depth-first by `kode`, parents before children. */
  baris: BarisBaganAkun[];
}

// ---------------------------------------------------------------------------
// The shared shape of a statement whose lines come from `baris_laporan`
// ---------------------------------------------------------------------------

/**
 * One printed line of Laporan Aktivitas or Laporan Posisi Keuangan.
 *
 * EVERY FIELD EXCEPT THE TWO FIGURES IS A COPY OF THE `baris_laporan` ROW.
 * That is the whole mechanic: the implementation walks rows and computes two
 * numbers per row, and knows nothing about what any line is called.
 *
 * `tanda` is applied to the figures BEFORE they are returned, so a caller
 * never has to remember to negate a contra line, and `nilaiTahunIni` on the
 * Penyisihan line is already the deduction it is printed as. `tanda` is kept
 * on the row so a reader can see why.
 */
export interface BarisStatement {
  barisLaporanId: string;
  kode: string;
  nama: string;
  parentKode: string | null;
  urutan: number;
  level: number;
  tipeBaris: TipeBaris;
  seksi: string | null;
  tanda: 1 | -1;
  cetakTebal: boolean;
  /** Account codes that fed a DETAIL line, so a reader can drill down. */
  akunKode: string[];
  nilaiTahunIni: Angka;
  nilaiTahunLalu: Angka;
}

/**
 * The comparative column spec 10.3 reports 17 and 19 require ("Kolom tahun ini
 * dan tahun lalu bersebelahan").
 *
 * THE CUT-OFFS ARE RETURNED, NOT INFERRED, because the two statements use
 * different ones and a caller must not have to guess:
 *   - Posisi Keuangan is a point in time: this year is the period end, last
 *     year is the END OF THE PRECEDING FINANCIAL YEAR. That is the comparative
 *     an interim statement of financial position carries.
 *   - Aktivitas is a span: this year is financial-year start to period end,
 *     last year is the SAME SPAN one year earlier.
 * Both derive from `akuntansi.tahun_buku_mulai_bulan`, never from a hardcoded
 * January.
 */
export interface KolomPembanding {
  labelTahunIni: string;
  dariTahunIni: TanggalIso;
  sampaiTahunIni: TanggalIso;
  labelTahunLalu: string;
  dariTahunLalu: TanggalIso;
  sampaiTahunLalu: TanggalIso;
}

// ---------------------------------------------------------------------------
// 17. Laporan Aktivitas
// ---------------------------------------------------------------------------

/**
 * spec 10.3 report 17. Sections, captions and their order come from the
 * AKTIVITAS rows of `baris_laporan`; the specification's own list of captions
 * ("Pendapatan Alokasi Dana dari BUMN Pembina", "Beban Pembinaan", ...) is
 * SEED DATA, not a type in this file.
 *
 * `kenaikanAsetNeto` is the statement's bottom line and, per section, is what
 * report 20 reports as that category's movement and what report 19 adds into
 * Aset Neto. The three are one number seen three ways; the tests assert they
 * agree rather than trusting each report separately.
 */
export interface SeksiAktivitas {
  /** `baris_laporan.seksi`, which also names the net-asset category. */
  kode: string;
  nama: string;
  baris: BarisStatement[];
  totalPendapatanTahunIni: Angka;
  totalPendapatanTahunLalu: Angka;
  totalBebanTahunIni: Angka;
  totalBebanTahunLalu: Angka;
  /** Pendapatan - Beban. Negative is a decrease and prints in parentheses. */
  kenaikanAsetNetoTahunIni: Angka;
  kenaikanAsetNetoTahunLalu: Angka;
}

export interface LaporanAktivitas {
  header: HeaderLaporan;
  kolom: KolomPembanding;
  /** In `baris_laporan.urutan` order of each section's first line. */
  seksi: SeksiAktivitas[];
  /** All lines in template order, sections flattened, for a plain printer. */
  baris: BarisStatement[];
  kenaikanAsetNetoTahunIni: Angka;
  kenaikanAsetNetoTahunLalu: Angka;
}

// ---------------------------------------------------------------------------
// 18. Laporan Arus Kas
// ---------------------------------------------------------------------------

/**
 * spec 10.3 report 18, direct method.
 *
 * HOW A MOVEMENT IS CLASSIFIED, stated once. Take every ledger line on an
 * `is_kas` account inside the span. Its classification is the
 * `klasifikasi_arus_kas` of the counter-account(s) in the SAME journal,
 * apportioned by amount when a journal has several. A counter-account with no
 * classification is a REFUSAL (`KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP`), never a
 * fourth bucket: an unclassified movement silently breaks Kas Akhir, and Kas
 * Akhir is the one figure this report must tie to the balance sheet.
 *
 * A cash-to-cash transfer (both legs `is_kas`, e.g. bank to petty cash) nets
 * to zero within the cash pool and produces NO line in any section.
 */
export interface BarisArusKas {
  /** The counter-account whose classification bucketed this movement. */
  akunId: string;
  akunKode: string;
  uraian: string;
  /** Signed, debit-positive on the CASH side: inflow positive, outflow negative. */
  nilaiTahunIni: Angka;
  nilaiTahunLalu: Angka;
}

export interface SeksiArusKas {
  klasifikasi: KlasifikasiArusKas;
  nama: string;
  baris: BarisArusKas[];
  totalTahunIni: Angka;
  totalTahunLalu: Angka;
}

export interface LaporanArusKas {
  header: HeaderLaporan;
  kolom: KolomPembanding;
  /** Always OPERASI, INVESTASI, PENDANAAN, in that order, even when empty:
   *  an empty section prints its caption and `0,00` (spec 10 zero rule). */
  seksi: SeksiArusKas[];
  kenaikanKasTahunIni: Angka;
  kenaikanKasTahunLalu: Angka;
  kasAwalTahunIni: Angka;
  kasAwalTahunLalu: Angka;
  /**
   * SPEC 10.3 REPORT 18, VERBATIM: "Kas Akhir wajib sama dengan saldo akun
   * berflag `is_kas` di Laporan Posisi Keuangan. Buat test untuk ini."
   *
   * Which is `LaporanPosisiKeuangan.kasDanSetaraKas` for the same period and
   * the same branch scope. Asserted by ./laporan-arus-kas.test.ts, non-zero
   * first so it cannot pass on an empty ledger.
   */
  kasAkhirTahunIni: Angka;
  kasAkhirTahunLalu: Angka;
  /** The `is_kas` accounts the closing balance was summed over, for drill-down. */
  akunKas: Array<{ akunId: string; kode: string; nama: string; saldo: Angka }>;
}

// ---------------------------------------------------------------------------
// 19. Laporan Posisi Keuangan
// ---------------------------------------------------------------------------

/**
 * spec 10.3 report 19. Lines from the POSISI_KEUANGAN rows of `baris_laporan`;
 * the specification's caption list is seed data.
 *
 * `totalAsetNeto` IS NOT THE SUM OF THE ASET_NETO ACCOUNTS. This system posts
 * no year-end closing entry, so every period's surplus since inception is
 * still sitting in PENDAPATAN and BEBAN. Net assets are therefore
 *
 *     sum(ASET_NETO accounts) + cumulative(PENDAPATAN - BEBAN) to the cut-off
 *
 * and `kenaikanAsetNetoPeriodeBerjalan` is the part of that which arose in the
 * current financial year, i.e. exactly report 17's bottom line. Any narrower
 * definition breaks Aset = Liabilitas + Aset Neto as soon as one revenue
 * journal exists, which is why this is stated here and tested directly.
 *
 * THE CUMULATIVE SURPLUS IS ATTRIBUTED TO THE ASET_NETO LINES, not carried as
 * a total the printed lines do not add up to. Each DETAIL line in the
 * ASET_NETO section prints its account balance PLUS the cumulative surplus of
 * the AKTIVITAS lines whose `seksi` names it, by the same rule report 20 uses.
 * So the section's lines foot to `totalAsetNeto`, and each line equals that
 * category's `saldoAkhir` in report 20. A statement whose section does not
 * foot to its own total is not one an accountant can sign.
 */
export interface LaporanPosisiKeuangan {
  header: HeaderLaporan;
  kolom: KolomPembanding;
  /** Every line, in template order, across all three sections. */
  baris: BarisStatement[];
  /** Lines whose `seksi` is ASET / LIABILITAS / ASET_NETO respectively. */
  barisAset: BarisStatement[];
  barisLiabilitas: BarisStatement[];
  barisAsetNeto: BarisStatement[];

  totalAsetTahunIni: Angka;
  totalAsetTahunLalu: Angka;
  totalLiabilitasTahunIni: Angka;
  totalLiabilitasTahunLalu: Angka;
  totalAsetNetoTahunIni: Angka;
  totalAsetNetoTahunLalu: Angka;
  /** The current financial year's movement, = report 17's bottom line. */
  kenaikanAsetNetoPeriodeBerjalanTahunIni: Angka;
  kenaikanAsetNetoPeriodeBerjalanTahunLalu: Angka;
  /**
   * Total Liabilitas + Aset Neto. Carried explicitly so the identity spec
   * 10.3 report 19 demands is a field comparison rather than arithmetic
   * performed by the caller, and so an Excel export prints the footing an
   * accountant expects to read next to Total Aset.
   */
  totalLiabilitasDanAsetNetoTahunIni: Angka;
  totalLiabilitasDanAsetNetoTahunLalu: Angka;

  /**
   * Sum of the accounts flagged `is_kas`. The figure report 18's Kas Akhir
   * must equal (spec 10.3 report 18).
   */
  kasDanSetaraKasTahunIni: Angka;
  kasDanSetaraKasTahunLalu: Angka;
}

// ---------------------------------------------------------------------------
// 20. Laporan Perubahan Aset Neto
// ---------------------------------------------------------------------------

/**
 * spec 10.3 report 20: "Saldo awal, kenaikan atau penurunan, saldo akhir, per
 * kategori aset neto".
 *
 * WHERE THE CATEGORIES COME FROM, AND THE SCHEMA GAP BEHIND IT.
 * `akun.klasifikasi_laporan` was SINGLE-VALUED, and every account's one value
 * was already spent: balance-sheet accounts pointed at POSISI_KEUANGAN lines
 * and result accounts at AKTIVITAS lines. So no account could point at a
 * PERUBAHAN_ASET_NETO line, and this statement had no account mapping of its
 * own. (Arus Kas had the same problem and solves it with the parallel
 * `akun.klasifikasi_arus_kas` column; there was no equivalent column here.)
 *
 * migrations/0028 CLOSED that gap: `akun.klasifikasi_akun` names a
 * classification, and `pemetaan_baris_laporan` gives that classification a
 * line in every statement, PERUBAHAN_ASET_NETO included. Re-expressing this
 * report on that mapping is a change to this contract and to
 * ./laporan-perubahan-aset-neto.test.ts together; until it is made, the
 * definition below is the one in force and the one the tests assert:
 *   - the CATEGORIES are the POSISI_KEUANGAN lines whose `seksi` is
 *     `ASET_NETO`, in `urutan` order;
 *   - a movement from Laporan Aktivitas belongs to the category whose
 *     `baris_laporan.kode` equals that AKTIVITAS line's `seksi`;
 *   - an AKTIVITAS line whose `seksi` names no such category is a REFUSAL
 *     (`SEKSI_ASET_NETO_TIDAK_DIKENAL`), never a silent drop, because a
 *     dropped movement makes `saldoAkhir != saldoAwal + perubahan`.
 *
 * THIS IS A MECHANIC, NOT A POSITION ON THE CATEGORIES THEMSELVES. Whether
 * they are the specification's "Tidak Terikat / Terikat Temporer" (PSAK 45) or
 * ISAK 335's "tanpa pembatasan / dengan pembatasan" is the client accounting
 * team's decision (docs/REGULASI.md finding 1, OPEN-QUESTIONS.md), and this
 * report reads whichever rows exist.
 *
 * FINDING, NOW CLOSED: the shipped seed (apps/api/src/seed/coa-inti.ts) used
 * to create no PERUBAHAN_ASET_NETO rows, no ARUS_KAS rows, no ASET_NETO
 * section lines and no postable ASET_NETO account. It creates all four now.
 * ./laporan-struktur-data.test.ts still pins each of those states as a
 * fail-closed refusal, reached by editing the rows rather than by relying on
 * the seed being short.
 */
export interface BarisPerubahanAsetNeto {
  /** `baris_laporan.kode` of the POSISI_KEUANGAN line for this category. */
  kategoriKode: string;
  nama: string;
  urutan: number;
  saldoAwalTahunIni: Angka;
  perubahanTahunIni: Angka;
  saldoAkhirTahunIni: Angka;
  saldoAwalTahunLalu: Angka;
  perubahanTahunLalu: Angka;
  saldoAkhirTahunLalu: Angka;
}

export interface LaporanPerubahanAsetNeto {
  header: HeaderLaporan;
  kolom: KolomPembanding;
  baris: BarisPerubahanAsetNeto[];
  totalSaldoAwalTahunIni: Angka;
  totalPerubahanTahunIni: Angka;
  /** Must equal `LaporanPosisiKeuangan.totalAsetNetoTahunIni`. */
  totalSaldoAkhirTahunIni: Angka;
  totalSaldoAwalTahunLalu: Angka;
  totalPerubahanTahunLalu: Angka;
  totalSaldoAkhirTahunLalu: Angka;
}

// ---------------------------------------------------------------------------
// 22. Buku Besar
// ---------------------------------------------------------------------------

/**
 * One movement line. spec 10.3 report 22: "setiap mutasi (tanggal, no jurnal,
 * keterangan, debit, kredit, saldo berjalan)", and "Wajib bisa drill down ke
 * jurnal".
 *
 * DRILL-DOWN IS AN ID, NOT A LINK. `jurnalId` and `jurnalBarisId` are carried
 * so the caller can open the entry itself; spec 11's rule ("Angka yang tidak
 * bisa ditelusuri asalnya tidak dipercaya user") is the reason, and a report
 * that returns only `noJurnal` forces a search that can find the wrong entry.
 */
export interface BarisBukuBesar {
  jurnalId: string;
  jurnalBarisId: string;
  noJurnal: string;
  tanggal: TanggalIso;
  jenisJurnal: string;
  /** Line description falling back to the journal's, which is what prints. */
  keterangan: string;
  debit: Angka;
  kredit: Angka;
  /**
   * Balance after this line, in the ACCOUNT'S OWN normal-balance direction, so
   * a liability's running balance grows on a credit rather than going
   * negative. `saldoAwal` uses the same direction.
   */
  saldoBerjalan: Angka;
  mitraId: string | null;
  akadId: string | null;
  cabangId: string;
}

export interface LaporanBukuBesar {
  header: HeaderLaporan;
  akunId: string;
  akunKode: string;
  akunNama: string;
  tipe: TipeAkun;
  saldoNormal: SaldoNormal;
  /** Balance the day before `header.dariTanggal`. */
  saldoAwal: Angka;
  /** Ordered by (tanggal, noJurnal, urutan), which is stable and reproducible. */
  mutasi: BarisBukuBesar[];
  totalDebit: Angka;
  totalKredit: Angka;
  /** = saldoAwal + totalDebit - totalKredit, in the account's own direction. */
  saldoAkhir: Angka;
}

// ---------------------------------------------------------------------------
// 23. Neraca Lajur
// ---------------------------------------------------------------------------

/**
 * spec 10.3 report 23: "Per akun: Saldo Awal (D, K), Mutasi (D, K), Saldo
 * Akhir (D, K). Baris total di bawah wajib balance di ketiga pasang kolom".
 *
 * SIX COLUMNS, ALL NON-NEGATIVE. A balance is shown in exactly one of its
 * pair: an account with a debit balance has `saldoAwalDebit` and
 * `saldoAwalKredit = 0.00`. That is what makes the three totals comparable
 * pairwise, and it is why `saldo_akun_periode`'s debit-positive convention has
 * to be split at this boundary rather than passed through.
 *
 * THE PERIOD IS THE PERIOD, NOT YEAR TO DATE. Saldo Awal is the balance the
 * day before `periode.tanggal_mulai` and Mutasi is that month alone, which is
 * exactly the shape `saldo_akun_periode` freezes (saldo_awal, mutasi_debit,
 * mutasi_kredit, saldo_akhir). The two paths of spec 10 could not otherwise
 * produce the same six numbers.
 */
export interface BarisNeracaLajur {
  akunId: string;
  kode: string;
  nama: string;
  tipe: TipeAkun;
  saldoNormal: SaldoNormal;
  saldoAwalDebit: Angka;
  saldoAwalKredit: Angka;
  mutasiDebit: Angka;
  mutasiKredit: Angka;
  saldoAkhirDebit: Angka;
  saldoAkhirKredit: Angka;
}

export interface TotalNeracaLajur {
  saldoAwalDebit: Angka;
  saldoAwalKredit: Angka;
  mutasiDebit: Angka;
  mutasiKredit: Angka;
  saldoAkhirDebit: Angka;
  saldoAkhirKredit: Angka;
}

export interface LaporanNeracaLajur {
  header: HeaderLaporan;
  /** Postable accounts with an opening balance or movement, by `kode`. */
  baris: BarisNeracaLajur[];
  /** The footing spec 10.3 report 23 requires to balance in all three pairs. */
  total: TotalNeracaLajur;
}

// ---------------------------------------------------------------------------
// Ports the engine consumes
// ---------------------------------------------------------------------------

export type LaporanTx = QueryRunner;

/**
 * READ ONLY IN PRACTICE, WIDE IN TYPE. This module writes nothing: it has no
 * `transaction` of its own to open and every method is a query. The port is
 * still `DbPort` so the composition root wires it exactly like every other
 * module, and so a later pass (a materialised report cache, an export
 * artefact row in `berkas_ekspor`) does not have to change the shape.
 *
 * Spec 16 scenario 23 is the standing rule for this module: an Auditor must be
 * able to open every report and must not be able to change anything. Nothing
 * in ./service.ts may issue an INSERT, UPDATE or DELETE.
 */
export type LaporanDbPort = DbPort;

export interface LaporanContext {
  userId: string;
  /** The user's own branch. */
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  /** Branches beyond the user's own. Admin Pusat / Auditor get every branch. */
  cabangDalamScope?: readonly string[];
}

export interface LaporanEngineDeps {
  db: LaporanDbPort;
  /** Injectable clock. Stamps `HeaderLaporan.tanggalCetak`, so a printed page
   *  is reproducible in a test instead of carrying today's date. */
  jam?: () => Date;
}

// ---------------------------------------------------------------------------
// The engine (spec 10.3, reports 16 to 20, 22 and 23)
// ---------------------------------------------------------------------------

export interface LaporanEngine {
  /** spec 10.3 report 16. */
  baganAkun(filter: FilterBaganAkun, ctx: LaporanContext): Promise<LaporanBaganAkun>;

  /** spec 10.3 report 17. Lines from `baris_laporan`, comparative column. */
  laporanAktivitas(filter: FilterLaporan, ctx: LaporanContext): Promise<LaporanAktivitas>;

  /** spec 10.3 report 18. Direct method; Kas Akhir ties to report 19. */
  laporanArusKas(filter: FilterLaporan, ctx: LaporanContext): Promise<LaporanArusKas>;

  /** spec 10.3 report 19. Total Aset = Total Liabilitas + Aset Neto. */
  laporanPosisiKeuangan(
    filter: FilterLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPosisiKeuangan>;

  /** spec 10.3 report 20. Ties to report 17's bottom line and report 19's Aset Neto. */
  laporanPerubahanAsetNeto(
    filter: FilterLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPerubahanAsetNeto>;

  /** spec 10.3 report 22. Drill-down ids on every movement. */
  bukuBesar(filter: FilterBukuBesar, ctx: LaporanContext): Promise<LaporanBukuBesar>;

  /** spec 10.3 report 23. Balances in all three column pairs. */
  neracaLajur(filter: FilterLaporan, ctx: LaporanContext): Promise<LaporanNeracaLajur>;
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * The one implementation site. `deps` flows straight through to ./service.ts,
 * which is private to this module.
 */
export function createLaporanEngine(deps: LaporanEngineDeps): LaporanEngine {
  return buatEngineLaporan(deps);
}
