// apps/api/src/modules/pumk/contract.ts
//
// FASE 3, MODUL PENDANAAN UMK (spec 9.1). Types, error codes, the state
// machine AS DATA, and a factory whose every method throws `not implemented`.
//
// THIS FILE IS A SPECIFICATION, NOT AN IMPLEMENTATION. It exists so the tests
// in this folder can be written first and can fail for the RIGHT reason. The
// behaviour belongs in a future ./service.ts; when it lands, the only change
// here is that `createPumkEngine` delegates to it instead of to
// `belumDiimplementasikan()`, exactly as modules/jurnal and modules/angsuran
// are wired.
//
// WHAT THIS MODULE IS
// The business layer that DRIVES the two engines. It owns the proposal state
// machine, the authorisation and segregation rules of spec 2, the akad, the
// disbursement, the read models (timeline, kartu piutang), the cluster, the
// collection follow-up trail and the portal conversion. It owns NO arithmetic
// and NO ledger SQL:
//   - every schedule and every allocation goes through `modules/angsuran`
//     (invariant 8, invariant 9, invariant 10);
//   - every journal goes through `modules/jurnal` (invariant 11).
// Both are reached as PORTS declared at the bottom of this file, which the
// real engines satisfy structurally, so the composition root wires
// `createPumkModule({ db, angsuran: angsuran.engine, jurnal: jurnal.engine })`
// with no adapter in between and no way for this module to write a schedule
// row or a journal row itself.
//
// WHY THE TESTS HIT REAL POSTGRES AND THE REAL ENGINES
// migrations/0008_pumk.sql, 0019 and 0020 enforce most of what matters here:
// segregation of duties as triggers, one live loan per mitra as a partial
// unique index, schedule immutability, the deferred version-1 total, the
// posting-path tripwire, journal immutability. A double proves nothing about
// any of them, and a double that stands in for a collaborator's VALIDATION
// (rather than only for its FAILURE) hides production defects behind a green
// suite. See the header of ./test-support.ts.
import type {
  AngsuranContext,
  HasilAlokasi,
  HasilReschedule,
  Jadwal,
  JenisReschedule,
  MetodePerhitungan,
  RateTahunan,
  Reschedule,
  StatusAkad,
  Uang,
} from "../angsuran/index";
import type { Jurnal, JurnalContext } from "../jurnal/index";

export type { RateTahunan, Uang, MetodePerhitungan, StatusAkad };

// ---------------------------------------------------------------------------
// Permission vocabulary
// ---------------------------------------------------------------------------

/**
 * The permission each operation checks. EVERY STRING HERE MUST BE A CANONICAL
 * CODE in modules/auth/permissions.ts; the engine is required to resolve them
 * through `canonicalPermission` at construction time and to refuse an
 * unresolvable one with `IZIN_BELUM_TERDAFTAR` rather than checking a string
 * no role can ever hold. A fixture that invents a permission vocabulary the
 * app lacks is how a real authorisation bug stays hidden, so the tests assert
 * the FAIL-CLOSED behaviour instead of inventing the code.
 *
 * FINDING (reported, not worked around): spec 9.1 requires a cluster page
 * ("kelola kelompok, tambah dan keluarkan anggota") and the shipped catalogue
 * has NO code for it. `pumk.cluster` below is therefore deliberately NOT in
 * PERMISSIONS, and every cluster operation must fail closed until the
 * catalogue owner adds it. Do not silently reuse `pumk.create` or
 * `konfigurasi.master`: the first would let any Maker restructure groups whose
 * kolektibilitas performance is reported on, the second would put an
 * operational PUMK screen behind Admin Pusat.
 */
export const PERMISSION_PUMK = {
  VIEW: "pumk.view",
  CREATE: "pumk.create",
  SURVEY: "pumk.survey",
  REVIEW: "pumk.review",
  APPROVE: "pumk.approve",
  AKAD: "pumk.akad",
  PENCAIRAN: "pumk.pencairan",
  ANGSURAN: "pumk.angsuran",
  RESCHEDULE: "pumk.reschedule",
  HAPUSBUKU: "pumk.hapusbuku",
  PENAGIHAN: "pumk.penagihan",
  KONVERSI_PORTAL: "portal.konversi",
  /** NOT in the auth catalogue. See the note above; must fail closed. */
  CLUSTER: "pumk.cluster",
} as const;

// ---------------------------------------------------------------------------
// Configuration this module READS. Never a hardcoded policy number.
// ---------------------------------------------------------------------------

/**
 * docs/BUILD-PLAN.md "Dampak temuan regulasi" and docs/REGULASI.md finding 3
 * record that the spec's jasa administrasi rate (FLAT 3 percent) and the
 * penyisihan basis contradict PER-1/MBU/03/2023 and the PKBL accounting
 * guidance, and that the choice is the client's accounting team's, not this
 * repo's. So the engine READS these rows and the tests assert the MECHANIC
 * (change the row, the akad changes) and NEVER the value.
 */
