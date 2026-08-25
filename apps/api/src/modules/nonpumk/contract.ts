// apps/api/src/modules/nonpumk/contract.ts
//
// FASE 4, MODUL NON PUMK (spec 9.2). Types, error codes, the state machine AS
// DATA, and the factory the composition root calls.
//
// THIS FILE IS THE SPECIFICATION AND THE PUBLIC SHAPE, NOT THE BEHAVIOUR. It
// was written BEFORE the engine so the tests in this folder could be written
// first and fail for the RIGHT reason. The behaviour now lives in ./service.ts
// and `createNonPumkEngine` is a one-line delegation to it; nothing else in the
// repo changed on the day it landed. Same arrangement as modules/pumk,
// modules/jurnal and modules/angsuran.
//
// WHAT THIS MODULE IS
// The grant line (spec 1: "Hibah / bantuan sosial dan lingkungan", no
// repayment, but a mandatory LPJ). It owns the proposal state machine of spec
// 9.2, the authorisation and segregation rules of spec 2, the assessment, the
// STAGED disbursement, the LPJ and the late-LPJ ageing view. It owns NO
// arithmetic that belongs to another engine and NO ledger SQL:
//   - every journal goes through `modules/jurnal` (invariant 11), reached as a
//     PORT declared at the bottom of this file which `JurnalEngine` satisfies
//     structurally, so the composition root wires
//     `createNonPumkModule({ db, jurnal: jurnal.engine })` with no adapter in
//     between and there is no way for this module to write a journal row.
//   - there is no instalment engine here at all: a grant has no schedule, no
//     receivable and no kolektibilitas. That absence is deliberate and is why
//     this module's port list is one entry long.
//
// WHY THE TESTS HIT REAL POSTGRES AND THE REAL LEDGER ENGINE
// migrations/0009_nonpumk.sql, 0010 and 0020 already enforce most of what
// matters here, and this module's job is to produce a CLEAN DOMAIN ERROR
// AHEAD of each of them:
//   - segregation of duties as triggers on nonpumk_review / nonpumk_approval
//     (TJSL-SOD-001 / TJSL-SOD-002, the same trigger FUNCTIONS as PUMK,
//     parameterised with this module's table names);
//   - SUM(nonpumk_penyaluran.jumlah) <= nonpumk_proposal.jumlah_disetujui as a
//     DEFERRED constraint trigger (TJSL-NPK-002), which fires at COMMIT;
//   - realisasi + sisa dikembalikan = total disbursed (TJSL-NPK-003), also
//     deferred, also at COMMIT;
//   - real, NON-DEFERRABLE foreign keys from `nonpumk_penyaluran.jurnal_id`
//     and `nonpumk_lpj.jurnal_id_pengembalian` to `jurnal` (migrations/0010),
//     so a test double that returned a synthetic uuid for a journal would
//     raise 23503 in production while the suite stayed green;
//   - the posting-path tripwire (TJSL-JRN-015, migrations/0020), which means
//     no fixture in this folder can hand-write a journal row even if it wanted
//     to.
// See the header of ./test-support.ts for the rule that follows: a double may
// stand in for a collaborator's FAILURE, never for its VALIDATION.
import type { DimensiBaris, Jurnal, JurnalContext, Uang } from "../jurnal/index";
import { buatEngineNonPumk } from "./service";

export type { Uang };

// ---------------------------------------------------------------------------
// Permission vocabulary
// ---------------------------------------------------------------------------

/**
 * The permission each operation checks. EVERY STRING HERE MUST BE A CANONICAL
 * CODE in modules/auth/permissions.ts; the engine is required to resolve them
 * through `canonicalPermission` and to refuse an unresolvable one with
 * `IZIN_BELUM_TERDAFTAR` rather than checking a string no role can ever hold.
 * A fixture that invents a permission vocabulary the app lacks is how a real
 * authorisation bug stays hidden, so the tests assert the FAIL-CLOSED
 * behaviour instead of inventing the code.
 *
 * FINDING (reported, not worked around): spec 4.5 gives `nonpumk_lpj` a
 * `status = DIVERIFIKASI` with `verified_by` / `verified_at`, and
 * docs/BUILD-PLAN.md's Fase 4 exit criterion is "satu proposal jalan sampai
 * LPJ DIVERIFIKASI". The shipped catalogue has no code for that act.
 * `nonpumk.lpj.verifikasi` below is therefore deliberately NOT in PERMISSIONS,
 * and both `verifikasiLpj` and `tolakLpj` must fail closed until the catalogue
 * owner adds it. Do not silently reuse one of the three that do exist:
 *   - `nonpumk.lpj` is granted to MAKER and means "input the LPJ", so reusing
 *     it lets the very person who wrote the accountability report sign it off,
 *     which is spec 2 rule 1 with the serial numbers filed off;
 *   - `nonpumk.review` is the PROPOSAL review code, held by CHECKER and not by
 *     APPROVER, and accepting an LPJ is a different control from recommending
 *     a grant;
 *   - `nonpumk.approve` is the decision to GIVE the money, taken months
 *     earlier by a different person on different evidence; merging the two
 *     means one grant of authority covers both ends of the same transaction.
 * This is the same shape of finding as `pumk.cluster`, which was filed rather
 * than worked around and then fixed in the catalogue.
 */
