// apps/api/src/modules/rka/contract.ts
//
// THE RKA MODULE'S ONLY SHAPE. Spec 4.8 (the data model), spec 9.3 (the three
// budget types, the versions and the status), spec 10.3 report 24 (Laporan RKA
// versus Realisasi) and spec 16 scenario 18 (the realisation figures must agree
// with the disbursement reports).
//
// WRITTEN BEFORE THE ENGINE. ./service.ts throws from every method; the six
// *.test.ts files in this folder are the specification. Fase 6 turns them green
// one method at a time.
//
// ---------------------------------------------------------------------------
// THE ONE DESIGN DECISION THIS FILE EXISTS TO PIN
// ---------------------------------------------------------------------------
// REALISATION IS READ, NEVER RECOMPUTED.
//
// The tempting implementation of report 24 is a query that sums
// `pumk_pencairan`, `nonpumk_penyaluran` and `jurnal_baris` with this module's
// own opinion about which rows count. That is a second definition of every
// number the rest of the system already publishes, and it drifts silently:
// nothing compares the two, so the day a reversal, a refund or a write-off is
// treated differently here than in the ledger, the budget report and the
// disbursement report disagree and neither one is obviously wrong.
//
// So the rule, stated once:
//
//   OPEN period    -> `v_ledger_baris`, the shipped view, whose predicate is
//                     `status IN ('POSTED','REVERSED')`.
//   CLOSED period  -> `saldo_akun_periode`, the trial balance the closing
//                     engine FROZE for that period (spec 10's own rule, and
//                     invariant 14: a past period's report must reproduce).
//
// NEVER a POSTED-only filter, in either case. ADR 0010 and migrations/0018:
// correction is by reversing entry, the original is marked REVERSED and both
// sets of lines stay in the ledger and cancel. Filtering on POSTED alone drops
// the original's lines while keeping the reversal's, so it subtracts a
// correction it never added. In a budget report that defect is invisible: the
// figure is plausible, the totals still add up, and no balance check in the
// system can see it, because report 24 has no balance to check.
//
// `BarisRkaVsRealisasi.sumberRealisasi` and `LaporanRkaVsRealisasi.sumberPerPeriode`
// exist so a test can assert WHICH source answered, rather than only that the
// number happened to be right. A period whose realisation came from the live
// ledger when it should have come from the frozen table produces the same
// figure today and a different one after a reopen, a reclassification, or a
// master-data edit, which is precisely the failure invariant 14 forbids and
// precisely the one an equality assertion cannot catch.
//
// ---------------------------------------------------------------------------
// TWO THINGS THIS MODULE REFUSES TO INVENT
// ---------------------------------------------------------------------------
// 1. PERMISSIONS. Every code this module needs is named here and resolved
//    through `canonicalPermission`, so a code the shipped catalogue does not
//    carry FAILS CLOSED with `IZIN_BELUM_TERDAFTAR` instead of being treated
//    as granted. That mechanism surfaced `pumk.cluster`,
//    `nonpumk.lpj.verifikasi`, `admin.closing.view` and then this module's own
//    `admin.rka.approve` and `admin.rka.view`, both of which now SHIP. The
//    guard stays because the next missing code is the one it exists for.
//    What did NOT go away is the control question: ADMIN_PUSAT holds the input
//    code and the approval code, so whether one person may do both is read
//    from `rka.pemisahan_tugas_persetujuan` and decided by nobody here.
// 2. DIMENSIONS. `saldo_akun_periode` carries (periode, cabang, akun) and
//    nothing else, so a CLOSED period has no frozen figure per sektor or per
//    bidang at all. Report 24 for RKA PUMK and RKA Non PUMK over a closed
//    period is therefore refused with `SKEMA_BELUM_LENGKAP` rather than
//    silently recomputed from live master data. See `MetodeRealisasi`.
import type { DbPort, QueryRunner } from "../../core/ports/db";
import type { HeaderLaporan } from "../laporan/index";
import { buatEngineRka } from "./service";

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * Decimal string, exactly two fractional digits. Never a JS number
 * (invariant 7). May be negative: `selisih` is `anggaran - realisasi` and a
 * budget overrun is a real, common, negative number.
 *
 * REMINDER FOR THE IMPLEMENTATION, and the reason this comment is here rather
 * than in a repo file that does not exist yet: `coalesce(sum(x), 0)` comes back
 * from Postgres as `'0'`, not `'0.00'`, and fails `POLA_UANG`. Cast
 * `::numeric(20,2)` BEFORE `::text`. A dimension with no realisation at all is
 * the common case in this report, so that path is hit on the first run.
 */
export type Uang = string;

export const POLA_UANG = /^-?\d{1,18}\.\d{2}$/;