export const KUNCI_KONFIGURASI_PUMK = {
  /** RateTahunan; default rate written onto an akad when approval names none. */
  RATE_DEFAULT: { grup: "jasa_adm", kunci: "jasa_adm_rate_default" },
  /** MetodePerhitungan; FLAT / EFEKTIF / ANUITAS. */
  METODE_DEFAULT: { grup: "jasa_adm", kunci: "jasa_adm_metode_default" },
  PLAFON_MIN: { grup: "batasan", kunci: "plafon_min_pumk" },
  PLAFON_MAX: { grup: "batasan", kunci: "plafon_max_pumk" },
  TENOR_MIN: { grup: "batasan", kunci: "tenor_min_bulan" },
  TENOR_MAX: { grup: "batasan", kunci: "tenor_max_bulan" },
  GRACE_MAX: { grup: "batasan", kunci: "grace_period_max_bulan" },
  /** Above this plafon at least one non-TANPA_JAMINAN jaminan is required. */
  WAJIB_JAMINAN_DI_ATAS: { grup: "batasan", kunci: "wajib_jaminan_di_atas_plafon" },
  /** Spec 5.5, default 1. Enforced in the module AHEAD of the unique index. */
  MAKS_PINJAMAN_AKTIF: { grup: "batasan", kunci: "maks_pinjaman_aktif_per_mitra" },
  /** Below this survey score a proposal cannot be recommended. */
  SKOR_MINIMUM: { grup: "batasan", kunci: "skor_survey_minimum_lolos" },
} as const;

// ---------------------------------------------------------------------------
// The state machine of spec 9.1, AS DATA
// ---------------------------------------------------------------------------

export type StatusProposal =
  | "DRAFT"
  | "SURVEY_PENDING"
  | "SURVEY_SELESAI"
  | "REVIEW_CHECKER"
  | "MENUNGGU_PERSETUJUAN"
  | "DISETUJUI"
  | "AKAD_DIBUAT"
  | "JADWAL_SIAP"
  | "DICAIRKAN"
  | "TIDAK_DIREKOMENDASIKAN"
  | "DITOLAK";

/** Written verbatim to `pumk_proposal_transisi.aksi`. */
export type AksiProposal =
  | "SUBMIT_SURVEY"
  | "INPUT_SURVEY"
  | "AJUKAN_CHECKER"
  | "REKOMENDASI"
  | "TIDAK_REKOMENDASI"
  | "MINTA_PERBAIKAN"
  | "SETUJU"
  | "TOLAK"
  | "KEMBALIKAN"
  | "BUAT_AKAD"
  | "GENERATE_JADWAL"
  | "PENCAIRAN";

export interface DefinisiTransisi {
  dari: StatusProposal;
  aksi: AksiProposal;
  ke: StatusProposal;
  /** The permission the actor must hold for this transition. */
  izin: string;
  /** `catatan` is mandatory on the transitions that reject or send back. */
  catatanWajib: boolean;
}

/**
 * Spec 9.1's diagram, transcribed, as the single source of truth for both the
 * engine and the tests. A table rather than a switch for the same reason
 * kolektibilitas ranges are a table (spec 5.1): a reviewer can diff it against
 * the spec line by line, and a missing edge is visible instead of buried in
 * control flow.
 *
 * TERMINAL: TIDAK_DIREKOMENDASIKAN, DITOLAK and DICAIRKAN have no outgoing
 * edge. DICAIRKAN is terminal for the PROPOSAL; the akad's own life continues
 * (angsuran, reschedule, pengakhiran) and is not modelled here.
 */
export const TRANSISI_SAH: readonly DefinisiTransisi[] = [
  { dari: "DRAFT", aksi: "SUBMIT_SURVEY", ke: "SURVEY_PENDING", izin: PERMISSION_PUMK.CREATE, catatanWajib: false },
  { dari: "SURVEY_PENDING", aksi: "INPUT_SURVEY", ke: "SURVEY_SELESAI", izin: PERMISSION_PUMK.SURVEY, catatanWajib: false },
  { dari: "SURVEY_SELESAI", aksi: "AJUKAN_CHECKER", ke: "REVIEW_CHECKER", izin: PERMISSION_PUMK.CREATE, catatanWajib: false },
  { dari: "REVIEW_CHECKER", aksi: "REKOMENDASI", ke: "MENUNGGU_PERSETUJUAN", izin: PERMISSION_PUMK.REVIEW, catatanWajib: false },
  { dari: "REVIEW_CHECKER", aksi: "TIDAK_REKOMENDASI", ke: "TIDAK_DIREKOMENDASIKAN", izin: PERMISSION_PUMK.REVIEW, catatanWajib: true },
  { dari: "REVIEW_CHECKER", aksi: "MINTA_PERBAIKAN", ke: "SURVEY_SELESAI", izin: PERMISSION_PUMK.REVIEW, catatanWajib: true },
  { dari: "MENUNGGU_PERSETUJUAN", aksi: "SETUJU", ke: "DISETUJUI", izin: PERMISSION_PUMK.APPROVE, catatanWajib: false },
  { dari: "MENUNGGU_PERSETUJUAN", aksi: "TOLAK", ke: "DITOLAK", izin: PERMISSION_PUMK.APPROVE, catatanWajib: true },
  { dari: "MENUNGGU_PERSETUJUAN", aksi: "KEMBALIKAN", ke: "REVIEW_CHECKER", izin: PERMISSION_PUMK.APPROVE, catatanWajib: true },
  { dari: "DISETUJUI", aksi: "BUAT_AKAD", ke: "AKAD_DIBUAT", izin: PERMISSION_PUMK.AKAD, catatanWajib: false },
  { dari: "AKAD_DIBUAT", aksi: "GENERATE_JADWAL", ke: "JADWAL_SIAP", izin: PERMISSION_PUMK.AKAD, catatanWajib: false },
  { dari: "JADWAL_SIAP", aksi: "PENCAIRAN", ke: "DICAIRKAN", izin: PERMISSION_PUMK.PENCAIRAN, catatanWajib: false },
];