export const PERMISSION_NONPUMK = {
  VIEW: "nonpumk.view",
  CREATE: "nonpumk.create",
  PENILAIAN: "nonpumk.penilaian",
  REVIEW: "nonpumk.review",
  APPROVE: "nonpumk.approve",
  PENYALURAN: "nonpumk.penyaluran",
  /** Submitting (and resubmitting) the LPJ. Held by MAKER. */
  LPJ: "nonpumk.lpj",
  /** NOT in the auth catalogue. See the note above; must fail closed. */
  LPJ_VERIFIKASI: "nonpumk.lpj.verifikasi",
} as const;

// ---------------------------------------------------------------------------
// Configuration this module READS. Never a hardcoded policy number.
// ---------------------------------------------------------------------------

/**
 * Spec 5's preamble makes every parameter the client's decision, and
 * docs/BUILD-PLAN.md "Keputusan sementara" plus OPEN-QUESTIONS.md record that
 * none of the Non PUMK limits has been decided. So the engine READS these rows
 * and the tests assert the MECHANIC (change the row, the behaviour changes)
 * and NEVER the value.
 *
 * NONE OF THESE KEYS IS SHIPPED IN migrations/0004. That is itself a finding
 * (reported): spec 5.5 "Batasan Program" lists only PUMK limits. Until the
 * rows exist the engine must refuse with `KONFIGURASI_TIDAK_ADA` rather than
 * fall back to a literal, which is what ./nonpumk-fixture.test.ts pins and
 * what ./test-support.ts seeds per world so the other tests have something to
 * read.
 */
export const KUNCI_KONFIGURASI_NONPUMK = {
  /** Below this assessment score a proposal cannot be recommended. */
  SKOR_MINIMUM: { grup: "batasan", kunci: "skor_penilaian_minimum_lolos_non_pumk" },
  /** Smallest and largest grant this module will accept on a proposal. */
  NILAI_MIN: { grup: "batasan", kunci: "nilai_min_non_pumk" },
  NILAI_MAX: { grup: "batasan", kunci: "nilai_max_non_pumk" },
  /**
   * Days after the LAST disbursement by which the LPJ is due. Drives
   * `terlambat` on the monitoring rows; the 30/60/90 ageing buckets are the
   * spec's and are NOT configurable.
   */
  BATAS_HARI_LPJ: { grup: "batasan", kunci: "batas_hari_lpj_non_pumk" },
} as const;

/**
 * Spec 9.2: "Dashboard monitoring LPJ yang terlambat, dengan aging (30, 60, 90
 * hari sejak penyaluran)". The three thresholds come from the SPEC, not from
 * `konfigurasi`, so they are a constant here and the tests assert them AT the
 * boundary (29/30, 59/60, 89/90) rather than in the middle of a bucket.
 */
export const AMBANG_UMUR_LPJ = [30, 60, 90] as const;

// ---------------------------------------------------------------------------
// The state machine of spec 9.2, AS DATA
// ---------------------------------------------------------------------------

export type StatusProposalNonPumk =
  | "DRAFT"
  | "PENILAIAN"
  | "REVIEW_CHECKER"
  | "MENUNGGU_PERSETUJUAN"
  | "DISETUJUI"
  | "DISALURKAN"
  | "MENUNGGU_LPJ"
  | "LPJ_DIAJUKAN"
  | "SELESAI"
  | "TIDAK_DIREKOMENDASIKAN"
  | "DITOLAK"
  | "LPJ_DITOLAK";

/** Written verbatim to `nonpumk_proposal_transisi.aksi`. */
export type AksiNonPumk =
  | "AJUKAN_PENILAIAN"
  | "INPUT_PENILAIAN"
  | "REKOMENDASI"
  | "TIDAK_REKOMENDASI"
  | "MINTA_PERBAIKAN"
  | "SETUJU"
  | "TOLAK"
  | "KEMBALIKAN"
  | "PENYALURAN"
  | "TUTUP_PENYALURAN"
  | "AJUKAN_LPJ"
  | "VERIFIKASI_LPJ"
  | "TOLAK_LPJ";

export interface DefinisiTransisiNonPumk {
  dari: StatusProposalNonPumk;
  aksi: AksiNonPumk;
  ke: StatusProposalNonPumk;
  /** The permission the actor must hold for this transition. */
  izin: string;
  /** `catatan` is mandatory on the transitions that reject or send back. */
  catatanWajib: boolean;
}

/**
 * Spec 9.2's diagram, transcribed, as the single source of truth for both the
 * engine and the tests. A table rather than a switch for the same reason the
 * kolektibilitas ranges are a table (spec 5.1): a reviewer can diff it against
 * the spec line by line, and a missing edge is visible instead of buried in
 * control flow.
 *
 * THREE EDGES THE SPEC'S ONE-LINE DIAGRAM LEAVES IMPLICIT, made explicit here
 * because "penyaluran bisa bertahap" cannot be expressed without them:
 *
 *   DISALURKAN -PENYALURAN-> DISALURKAN   the second and later termin. Without
 *       the self loop, a multi-termin grant would have to leave and re-enter
 *       the state, or the second termin would be an unguarded write.
 *   DISALURKAN -TUTUP_PENYALURAN-> MENUNGGU_LPJ   "no further termin, the LPJ
 *       clock starts". The spec draws DISALURKAN -> MENUNGGU_LPJ as one arrow;
 *       with staged disbursement something has to decide that the staging is
 *       over, and leaving it implicit would mean the ageing of spec 9.2 starts
 *       counting while money is still going out.
 *   LPJ_DITOLAK -AJUKAN_LPJ-> LPJ_DIAJUKAN   the spec's own parenthesis,
 *       "LPJ_DITOLAK (kembali ke LPJ_DIAJUKAN)".
 *
 * TERMINAL: TIDAK_DIREKOMENDASIKAN, DITOLAK and SELESAI have no outgoing edge.
 */