/**
 * Percentage achieved, two decimals, as a string for the same reason money is.
 * Signed: a negative budget line or a refund-heavy bidang can produce one.
 */
export type Persen = string;

export const POLA_PERSEN = /^-?\d{1,10}\.\d{2}$/;

/** Mirrors the CHECK on `rka.jenis` (migrations/0012). */
export type JenisRka = "PUMK" | "NON_PUMK" | "KEUANGAN";

/** Mirrors the CHECK on `rka.status` (migrations/0012). */
export type StatusRka = "DRAFT" | "DISETUJUI" | "REVISI";

/** Mirrors the CHECK on `periode.status` (migrations/0007). */
export type StatusPeriode = "OPEN" | "CLOSING_IN_PROGRESS" | "CLOSED";

/**
 * The dimension a budget line is filed against. One per `JenisRka`, enforced
 * by `trg_rka_detail_10_dimensi` (migrations/0012), which raises TJSL-RKA-001,
 * -002 and -003. This module validates FIRST and expects to be the one
 * rejecting; ./kesalahan.ts maps the trigger anyway, for the race.
 */
export type DimensiRka = "AKUN" | "SEKTOR" | "BIDANG";

/** The dimension each budget type uses. Spec 9.3, spec 10.3 report 24. */
export const DIMENSI_UNTUK_JENIS: Readonly<Record<JenisRka, DimensiRka>> = Object.freeze({
  PUMK: "SEKTOR",
  NON_PUMK: "BIDANG",
  KEUANGAN: "AKUN",
});

/**
 * WHERE A ROW'S REALISATION CAME FROM. Not decoration: see this file's header.
 *
 * `SALDO_AKUN_PERIODE` is the frozen trial balance of a CLOSED period.
 * `V_LEDGER_BARIS` is the live ledger of an OPEN one, read through the shipped
 * view so the reversal predicate is the ledger's own and not a copy.
 *
 * There is deliberately no third member for "recomputed from pumk_pencairan /
 * nonpumk_penyaluran". Those tables are where the DISBURSEMENT reports read
 * from, and spec 16 scenario 18 requires this report to AGREE with them; it
 * does not licence this module to become a second implementation of them.
 */
export type SumberRealisasi = "SALDO_AKUN_PERIODE" | "V_LEDGER_BARIS";

// ---------------------------------------------------------------------------
// Permissions (spec 2, spec 9.3)
// ---------------------------------------------------------------------------

/**
 * ALL FOUR CODES BELOW ARE NOW IN THE SHIPPED CATALOGUE
 * (modules/auth/permissions.ts). `admin.rka.approve` and `admin.rka.view` were
 * findings this module filed and they have since been DISCHARGED, so the
 * engine checks them like any other code rather than failing closed on them.
 *
 * THE FAIL-CLOSED MECHANISM STAYS, and it is not dead code: `wajibIzin` in
 * ./service.ts still resolves every code through `canonicalPermission` and
 * raises `IZIN_BELUM_TERDAFTAR` for one the catalogue does not carry, which is
 * how these two were found and how `pumk.cluster`,
 * `nonpumk.lpj.verifikasi` and `admin.closing.view` were found before them.
 * ./rka-fixture.test.ts keeps it pinned on codes the catalogue genuinely lacks.
 *
 * THE PART OF THE OLD INSTRUCTION THAT STILL HOLDS: never put a permission
 * string into a fixture's permission list to make a test green. Every context
 * in this folder gets its codes from `permissionsForRole`, which reads the
 * shipped grant matrix out of the database; a fixture that grants itself the
 * code it wants proves only that the fixture agrees with itself.
 *
 * WHERE THE GAP WENT, because it moved rather than disappeared: ADMIN_PUSAT
 * holds BOTH `admin.rka` and `admin.rka.approve`, so on the shipped matrix one
 * person can still draft a budget and approve it. Separating those two acts is
 * now a CONFIGURATION question, `rka.pemisahan_tugas_persetujuan`, which ships
 * as a BOOLEAN whose provenance is marked `ASUMSI` because spec 2 scopes its
 * segregation rules to the two proposal modules and the RKA has no Checker
 * stage. `setujuiRka` READS that key in both directions and assumes neither
 * answer; see `KUNCI_KONFIGURASI_RKA.PEMISAHAN_TUGAS_PERSETUJUAN`.
 */
