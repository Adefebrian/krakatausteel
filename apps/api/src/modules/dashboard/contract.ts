// apps/api/src/modules/dashboard/contract.ts
//
// THE DASHBOARD MODULE'S ONLY SHAPE. Spec 11.
//
// ---------------------------------------------------------------------------
// RULE 1: EVERY NUMBER IS DRILLABLE, OR IT IS NOT SHOWN.
// ---------------------------------------------------------------------------
// Spec 11's own words: "Semua angka wajib bisa diklik untuk drill down ke
// laporan atau daftar data sumbernya. Angka yang tidak bisa ditelusuri asalnya
// tidak dipercaya user."
//
// That is a structural requirement, not a UI note, so it is expressed in the
// TYPE: every `Metrik`, every `BarisKolektibilitas` and every `BarisAntrian`
// carries a `rincian` key, and `rincian(kunci)` returns the underlying rows
// WITH THEIR IDS. `./dashboard-drilldown.test.ts` sweeps every key the summary
// emits and fails if one of them does not answer, so a metric cannot be added
// without its drill-down.
//
// ---------------------------------------------------------------------------
// RULE 2: A CLOSED PERIOD IS READ FROZEN. NEVER RECOMPUTED. NEVER FALLEN BACK.
// ---------------------------------------------------------------------------
// Spec 10's technical rule ("Laporan untuk periode CLOSED dibaca dari
// `saldo_akun_periode` dan `kolektibilitas_snapshot`, bukan dihitung ulang")
// binds the dashboard too, and more sharply: the dashboard is the first screen
// anybody opens, so a dashboard that recomputes a closed month from live rows
// disagrees with the statements for that month, and that is the single most
// common way this class of system loses the accounting team.
//
//   OPEN period    -> `v_ledger_baris` (money) and the live sub ledger
//                     (`pumk_akad`, `pumk_angsuran`, `pumk_jadwal_angsuran`).
//   CLOSED period  -> `saldo_akun_periode` (money) and
//                     `kolektibilitas_snapshot` (the portfolio).
//
// NEVER a POSTED-only filter, in either case: ADR 0010 and migrations/0018, a
// REVERSED journal is still in the ledger and its lines are offset by its
// reversal's. `v_ledger_baris` states that predicate once and this module
// reads the view rather than restating it.
//
// AND NEVER A FALLBACK. A CLOSED period whose `saldo_akun_periode` rows are
// missing is a period whose freeze did not happen. The metric is answered with
// `nilai: null` and `alasanKosong: "SALDO_PERIODE_BELUM_DIBEKUKAN"`, not with
// a live recomputation that looks identical today and different after a
// reopen. `Metrik.sumber` says which artefact answered, so a test can assert
// WHICH ONE was read rather than only that the figure happened to match: two
// sources agree on well-behaved data, so an equality assertion alone passes on
// an implementation that got the rule backwards.
//
// ---------------------------------------------------------------------------
// RULE 3: THIS MODULE INVENTS NO DEFINITION THAT ANOTHER MODULE OWNS.
// ---------------------------------------------------------------------------
// Three figures on this page belong to somebody else, and each is obtained
// through a PORT that the owning engine satisfies structurally, never
// re-derived here:
//
//   - "LPJ terlambat" is `batasan.batas_hari_lpj_non_pumk` applied to the last
//     disbursement date. modules/nonpumk owns it (`monitoringLpj`), the
//     threshold is CONFIGURATION, and a second copy of the comparison here
//     would drift the day somebody changes the parameter.
//   - "the closing checklist" is spec 8.4's ten checks. modules/closing owns
//     them (`periksaPrasyarat`), and a dashboard that re-listed them would be
//     a second opinion about whether a month may be closed.
//   - "which RKA version is the baseline" is spec 9.3's baseline pembanding.
//     modules/rka owns it (`baseline`), resolved in ONE place so report 24 and
//     this page cannot disagree about which document a branch is measured
//     against. What this module does with the baseline's LINES is arithmetic;
//     what it does not do is decide which document they came from.
//
// The ports are declared HERE and are structurally satisfied by those engines,
// so this file imports none of them: no cycle, no deep import, and a module
// being edited elsewhere cannot break this one by moving a file.
//
// Every port is OPTIONAL. The engine must be constructible with a database and
// nothing else (the fixtures do exactly that), and an absent port produces
// `alasanKosong: "SUMBER_TIDAK_TERPASANG"` rather than a zero that reads as
// "there is nothing to do today".
//
// ---------------------------------------------------------------------------
// RULE 4: A NUMBER THE CALLER MAY NOT SEE IS ABSENT, NOT ZERO.
// ---------------------------------------------------------------------------
// `dashboard.view` is held by every role. `admin.rka.view` and
// `admin.closing.view` are not: they are evidence codes, granted deliberately.
// So a MAKER opening this page gets the budget metric as `nilai: null` with
// `alasanKosong: "IZIN_TIDAK_DIMILIKI"` and the closing checklist as null with
// the same reason. Returning zero would both leak nothing and lie; returning
// the figure would leak the budget to a role the catalogue keeps it from.
import type { DbPort } from "../../core/ports/db";
import { buatEngineDashboard } from "./service";

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Decimal string, exactly two fractional digits. Never a JS number. */
export type Uang = string;
export const POLA_UANG = /^-?\d{1,18}\.\d{2}$/;