export const STATUS_TERMINAL: readonly StatusProposal[] = [
  "TIDAK_DIREKOMENDASIKAN",
  "DITOLAK",
  "DICAIRKAN",
];

/** The valid target of `aksi` from `dari`, or null when the edge does not exist. */
export function transisiUntuk(dari: StatusProposal, aksi: AksiProposal): DefinisiTransisi | null {
  return TRANSISI_SAH.find((t) => t.dari === dari && t.aksi === aksi) ?? null;
}

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * Every rejection this module produces carries one of these codes.
 *
 * THE DATABASE ALREADY ENFORCES MUCH OF THIS, and that is the point: the
 * module must produce a CLEAN DOMAIN ERROR AHEAD of the trigger, so a caller
 * never sees `TJSL-SOD-001: user 9f2c... adalah maker proposal ini` or
 * `duplicate key value violates unique constraint
 * "pumk_akad_satu_aktif_per_mitra_uq"`. Where the race is real (two concurrent
 * approvals), the trigger stays the serialisation point and the driver error
 * must still be translated into the same code, mapping on SQLSTATE and
 * `constraint`, never on message text.
 */
export const KODE_PUMK = {
  // --- lookup
  PROPOSAL_TIDAK_DITEMUKAN: "PROPOSAL_TIDAK_DITEMUKAN",
  MITRA_TIDAK_DITEMUKAN: "MITRA_TIDAK_DITEMUKAN",
  AKAD_TIDAK_DITEMUKAN: "AKAD_TIDAK_DITEMUKAN",
  SEKTOR_TIDAK_DITEMUKAN: "SEKTOR_TIDAK_DITEMUKAN",
  CLUSTER_TIDAK_DITEMUKAN: "CLUSTER_TIDAK_DITEMUKAN",
  SUBMISSION_TIDAK_DITEMUKAN: "SUBMISSION_TIDAK_DITEMUKAN",

  // --- state machine (spec 9.1)
  TRANSISI_TIDAK_VALID: "TRANSISI_TIDAK_VALID",
  STATUS_TERMINAL: "STATUS_TERMINAL",
  CATATAN_WAJIB: "CATATAN_WAJIB",

  // --- proposal input (bounds from konfigurasi, never from code)
  PLAFON_DILUAR_BATAS: "PLAFON_DILUAR_BATAS",
  TENOR_DILUAR_BATAS: "TENOR_DILUAR_BATAS",
  GRACE_DILUAR_BATAS: "GRACE_DILUAR_BATAS",
  JAMINAN_WAJIB: "JAMINAN_WAJIB",
  MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF: "MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF",
  NILAI_BUKAN_DESIMAL: "NILAI_BUKAN_DESIMAL",
  TANGGAL_TIDAK_VALID: "TANGGAL_TIDAK_VALID",

  // --- survey / review / approval
  SURVEY_SUDAH_ADA: "SURVEY_SUDAH_ADA",
  SURVEY_BELUM_ADA: "SURVEY_BELUM_ADA",
  SKOR_DIBAWAH_MINIMUM: "SKOR_DIBAWAH_MINIMUM",
  KEPUTUSAN_TIDAK_VALID: "KEPUTUSAN_TIDAK_VALID",

  // --- akad, jadwal, pencairan
  AKAD_SUDAH_ADA: "AKAD_SUDAH_ADA",
  JADWAL_BELUM_SIAP: "JADWAL_BELUM_SIAP",
  PENCAIRAN_SUDAH_ADA: "PENCAIRAN_SUDAH_ADA",
  NILAI_PENCAIRAN_TIDAK_COCOK: "NILAI_PENCAIRAN_TIDAK_COCOK",
  AKUN_KAS_TIDAK_VALID: "AKUN_KAS_TIDAK_VALID",

  // --- pengakhiran / hapus buku
  PENGAKHIRAN_SUDAH_ADA: "PENGAKHIRAN_SUDAH_ADA",
  AKAD_TIDAK_BISA_DIAKHIRI: "AKAD_TIDAK_BISA_DIAKHIRI",

  // --- cluster
  MITRA_SUDAH_DI_CLUSTER: "MITRA_SUDAH_DI_CLUSTER",
  MITRA_BUKAN_ANGGOTA_CLUSTER: "MITRA_BUKAN_ANGGOTA_CLUSTER",

  // --- portal (spec 9.5, scenario 21)
  SUBMISSION_SUDAH_DIKONVERSI: "SUBMISSION_SUDAH_DIKONVERSI",
  SUBMISSION_BUKAN_PUMK: "SUBMISSION_BUKAN_PUMK",
  SUBMISSION_DATA_TIDAK_LENGKAP: "SUBMISSION_DATA_TIDAK_LENGKAP",

  // --- collaborators
  JURNAL_GAGAL: "JURNAL_GAGAL",
  JADWAL_GAGAL: "JADWAL_GAGAL",
  SETORAN_GAGAL: "SETORAN_GAGAL",

  // --- authorisation (spec 2)
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
  /** Spec 2 rule 1, ahead of trg_pumk_review_10_sod (TJSL-SOD-001). */
  KONFLIK_MAKER_CHECKER: "KONFLIK_MAKER_CHECKER",
  /** Spec 2 rule 2, ahead of trg_pumk_approval_10_sod (TJSL-SOD-002). */
  KONFLIK_CHECKER_APPROVER: "KONFLIK_CHECKER_APPROVER",
  /**
   * The operation names a permission that is not in the auth catalogue, so no
   * role could ever hold it. Fail closed, never open. See PERMISSION_PUMK.
   */
  IZIN_BELUM_TERDAFTAR: "IZIN_BELUM_TERDAFTAR",

  // --- undecided policy and missing mappings: FAIL CLOSED
  KONFIGURASI_TIDAK_ADA: "KONFIGURASI_TIDAK_ADA",
  KONFIGURASI_TIDAK_VALID: "KONFIGURASI_TIDAK_VALID",
  /**
   * Spec 6.4 has no event code for the operation requested, so there is no
   * sanctioned account pair. docs/REGULASI.md finding 5: penghapustagihan is a
   * legally distinct event from penghapusbukuan and has no mapping; ADR 0011 /
   * OPEN-QUESTIONS item 21: a principal restructure has none either. Refuse;
   * do not borrow HAPUS_BUKU_PIUTANG and do not invent a pair.
   */
  EVENT_MAPPING_BELUM_ADA: "EVENT_MAPPING_BELUM_ADA",
  /**
   * The operation depends on a policy the owner has not decided (the
   * penyisihan shortfall route of docs/BUILD-PLAN.md, the penyisihan basis of
   * OPEN-QUESTIONS item 6). Refuse rather than pick.
   */
  KEBIJAKAN_BELUM_DIPUTUSKAN: "KEBIJAKAN_BELUM_DIPUTUSKAN",
} as const;