export const PERMISSION_RKA = {
  /**
   * spec 9.3 "Input RKA PUMK / Non PUMK / Keuangan": creating a budget,
   * editing a DRAFT's lines, opening a revision. SHIPPED.
   */
  KELOLA: "admin.rka",

  /**
   * APPROVING an RKA, which is what turns it into the baseline every
   * comparison in the system is measured against.
   *
   * SHIPPED, and granted to ADMIN_PUSAT. It began as a finding this module
   * filed (there was one code for input and approval), and the catalogue now
   * carries it; ./rka-fixture.test.ts re-pins the discharge as a positive.
   *
   * It is not a reuse of `admin.rka`. Spec 9.3 gives the RKA a status and an
   * approval (`approved_by`, `approved_at`, and `rka_disetujui_ck` in
   * migrations/0012 makes both mandatory), and spec 2 separates the authority
   * to INPUT from the authority to APPROVE in every other place the two exist.
   * With one code, the person who types the sector targets is the person who
   * blesses them, and the resulting baseline is the yardstick for report 24,
   * for report 2 ("versus RKA") and for report 13 ("versus RKA"). That is the
   * one document in the system whose approval nobody can check afterwards,
   * because there is no second party in the record.
   *
   * It is also not `konfigurasi.master`: an annual budget is not master data,
   * and gating it there would put budget approval behind the same code as
   * editing the list of provinces.
   *
   * HOLDING THE CODE IS NOT THE WHOLE CONTROL. ADMIN_PUSAT holds this and
   * `admin.rka`, so whether the drafter may also approve is decided by
   * `rka.pemisahan_tugas_persetujuan`, not by the catalogue. `setujuiRka`
   * reads that key and refuses a self-approval with `KONFLIK_MAKER_APPROVER`
   * when it is on.
   */
  SETUJUI: "admin.rka.approve",

  /**
   * READING the budgets: the list, a version's lines, which version is the
   * baseline, who approved it and when. No right to change anything.
   *
   * SHIPPED, and granted to AUDITOR (and so to ADMIN_PUSAT, which is the whole
   * catalogue). It began as a finding this module filed, exactly the shape of
   * `admin.closing.view` before that existed, and it was discharged the same
   * way: a read-only evidence code, listed in `HANYA_BUKTI` so the operational
   * roles do not inherit it. The paragraphs below are the argument that made
   * the case, kept because they are still why the code is its own.
   *
   * Spec 2 gives the Auditor "read only penuh termasuk semua laporan dan audit
   * trail" and spec 16 scenario 23 requires every report and every evidence
   * screen to open for that role with no control that writes. Which version of
   * the budget was approved, by whom, and on what date is evidence: without it
   * an auditor cannot tell whether report 24's baseline was the one in force.
   *
   * `laporan.view` does not reach it. That code gates the 31 reports of spec
   * 10, and the budget entry screens of spec 9.3 are not among them, so a role
   * holding `laporan.view` can read report 24 without being able to see the
   * versions the report compares against.
   *
   * `admin.rka` does not reach it either, without handing a WRITE code to a
   * role spec 2 forbids to write. That trade was refused for the closing
   * evidence and is refused here for the same reason.
   */
  LIHAT: "admin.rka.view",

  /**
   * Report 24 itself. SHIPPED, and correctly so: report 24 is one of the 31
   * reports in spec 10, so the code that gates the report catalogue is the
   * code that gates it, and the Auditor already holds it.
   */
  LAPORAN: "laporan.view",
} as const;

export type PermissionRka = (typeof PERMISSION_RKA)[keyof typeof PERMISSION_RKA];

// ---------------------------------------------------------------------------
// Configuration this module READS. Never a hardcoded policy number.
// ---------------------------------------------------------------------------

/**
 * Resolved bumn-scoped first, then global (`bumn_id IS NULL`), the same
 * resolution order every other engine in this repo uses. A MISSING row is a
 * refusal (`KONFIGURASI_TIDAK_ADA`), never a default invented at the call site.
 */