/** Percentage, two decimals, as a string for the same reason money is. */
export type Persen = string;
export const POLA_PERSEN = /^-?\d{1,10}\.\d{2}$/;

/** Mirrors the CHECK on `periode.status` (migrations/0007). */
export type StatusPeriode = "OPEN" | "CLOSING_IN_PROGRESS" | "CLOSED";

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const PERMISSION_DASHBOARD = {
  /** The page itself. Every role holds it (modules/auth `READ_ONLY`). */
  LIHAT: "dashboard.view",
  /**
   * The RKA baseline the Non PUMK effectiveness metric is measured against.
   * NOT held by MAKER, CHECKER or APPROVER: it is an evidence code granted to
   * AUDITOR, ADMIN_CABANG and ADMIN_PUSAT. A caller without it gets the metric
   * as null with a reason, never as zero.
   */
  RKA: "admin.rka.view",
  /** The closing checklist panel. Same treatment. */
  CLOSING: "admin.closing.view",
  /**
   * The LPJ overdue count, which `PorterNonPumkDashboard` answers.
   *
   * ADDED WHILE IMPLEMENTING, and it is a correction rather than a widening.
   * `NonPumkEngine.monitoringLpj` gates itself on `nonpumk.view`, so a caller
   * without it does not get "no overdue reports": it gets a `NonPumkError`
   * thrown out of the middle of this module's `ringkasan`, which would take
   * the whole page down over ONE panel row. Rule 4 in this file's header is
   * the rule that decides it -- a number the caller may not see is ABSENT,
   * with `IZIN_TIDAK_DIMILIKI`, not an exception and not a zero.
   *
   * Every role holds it today (modules/auth `READ_ONLY`), so the guard fires
   * for nobody; it exists because the day the catalogue narrows the code, the
   * failure mode without it is a 500 on the landing screen.
   */
  NONPUMK: "nonpumk.view",
} as const;

export type PermissionDashboard =
  (typeof PERMISSION_DASHBOARD)[keyof typeof PERMISSION_DASHBOARD];

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const KODE_DASHBOARD = {
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
  CABANG_TIDAK_DITEMUKAN: "CABANG_TIDAK_DITEMUKAN",
  IZIN_BELUM_TERDAFTAR: "IZIN_BELUM_TERDAFTAR",
  /** No period matches the request, and none may be invented. */
  PERIODE_TIDAK_ADA: "PERIODE_TIDAK_ADA",
  /** A drill-down key the catalogue does not carry. */
  RINCIAN_TIDAK_DIKENAL: "RINCIAN_TIDAK_DIKENAL",
} as const;

export type KodeDashboard = (typeof KODE_DASHBOARD)[keyof typeof KODE_DASHBOARD];