export const TRANSISI_SAH_NON_PUMK: readonly DefinisiTransisiNonPumk[] = [
  { dari: "DRAFT", aksi: "AJUKAN_PENILAIAN", ke: "PENILAIAN", izin: PERMISSION_NONPUMK.CREATE, catatanWajib: false },
  { dari: "PENILAIAN", aksi: "INPUT_PENILAIAN", ke: "REVIEW_CHECKER", izin: PERMISSION_NONPUMK.PENILAIAN, catatanWajib: false },
  { dari: "REVIEW_CHECKER", aksi: "REKOMENDASI", ke: "MENUNGGU_PERSETUJUAN", izin: PERMISSION_NONPUMK.REVIEW, catatanWajib: false },
  { dari: "REVIEW_CHECKER", aksi: "TIDAK_REKOMENDASI", ke: "TIDAK_DIREKOMENDASIKAN", izin: PERMISSION_NONPUMK.REVIEW, catatanWajib: true },
  { dari: "REVIEW_CHECKER", aksi: "MINTA_PERBAIKAN", ke: "PENILAIAN", izin: PERMISSION_NONPUMK.REVIEW, catatanWajib: true },
  { dari: "MENUNGGU_PERSETUJUAN", aksi: "SETUJU", ke: "DISETUJUI", izin: PERMISSION_NONPUMK.APPROVE, catatanWajib: false },
  { dari: "MENUNGGU_PERSETUJUAN", aksi: "TOLAK", ke: "DITOLAK", izin: PERMISSION_NONPUMK.APPROVE, catatanWajib: true },
  { dari: "MENUNGGU_PERSETUJUAN", aksi: "KEMBALIKAN", ke: "REVIEW_CHECKER", izin: PERMISSION_NONPUMK.APPROVE, catatanWajib: true },
  { dari: "DISETUJUI", aksi: "PENYALURAN", ke: "DISALURKAN", izin: PERMISSION_NONPUMK.PENYALURAN, catatanWajib: false },
  { dari: "DISALURKAN", aksi: "PENYALURAN", ke: "DISALURKAN", izin: PERMISSION_NONPUMK.PENYALURAN, catatanWajib: false },
  { dari: "DISALURKAN", aksi: "TUTUP_PENYALURAN", ke: "MENUNGGU_LPJ", izin: PERMISSION_NONPUMK.PENYALURAN, catatanWajib: false },
  { dari: "MENUNGGU_LPJ", aksi: "AJUKAN_LPJ", ke: "LPJ_DIAJUKAN", izin: PERMISSION_NONPUMK.LPJ, catatanWajib: false },
  { dari: "LPJ_DIAJUKAN", aksi: "VERIFIKASI_LPJ", ke: "SELESAI", izin: PERMISSION_NONPUMK.LPJ_VERIFIKASI, catatanWajib: false },
  { dari: "LPJ_DIAJUKAN", aksi: "TOLAK_LPJ", ke: "LPJ_DITOLAK", izin: PERMISSION_NONPUMK.LPJ_VERIFIKASI, catatanWajib: true },
  { dari: "LPJ_DITOLAK", aksi: "AJUKAN_LPJ", ke: "LPJ_DIAJUKAN", izin: PERMISSION_NONPUMK.LPJ, catatanWajib: false },
];

export const STATUS_TERMINAL_NON_PUMK: readonly StatusProposalNonPumk[] = [
  "TIDAK_DIREKOMENDASIKAN",
  "DITOLAK",
  "SELESAI",
];