export const KUNCI_KONFIGURASI_RKA = {
  /**
   * spec 5.6, SHIPPED. The month the financial year starts in.
   *
   * Report 24's cumulative form is "year to date", and a year that starts in
   * April makes month 4 the FIRST month of the cumulation and month 3 the
   * last. Hardcoding January would produce a report that is right for most
   * clients and quietly wrong for the ones who asked for this column.
   *
   * NO TEST IN THIS FOLDER ASSERTS THAT THE YEAR STARTS IN JANUARY. They
   * assert that changing this row moves the window.
   */
  TAHUN_BUKU_MULAI_BULAN: { grup: "akuntansi", kunci: "tahun_buku_mulai_bulan" },

  /**
   * Whether the person who created or last edited an RKA may approve it.
   *
   * IN THE CATALOGUE (modules/konfigurasi/katalog.ts), as a BOOLEAN whose
   * `asalNilaiDefault` is `ASUMSI` and whose description says in as many words
   * that it is waiting on the client. That provenance is the point: the key had
   * to arrive labelled as an assumption rather than as settled policy, or the
   * system would be asserting a control nobody chose. It is a genuine policy
   * question rather than an oversight:
   *
   *   Spec 2's segregation rules are scoped, in the spec's own words, to the
   *   "pola Maker, Checker, Approval yang berlaku di dua modul (PUMK dan Non
   *   PUMK)". The RKA has an approval but no Checker stage, so neither rule 1
   *   (maker vs checker) nor rule 2 (checker vs approver) reaches it verbatim.
   *   Whether a single Admin Pusat may draft and approve the annual budget
   *   alone is a control decision belonging to the client, not to this module.
   *
   * So the module READS the key and assumes neither answer: with it on, the
   * creator or last editor is refused with `KONFLIK_MAKER_APPROVER`; with it
   * off, the same person may approve. Both directions are asserted, which is
   * what makes this a mechanic rather than a smuggled policy, and an engine
   * with the rule hardcoded either way fails one of the two.
   *
   * Resolution is bumn-scoped then global, per this constant group's header, so
   * a client that has not decided gets the shipped assumption rather than a
   * literal invented at the call site. `KONFIGURASI_TIDAK_ADA` is still raised
   * when NEITHER row exists, which is what a database missing its Fase 0 seed
   * looks like, and refusing there beats guessing which control applies.
   */
  PEMISAHAN_TUGAS_PERSETUJUAN: { grup: "rka", kunci: "pemisahan_tugas_persetujuan" },
} as const;

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const KODE_RKA = {
  RKA_TIDAK_DITEMUKAN: "RKA_TIDAK_DITEMUKAN",
  BASELINE_TIDAK_ADA: "BASELINE_TIDAK_ADA",
  VERSI_TIDAK_DITEMUKAN: "VERSI_TIDAK_DITEMUKAN",
  PERIODE_TIDAK_DITEMUKAN: "PERIODE_TIDAK_DITEMUKAN",
  AKUN_TIDAK_DITEMUKAN: "AKUN_TIDAK_DITEMUKAN",
  SEKTOR_TIDAK_DITEMUKAN: "SEKTOR_TIDAK_DITEMUKAN",
  BIDANG_TIDAK_DITEMUKAN: "BIDANG_TIDAK_DITEMUKAN",

  /** Editing anything on a DISETUJUI version. Spec 9.3: revise, do not edit. */
  RKA_SUDAH_DISETUJUI: "RKA_SUDAH_DISETUJUI",
  /** Approving something that is not a DRAFT. */
  RKA_BUKAN_DRAFT: "RKA_BUKAN_DRAFT",
  /** Opening a revision from a version that was never approved. */
  REVISI_HARUS_DARI_DISETUJUI: "REVISI_HARUS_DARI_DISETUJUI",
  /** A second DRAFT for a scope that already has one open. */
  REVISI_MASIH_TERBUKA: "REVISI_MASIH_TERBUKA",
  /** `rka_versi_uq` / `rka_baseline_uq`, reached only by a race. */
  VERSI_GANDA: "VERSI_GANDA",
  BASELINE_GANDA: "BASELINE_GANDA",

  /** The line's dimension does not match the budget's type (TJSL-RKA-001..003). */
  DIMENSI_TIDAK_SESUAI_JENIS: "DIMENSI_TIDAK_SESUAI_JENIS",
  /** Two lines for the same dimension and the same month. */
  BARIS_DUPLIKAT: "BARIS_DUPLIKAT",
  BULAN_TIDAK_VALID: "BULAN_TIDAK_VALID",
  TAHUN_TIDAK_VALID: "TAHUN_TIDAK_VALID",
  /** A budget line for an account that cannot be posted to, or is not a
   *  BEBAN/PENDAPATAN account. Spec 9.3: "anggaran per akun beban dan target
   *  pendapatan". */
  AKUN_TIDAK_DAPAT_DIANGGARKAN: "AKUN_TIDAK_DAPAT_DIANGGARKAN",
  NILAI_BUKAN_DESIMAL: "NILAI_BUKAN_DESIMAL",
  NILAI_NEGATIF: "NILAI_NEGATIF",
  UNIT_TIDAK_VALID: "UNIT_TIDAK_VALID",

  /**
   * The storage this report needs to be REPRODUCIBLE does not exist yet, so
   * the report stops instead of producing a figure that cannot be defended
   * later. See `MetodeRealisasi` and ./rka-realisasi-sumber.test.ts.
   */
  SKEMA_BELUM_LENGKAP: "SKEMA_BELUM_LENGKAP",
  /** A closed period whose `saldo_akun_periode` rows are missing entirely:
   *  the freeze did not happen, so there is nothing to read and nothing to
   *  invent. */
  SALDO_PERIODE_TIDAK_ADA: "SALDO_PERIODE_TIDAK_ADA",

  KONFIGURASI_TIDAK_ADA: "KONFIGURASI_TIDAK_ADA",
  KONFIGURASI_TIDAK_VALID: "KONFIGURASI_TIDAK_VALID",

  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
  /** spec 2 rules 1 and 2, applied to the RKA approval when the configured
   *  policy says they apply. */
  KONFLIK_MAKER_APPROVER: "KONFLIK_MAKER_APPROVER",
  /** A permission this module needs is not in the shipped catalogue, so the
   *  operation fails closed instead of treating an unknown code as granted. */
  IZIN_BELUM_TERDAFTAR: "IZIN_BELUM_TERDAFTAR",
} as const;