export type KodePumk = (typeof KODE_PUMK)[keyof typeof KODE_PUMK];

/**
 * The only error type this module throws. `message` is user-facing Indonesian
 * prose and must stay free of driver/trigger internals; `penyebabDb` is where
 * the raw DB text goes, for logs only. Same shape as `JurnalError` and
 * `AngsuranError` on purpose.
 */
export class PumkError extends Error {
  readonly kode: KodePumk;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly penyebabDb?: string;

  constructor(
    kode: KodePumk,
    message: string,
    detail: Record<string, unknown> = {},
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "PumkError";
    this.kode = kode;
    this.detail = detail;
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

export type SumberPengajuan = "INTERNAL" | "PORTAL_ONLINE";

export interface Proposal {
  id: string;
  cabangId: string;
  noProposal: string;
  tanggalProposal: string;
  mitraId: string;
  sektorId: string | null;
  jumlahDiajukan: Uang;
  tenorDiajukan: number;
  tujuanPenggunaan: string | null;
  sumberPengajuan: SumberPengajuan;
  portalSubmissionId: string | null;
  status: StatusProposal;
  currentStep: number;
  createdBy: string | null;
}

/** One row of `pumk_proposal_transisi`, the timeline of spec 9.1. */
export interface TransisiProposal {
  statusDari: StatusProposal | null;
  statusKe: StatusProposal;
  aksi: AksiProposal;
  /** WHO. Never null for a transition made through the engine. */
  olehUserId: string | null;
  /** WHEN, ISO 8601. */
  waktu: string;
  /** WHAT NOTE. */
  catatan: string | null;
}

export interface Survey {
  id: string;
  proposalId: string;
  tanggalSurvey: string;
  petugasKaryawanId: string | null;
  skorTotal: string | null;
  plafonRekomendasi: Uang | null;
  tenorRekomendasi: number | null;
  catatan: string | null;
}

export interface Akad {
  id: string;
  proposalId: string;
  mitraId: string;
  cabangId: string;
  noAkad: string;
  tanggalAkad: string;
  pokokPinjaman: Uang;
  jasaAdmRate: RateTahunan;
  metodePerhitungan: MetodePerhitungan;
  tenorBulan: number;
  gracePeriodBulan: number;
  tanggalMulaiAngsuran: string;
  tanggalJatuhTempoAkhir: string;
  status: StatusAkad;
  outstandingPokok: Uang;
  outstandingJasa: Uang;
}

export interface HasilPencairan {
  pencairanId: string;
  akadId: string;
  tanggalPencairan: string;
  jumlah: Uang;
  /** Always set: a disbursement without a journal is not a disbursement. */
  jurnalId: string;
  akad: Akad;
  proposal: Proposal;
}

export interface Pengakhiran {
  id: string;
  akadId: string;
  jenis: JenisPengakhiran;
  tanggal: string;
  outstandingPokokSaatItu: Uang;
  outstandingJasaSaatItu: Uang;
  noSk: string | null;
  /** Null for LUNAS_DIPERCEPAT, which moves no money of its own. */
  jurnalId: string | null;
  akadSetelah: Akad;
}

export type JenisPengakhiran = "LUNAS_DIPERCEPAT" | "HAPUS_BUKU" | "PENGHAPUSAN_BERSYARAT";

export type JenisTindakLanjut = "KUNJUNGAN" | "TELEPON" | "SURAT_PERINGATAN" | "SOMASI";

export interface TindakLanjut {
  id: string;
  akadId: string;
  tanggal: string;
  jenis: JenisTindakLanjut;
  hasil: string | null;
  petugasKaryawanId: string | null;
  catatan: string | null;
}

export interface AnggotaCluster {
  clusterId: string;
  mitraId: string;
  tanggalMasuk: string;
  tanggalKeluar: string | null;
  alasanKeluar: string | null;
}

/**
 * Spec 9.1's Kartu Piutang, in ONE call: "data mitra, akad, jadwal lengkap,
 * semua setoran, riwayat kolektibilitas per periode, dan outstanding terkini".
 *
 * `jadwal` carries EVERY version, newest first, because the page must show all
 * versions and mark the active one. `outstanding` is read from the akad (the
 * sub-ledger), and `saldoBukuBesar` from the posted ledger, so the page itself
 * proves spec 8.4 check 10 rather than asserting it elsewhere: `selisih` is
 * the reconciliation number and must be exactly "0.00".
 */
export interface KartuPiutang {
  mitra: {
    id: string;
    kodeMitra: string;
    namaLengkap: string;
    status: string;
    clusterId: string | null;
  };
  akad: Akad;
  jadwal: Jadwal[];
  setoran: Array<{
    id: string;
    tanggalTerima: string;
    jumlahDiterima: Uang;
    alokasiPokok: Uang;
    alokasiJasa: Uang;
    alokasiKelebihan: Uang;
    jurnalId: string | null;
  }>;
  kelebihan: Array<{ id: string; tanggal: string; jumlah: Uang; status: string }>;
  riwayatKolektibilitas: Array<{ periodeId: string; kelas: string; hariTunggakan: number }>;
  outstanding: { pokok: Uang; jasa: Uang };
  /** Sum(debit - kredit) on the receivable account for this akad, POSTED only. */
  saldoBukuBesar: Uang;
  /** outstanding.pokok - saldoBukuBesar. Must be "0.00" (spec 8.4 check 10). */
  selisihRekonsiliasi: Uang;
}

// ---------------------------------------------------------------------------
// Write shapes
// ---------------------------------------------------------------------------

export interface BuatProposalInput {
  cabangId: string;
  mitraId: string;
  sektorId?: string | null;
  tanggalProposal: string;
  tanggalDaftar?: string | null;
  jumlahDiajukan: Uang;
  tenorDiajukan: number;
  tujuanPenggunaan?: string | null;
}

export interface JaminanInput {
  jenis: "BPKB" | "SHM" | "SHGB" | "AJB" | "DEPOSITO" | "TANPA_JAMINAN" | "LAINNYA";
  deskripsi?: string | null;
  nilaiTaksasi?: Uang | null;
  nomorDokumen?: string | null;
  atasNama?: string | null;
  lokasi?: string | null;
  tanggalTerima?: string | null;
}

export interface InputSurveyInput {
  proposalId: string;
  tanggalSurvey: string;
  petugasKaryawanId?: string | null;
  /** Spec 4.4: karakter, kapasitas usaha, tempat usaha, agunan, riwayat. */
  hasil: Record<string, unknown>;
  skorTotal: string;
  plafonRekomendasi: Uang;
  tenorRekomendasi: number;
  catatan?: string | null;
  lampiranFoto?: readonly string[];
}

export type KeputusanChecker = "REKOMENDASI" | "TIDAK_REKOMENDASI" | "MINTA_PERBAIKAN";
export type KeputusanApprover = "SETUJU" | "TOLAK" | "KEMBALIKAN";

export interface ReviewInput {
  proposalId: string;
  tanggal: string;
  keputusan: KeputusanChecker;
  catatan?: string | null;
}

/**
 * Spec 9.1: "Halaman persetujuan dengan kemampuan approver MENGUBAH PLAFON DAN
 * TENOR dari yang diajukan (ini sering terjadi di praktik)". So the approved
 * plafon and tenor are inputs here, and `buatAkad` must take them from the
 * APPROVAL, not from the proposal (scenario 3).
 *
 * `jasaAdmRate` is optional: absent means "read
 * konfigurasi jasa_adm.jasa_adm_rate_default". It is never a literal in code.
 */
export interface KeputusanApprovalInput {
  proposalId: string;
  tanggal: string;
  keputusan: KeputusanApprover;
  plafonDisetujui?: Uang | null;
  tenorDisetujui?: number | null;
  jasaAdmRate?: RateTahunan | null;
  catatan?: string | null;
}

/**
 * Spec 9.1 "Form realisasi akad". Deliberately carries NO pokok and NO tenor:
 * those come from the APPROVAL row so an akad can never disagree with what was
 * approved. What the akad step really adds is the contract date, the schedule
 * shape and the document.
 */
export interface BuatAkadInput {
  proposalId: string;
  tanggalAkad: string;
  tanggalMulaiAngsuran: string;
  gracePeriodBulan?: number;
  metodePerhitungan?: MetodePerhitungan;
  pathDokumenAkad?: string | null;
}

export interface PencairanInput {
  akadId: string;
  tanggalPencairan: string;
  jumlah: Uang;
  akunKasId: string;
  noBukti?: string | null;
  keterangan?: string | null;
}

export interface TerimaAngsuranInput {
  akadId: string;
  tanggalTerima: string;
  jumlah: Uang;
  akunKasId: string;
  noBukti?: string | null;
  tanggalValuta?: string | null;
  keterangan?: string | null;
}

export interface PengakhiranInput {
  akadId: string;
  jenis: JenisPengakhiran;
  tanggal: string;
  dasarKeputusan: string;
  noSk?: string | null;
  akunKasId?: string | null;
}

export interface TindakLanjutInput {
  akadId: string;
  tanggal: string;
  jenis: JenisTindakLanjut;
  hasil?: string | null;
  petugasKaryawanId?: string | null;
  catatan?: string | null;
  lampiran?: readonly string[];
}

export interface KonversiPortalInput {
  submissionId: string;
  cabangId: string;
  /** The mitra the officer matched or created from the submission. */
  mitraId: string;
  sektorId?: string | null;
  tanggalProposal: string;
  catatanPetugas?: string | null;
}

export interface FilterProposal {
  cabangId?: string | null;
  sektorId?: string | null;
  status?: StatusProposal | null;
  sumberPengajuan?: SumberPengajuan | null;
  dariTanggal?: string | null;
  sampaiTanggal?: string | null;
  /** Matches mitra nama_lengkap or NIK (spec 9.1 daftar proposal). */
  cari?: string | null;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A handle that runs statements on ONE connection inside ONE transaction. */
export interface PumkTx {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Same shape as `AngsuranDbPort` and `JurnalDbPort` BY DESIGN, so one world's
 * port drives all three engines and they therefore share one transaction. It
 * is declared here rather than imported for the reason those two give: the
 * transaction requirement is part of THIS module's contract, and consolidating
 * the three onto `core/ports/db.ts` is one deliberate later change in which
 * this declaration is the only thing that moves.
 *
 * Why a transaction is not optional here: `catatPencairan` writes the pencairan
 * row, flips the akad AKTIF, moves the proposal to DICAIRKAN, appends the
 * timeline row and posts the journal. Half of that on disk is a receivable
 * with no ledger entry, which is precisely the drift
 * `v_rekonsiliasi_piutang` exists to detect.
 */
export interface PumkDbPort extends PumkTx {
  transaction<T>(jalankan: (tx: PumkTx) => Promise<T>): Promise<T>;
}

/**
 * The instalment engine, as the SUBSET this module uses. Structurally
 * satisfied by `AngsuranEngine`, so the composition root passes the real
 * engine with no adapter and invariants 8, 9 and 10 hold by construction:
 * there is no other way for this module to reach a schedule.
 *
 * It is a port rather than a direct dependency for one reason that matters:
 * spec 9.1's pencairan step must roll back completely if the ledger refuses,
 * and that is only testable if a test can inject a collaborator that fails.
 * A test double here may stand in for the engine's FAILURE. It may NOT stand
 * in for its VALIDATION: modules/angsuran/test-support.ts records what that
 * mistake cost, and ./test-support.ts wraps the real engines for the same
 * reason.
 */
export interface PorterAngsuranPumk {
  generateJadwal(input: { akadId: string }, ctx: AngsuranContext): Promise<Jadwal>;
  alokasikanSetoran(
    input: {
      akadId: string;
      tanggal: string;
      jumlah: Uang;
      akunKasId: string;
      noBukti?: string | null;
      tanggalValuta?: string | null;
      keterangan?: string | null;
    },
    ctx: AngsuranContext,
  ): Promise<HasilAlokasi>;
  ajukanReschedule(
    input: {
      akadId: string;
      tanggalPengajuan: string;
      alasan: string;
      jenis: JenisReschedule;
      tenorBaru?: number | null;
      graceBaru?: number | null;
      jasaRateBaru?: RateTahunan | null;
      catatan?: string | null;
    },
    ctx: AngsuranContext,
  ): Promise<Reschedule>;
  setujuiReschedule(rescheduleId: string, ctx: AngsuranContext): Promise<HasilReschedule>;
  riwayatJadwal(akadId: string, ctx: AngsuranContext): Promise<Jadwal[]>;
}

/**
 * The journal engine, as the SUBSET this module uses: `postingEvent` only.
 * Structurally satisfied by `JurnalEngine`.
 *
 * ONE EVENT PER BUSINESS ACT here, so `postingEvent` suffices; the combined
 * posting of spec 7.2 step 8 belongs to the allocation, which this module
 * delegates to the instalment engine rather than assembling itself. The
 * accounts come from `event_jurnal_mapping` (invariant 11, ADR 0004), so no
 * account pair may appear anywhere in this module.
 */
export interface PorterJurnalPumk {
  postingEvent(
    eventCode: string,
    payload: {
      cabangId: string;
      tanggalTransaksi: string;
      nilai: Uang;
      keterangan?: string | null;
      akunKasId?: string;
      mitraId?: string | null;
      akadId?: string | null;
      referensiTipe?: string | null;
      referensiId?: string | null;
      kunciIdempotensi?: string | null;
    },
    ctx: JurnalContext,
  ): Promise<Jurnal>;
}

/**
 * Who is acting. Same shape as `JurnalContext` and `AngsuranContext` (spec 2
 * rule 3), so a context flows into the collaborating engines unchanged and the
 * branch scope cannot be widened on the way through.
 */
export interface PumkContext {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  /** Branches beyond the user's own. Admin Pusat / Auditor get every branch. */
  cabangDalamScope?: readonly string[];
}

export interface PumkEngineDeps {
  db: PumkDbPort;
  angsuran: PorterAngsuranPumk;
  jurnal: PorterJurnalPumk;
  /** Injectable clock, so tests are not hostage to the wall clock. */
  jam?: () => Date;
}

// ---------------------------------------------------------------------------
// The engine (spec 9.1)
// ---------------------------------------------------------------------------

export interface PumkEngine {
  // --- proposal and state machine -----------------------------------------

  /**
   * Creates the DRAFT. Allocates `no_proposal` through modules/nomor inside
   * the same transaction, validates plafon/tenor against `konfigurasi`, and
   * refuses a mitra who already holds a live loan
   * (`MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF`) AHEAD of
   * pumk_akad_satu_aktif_per_mitra_uq, which only fires at akad time and by
   * then the operator has typed a whole form.
   */
  buatProposal(input: BuatProposalInput, ctx: PumkContext): Promise<Proposal>;

  /** Multi-jaminan per proposal (spec 9.1 "Form profil jaminan"). */
  tambahJaminan(proposalId: string, input: JaminanInput, ctx: PumkContext): Promise<{ id: string }>;

  /** DRAFT -> SURVEY_PENDING. */
  submitUntukSurvey(proposalId: string, catatan: string | null, ctx: PumkContext): Promise<Proposal>;

  /** SURVEY_PENDING -> SURVEY_SELESAI. One survey per proposal. */
  inputSurvey(input: InputSurveyInput, ctx: PumkContext): Promise<Proposal>;

  /** SURVEY_SELESAI -> REVIEW_CHECKER. */
  ajukanKeChecker(proposalId: string, catatan: string | null, ctx: PumkContext): Promise<Proposal>;

  /**
   * REVIEW_CHECKER -> MENUNGGU_PERSETUJUAN | TIDAK_DIREKOMENDASIKAN |
   * SURVEY_SELESAI. Writes `pumk_review` and refuses a reviewer who is the
   * proposal's maker with `KONFLIK_MAKER_CHECKER` (spec 2 rule 1), ahead of
   * TJSL-SOD-001.
   */
  review(input: ReviewInput, ctx: PumkContext): Promise<Proposal>;

  /**
   * MENUNGGU_PERSETUJUAN -> DISETUJUI | DITOLAK | REVIEW_CHECKER. Writes
   * `pumk_approval` including the possibly-CHANGED plafon and tenor, and
   * refuses an approver who reviewed the same document with
   * `KONFLIK_CHECKER_APPROVER` (spec 2 rule 2), ahead of TJSL-SOD-002.
   */
  putuskanPersetujuan(input: KeputusanApprovalInput, ctx: PumkContext): Promise<Proposal>;

  /** The timeline of spec 9.1: who, when, what note, oldest first. */
  timeline(proposalId: string, ctx: PumkContext): Promise<TransisiProposal[]>;

  /** Spec 9.1 daftar proposal, with the internal / portal split as a filter. */
  daftarProposal(filter: FilterProposal, ctx: PumkContext): Promise<Proposal[]>;

  // --- akad, jadwal, pencairan --------------------------------------------

  /**
   * DISETUJUI -> AKAD_DIBUAT. Pokok, tenor and rate come from the APPROVAL
   * row, so an approver's change of plafon or tenor flows through instead of
   * being recorded and ignored (spec 9.1, scenario 3).
   */
  buatAkad(input: BuatAkadInput, ctx: PumkContext): Promise<Akad>;

  /**
   * AKAD_DIBUAT -> JADWAL_SIAP. Delegates to the instalment engine; this
   * module never writes a `pumk_jadwal_angsuran` row (invariant 8).
   */
  generateJadwal(akadId: string, ctx: PumkContext): Promise<Jadwal>;

  /**
   * JADWAL_SIAP -> DICAIRKAN, akad -> AKTIF with `outstanding_pokok` equal to
   * the disbursed principal, and the PENCAIRAN_PUMK journal posted through the
   * ledger engine, ALL IN ONE TRANSACTION. If the journal fails, nothing
   * survives and the call rejects with `JURNAL_GAGAL`.
   */
  catatPencairan(input: PencairanInput, ctx: PumkContext): Promise<HasilPencairan>;

  // --- akad life ----------------------------------------------------------

  /** Delegates to the instalment engine (spec 7.2). */
  terimaAngsuran(input: TerimaAngsuranInput, ctx: PumkContext): Promise<HasilAlokasi>;

  ajukanReschedule(
    input: {
      akadId: string;
      tanggalPengajuan: string;
      alasan: string;
      jenis: JenisReschedule;
      tenorBaru?: number | null;
      graceBaru?: number | null;
      jasaRateBaru?: RateTahunan | null;
      catatan?: string | null;
    },
    ctx: PumkContext,
  ): Promise<Reschedule>;

  setujuiReschedule(rescheduleId: string, ctx: PumkContext): Promise<HasilReschedule>;

  /**
   * Spec 9.1 "Halaman pengakhiran dan hapus buku".
   *
   *   LUNAS_DIPERCEPAT       records the termination; the money already moved
   *                          through the allocation, so `jurnalId` is null.
   *   HAPUS_BUKU             posts HAPUS_BUKU_PIUTANG for the outstanding
   *                          principal, requires `pumk.hapusbuku`, and leaves
   *                          the receivable OUT of the active book while the
   *                          right to collect survives (SK-277/MBU/10/2023).
   *   PENGHAPUSAN_BERSYARAT  MUST FAIL CLOSED with `EVENT_MAPPING_BELUM_ADA`.
   *                          docs/REGULASI.md finding 5: penghapustagihan is a
   *                          legally distinct act with no event code in spec
   *                          6.4 and no extracomptable table, and reusing
   *                          HAPUS_BUKU_PIUTANG would merge two events that
   *                          differ in whether the debt still exists.
   */
  catatPengakhiran(input: PengakhiranInput, ctx: PumkContext): Promise<Pengakhiran>;

  /** Spec 9.1 "pengaturan mitra bermasalah": the follow-up trail. */
  catatTindakLanjut(input: TindakLanjutInput, ctx: PumkContext): Promise<TindakLanjut>;

  daftarTindakLanjut(akadId: string, ctx: PumkContext): Promise<TindakLanjut[]>;

  // --- cluster (spec 9.1) --------------------------------------------------

  tambahAnggotaCluster(
    input: { clusterId: string; mitraId: string; tanggalMasuk: string },
    ctx: PumkContext,
  ): Promise<AnggotaCluster>;

  keluarkanAnggotaCluster(
    input: { clusterId: string; mitraId: string; tanggalKeluar: string; alasan: string },
    ctx: PumkContext,
  ): Promise<AnggotaCluster>;

  /** Membership as dated history: pass `padaTanggal` to see a past roster. */
  daftarAnggotaCluster(
    clusterId: string,
    ctx: PumkContext,
    opsi?: { padaTanggal?: string },
  ): Promise<AnggotaCluster[]>;

  // --- read model ---------------------------------------------------------

  /** Spec 9.1's Kartu Piutang, one call. See `KartuPiutang`. */
  kartuPiutang(akadId: string, ctx: PumkContext): Promise<KartuPiutang>;

  // --- portal (spec 9.5, scenario 21) -------------------------------------

  /**
   * Converts a verified portal submission into an internal proposal:
   * `sumber_pengajuan = PORTAL_ONLINE`, `portal_submission_id` set, the
   * submission marked DIKONVERSI with `converted_proposal_id`, and the form
   * data copied. Requires `portal.konversi`. A submission already converted
   * rejects with `SUBMISSION_SUDAH_DIKONVERSI`.
   */
  konversiSubmissionPortal(input: KonversiPortalInput, ctx: PumkContext): Promise<Proposal>;
}

// ---------------------------------------------------------------------------
// The stub factory
// ---------------------------------------------------------------------------

/**
 * DELIBERATELY A PLAIN `Error`, NOT A `PumkError`.
 *
 * ./test-support.ts's `tolakDengan` asserts `instanceof PumkError` and a
 * matching `kode`. If this threw a `PumkError` with, say,
 * `TRANSISI_TIDAK_VALID`, every rejection test in this folder would go GREEN
 * against an unimplemented module, which is the exact failure mode a
 * tests-first suite exists to avoid. So the stub throws something no
 * assertion in this folder can mistake for the real thing.
 */
function belumDiimplementasikan(nama: string): never {
  throw new Error(
    `PumkEngine.${nama}: not implemented. Fase 3 (spec 9.1) belum dibangun; ` +
      "lihat apps/api/src/modules/pumk/contract.ts dan test di folder yang sama.",
  );
}

/**
 * The one implementation site. Today every method is a stub; when ./service.ts
 * lands this becomes `return buatEnginePumk(deps)` and nothing else in the
 * repo changes.
 *
 * `deps` is intentionally accepted and ignored rather than omitted: the wiring
 * in the composition root and in the tests is part of what these tests pin,
 * and a factory with no parameters would let a wrong wiring compile.
 */
export function createPumkEngine(deps: PumkEngineDeps): PumkEngine {
  void deps;
  return {
    buatProposal: () => belumDiimplementasikan("buatProposal"),
    tambahJaminan: () => belumDiimplementasikan("tambahJaminan"),
    submitUntukSurvey: () => belumDiimplementasikan("submitUntukSurvey"),
    inputSurvey: () => belumDiimplementasikan("inputSurvey"),
    ajukanKeChecker: () => belumDiimplementasikan("ajukanKeChecker"),
    review: () => belumDiimplementasikan("review"),
    putuskanPersetujuan: () => belumDiimplementasikan("putuskanPersetujuan"),
    timeline: () => belumDiimplementasikan("timeline"),
    daftarProposal: () => belumDiimplementasikan("daftarProposal"),
    buatAkad: () => belumDiimplementasikan("buatAkad"),
    generateJadwal: () => belumDiimplementasikan("generateJadwal"),
    catatPencairan: () => belumDiimplementasikan("catatPencairan"),
    terimaAngsuran: () => belumDiimplementasikan("terimaAngsuran"),
    ajukanReschedule: () => belumDiimplementasikan("ajukanReschedule"),
    setujuiReschedule: () => belumDiimplementasikan("setujuiReschedule"),
    catatPengakhiran: () => belumDiimplementasikan("catatPengakhiran"),
    catatTindakLanjut: () => belumDiimplementasikan("catatTindakLanjut"),
    daftarTindakLanjut: () => belumDiimplementasikan("daftarTindakLanjut"),
    tambahAnggotaCluster: () => belumDiimplementasikan("tambahAnggotaCluster"),
    keluarkanAnggotaCluster: () => belumDiimplementasikan("keluarkanAnggotaCluster"),
    daftarAnggotaCluster: () => belumDiimplementasikan("daftarAnggotaCluster"),
    kartuPiutang: () => belumDiimplementasikan("kartuPiutang"),
    konversiSubmissionPortal: () => belumDiimplementasikan("konversiSubmissionPortal"),
  };
}