/**
 * The one error type this module raises. Listed in `NAMA_ERROR_BERKODE` in
 * core/http.ts, because four modules shipped without being listed and every
 * refusal each of them made left an anonymous 500 with no DITOLAK row.
 */
export class DashboardError extends Error {
  readonly kode: KodeDashboard;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly penyebabDb?: string;

  constructor(
    kode: KodeDashboard,
    message: string,
    detail: Record<string, unknown> = {},
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "DashboardError";
    this.kode = kode;
    this.detail = Object.freeze({ ...detail });
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// Where a number came from, and why one is missing
// ---------------------------------------------------------------------------

/**
 * WHICH SHIPPED ARTEFACT ANSWERED. Never decoration, and never a guess: see
 * rule 2 in this file's header for why an equality assertion cannot replace it.
 */
export type SumberAngka =
  /** The frozen trial balance of a CLOSED period (migrations/0011). */
  | "SALDO_AKUN_PERIODE"
  /** The frozen portfolio of a CLOSED period (migrations/0011). */
  | "KOLEKTIBILITAS_SNAPSHOT"
  /** The live ledger of an OPEN period, ADR 0010's predicate (migrations/0018). */
  | "V_LEDGER_BARIS"
  /** The live business tables: `pumk_akad`, `pumk_angsuran`, `pumk_jadwal_angsuran`. */
  | "SUB_LEDGER"
  /** `rka` / `rka_detail`, on the baseline modules/rka resolved. */
  | "RKA"
  /** A count of documents waiting in a state machine. */
  | "PROSES";

/**
 * WHY A NUMBER IS ABSENT. Every one of these is a refusal to guess, and the
 * page renders the reason instead of a zero. A zero on a dashboard is a
 * statement of fact ("nothing happened"), and the six cases below are all
 * "this system cannot answer that today".
 */
export type AlasanKosong =
  /** The caller does not hold the evidence code the figure sits behind. */
  | "IZIN_TIDAK_DIMILIKI"
  /** The period is CLOSED and `saldo_akun_periode` holds nothing for it. */
  | "SALDO_PERIODE_BELUM_DIBEKUKAN"
  /** No `kolektibilitas_snapshot` for this period, so no classification exists. */
  | "KOLEKTIBILITAS_BELUM_DIJALANKAN"
  /** modules/rka reports no approved version for this scope and year. */
  | "BASELINE_RKA_TIDAK_ADA"
  /** The baseline exists but carries no line for the reported month. */
  | "ANGGARAN_TIDAK_PER_BULAN"
  /** A ratio whose denominator is zero. Not "0 percent", and not infinity. */
  | "PEMBAGI_NOL"
  /**
   * `event_jurnal_mapping` names no account for the event the figure is
   * defined in terms of, so there is no account whose movement to read.
   *
   * ADDED WHILE IMPLEMENTING. `PENYALURAN_PUMK` is "debit movement on the
   * receivable", and WHICH account the receivable is comes from the sanctioned
   * event mapping (invariant 11), never from a hard coded `1.1.03` in this
   * module. modules/tools REFUSES outright in the same situation
   * (`MAPPING_PIUTANG_TIDAK_ADA`), which is right for a reconciliation whose
   * entire product is that one comparison, and wrong here: a landing page that
   * 409s in full because one of eleven metrics has no account is a page that
   * hides ten answers it does have.
   */
  | "PEMETAAN_AKUN_BELUM_ADA"
  /** The owning module's port was not wired into this engine. */
  | "SUMBER_TIDAK_TERPASANG";

export type JenisAngka = "UANG" | "CACAH" | "PERSEN";

// ---------------------------------------------------------------------------
// The metric catalogue
// ---------------------------------------------------------------------------

export const METRIK_DASHBOARD = {
  /** Spec 11 KPI "Saldo Kas dan Setara Kas": closing balance of `akun.is_kas`. */
  DANA_TERSEDIA: "DANA_TERSEDIA",
  /** PUMK plus Non PUMK channelled in the reported month. */
  DANA_TERSALUR: "DANA_TERSALUR",
  /** Spec 11 KPI "Realisasi Penyaluran PUMK": debit movement on the receivable. */
  PENYALURAN_PUMK: "PENYALURAN_PUMK",
  /** Spec 11 KPI "Realisasi Penyaluran Non PUMK", NET of post-LPJ refunds. */
  REALISASI_NON_PUMK: "REALISASI_NON_PUMK",
  /** Spec 11 KPI "Outstanding Piutang PUMK". */
  OUTSTANDING_PUMK: "OUTSTANDING_PUMK",
  /** Spec 11 KPI "Jumlah Mitra Binaan Aktif". */
  MITRA_AKTIF: "MITRA_AKTIF",
  /** Spec 11 KPI "Rasio Kolektibilitas Lancar (persen)". */
  RASIO_KOLEKTIBILITAS_LANCAR: "RASIO_KOLEKTIBILITAS_LANCAR",
  /** Spec 11 KPI "Tingkat Pengembalian": angsuran diterima / jatuh tempo. */
  TINGKAT_PENGEMBALIAN: "TINGKAT_PENGEMBALIAN",
  /** The Non PUMK budget for the reported month, from the RKA baseline. */
  ANGGARAN_NON_PUMK: "ANGGARAN_NON_PUMK",
  /** Spec 11 KPI "Efektivitas Penyaluran": realisasi / anggaran, Non PUMK. */
  EFEKTIVITAS_NON_PUMK: "EFEKTIVITAS_NON_PUMK",
  /** Spec 11 panel 7's overdue row. Counted by modules/nonpumk, not here. */
  LPJ_TERLAMBAT: "LPJ_TERLAMBAT",
} as const;

export type KunciMetrik = (typeof METRIK_DASHBOARD)[keyof typeof METRIK_DASHBOARD];

export interface Metrik {
  kunci: KunciMetrik;
  /** Indonesian, the wording spec 11 uses. */
  nama: string;
  jenis: JenisAngka;
  /**
   * The figure, as a STRING. Money is two decimals, a percentage is two
   * decimals, a count is an integer. NULL means "this system cannot answer
   * that", and `alasanKosong` says which of the six reasons applies.
   */
  nilai: string | null;
  /** Which artefact answered. Null exactly when `nilai` is null. */
  sumber: SumberAngka | null;
  alasanKosong: AlasanKosong | null;
  /**
   * The drill-down key, for `rincian(...)`. Null only when the figure itself
   * is null: an absent number has no rows behind it, and offering a link that
   * answers with nothing is worse than offering none.
   */
  rincian: string | null;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/** Spec 11 panel 3, "Komposisi kolektibilitas". */
export interface BarisKolektibilitas {
  kelas: string;
  namaKelas: string;
  /**
   * `kolektibilitas_kelas.is_bermasalah`, READ from the table rather than
   * decided here.
   *
   * This comment used to say "true for KURANG_LANCAR, DIRAGUKAN, MACET". The
   * shipped reference set (migrations/0004) says otherwise: KURANG_LANCAR is
   * `is_bermasalah = false`, and only DIRAGUKAN and MACET are true. The table
   * wins -- `mitra.status = BERMASALAH` is driven off that same column in
   * spec 8.1 step 7, so a second opinion here would put a partner in the
   * dashboard's problem bucket and not in the one the closing run wrote.
   */
  bermasalah: boolean;
  jumlahAkad: number;
  outstandingPokok: Uang;
  /** Share of the portfolio's outstanding, two decimals. Null when it is zero. */
  persen: Persen | null;
  rincian: string;
}

/**
 * Spec 11 panel 7, "Antrian Kerja Saya". The stage a document is waiting at,
 * with the permission whose holder acts on it.
 */
export const TAHAP_ANTRIAN = {
  PUMK_SURVEY: "PUMK_SURVEY",
  PUMK_REVIEW: "PUMK_REVIEW",
  PUMK_PERSETUJUAN: "PUMK_PERSETUJUAN",
  PUMK_AKAD: "PUMK_AKAD",
  PUMK_PENCAIRAN: "PUMK_PENCAIRAN",
  NONPUMK_PENILAIAN: "NONPUMK_PENILAIAN",
  NONPUMK_REVIEW: "NONPUMK_REVIEW",
  NONPUMK_PERSETUJUAN: "NONPUMK_PERSETUJUAN",
  NONPUMK_PENYALURAN: "NONPUMK_PENYALURAN",
  NONPUMK_LPJ_VERIFIKASI: "NONPUMK_LPJ_VERIFIKASI",
} as const;

export type TahapAntrian = (typeof TAHAP_ANTRIAN)[keyof typeof TAHAP_ANTRIAN];

export interface BarisAntrian {
  tahap: TahapAntrian;
  nama: string;
  /** The canonical permission whose holder is the one who acts on this stage. */
  izin: string;
  jumlah: number;
  /**
   * True when THIS caller holds `izin`. Spec 11: "dokumen yang menunggu aksi
   * user yang login". The whole queue is still returned, because a branch
   * manager needs to see what their branch is waiting on even where they are
   * not the actor; `hanyaMilikSaya` narrows it.
   */
  milikSaya: boolean;
  rincian: string;
}

/** Spec 11 panel 10, "Status closing periode berjalan dengan checklist". */
export interface BarisPrasyaratDashboard {
  nomor: number;
  kode: string;
  status: string;
  alasan: string;
}

export interface StatusClosingDashboard {
  periodeId: string;
  status: StatusPeriode;
  /** ISO timestamp, or null while the period is not closed. */
  closedAt: string | null;
  /** Null when the caller lacks `admin.closing.view`, or no port is wired. */
  prasyarat: {
    boleh: boolean;
    perluKonfirmasi: boolean;
    hasil: BarisPrasyaratDashboard[];
  } | null;
  alasanKosong: AlasanKosong | null;
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export interface PeriodeDashboard {
  id: string;
  tahun: number;
  bulan: number;
  status: StatusPeriode;
  tanggalMulai: string;
  tanggalAkhir: string;
}

export interface CabangDashboard {
  id: string;
  kode: string;
  nama: string;
}

export interface RingkasanDashboard {
  /** ISO timestamp from the injected clock. */
  dibuatPada: string;
  periode: PeriodeDashboard;
  /**
   * WHICH SOURCE THE MONEY FIGURES CAME FROM, decided once from the period's
   * own status and never from the request. A caller cannot ask for a live
   * reading of a closed month.
   */
  sumberPeriode: "SALDO_AKUN_PERIODE" | "V_LEDGER_BARIS";
  /** The branch filter that was applied, or null for "every branch in scope". */
  cabangId: string | null;
  /** The branches actually covered. */
  cabangDilaporkan: CabangDashboard[];
  metrik: Metrik[];
  kolektibilitas: BarisKolektibilitas[];
  /** Null with a reason when no snapshot exists for the period. */
  alasanKolektibilitasKosong: AlasanKosong | null;
  antrian: BarisAntrian[];
  closing: StatusClosingDashboard;
}

export interface FilterDashboard {
  /** Absent means the entity's newest OPEN period, else its newest period. */
  periodeId?: string | null;
  tahun?: number | null;
  bulan?: number | null;
  /**
   * A FILTER, never authority. Intersected with the branches the SESSION
   * resolved; a branch outside that set is REFUSED, not answered with an empty
   * page (spec 2 rule 3, spec 16 scenario 24).
   */
  cabangId?: string | null;
  /** Spec 11 panel 7: show only the stages this caller may act on. */
  hanyaMilikSaya?: boolean | null;
}

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

/**
 * One underlying record. Uniform across every metric so the page renders one
 * table and a caller can always follow the id.
 *
 * `nilai` is the amount THIS ROW contributes to the metric, so the rows add up
 * to the number that was clicked. Every money value is a string, for the reason
 * invariant 7 exists.
 */
export interface BarisRincian {
  id: string;
  /** What `id` names: 'jurnal', 'pumk_akad', 'pumk_proposal', 'rka_detail', ... */
  entitas: string;
  label: string;
  cabangId: string | null;
  /** ISO date, when the row has one. */
  tanggal: string | null;
  nilai: Uang | null;
  fakta: Readonly<Record<string, string | null>>;
}

export interface RincianDashboard {
  kunci: string;
  nama: string;
  sumber: SumberAngka;
  jumlah: number;
  /** Sum of `nilai` over ALL matching rows, not only the returned page. */
  total: Uang | null;
  baris: BarisRincian[];
  terpotong: boolean;
}

export const BATAS_RINCIAN_BAWAAN = 50;
export const BATAS_RINCIAN_MAKS = 500;

export interface FilterRincian extends FilterDashboard {
  batasBaris?: number | null;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type DashboardDbPort = DbPort;

export interface DashboardContext {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  cabangDalamScope?: readonly string[];
}

/**
 * modules/rka's baseline resolution, narrowed to what this page needs.
 * Structurally satisfied by `RkaEngine`, so nothing here imports that module.
 */
export interface PorterRkaDashboard {
  baseline(
    input: { tahun: number; jenis: "PUMK" | "NON_PUMK" | "KEUANGAN"; cabangId: string | null },
    ctx: DashboardContext,
  ): Promise<{ id: string; versi: number; status: string } | null>;
}

/**
 * modules/nonpumk's LPJ monitoring, narrowed. Structurally satisfied by
 * `NonPumkEngine`. The `terlambat` flag is THEIRS: it compares the age of the
 * last disbursement against `batasan.batas_hari_lpj_non_pumk`, which is
 * configuration, and a second copy of that comparison in this module would
 * drift the day the parameter changes.
 */
export interface PorterNonPumkDashboard {
  monitoringLpj(
    filter: { cabangId?: string | null; hanyaTerlambat?: boolean },
    ctx: DashboardContext,
  ): Promise<
    ReadonlyArray<{
      proposalId: string;
      noProposal: string;
      cabangId: string;
      namaPemohon: string;
      judulProgram: string;
      totalDisalurkan: string;
      tanggalPenyaluranTerakhir: string;
      umurHari: number;
      terlambat: boolean;
    }>
  >;
}

/**
 * modules/closing's spec 8.4 checklist, narrowed. Structurally satisfied by
 * `ClosingEngine`.
 */
export interface PorterClosingDashboard {
  periksaPrasyarat(
    periodeId: string,
    ctx: DashboardContext,
  ): Promise<{
    boleh: boolean;
    perluKonfirmasi: boolean;
    hasil: ReadonlyArray<{
      nomor: number;
      kode: string;
      status: string;
      alasan: string;
    }>;
  }>;
}

export interface DashboardEngineDeps {
  db: DashboardDbPort;
  /** Injectable clock, so `dibuatPada` is deterministic under test. */
  jam?: () => Date;
  rka?: PorterRkaDashboard;
  nonpumk?: PorterNonPumkDashboard;
  closing?: PorterClosingDashboard;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * NO JOURNAL PORT AND NO AUDIT PORT. Every method is a SELECT (plus, for three
 * figures, a read through another engine's read-only method), so invariant 11
 * is unreachable from here rather than merely respected. A dashboard is the
 * one screen in the system with no reason ever to write.
 */
export interface DashboardEngine {
  /** The period picker, newest first. Needs `dashboard.view`. */
  daftarPeriode(
    filter: { tahun?: number | null },
    ctx: DashboardContext,
  ): Promise<PeriodeDashboard[]>;

  /** Spec 11's whole page in one call. Needs `dashboard.view`. */
  ringkasan(filter: FilterDashboard, ctx: DashboardContext): Promise<RingkasanDashboard>;

  /**
   * The rows behind one number. `kunci` is a value the summary emitted, so a
   * client never constructs one; an unknown key is refused with
   * `RINCIAN_TIDAK_DIKENAL` rather than answered with an empty list, because
   * an empty list reads as "there is nothing there".
   */
  rincian(
    kunci: string,
    filter: FilterRincian,
    ctx: DashboardContext,
  ): Promise<RincianDashboard>;
}

/** The one implementation site. `deps` flows through to ./service.ts. */
export function createDashboardEngine(deps: DashboardEngineDeps): DashboardEngine {
  return buatEngineDashboard(deps);
}