export type KodeRka = (typeof KODE_RKA)[keyof typeof KODE_RKA];

/** The one error type this module raises. */
export class RkaError extends Error {
  readonly kode: KodeRka;
  readonly detail: Readonly<Record<string, unknown>>;
  /** Raw driver/trigger text, for the SERVER LOG ONLY. Never rendered. */
  readonly penyebabDb?: string;

  constructor(
    kode: KodeRka,
    message: string,
    detail: Record<string, unknown> = {},
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "RkaError";
    this.kode = kode;
    this.detail = Object.freeze({ ...detail });
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// The budget (spec 4.8)
// ---------------------------------------------------------------------------

export interface Rka {
  id: string;
  bumnId: string;
  /** NULL = a consolidated, entity-wide budget rather than a branch budget. */
  cabangId: string | null;
  tahun: number;
  jenis: JenisRka;
  status: StatusRka;
  versi: number;
  approvedBy: string | null;
  /** ISO timestamp. */
  approvedAt: string | null;
  keterangan: string | null;
  createdBy: string | null;
  /** The version this one was revised FROM, when it is a revision. */
  versiSebelumnya: number | null;
}

/**
 * One budget line. Exactly one of `akunId` / `sektorId` / `bidangId` is set,
 * decided by the parent's `jenis` (`DIMENSI_UNTUK_JENIS`).
 */
export interface BarisRka {
  id: string;
  rkaId: string;
  akunId: string | null;
  sektorId: string | null;
  bidangId: string | null;
  uraian: string;
  /** 1..12, or null for an annual figure with no monthly breakdown. */
  bulan: number | null;
  jumlahAnggaran: Uang;
  /**
   * The non-money target. Spec 9.3 names it for RKA PUMK ("jumlah mitra
   * target"); it is null for the other two types unless the client asks
   * otherwise.
   */
  jumlahUnit: number | null;
  keterangan: string | null;
}

export interface RkaLengkap extends Rka {
  baris: BarisRka[];
  /** Sum of `jumlahAnggaran` over every line, for the header of the screen. */
  totalAnggaran: Uang;
}

export interface BuatRkaInput {
  cabangId: string | null;
  tahun: number;
  jenis: JenisRka;
  keterangan?: string | null;
  /** Optional: create the version and its lines in one call. */
  baris?: readonly BarisRkaInput[];
}

export interface BarisRkaInput {
  akunId?: string | null;
  sektorId?: string | null;
  bidangId?: string | null;
  uraian: string;
  bulan: number | null;
  jumlahAnggaran: Uang;
  jumlahUnit?: number | null;
  keterangan?: string | null;
}

/**
 * REPLACES the lines of a DRAFT version, whole. Not a per-row patch:
 * a budget is entered as a grid and saved as a grid, and a partial update is
 * how a row silently survives a revision nobody meant to keep.
 */
export interface SimpanBarisRkaInput {
  rkaId: string;
  baris: readonly BarisRkaInput[];
}

export interface SetujuiRkaInput {
  rkaId: string;
  /** ISO date. Defaults to the injected clock. */
  tanggal?: string | null;
  catatan?: string | null;
}

export interface BuatRevisiInput {
  /** The DISETUJUI version being revised. */
  rkaId: string;
  keterangan?: string | null;
  /**
   * Copy the approved version's lines into the new DRAFT. Default true: a
   * revision is almost always an edit of the numbers in force, and an empty
   * grid invites re-keying a budget that already exists.
   */
  salinBaris?: boolean;
}

export interface FilterRka {
  tahun?: number | null;
  jenis?: JenisRka | null;
  cabangId?: string | null;
  status?: StatusRka | null;
}

// ---------------------------------------------------------------------------
// Report 24 (spec 10.3, spec 16 scenario 18)
// ---------------------------------------------------------------------------

/** Monthly, or cumulative from the start of the financial year. */
export type ModeLaporanRka = "BULANAN" | "KUMULATIF_YTD";

/**
 * Report 24's printed title, verbatim from the spec 10.3 catalogue, for the
 * same reason modules/laporan keeps `NAMA_LAPORAN`: the header, the Excel
 * sheet name and the PDF title must not drift apart, and a test should name
 * the report the way the contract does.
 */
export const NAMA_LAPORAN_RKA = "Laporan RKA versus Realisasi";

/**
 * THE HEADER SPEC 10'S PREAMBLE REQUIRES OF EVERY REPORT, and report 24 is
 * every report too.
 *
 * It is modules/laporan's `HeaderLaporan`, imported through that module's
 * index and NOT a same-shaped copy declared here. Two structurally identical
 * types are two types: one of them gains a field, the other does not, and the
 * screen ends up with two header renderers that disagree about what a printed
 * page states. Sharing the type means a change over there fails to compile
 * here, which is the loud handover this repository prefers everywhere else.
 *
 * Report 24 lives in this module rather than in modules/laporan because its
 * figures are budget versus realisation, not `baris_laporan` lines (see this
 * file's header). That is a reason for the SERVICE to be here; it is not a
 * reason for the printed preamble to be different, and until now report 24 was
 * the only one of the 31 reports that shipped without one, so the screen
 * borrowed the entity name out of report 16's header. That was a workaround
 * for a gap, and this is the gap closed.
 *
 * TWO FIELDS ARE FILLED DIFFERENTLY FROM A modules/laporan REPORT, and both
 * differences are stated rather than fudged:
 *
 *   `sumberTemplate` is always TANPA_TEMPLATE and `templateLaporanId` is always
 *   null. That member means "this report has no layout template at all", which
 *   is exactly true here: report 24 prints budget lines per dimension, no
 *   `baris_laporan` row is involved, and naming a template the page did not use
 *   would be a false claim about its reproducibility.
 *
 *   `sumberData` is the same claim `sumberRealisasi` makes per row, in
 *   modules/laporan's vocabulary: SNAPSHOT_PERIODE when EVERY month in the
 *   window was read from the frozen `saldo_akun_periode`, LEDGER_LIVE
 *   otherwise. A mixed window is LEDGER_LIVE, because a page that was half
 *   recomputed cannot call itself reproducible; `sumberPerPeriode` still says
 *   which month came from where.
 */
export type HeaderLaporanRka = HeaderLaporan;

export interface FilterLaporanRka {
  tahun: number;
  jenis: JenisRka;
  /** null = every branch in the caller's scope, consolidated. */
  cabangId?: string | null;
  /**
   * WHICH VERSION TO COMPARE AGAINST. Spec 9.3: "laporan bisa memilih versi
   * mana yang dibandingkan".
   *
   * Omitted means the DISETUJUI baseline, which is what spec 9.3 makes the
   * default ("RKA DISETUJUI jadi baseline pembanding"), and a scope with no
   * approved version is `BASELINE_TIDAK_ADA` rather than a silent fall back to
   * the newest draft. A draft is somebody's proposal; reporting against it
   * would present an unapproved target as performance.
   */
  versi?: number | null;
  /** Exact version by id, for a caller that already has one in hand. */
  rkaId?: string | null;
  mode: ModeLaporanRka;
  /**
   * BULANAN: the single month reported.
   * KUMULATIF_YTD: the LAST month of the cumulation, counted from the first
   * month of the financial year (see `KUNCI_KONFIGURASI_RKA.TAHUN_BUKU_MULAI_BULAN`).
   */
  bulan: number;
}

export interface BarisRkaVsRealisasi {
  dimensi: DimensiRka;
  dimensiId: string;
  /** Account code, sector code or bidang code: what a human recognises. */
  dimensiKode: string;
  dimensiNama: string;
  /** Report 24 column 1. The budget line's own `uraian`, or the dimension's
   *  name when several lines roll up into one row. */
  uraian: string;
  /** Report 24 column 2. */
  anggaran: Uang;
  /** Report 24 column 3. READ, never recomputed. See this file's header. */
  realisasi: Uang;
  /** Report 24 column 4, `anggaran - realisasi`. Negative = over budget. */
  selisih: Uang;
  /**
   * Report 24 column 5, `realisasi / anggaran * 100`, two decimals, rounded
   * HALF UP away from zero.
   *
   * NULL when `anggaran` is zero, deliberately. Realisation against a zero
   * budget is not "0 percent" and it is not infinity; it is a line that was
   * spent without being budgeted, and the report says so by leaving the
   * percentage empty rather than printing a number that reads as compliance.
   */
  persenCapaian: Persen | null;
  /**
   * Spec 9.3's "jumlah mitra target" for RKA PUMK, and what was actually
   * achieved. Null for the other two types.
   *
   * `unitRealisasi` counts DISTINCT mitra funded in the window, not
   * disbursements: a second tranche to the same mitra is not a second partner.
   */
  unitAnggaran: number | null;
  unitRealisasi: number | null;
  /** Which of the two sources answered for this row. Never a guess. */
  sumberRealisasi: SumberRealisasi;
}

export interface TotalRkaVsRealisasi {
  anggaran: Uang;
  realisasi: Uang;
  selisih: Uang;
  persenCapaian: Persen | null;
  unitAnggaran: number | null;
  unitRealisasi: number | null;
}

/**
 * One entry per calendar month the report covers, saying what that month's
 * period was and which source its realisation came from.
 *
 * EXISTS TO BE ASSERTED ON. A cumulative report that spans a closed January and
 * an open February must read January from the frozen table and February from
 * the live ledger; a single figure cannot show that it did, and the two
 * readings agree on well-behaved data, so an equality assertion alone would
 * pass on an implementation that got the rule backwards.
 */
export interface SumberPeriode {
  periodeId: string;
  tahun: number;
  bulan: number;
  statusPeriode: StatusPeriode;
  sumber: SumberRealisasi;
}

export interface LaporanRkaVsRealisasi {
  /** Spec 10's preamble: entity, report name, period, branch, print date and
   *  who printed it. See `HeaderLaporanRka`. */
  header: HeaderLaporanRka;
  rkaId: string;
  jenis: JenisRka;
  dimensi: DimensiRka;
  tahun: number;
  versi: number;
  statusRka: StatusRka;
  cabangId: string | null;
  mode: ModeLaporanRka;
  /** Inclusive month window actually reported, after the fiscal-year offset. */
  dariBulan: number;
  sampaiBulan: number;
  baris: BarisRkaVsRealisasi[];
  total: TotalRkaVsRealisasi;
  sumberPerPeriode: SumberPeriode[];
}

/**
 * How this module is ALLOWED to obtain realisation for a given budget type and
 * period status. Returned by `metodeRealisasi` so the refusal below is
 * inspectable rather than only observable as an exception.
 *
 * THE GAP THIS TYPE EXISTS TO NAME. `saldo_akun_periode` is keyed
 * (periode, cabang, akun) and carries no sektor and no bidang, so a CLOSED
 * period has NO frozen figure per sector or per bidang. The only remaining way
 * to produce one is to re-derive it from the live ledger and join out to
 * master data that can change:
 *
 *   - a PUMK disbursement's sector is reachable only through
 *     `pumk_akad -> pumk_proposal.sektor_id`, because `PENCAIRAN_PUMK` puts
 *     `mitraId` and `akadId` on the line and NO `sektorId` in `dimensi_json`;
 *   - `pumk_proposal.sektor_id` is editable master data.
 *
 * So re-deriving means a closed period's report 24 changes when somebody
 * reclassifies a partner, which is invariant 14 broken for the report spec 16
 * scenario 18 exists to check. Refusing is the fail-closed answer and the one
 * that gets the column added. `TIDAK_TERSEDIA` is what `metodeRealisasi`
 * returns for that combination and `SKEMA_BELUM_LENGKAP` is what the report
 * raises.
 *
 * Non PUMK is a near miss rather than a second instance: `PENYALURAN_NON_PUMK`
 * DOES carry `bidangId` in `dimensi_json`, so its attribution is immutable
 * ledger data. It still has nowhere frozen to read it from once the period
 * closes.
 */
export type MetodeRealisasi = SumberRealisasi | "TIDAK_TERSEDIA";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type RkaTx = QueryRunner;
export type RkaDbPort = DbPort;

/**
 * The audit trail, as a port. Structurally satisfied by modules/audit's
 * service. Optional, for the reason modules/jurnal gives: the engine must be
 * constructible with a database and nothing else. Spec 2 rule 5 nonetheless
 * REQUIRES every authorisation refusal to reach the log, so the tests wire it
 * and assert it.
 */
export interface PencatatAuditRka {
  record(
    entry: {
      userId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      aksi: string;
      entitas: string;
      entitasId?: string | null;
      nilaiLama?: unknown;
      nilaiBaru?: unknown;
      hasil: "SUKSES" | "DITOLAK";
      keterangan?: string | null;
    },
    runner?: RkaTx,
  ): Promise<string>;
}

/**
 * Who is acting. Same shape as `JurnalContext` and `ClosingContext` (spec 2
 * rule 3), so a context flows between modules unchanged and the branch scope
 * cannot be widened on the way through.
 */
export interface RkaContext {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  /** Branches beyond the user's own. Admin Pusat / Auditor get every branch. */
  cabangDalamScope?: readonly string[];
}

export interface RkaEngineDeps {
  db: RkaDbPort;
  /** Injectable clock. Stamps `approved_at` and defaults a report's date. */
  jam?: () => Date;
  audit?: PencatatAuditRka;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * THERE IS NO LEDGER PORT HERE, AND THAT IS DELIBERATE.
 *
 * Every other engine in this repo takes a `PorterJurnal*` because it WRITES to
 * the ledger and invariant 11 requires that to go through one path. This module
 * writes nothing to the ledger: an RKA is a target, not a transaction. It only
 * READS, and it reads through the two shipped artefacts named in this file's
 * header. A port here would be an invitation to hand the engine a double that
 * answers for the ledger, which is the one thing modules/angsuran's
 * test-support records as having cost this project two production defects.
 */
export interface RkaEngine {
  // --- spec 9.3 input -----------------------------------------------------

  /**
   * Creates version 1 of a budget for (cabang, tahun, jenis), DRAFT.
   * Requires `admin.rka` and the branch in scope.
   */
  buatRka(input: BuatRkaInput, ctx: RkaContext): Promise<RkaLengkap>;

  /**
   * Replaces the lines of a DRAFT version. Refuses with `RKA_SUDAH_DISETUJUI`
   * on a DISETUJUI or REVISI version: spec 9.3 says a change makes a NEW
   * version, so an approved baseline is immutable and a superseded one is
   * history.
   */
  simpanBaris(input: SimpanBarisRkaInput, ctx: RkaContext): Promise<RkaLengkap>;

  /**
   * DRAFT -> DISETUJUI, and the previous DISETUJUI version for the same scope
   * -> REVISI, in ONE transaction. `rka_baseline_uq` (a partial unique index
   * over status = 'DISETUJUI') means the two cannot both be approved even for
   * an instant, so this ordering is not a preference.
   *
   * Requires `PERMISSION_RKA.SETUJUI`, which SHIPS and is granted to
   * ADMIN_PUSAT. Resolved through `canonicalPermission` all the same, so a code
   * the catalogue stops carrying fails closed rather than passing silently.
   *
   * Reads `KUNCI_KONFIGURASI_RKA.PEMISAHAN_TUGAS_PERSETUJUAN` and, when it is
   * on, refuses an approver who created or last edited the version with
   * `KONFLIK_MAKER_APPROVER`.
   */
  setujuiRka(input: SetujuiRkaInput, ctx: RkaContext): Promise<Rka>;

  /**
   * Opens the NEXT version as a DRAFT, from a DISETUJUI one. The source
   * version is left EXACTLY as it is: still DISETUJUI, still the baseline,
   * still readable with every line intact, until the new version is approved.
   * Spec 16 scenario 8 asks the same thing of a rescheduled instalment plan
   * and the reasoning is identical.
   */
  buatRevisi(input: BuatRevisiInput, ctx: RkaContext): Promise<RkaLengkap>;

  // --- reads (PERMISSION_RKA.LIHAT) ---------------------------------------

  /** Every version in scope, newest first. Read path. */
  daftarRka(filter: FilterRka, ctx: RkaContext): Promise<Rka[]>;

  /** One version with its lines. Read path. */
  bacaRka(rkaId: string, ctx: RkaContext): Promise<RkaLengkap>;

  /**
   * The DISETUJUI version for a scope, or null. Read path.
   * This is the "baseline pembanding" of spec 9.3, resolved in one place so
   * report 24 and the future reports 2 and 13 cannot disagree about it.
   */
  baseline(
    input: { tahun: number; jenis: JenisRka; cabangId: string | null },
    ctx: RkaContext,
  ): Promise<Rka | null>;

  // --- report 24 (PERMISSION_RKA.LAPORAN) ---------------------------------

  /**
   * Spec 10.3 report 24. Uraian, Anggaran, Realisasi, Selisih, persen Capaian,
   * per account / sector / bidang according to `jenis`, monthly or cumulative.
   *
   * Realisation is READ (this file's header). Spec 16 scenario 18 requires the
   * figures to agree with the disbursement reports, so an implementation that
   * sums the source tables with its own predicate is wrong even when it
   * happens to produce the same number today.
   */
  laporanRkaVsRealisasi(
    filter: FilterLaporanRka,
    ctx: RkaContext,
  ): Promise<LaporanRkaVsRealisasi>;

  /**
   * Which source this module WOULD use for a budget type in a given period,
   * without running the report.
   *
   * Exists so the schema gap above is inspectable: a caller (and a test) can
   * ask "is a per-sector figure available for this closed period at all"
   * and get `TIDAK_TERSEDIA` instead of having to provoke an exception, and a
   * UI can grey the button rather than show an error after the click.
   */
  metodeRealisasi(
    input: { periodeId: string; jenis: JenisRka },
    ctx: RkaContext,
  ): Promise<MetodeRealisasi>;
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * The one implementation site. `deps` flows straight through to ./service.ts,
 * which is private to this module.
 *
 * The import at the top closes a cycle (contract -> service -> kesalahan ->
 * contract), which is safe as long as neither ./service.ts nor ./kesalahan.ts
 * touches a runtime binding of this file at module-evaluation time.
 * ./kesalahan.ts keys its message catalogue with string literals for exactly
 * that reason.
 */
export function createRkaEngine(deps: RkaEngineDeps): RkaEngine {
  return buatEngineRka(deps);
}