/** The valid target of `aksi` from `dari`, or null when the edge does not exist. */
export function transisiNonPumkUntuk(
  dari: StatusProposalNonPumk,
  aksi: AksiNonPumk,
): DefinisiTransisiNonPumk | null {
  return TRANSISI_SAH_NON_PUMK.find((t) => t.dari === dari && t.aksi === aksi) ?? null;
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * Every rejection this module produces carries one of these codes.
 *
 * THE DATABASE ALREADY ENFORCES MUCH OF THIS, and that is the point: the
 * module must produce a CLEAN DOMAIN ERROR AHEAD of the trigger, so a caller
 * never sees `TJSL-NPK-002: total penyaluran (...) melebihi nilai disetujui
 * (...)` or `TJSL-SOD-001`. Both NPK triggers are DEFERRED and fire at COMMIT,
 * which makes the point sharper rather than softer: by the time Postgres
 * objects, the transaction is already unwindable only as a whole and the
 * caller has no idea which of several writes was the offending one.
 */
export const KODE_NONPUMK = {
  // --- lookup
  PROPOSAL_TIDAK_DITEMUKAN: "PROPOSAL_TIDAK_DITEMUKAN",
  BIDANG_TIDAK_DITEMUKAN: "BIDANG_TIDAK_DITEMUKAN",
  SDG_TIDAK_DITEMUKAN: "SDG_TIDAK_DITEMUKAN",
  PENYALURAN_TIDAK_DITEMUKAN: "PENYALURAN_TIDAK_DITEMUKAN",
  LPJ_TIDAK_DITEMUKAN: "LPJ_TIDAK_DITEMUKAN",

  // --- state machine (spec 9.2)
  TRANSISI_TIDAK_VALID: "TRANSISI_TIDAK_VALID",
  STATUS_TERMINAL: "STATUS_TERMINAL",
  CATATAN_WAJIB: "CATATAN_WAJIB",

  // --- proposal input (bounds from konfigurasi, never from code)
  NILAI_DILUAR_BATAS: "NILAI_DILUAR_BATAS",
  /** Spec 9.2: "wajib pemetaan ke bidang Non PUMK dan MINIMAL SATU SDG". */
  SDG_WAJIB: "SDG_WAJIB",
  SDG_DUPLIKAT: "SDG_DUPLIKAT",
  BOBOT_SDG_TIDAK_VALID: "BOBOT_SDG_TIDAK_VALID",
  /** Spec 9.2: estimated at proposal, actual at LPJ. Both mandatory. */
  PENERIMA_MANFAAT_WAJIB: "PENERIMA_MANFAAT_WAJIB",
  NILAI_BUKAN_DESIMAL: "NILAI_BUKAN_DESIMAL",
  TANGGAL_TIDAK_VALID: "TANGGAL_TIDAK_VALID",

  // --- penilaian / review / approval
  PENILAIAN_BELUM_ADA: "PENILAIAN_BELUM_ADA",
  SKOR_DIBAWAH_MINIMUM: "SKOR_DIBAWAH_MINIMUM",
  KEPUTUSAN_TIDAK_VALID: "KEPUTUSAN_TIDAK_VALID",
  NILAI_DISETUJUI_WAJIB: "NILAI_DISETUJUI_WAJIB",
  NILAI_DISETUJUI_MELEBIHI_PENGAJUAN: "NILAI_DISETUJUI_MELEBIHI_PENGAJUAN",

  // --- penyaluran bertahap (spec 9.2)
  /** Ahead of TJSL-NPK-002. Total of all termin would exceed jumlah_disetujui. */
  PLAFON_PENYALURAN_TERLAMPAUI: "PLAFON_PENYALURAN_TERLAMPAUI",
  BELUM_DISETUJUI: "BELUM_DISETUJUI",
  TERMIN_SUDAH_ADA: "TERMIN_SUDAH_ADA",
  AKUN_KAS_TIDAK_VALID: "AKUN_KAS_TIDAK_VALID",
  AKUN_BEBAN_TIDAK_VALID: "AKUN_BEBAN_TIDAK_VALID",

  // --- LPJ
  LPJ_SUDAH_DIAJUKAN: "LPJ_SUDAH_DIAJUKAN",
  LPJ_BELUM_DIAJUKAN: "LPJ_BELUM_DIAJUKAN",
  /** Realisasi larger than what actually went out. Ahead of TJSL-NPK-003. */
  REALISASI_MELEBIHI_PENYALURAN: "REALISASI_MELEBIHI_PENYALURAN",
  /** realisasi + sisa dikembalikan != total disalurkan. Ahead of TJSL-NPK-003. */
  LPJ_TIDAK_REKONSILIASI: "LPJ_TIDAK_REKONSILIASI",

  // --- collaborators
  JURNAL_GAGAL: "JURNAL_GAGAL",

  // --- authorisation (spec 2)
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
  /** Spec 2 rule 1, ahead of trg_nonpumk_review_10_sod (TJSL-SOD-001). */
  KONFLIK_MAKER_CHECKER: "KONFLIK_MAKER_CHECKER",
  /** Spec 2 rule 2, ahead of trg_nonpumk_approval_10_sod (TJSL-SOD-002). */
  KONFLIK_CHECKER_APPROVER: "KONFLIK_CHECKER_APPROVER",
  /**
   * The operation names a permission that is not in the auth catalogue, so no
   * role could ever hold it. Fail closed, never open. See PERMISSION_NONPUMK.
   */
  IZIN_BELUM_TERDAFTAR: "IZIN_BELUM_TERDAFTAR",

  // --- undecided policy and missing mappings: FAIL CLOSED
  KONFIGURASI_TIDAK_ADA: "KONFIGURASI_TIDAK_ADA",
  KONFIGURASI_TIDAK_VALID: "KONFIGURASI_TIDAK_VALID",
  /**
   * Spec 6.4 has no event code for the operation requested, so there is no
   * sanctioned account pair. Refuse; never invent a pair, never borrow a
   * neighbouring event's.
   */
  EVENT_MAPPING_BELUM_ADA: "EVENT_MAPPING_BELUM_ADA",
  /** The operation depends on a policy the owner has not decided. */
  KEBIJAKAN_BELUM_DIPUTUSKAN: "KEBIJAKAN_BELUM_DIPUTUSKAN",
} as const;

export type KodeNonPumk = (typeof KODE_NONPUMK)[keyof typeof KODE_NONPUMK];

/**
 * The only error type this module throws. `message` is user-facing Indonesian
 * prose and must stay free of driver/trigger internals; `penyebabDb` is where
 * the raw DB text goes, for logs only. Same shape as `PumkError`,
 * `JurnalError` and `AngsuranError` on purpose.
 */
export class NonPumkError extends Error {
  readonly kode: KodeNonPumk;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly penyebabDb?: string;

  constructor(
    kode: KodeNonPumk,
    message: string,
    detail: Record<string, unknown> = {},
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "NonPumkError";
    this.kode = kode;
    this.detail = detail;
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

export type SumberPengajuanNonPumk = "INTERNAL" | "PORTAL_ONLINE";

export interface ProposalNonPumk {
  id: string;
  cabangId: string;
  noProposal: string;
  tanggalProposal: string;
  namaPemohon: string;
  atasNama: string | null;
  bidangId: string;
  judulProgram: string;
  deskripsiProgram: string | null;
  jumlahDiajukan: Uang;
  /** Null until an approval SETUJU lands. The disbursement ceiling. */
  jumlahDisetujui: Uang | null;
  /** Spec 9.2: estimated at proposal time. */
  penerimaManfaatEstimasi: number | null;
  sumberPengajuan: SumberPengajuanNonPumk;
  status: StatusProposalNonPumk;
  currentStep: number;
  createdBy: string | null;
}

/** One row of `nonpumk_proposal_transisi`, the timeline of spec 9.2. */
export interface TransisiProposalNonPumk {
  statusDari: StatusProposalNonPumk | null;
  statusKe: StatusProposalNonPumk;
  aksi: AksiNonPumk;
  /** WHO. Never null for a transition made through the engine. */
  olehUserId: string | null;
  /** WHEN, ISO 8601. */
  waktu: string;
  /** WHAT NOTE. */
  catatan: string | null;
}

export interface SdgProposal {
  sdgId: string;
  nomor: number;
  nama: string;
  /** 0 < bobot <= 1 (ASSUMPTIONS.md A-09). Not forced to sum to 1. */
  bobot: string;
}

export interface Penilaian {
  id: string;
  proposalId: string;
  tanggal: string;
  petugasKaryawanId: string | null;
  skorTotal: string | null;
  nilaiRekomendasi: Uang | null;
  catatan: string | null;
}

export interface Penyaluran {
  id: string;
  proposalId: string;
  termin: number;
  tanggalPenyaluran: string;
  jumlah: Uang;
  akunKasId: string;
  akunBebanId: string;
  noBukti: string | null;
  keterangan: string | null;
  /** Always set: a disbursement without a journal is not a disbursement. */
  jurnalId: string;
}

export type StatusLpj = "BELUM" | "DIAJUKAN" | "DIVERIFIKASI" | "DITOLAK";

export interface Lpj {
  id: string;
  proposalId: string;
  tanggalLpj: string;
  jumlahRealisasi: Uang;
  /** COMPUTED by the engine as totalDisalurkan - jumlahRealisasi, never taken
   *  from the caller: the two numbers must reconcile (TJSL-NPK-003) and a form
   *  that can disagree with itself is a form that will. */
  jumlahSisaDikembalikan: Uang;
  /** Spec 9.2: actual at LPJ time. */
  penerimaManfaatAktual: number | null;
  uraianRealisasi: string | null;
  status: StatusLpj;
  verifiedBy: string | null;
  verifiedAt: string | null;
  /** Set only when sisa > 0 AND the LPJ has been verified. */
  jurnalIdPengembalian: string | null;
}

/**
 * Spec 9.2's proposal detail page in ONE call: the mapping (bidang + SDG), the
 * money actually out of the door across every termin, the headroom left under
 * the approved amount, the LPJ, and the LEDGER effect of both.
 *
 * `bebanBersihBukuBesar` and `kasBersihBukuBesar` are read from the POSTED
 * ledger, not recomputed from the business rows, so the page itself proves the
 * two agree instead of asserting it elsewhere. After a grant of X disbursed in
 * full with a realisation of Y and X - Y returned, the expense must be exactly
 * Y and the cash movement exactly -Y. That is the assertion scenario 9 is
 * really asking for; the `nonpumk_lpj` row on its own proves nothing.
 */
export interface RingkasanProposal {
  proposal: ProposalNonPumk;
  sdg: SdgProposal[];
  penilaian: Penilaian | null;
  penyaluran: Penyaluran[];
  /** SUM of every live termin. */
  totalDisalurkan: Uang;
  /** jumlahDisetujui - totalDisalurkan. Never negative; the engine refuses first. */
  sisaPagu: Uang;
  lpj: Lpj | null;
  /** SUM(debit - kredit) over BEBAN accounts on this proposal's POSTED journals. */
  bebanBersihBukuBesar: Uang;
  /** SUM(debit - kredit) over is_kas accounts on this proposal's POSTED journals. */
  kasBersihBukuBesar: Uang;
}

/**
 * Spec 9.2's late-LPJ ageing bucket. The boundaries are the SPEC's 30, 60 and
 * 90 (see AMBANG_UMUR_LPJ) and are half-open on the left: a grant disbursed
 * exactly 30 days ago is `UMUR_30_59`, not `UMUR_0_29`. Stated here because an
 * off-by-one in an ageing bucket is invisible in every screenshot and wrong in
 * every management report.
 */
export type EmberUmurLpj = "UMUR_0_29" | "UMUR_30_59" | "UMUR_60_89" | "UMUR_90_PLUS";

export interface BarisMonitoringLpj {
  proposalId: string;
  noProposal: string;
  cabangId: string;
  bidangId: string;
  namaPemohon: string;
  judulProgram: string;
  status: StatusProposalNonPumk;
  totalDisalurkan: Uang;
  /** The LATEST live termin's date; the ageing clock starts at the last money out. */
  tanggalPenyaluranTerakhir: string;
  /** Whole days from `tanggalPenyaluranTerakhir` to the engine's clock. */
  umurHari: number;
  ember: EmberUmurLpj;
  /** umurHari > konfigurasi batasan.batas_hari_lpj_non_pumk. Policy, so it is READ. */
  terlambat: boolean;
}

// ---------------------------------------------------------------------------
// Write shapes
// ---------------------------------------------------------------------------

export interface SdgInput {
  sdgId: string;
  /** 0 < bobot <= 1. Absent means 1. */
  bobot?: string | null;
}

export interface BuatProposalNonPumkInput {
  cabangId: string;
  tanggalProposal: string;
  tanggalDaftar?: string | null;
  /** Institution, foundation or person. Non PUMK has no borrower master. */
  namaPemohon: string;
  atasNama?: string | null;
  alamat?: string | null;
  kelurahan?: string | null;
  kecamatan?: string | null;
  kotaId?: string | null;
  telepon?: string | null;
  email?: string | null;
  /** Spec 9.2: MANDATORY. */
  bidangId: string;
  /** Spec 9.2: MANDATORY, at least one. */
  sdg: readonly SdgInput[];
  judulProgram: string;
  deskripsiProgram?: string | null;
  jumlahDiajukan: Uang;
  /** Spec 9.2: MANDATORY at proposal time. */
  penerimaManfaatEstimasi: number;
  sumberPengajuan?: SumberPengajuanNonPumk;
  portalSubmissionId?: string | null;
}

export interface InputPenilaianInput {
  proposalId: string;
  tanggal: string;
  petugasKaryawanId?: string | null;
  /** Spec 4.5: kelayakan, urgensi, dampak, kesesuaian bidang, kesesuaian SDG. */
  hasil: Record<string, unknown>;
  skorTotal: string;
  nilaiRekomendasi: Uang;
  catatan?: string | null;
  lampiran?: readonly string[];
}

export type KeputusanCheckerNonPumk = "REKOMENDASI" | "TIDAK_REKOMENDASI" | "MINTA_PERBAIKAN";
export type KeputusanApproverNonPumk = "SETUJU" | "TOLAK" | "KEMBALIKAN";

export interface ReviewNonPumkInput {
  proposalId: string;
  tanggal: string;
  keputusan: KeputusanCheckerNonPumk;
  catatan?: string | null;
}

/**
 * The approver may cut the amount, exactly as in PUMK ("ini sering terjadi di
 * praktik"). `jumlahDisetujui` is therefore an input here and is the ONLY
 * source of `nonpumk_proposal.jumlah_disetujui`, which is in turn the ceiling
 * the staged-disbursement guard reads. A SETUJU without it is refused with
 * `NILAI_DISETUJUI_WAJIB` ahead of nonpumk_approval_setuju_ck.
 */
export interface KeputusanApprovalNonPumkInput {
  proposalId: string;
  tanggal: string;
  keputusan: KeputusanApproverNonPumk;
  jumlahDisetujui?: Uang | null;
  catatan?: string | null;
}

export interface PenyaluranInput {
  proposalId: string;
  tanggalPenyaluran: string;
  jumlah: Uang;
  akunKasId: string;
  /**
   * Spec 6.4: PENYALURAN_NON_PUMK debits "Beban Penyaluran Non PUMK (PER
   * BIDANG)", and the shipped mapping row carries `debit_dari_payload = true`
   * for exactly that reason. So the expense account arrives on the form and
   * this module hands it to the ledger engine; it never names an account pair
   * of its own (invariant 11, ADR 0004).
   */
  akunBebanId: string;
  noBukti?: string | null;
  keterangan?: string | null;
}

export interface AjukanLpjInput {
  proposalId: string;
  tanggalLpj: string;
  jumlahRealisasi: Uang;
  /** Spec 9.2: the ACTUAL beneficiary count. Mandatory. */
  penerimaManfaatAktual: number;
  uraianRealisasi?: string | null;
  lampiran?: readonly string[];
}

export interface VerifikasiLpjInput {
  proposalId: string;
  tanggalVerifikasi: string;
  /**
   * Where the returned money landed. Required only when there is a remainder;
   * with sisa = 0 no journal is posted at all and this is ignored.
   */
  akunKasId?: string | null;
  catatan?: string | null;
}

export interface TolakLpjInput {
  proposalId: string;
  tanggal: string;
  catatan: string;
}

export interface FilterProposalNonPumk {
  cabangId?: string | null;
  bidangId?: string | null;
  sdgId?: string | null;
  status?: StatusProposalNonPumk | null;
  sumberPengajuan?: SumberPengajuanNonPumk | null;
  dariTanggal?: string | null;
  sampaiTanggal?: string | null;
  /** Matches nama_pemohon or judul_program. */
  cari?: string | null;
}

export interface FilterMonitoringLpj {
  cabangId?: string | null;
  bidangId?: string | null;
  /** Only rows at or beyond this bucket. Absent means every outstanding row. */
  emberMinimal?: EmberUmurLpj | null;
  /** Only rows past the configured LPJ deadline. */
  hanyaTerlambat?: boolean;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A handle that runs statements on ONE connection inside ONE transaction. */
export interface NonPumkTx {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Same shape as `JurnalDbPort` BY DESIGN, so one world's port drives both
 * engines and they therefore share one transaction. Declared here rather than
 * imported for the reason the sibling engines give: the transaction
 * requirement is part of THIS module's contract.
 *
 * Why a transaction is not optional here: `catatPenyaluran` writes the
 * penyaluran row, moves the proposal to DISALURKAN, appends the timeline row
 * and posts the journal, and BOTH NPK guards are DEFERRED constraint triggers
 * that fire at COMMIT. A partial write is a grant expense in the ledger with
 * no business record behind it, or a termin over the approved ceiling that
 * nothing rolled back.
 */
export interface NonPumkDbPort extends NonPumkTx {
  transaction<T>(jalankan: (tx: NonPumkTx) => Promise<T>): Promise<T>;
}

/**
 * The journal engine, as the SUBSET this module uses: `postingEvent` only.
 * Structurally satisfied by `JurnalEngine`.
 *
 * ONE EVENT PER BUSINESS ACT, so `postingEvent` suffices. The accounts come
 * from `event_jurnal_mapping` (invariant 11, ADR 0004), so no account pair may
 * appear anywhere in this module; `akunDebitId` is passed because the shipped
 * PENYALURAN_NON_PUMK row asks for it (`debit_dari_payload`), not because this
 * module decided which expense account to use.
 *
 * It is a port rather than a direct dependency for one reason that matters:
 * spec 9.2's disbursement must roll back completely if the ledger refuses, and
 * that is only testable if a test can inject a collaborator that fails. A test
 * double here may stand in for the engine's FAILURE. It may NOT stand in for
 * its VALIDATION: modules/angsuran/test-support.ts records what that mistake
 * cost, and ./test-support.ts wraps the real engine for the same reason.
 */
export interface PorterJurnalNonPumk {
  postingEvent(
    eventCode: string,
    payload: {
      cabangId: string;
      tanggalTransaksi: string;
      nilai: Uang;
      keterangan?: string | null;
      akunDebitId?: string;
      akunKreditId?: string;
      akunKasId?: string;
      referensiTipe?: string | null;
      referensiId?: string | null;
      dimensi?: DimensiBaris;
      kunciIdempotensi?: string | null;
    },
    ctx: JurnalContext,
  ): Promise<Jurnal>;
}

/**
 * Who is acting. Same shape as `JurnalContext` (spec 2 rule 3), so a context
 * flows into the ledger engine unchanged and the branch scope cannot be
 * widened on the way through.
 */
export interface NonPumkContext {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  /** Branches beyond the user's own. Admin Pusat / Auditor get every branch. */
  cabangDalamScope?: readonly string[];
}

export interface NonPumkEngineDeps {
  db: NonPumkDbPort;
  jurnal: PorterJurnalNonPumk;
  /** Injectable clock, so tests are not hostage to the wall clock. The LPJ
   *  ageing of spec 9.2 is measured against it. */
  jam?: () => Date;
}

// ---------------------------------------------------------------------------
// The engine (spec 9.2)
// ---------------------------------------------------------------------------

export interface NonPumkEngine {
  // --- proposal and state machine -----------------------------------------

  /**
   * Creates the DRAFT. Allocates `no_proposal` through modules/nomor inside the
   * same transaction, validates the amount against `konfigurasi`, and enforces
   * the two mappings spec 9.2 calls mandatory: a bidang that exists in this
   * bumn (`BIDANG_TIDAK_DITEMUKAN`) and AT LEAST ONE SDG (`SDG_WAJIB`). The
   * estimated beneficiary count is mandatory here and the actual one at LPJ.
   */
  buatProposal(input: BuatProposalNonPumkInput, ctx: NonPumkContext): Promise<ProposalNonPumk>;

  /** DRAFT -> PENILAIAN. */
  ajukanPenilaian(
    proposalId: string,
    catatan: string | null,
    ctx: NonPumkContext,
  ): Promise<ProposalNonPumk>;

  /**
   * PENILAIAN -> REVIEW_CHECKER. ONE assessment row per proposal
   * (nonpumk_penilaian_proposal_uq), so a proposal sent back by
   * MINTA_PERBAIKAN and reassessed UPDATES that row rather than inserting a
   * second one; the timeline is where the history of the loop lives.
   */
  inputPenilaian(input: InputPenilaianInput, ctx: NonPumkContext): Promise<ProposalNonPumk>;

  /**
   * REVIEW_CHECKER -> MENUNGGU_PERSETUJUAN | TIDAK_DIREKOMENDASIKAN |
   * PENILAIAN. Writes `nonpumk_review` and refuses a reviewer who is the
   * proposal's maker with `KONFLIK_MAKER_CHECKER` (spec 2 rule 1), ahead of
   * TJSL-SOD-001.
   */
  review(input: ReviewNonPumkInput, ctx: NonPumkContext): Promise<ProposalNonPumk>;

  /**
   * MENUNGGU_PERSETUJUAN -> DISETUJUI | DITOLAK | REVIEW_CHECKER. Writes
   * `nonpumk_approval` including the possibly-CUT amount, copies it to
   * `nonpumk_proposal.jumlah_disetujui` (ASSUMPTIONS.md A-15) so the staged
   * guard has a single ceiling to read, and refuses an approver who reviewed
   * the same document with `KONFLIK_CHECKER_APPROVER` (spec 2 rule 2), ahead
   * of TJSL-SOD-002.
   */
  putuskanPersetujuan(
    input: KeputusanApprovalNonPumkInput,
    ctx: NonPumkContext,
  ): Promise<ProposalNonPumk>;

  /** The timeline of spec 9.2: who, when, what note, oldest first. */
  timeline(proposalId: string, ctx: NonPumkContext): Promise<TransisiProposalNonPumk[]>;

  daftarProposal(
    filter: FilterProposalNonPumk,
    ctx: NonPumkContext,
  ): Promise<ProposalNonPumk[]>;

  // --- penyaluran bertahap (spec 9.2) -------------------------------------

  /**
   * DISETUJUI -> DISALURKAN for the first termin, DISALURKAN -> DISALURKAN for
   * every one after it. Allocates the next `termin`, posts ONE
   * PENYALURAN_NON_PUMK journal through the ledger engine carrying the
   * proposal's bidang as an analytic dimension, and refuses the termin that
   * would take the running total past `jumlah_disetujui` with
   * `PLAFON_PENYALURAN_TERLAMPAUI`, AHEAD of the deferred TJSL-NPK-002.
   * All in ONE transaction: if the journal fails, no termin survives.
   */
  catatPenyaluran(input: PenyaluranInput, ctx: NonPumkContext): Promise<Penyaluran>;

  /** DISALURKAN -> MENUNGGU_LPJ. Closes the staging and starts the LPJ clock. */
  tutupPenyaluran(
    proposalId: string,
    catatan: string | null,
    ctx: NonPumkContext,
  ): Promise<ProposalNonPumk>;

  // --- LPJ (spec 9.2, spec 4.5, scenario 9) -------------------------------

  /**
   * MENUNGGU_LPJ -> LPJ_DIAJUKAN, and LPJ_DITOLAK -> LPJ_DIAJUKAN for a
   * resubmission. Writes ONE `nonpumk_lpj` row per proposal
   * (nonpumk_lpj_proposal_uq), so a resubmission UPDATES it.
   *
   * `jumlahSisaDikembalikan` is COMPUTED as totalDisalurkan - jumlahRealisasi
   * and never taken from the caller. A realisation larger than what actually
   * went out is `REALISASI_MELEBIHI_PENYALURAN`, ahead of the deferred
   * TJSL-NPK-003.
   *
   * POSTS NO JOURNAL. The money comes back when the LPJ is ACCEPTED, not when
   * it is filed: an LPJ that can still be rejected must not have moved the
   * ledger, otherwise every rejection needs a reversal and spec 6.3's rule
   * about reversal being the correction path gets exercised for a routine
   * back-and-forth. Scenario 9 still holds end to end, one step later.
   */
  ajukanLpj(input: AjukanLpjInput, ctx: NonPumkContext): Promise<Lpj>;

  /**
   * LPJ_DIAJUKAN -> SELESAI. Stamps `verified_by` / `verified_at` and, WHEN
   * AND ONLY WHEN there is a remainder, posts PENGEMBALIAN_SISA_NON_PUMK for
   * it (spec 6.4, scenario 9) and records the journal on
   * `nonpumk_lpj.jurnal_id_pengembalian`, which carries a real non-deferrable
   * FK. With sisa = 0 there is nothing to post and no journal is created: a
   * balanced pair of zero lines would be refused by validation 6.2.3 anyway,
   * and an empty journal in the buku besar is noise an auditor has to explain.
   *
   * REQUIRES `nonpumk.lpj.verifikasi`, WHICH THE SHIPPED CATALOGUE DOES NOT
   * HAVE. Must fail closed with `IZIN_BELUM_TERDAFTAR` for every role,
   * including Admin Pusat, until it is added. See PERMISSION_NONPUMK.
   */
  verifikasiLpj(input: VerifikasiLpjInput, ctx: NonPumkContext): Promise<Lpj>;

  /**
   * LPJ_DIAJUKAN -> LPJ_DITOLAK, with a mandatory note. Same missing
   * permission as `verifikasiLpj`, same fail-closed requirement.
   */
  tolakLpj(input: TolakLpjInput, ctx: NonPumkContext): Promise<ProposalNonPumk>;

  // --- read models --------------------------------------------------------

  /** Spec 9.2's detail page, one call. See `RingkasanProposal`. */
  ringkasan(proposalId: string, ctx: NonPumkContext): Promise<RingkasanProposal>;

  /**
   * Spec 9.2: "Dashboard monitoring LPJ yang terlambat, dengan aging (30, 60,
   * 90 hari sejak penyaluran)".
   *
   * Covers the three statuses where money is out and no accepted LPJ exists:
   * DISALURKAN (staging still open), MENUNGGU_LPJ and LPJ_DITOLAK. NOT
   * LPJ_DIAJUKAN, where the recipient has done their part and the ball is with
   * the verifier, and NOT SELESAI. Ageing runs from the LATEST live termin.
   */
  monitoringLpj(
    filter: FilterMonitoringLpj,
    ctx: NonPumkContext,
  ): Promise<BarisMonitoringLpj[]>;
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * The one implementation site. `deps` flows straight through to ./service.ts,
 * which is private to this module; nothing else in the repo changed when the
 * behaviour landed, which is what the tests-first arrangement was for.
 *
 * `deps` is intentionally named rather than omitted: the wiring in the
 * composition root and in the tests is part of what these tests pin, and a
 * factory with no parameters would let a wrong wiring compile.
 */
export function createNonPumkEngine(deps: NonPumkEngineDeps): NonPumkEngine {
  return buatEngineNonPumk(deps);
}
