// apps/api/src/modules/angsuran/contract.ts
//
// TYPE CONTRACT FOR THE INSTALMENT ENGINE (spec 7). Written BEFORE the
// implementation, per spec rule 5: the tests in this folder are the
// specification and this file is the shape they were written against. The
// behaviour now lives in ./service.ts, ./jadwal.ts and ./alokasi.ts, reached
// only through `createAngsuranEngine` below, so this stays the one file a
// caller has to read.
//
// -------------------------------------------------------------------------
// MONEY IS A DECIMAL STRING, IDENTICAL TO THE JOURNAL ENGINE'S CHOICE
// -------------------------------------------------------------------------
// `Uang` here is exactly what `apps/api/src/modules/jurnal/contract.ts`
// defines: a fixed-precision amount as a DECIMAL STRING with exactly two
// fractional digits ("1500000.00"), never a JS `number`. The reasoning is
// spelled out at length in that file and is not repeated here; the short
// version is invariant 7 (money is NUMERIC(20,2), never float), plus the fact
// that NUMERIC(20,2) reaches 10^18 sen while Number.MAX_SAFE_INTEGER is only
// ~9.007 x 10^15, so even integer minor units in a `number` would silently
// lose precision inside the range the column accepts. The Postgres driver
// hands NUMERIC back as this same string, so values cross the DB boundary
// with zero conversion.
//
// The type is DECLARED AGAIN rather than imported because
// `bun tools/check-boundaries.ts` forbids a deep import into a sibling module
// (`../jurnal/contract`) and modules/jurnal has no index.ts yet. When it gets
// one, this alias should become a re-export; the shape must not drift in the
// meantime, which is why POLA_UANG below is character-for-character the same
// pattern.
//
// -------------------------------------------------------------------------
// THE ARITHMETIC IS PINNED HERE, NOT LEFT TO THE IMPLEMENTER
// -------------------------------------------------------------------------
// Spec 7.1 fixes the ROUNDING POLICY ("selisih akumulasi dibebankan seluruhnya
// ke angsuran terakhir", "SUM(pokok) sama persis") but not the arithmetic that
// gets there, and two reasonable implementations of "round" differ by a sen on
// almost every row. A sen of drift is a reconciliation break (spec 8.4 check
// 10), so the convention is nailed down below and the tests assert it to the
// sen. If the client's accounting team wants a different convention, this
// block and the fixtures change together, deliberately.
//
//   1. All arithmetic happens on BigInt MINOR UNITS (sen). No parseFloat, no
//      Number, anywhere, for any amount.
//   2. Rates are BigInt MICRO units (6 decimals), matching
//      pumk_akad.jasa_adm_rate NUMERIC(9,6). "0.030000" -> 30000n.
//   3. Division TRUNCATES TOWARD ZERO. Never round-half-up, never banker's
//      rounding: truncation is the only rule that guarantees the last-row
//      remainder is non-negative, and a negative remainder on the last row
//      would violate the CHECK on pumk_jadwal_angsuran.pokok.
//   4. `pembulatan_angsuran` becomes a rounding UNIT in sen:
//         0    -> 1n        (no rounding beyond the column's 2 decimals)
//         100  -> 10000n    (nearest hundred rupiah)
//         1000 -> 100000n   (nearest thousand rupiah)
//      Every row 1..n-1 is FLOORED to that unit (`x - (x % unit)`).
//   5. THE LAST ROW OF THE SCHEDULE TAKES THE WHOLE ACCUMULATED REMAINDER,
//      separately for pokok and for jasa:
//         pokok_terakhir = pokok_pinjaman - SUM(pokok baris sebelumnya)
//         jasa_terakhir  = target_jasa    - SUM(jasa baris sebelumnya)
//      Consequence, and it is intended: on a rounded schedule the last row's
//      `total` is NOT equal to the other rows' `total`.
//   6. `target_jasa` per method:
//         FLAT    trunc(pokok * rate * bulan_berjasa / 12)
//         EFEKTIF sum of the per-row unrounded values (see below)
//         ANUITAS sum of the per-row unrounded values (see below)
//   7. `saldo_pokok_setelah` is pokok_pinjaman minus the cumulative ROUNDED
//      pokok, so the last row is exactly "0.00" by construction, and the
//      EFEKTIF/ANUITAS jasa of row k is computed on that same rounded balance.
//      There is no second, unrounded shadow balance anywhere.

import { buatEngineAngsuran } from "./service";

// ---------------------------------------------------------------------------
// Money and rates
// ---------------------------------------------------------------------------

/**
 * A fixed-precision amount as a decimal string with exactly two fractional
 * digits and no thousands separator: "0.00", "1500000.00". Amounts are never
 * negative. Same type as `Uang` in modules/jurnal/contract.ts; see header.
 */
export type Uang = string;

/** Matches a valid `Uang`: non-negative, exactly two decimal places. */
export const POLA_UANG = /^\d{1,18}\.\d{2}$/;

/**
 * An annual rate as a decimal string with exactly six fractional digits,
 * mirroring NUMERIC(9,6): "0.030000" is three percent. A rate is not money, so
 * it gets its own type; using `Uang` for it would silently truncate the last
 * four digits of every rate the database returns.
 */
export type RateTahunan = string;

/** Matches a valid `RateTahunan`. */
export const POLA_RATE = /^\d{1,3}\.\d{6}$/;

/** Rounding unit in sen, derived from `angsuran.pembulatan_angsuran`. */
export const UNIT_PEMBULATAN: Readonly<Record<string, bigint>> = Object.freeze({
  "0": 1n,
  "100": 10_000n,
  "1000": 100_000n,
});

// ---------------------------------------------------------------------------
// Enumerations, mirrored from the CHECK constraints in migrations/0008_pumk.sql
// ---------------------------------------------------------------------------

/** pumk_akad.metode_perhitungan (spec 7.1). */
export type MetodePerhitungan = "FLAT" | "EFEKTIF" | "ANUITAS";

/** pumk_jadwal_angsuran.status. */
export type StatusBarisJadwal =
  | "BELUM_JATUH_TEMPO"
  | "JATUH_TEMPO"
  | "LUNAS"
  | "SEBAGIAN"
  | "DIRESCHEDULE";

/** pumk_akad.status. */
export type StatusAkad =
  | "BELUM_CAIR"
  | "AKTIF"
  | "LUNAS"
  | "RESCHEDULED"
  | "MACET"
  | "HAPUS_BUKU";

/** alokasi_setoran_preset.komponen (spec 5.4). */
export type KomponenAlokasi =
  | "TUNGGAKAN_JASA"
  | "TUNGGAKAN_POKOK"
  | "JASA_BERJALAN"
  | "POKOK_BERJALAN"
  | "KELEBIHAN";

/** pumk_reschedule.jenis and .status. */
export type JenisReschedule =
  | "PERPANJANG_TENOR"
  | "TURUNKAN_ANGSURAN"
  | "GRACE_PERIOD"
  | "RESTRUKTUR_POKOK";
export type StatusReschedule = "DRAFT" | "DISETUJUI" | "DITOLAK";

/**
 * `konfigurasi.akuntansi.jasa_grace_period` (ASSUMPTIONS.md A-05). Drives both
 * how many rows carry jasa and what the FLAT total jasa is:
 *
 *   TIDAK_DIHITUNG        grace rows carry jasa 0 and no jasa accrues for them
 *                         at all; FLAT target jasa uses `tenor` months.
 *   DIHITUNG_DIBAYAR      every row including the grace rows carries jasa;
 *                         FLAT target jasa uses `grace + tenor` months.
 *   DIHITUNG_DITANGGUHKAN jasa accrues during grace but the grace rows carry
 *                         0; FLAT target jasa uses `grace + tenor` months and
 *                         is spread over the `tenor` post-grace rows only.
 *
 * SPEC CONFLICT, deliberately not resolved in code: spec 7.1 says the default
 * is "jasa dibayar", while ASSUMPTIONS.md A-05 and the row shipped by
 * migrations/0004 make TIDAK_DIHITUNG the default. The engine must READ the
 * row, and no test in this folder asserts which value is the default.
 */
export type KebijakanJasaGrace =
  | "TIDAK_DIHITUNG"
  | "DIHITUNG_DITANGGUHKAN"
  | "DIHITUNG_DIBAYAR";

/**
 * Definition of "equivalent" for the flat-rate conversion helper that
 * docs/BUILD-PLAN.md requires (PER-1/MBU/03/2023 pasal 22(2) sets 3 percent
 * EFEKTIF, or a flat rate equivalent to it).
 *
 *   EFEKTIF_POKOK_RATA  equal-principal declining balance, which is exactly
 *                       what MetodePerhitungan EFEKTIF computes here. Total
 *                       jasa = rate * pokok * (n + 1) / 24, so the equivalent
 *                       flat rate is rate * (n + 1) / (2n). Implementable and
 *                       verifiable against the EFEKTIF schedule itself, which
 *                       is what the tests do.
 *   IRR_ANUITAS         the annuity-IRR reading of "efektif". docs/REGULASI.md
 *                       finding 3 records that which definition applies is an
 *                       open decision for the client's accounting team, so the
 *                       engine MUST refuse this basis with
 *                       `BASIS_EKUIVALENSI_BELUM_DIPUTUSKAN` rather than
 *                       silently pick a formula. Failing closed on an
 *                       undecided policy is the requirement, not a limitation.
 */
export type BasisEkuivalensi = "EFEKTIF_POKOK_RATA" | "IRR_ANUITAS";

/** Permission codes this engine checks (spec 2, modules/auth/permissions.ts). */
export const PERMISSION_ANGSURAN = {
  /** Maker generates the schedule as part of the akad step (spec 9.1). */
  GENERATE_JADWAL: "pumk.akad",
  /** Maker records an instalment receipt. */
  SETORAN: "pumk.angsuran",
  /** Maker drafts a reschedule. */
  RESCHEDULE_AJUKAN: "pumk.reschedule",
  /** Approver approves it (spec 7.3.1). */
  RESCHEDULE_SETUJUI: "pumk.approve",
} as const;

/**
 * Configuration the engine must READ rather than hardcode. Spec 5's preamble
 * and docs/BUILD-PLAN.md both make these the client accounting team's
 * decision, so the tests assert the MECHANIC (changing the row changes the
 * behaviour) and never the policy value.
 *
 * `angsuran.hari_jatuh_tempo_tetap` is the one key here that is NOT yet in
 * modules/konfigurasi/katalog.ts. Spec 7.1 requires it ("Sediakan opsi
 * konfigurasi hari jatuh tempo tetap, misal selalu tanggal 25") and the
 * catalogue is another module's file, so it is declared here and seeded by
 * this module's test-support; adding the catalogue entry is the konfigurasi
 * owner's task.
 */
export const KUNCI_KONFIGURASI = {
  /** ENUM "0" | "100" | "1000"; rupiah rounding unit (spec 5.3). */
  PEMBULATAN: { grup: "angsuran", kunci: "pembulatan_angsuran" },
  /** Preset code in `alokasi_setoran_preset` (spec 5.4). */
  PRESET_ALOKASI: { grup: "angsuran", kunci: "urutan_alokasi_setoran_preset" },
  /** 0 = same day-of-month as tanggal_mulai_angsuran; 1..31 = fixed day. */
  HARI_JATUH_TEMPO_TETAP: { grup: "angsuran", kunci: "hari_jatuh_tempo_tetap" },
  /** KebijakanJasaGrace (spec 7.1 grace period, ASSUMPTIONS.md A-05). */
  JASA_GRACE: { grup: "akuntansi", kunci: "jasa_grace_period" },
  /** ENUM "360" | "365" (spec 5.3). Only EFEKTIF/ANUITAS consult it. */
  BASIS_HARI: { grup: "jasa_adm", kunci: "jasa_adm_basis_hari" },
  /** BOOLEAN; derive the FLAT rate from the reference effective rate. */
  TURUNKAN_FLAT_DARI_EFEKTIF: { grup: "jasa_adm", kunci: "turunkan_flat_dari_efektif" },
  /** RateTahunan used as the conversion reference when the switch is on. */
  RATE_EFEKTIF_ACUAN: { grup: "jasa_adm", kunci: "rate_efektif_acuan" },
  /** INTEGER; regulatory ceiling, 36 months (docs/BUILD-PLAN.md). */
  TENOR_MAX: { grup: "batasan", kunci: "tenor_max_bulan" },
  /** INTEGER; grace ceiling (spec 5.5). */
  GRACE_MAX: { grup: "batasan", kunci: "grace_period_max_bulan" },
} as const;

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * Every rejection the engine produces carries one of these codes.
 *
 * Several of the invariants behind them are enforced by Postgres in
 * migrations/0008_pumk.sql: schedule immutability (trg_pumk_jadwal_10_immutable,
 * TJSL-JDW-002), one active version per akad (pumk_jadwal_versi_aktif_uq),
 * version-1 total pokok as a DEFERRED constraint trigger
 * (trg_pumk_jadwal_50_total_pokok, TJSL-JDW-001), and
 * `0 <= outstanding_pokok <= pokok_pinjaman` as CHECKs. When the DB raises,
 * the engine MUST catch the driver error and re-raise it as an `AngsuranError`
 * with the matching code: a raw trigger string like
 *   'TJSL-JDW-001: total pokok jadwal versi 1 (...) harus sama persis ...'
 * must never reach a caller, an HTTP response, or a log line a user reads.
 * The Bun Postgres driver exposes the SQLSTATE as `err.errno` and the
 * constraint name as `err.constraint`; map on those, not on message text.
 *
 * These tests assert the engine produces a clean domain error AHEAD of the
 * trigger, not that Postgres works.
 */
export const KODE_ANGSURAN = {
  // --- akad and schedule lookup
  AKAD_TIDAK_DITEMUKAN: "AKAD_TIDAK_DITEMUKAN",
  AKAD_TIDAK_BISA_DIANGSUR: "AKAD_TIDAK_BISA_DIANGSUR", // LUNAS / HAPUS_BUKU / BELUM_CAIR
  JADWAL_TIDAK_DITEMUKAN: "JADWAL_TIDAK_DITEMUKAN",
  JADWAL_SUDAH_ADA: "JADWAL_SUDAH_ADA", // regenerate instead of reschedule

  // --- schedule generation input (spec 7.1, bounds from konfigurasi)
  POKOK_TIDAK_VALID: "POKOK_TIDAK_VALID", // <= 0
  POKOK_DILUAR_PLAFON: "POKOK_DILUAR_PLAFON",
  TENOR_TIDAK_VALID: "TENOR_TIDAK_VALID", // <= 0
  TENOR_DILUAR_BATAS: "TENOR_DILUAR_BATAS", // grace + tenor > tenor_max_bulan
  GRACE_DILUAR_BATAS: "GRACE_DILUAR_BATAS",
  RATE_TIDAK_VALID: "RATE_TIDAK_VALID",
  METODE_TIDAK_DIKENAL: "METODE_TIDAK_DIKENAL",
  TANGGAL_TIDAK_VALID: "TANGGAL_TIDAK_VALID",
  NILAI_BUKAN_DESIMAL: "NILAI_BUKAN_DESIMAL", // amount/rate is not a valid Uang/RateTahunan

  // --- rounding and totals (spec 7.1, invariant 9)
  PEMBULATAN_TIDAK_VALID: "PEMBULATAN_TIDAK_VALID", // config value outside 0/100/1000
  TOTAL_POKOK_TIDAK_COCOK: "TOTAL_POKOK_TIDAK_COCOK", // internal assert, ahead of TJSL-JDW-001
  JADWAL_IMMUTABLE: "JADWAL_IMMUTABLE", // ahead of TJSL-JDW-002

  // --- allocation (spec 7.2)
  SETORAN_TIDAK_POSITIF: "SETORAN_TIDAK_POSITIF",
  PRESET_ALOKASI_TIDAK_DITEMUKAN: "PRESET_ALOKASI_TIDAK_DITEMUKAN",
  PRESET_ALOKASI_TIDAK_LENGKAP: "PRESET_ALOKASI_TIDAK_LENGKAP", // a komponen is missing
  AKUN_KAS_TIDAK_VALID: "AKUN_KAS_TIDAK_VALID",
  OUTSTANDING_NEGATIF: "OUTSTANDING_NEGATIF", // invariant 10, ahead of the CHECK
  JURNAL_GAGAL: "JURNAL_GAGAL", // journal port rejected; the whole allocation rolled back

  // --- reschedule (spec 7.3)
  // Carrying accrued jasa onto the new version found no room for it, so the
  // restructure would silently write off income already recognised and a
  // receivable already in the ledger (migrations/0030).
  AKRUAL_TIDAK_TERTAMPUNG: "AKRUAL_TIDAK_TERTAMPUNG",
  RESCHEDULE_TIDAK_DITEMUKAN: "RESCHEDULE_TIDAK_DITEMUKAN",
  RESCHEDULE_BELUM_DISETUJUI: "RESCHEDULE_BELUM_DISETUJUI",
  RESCHEDULE_SUDAH_DIPROSES: "RESCHEDULE_SUDAH_DIPROSES",
  ALASAN_WAJIB: "ALASAN_WAJIB",
  APPROVER_TIDAK_BOLEH_MAKER: "APPROVER_TIDAK_BOLEH_MAKER", // spec 2 rule 1

  // --- rate conversion (docs/BUILD-PLAN.md)
  BASIS_EKUIVALENSI_BELUM_DIPUTUSKAN: "BASIS_EKUIVALENSI_BELUM_DIPUTUSKAN",

  // --- configuration and authorisation
  KONFIGURASI_TIDAK_ADA: "KONFIGURASI_TIDAK_ADA",
  KONFIGURASI_TIDAK_VALID: "KONFIGURASI_TIDAK_VALID",
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
} as const;

export type KodeAngsuran = (typeof KODE_ANGSURAN)[keyof typeof KODE_ANGSURAN];

/**
 * The only error type this module throws. `message` is user-facing Indonesian
 * prose and must stay free of driver/trigger internals; `penyebabDb` is the
 * place for the raw DB text, for logs only. Same shape as `JurnalError`.
 */
export class AngsuranError extends Error {
  readonly kode: KodeAngsuran;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly penyebabDb?: string;

  constructor(
    kode: KodeAngsuran,
    message: string,
    detail: Record<string, unknown> = {},
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "AngsuranError";
    this.kode = kode;
    this.detail = detail;
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// Schedule shapes
// ---------------------------------------------------------------------------

/** One row of a schedule, mirroring pumk_jadwal_angsuran's priced columns. */
export interface BarisJadwal {
  angsuranKe: number;
  /** ISO date, `YYYY-MM-DD`. */
  tanggalJatuhTempo: string;
  pokok: Uang;
  jasaAdm: Uang;
  /** Always pokok + jasaAdm (pumk_jadwal_total_ck). */
  total: Uang;
  /** pokok_pinjaman minus cumulative pokok. Exactly "0.00" on the last row. */
  saldoPokokSetelah: Uang;
}

/** Spec 7.4's required summary output. */
export interface RingkasanJadwal {
  totalPokok: Uang;
  totalJasa: Uang;
  totalBayar: Uang;
  /**
   * The instalment a borrower is quoted: the `total` of the first row that
   * carries pokok. Deliberately NOT an average, and deliberately not the last
   * row, which absorbs the rounding remainder (see the header, rule 5).
   */
  angsuranPerBulan: Uang;
  jumlahBaris: number;
}

/**
 * A schedule table with nothing persisted about it. This is what
 * `simulasiJadwal` returns, and it is the part of `Jadwal` that spec 7.5
 * item 11 requires to be IDENTICAL between simulation and real generation, so
 * the identity assertion is a single deep-equal on this object and cannot be
 * weakened by an id or a timestamp sneaking into the comparison.
 */
export interface TabelJadwal {
  baris: BarisJadwal[];
  ringkasan: RingkasanJadwal;
  /** Echo of the parameters actually used, after config resolution. */
  parameterTerpakai: ParameterTerpakai;
}

/**
 * The resolved parameters. Present so a test can prove the engine READ the
 * configuration instead of hardcoding it, and so a stored schedule can be
 * explained later on the kartu piutang (spec 9.1).
 */
export interface ParameterTerpakai {
  pokok: Uang;
  /** The rate actually applied. Differs from the akad's rate when `turunkan_flat_dari_efektif` is on. */
  rate: RateTahunan;
  metode: MetodePerhitungan;
  tenorBulan: number;
  gracePeriodBulan: number;
  /** Rounding unit in rupiah, as read from config: 0, 100 or 1000. */
  pembulatan: number;
  jasaGrace: KebijakanJasaGrace;
  basisHari: number;
  /** 0 when due dates follow the start date's day-of-month. */
  hariJatuhTempoTetap: number;
}

/** A persisted schedule version. */
export interface Jadwal extends TabelJadwal {
  akadId: string;
  versi: number;
  isActiveVersion: boolean;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Spec 7.4: the calculator's inputs, with no akad and no proposal behind it. */
export interface SimulasiInput {
  pokok: Uang;
  rate: RateTahunan;
  metode: MetodePerhitungan;
  tenorBulan: number;
  gracePeriodBulan: number;
  /** ISO date, `YYYY-MM-DD`. */
  tanggalMulaiAngsuran: string;
}

/**
 * Spec 7.1 generation. Takes only the akad id: pokok, rate, metode, tenor,
 * grace and start date are columns on `pumk_akad`, and re-passing them would
 * let a caller persist a schedule that does not describe its own akad, which
 * the deferred trigger TJSL-JDW-001 would then reject at COMMIT with a raw
 * Postgres message.
 */
export interface GenerateJadwalInput {
  akadId: string;
}

/**
 * Spec 7.2 `alokasikanSetoran(akadId, tanggal, jumlah)`, plus the two fields
 * the schema makes mandatory: `pumk_angsuran.akun_kas_id` is NOT NULL (the
 * cash account picked on the form, which the journal's cash leg also needs),
 * and `noBukti` is the receipt number an operator types.
 */
export interface SetoranInput {
  akadId: string;
  /** ISO date, `YYYY-MM-DD`. Drives which rows count as arrears. */
  tanggal: string;
  jumlah: Uang;
  akunKasId: string;
  noBukti?: string | null;
  /** Value date, when the money landed. Defaults to `tanggal`. */
  tanggalValuta?: string | null;
  keterangan?: string | null;
}

/** What one schedule row received from one deposit. */
export interface RincianAlokasiBaris {
  jadwalId: string;
  angsuranKe: number;
  pokokDialokasikan: Uang;
  jasaDialokasikan: Uang;
  statusSetelah: StatusBarisJadwal;
}

export interface HasilAlokasi {
  angsuranId: string;
  jumlahDiterima: Uang;
  /** jumlahDiterima = alokasiPokok + alokasiJasa + alokasiKelebihan (pumk_angsuran_alokasi_ck). */
  alokasiPokok: Uang;
  alokasiJasa: Uang;
  alokasiKelebihan: Uang;
  /**
   * The two halves of `alokasiJasa`, and they always sum to it.
   *
   * `alokasiJasaAkrual` is the part that CLEARS Piutang Jasa Administrasi
   * because the closing engine had already accrued it onto the schedule rows
   * this receipt paid (`ANGSURAN_JASA_ADM_AKRUAL`); `alokasiJasaLangsung` is
   * the part recognised as income now (`ANGSURAN_JASA_ADM`). One receipt can
   * legitimately need both. Exposed rather than left inside the journal so a
   * caller, a report and a test can see the classification without reading
   * `jurnal_baris` back. See migrations/0030.
   */
  alokasiJasaAkrual: Uang;
  alokasiJasaLangsung: Uang;
  rincian: RincianAlokasiBaris[];
  /**
   * The waterfall the engine actually walked, in order, as read from
   * `alokasi_setoran_preset`. Exposed so a test can prove the order came from
   * configuration and not from the shape of the code (spec 5.4).
   */
  urutanKomponenDipakai: KomponenAlokasi[];
  /** Exactly ONE journal id, however many components moved (spec 7.2 step 8). */
  jurnalId: string;
  /** Set only when there was a surplus (invariant 10). */
  kelebihanId: string | null;
  akadSetelah: {
    outstandingPokok: Uang;
    outstandingJasa: Uang;
    status: StatusAkad;
    tanggalLunas: string | null;
  };
}

/** What `pulihkanAkrualSetoran` gave back, and to which rows. */
export interface HasilPemulihanAkrual {
  angsuranId: string;
  /** Sum restored by THIS call. "0.00" when there was nothing left to restore. */
  totalDipulihkan: Uang;
  /** Per active-version schedule row, in due-date order. */
  perBaris: Array<{ jadwalId: string; nilai: Uang }>;
}

/** Spec 7.3 step 1: a reschedule is drafted, then approved. */
export interface AjukanRescheduleInput {
  akadId: string;
  tanggalPengajuan: string;
  alasan: string;
  jenis: JenisReschedule;
  tenorBaru?: number | null;
  graceBaru?: number | null;
  jasaRateBaru?: RateTahunan | null;
  catatan?: string | null;
}

export interface Reschedule {
  id: string;
  akadId: string;
  status: StatusReschedule;
  jenis: JenisReschedule;
  jadwalVersiLama: number;
  jadwalVersiBaru: number | null;
  tenorBaru: number | null;
  graceBaru: number | null;
  jasaRateBaru: RateTahunan | null;
}

export interface HasilReschedule {
  reschedule: Reschedule;
  versiLama: number;
  versiBaru: number;
  jadwalBaru: Jadwal;
  /**
   * Spec 7.3 step 7: null when the principal does not change. Non-null only
   * for a principal correction.
   */
  jurnalId: string | null;
  /** Spec 7.5 item 10's arithmetic: these two must sum to the original principal. */
  pokokTerbayarHistoris: Uang;
  outstandingBaru: Uang;
}

export interface KonversiRateInput {
  rateEfektif: RateTahunan;
  tenorBulan: number;
  /** Defaults to EFEKTIF_POKOK_RATA. */
  basis?: BasisEkuivalensi;
}

// ---------------------------------------------------------------------------
// Ports the engine consumes
// ---------------------------------------------------------------------------

/** A handle that runs statements on ONE connection inside ONE transaction. */
export interface AngsuranTx {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * The database port the engine needs. Wider than `core/ports/db.ts` on
 * purpose, and declared here rather than by editing that port, for exactly the
 * reason modules/jurnal declares its own `JurnalDbPort`: the core port is
 * query-only, another agent is live in core/**, and this engine cannot be
 * built on autocommit queries.
 *
 *   - Spec 7.2 is explicit: "Seluruh langkah 1 sampai 8 dalam satu transaksi
 *     database. Kalau jurnal gagal, alokasi harus rollback."
 *   - Spec 7.3 flips a version off, marks rows DIRESCHEDULE and writes a whole
 *     new version; a partial application would leave two active versions or
 *     none.
 *   - The version-1 total-pokok check is a DEFERRED constraint trigger, so it
 *     fires at COMMIT, not at the offending INSERT. `transaction()` must
 *     surface a COMMIT failure as a rejected promise, and the engine must
 *     translate it into `TOTAL_POKOK_TIDAK_COCOK`.
 */
export interface AngsuranDbPort extends AngsuranTx {
  transaction<T>(jalankan: (tx: AngsuranTx) => Promise<T>): Promise<T>;
}

/** One leg of the combined allocation journal, named by its spec 6.4 event. */
export interface KomponenJurnal {
  /** e.g. ANGSURAN_POKOK, ANGSURAN_JASA_ADM, TERIMA_KELEBIHAN_ANGSURAN. */
  eventCode: string;
  nilai: Uang;
  mitraId?: string | null;
  akadId?: string | null;
}

/**
 * The journal port. NOT `JurnalEngine`: spec 7.2 step 8 requires the pokok,
 * jasa and kelebihan components of one deposit to land in "satu jurnal dengan
 * beberapa baris, bukan tiga jurnal terpisah", and
 * modules/jurnal/contract.ts's `postingEvent(eventCode, payload)` produces one
 * whole journal per call, so three calls would produce three journals. The
 * capability this engine needs is therefore a COMBINED event posting: several
 * mapped events, one journal.
 *
 * It is a port rather than a direct dependency for three reasons:
 *   - invariant 11 still holds: the accounts come from
 *     `event_jurnal_mapping`, and only the journal module reads that table;
 *   - `bun tools/check-boundaries.ts` forbids a deep import into
 *     modules/jurnal, which has no index.ts yet;
 *   - the rollback requirement of spec 7.2 is only testable if the test can
 *     inject a poster that fails.
 *
 * It takes the transaction handle explicitly, because "same transaction" is
 * the requirement, not an implementation detail.
 */
export interface PorterJurnalAngsuran {
  postingEventGabungan(
    input: {
      cabangId: string;
      tanggalTransaksi: string;
      komponen: KomponenJurnal[];
      keterangan?: string | null;
      referensiTipe?: string | null;
      referensiId?: string | null;
      /** Overrides the cash leg of every component's mapping. */
      akunKasId?: string | null;
      kunciIdempotensi?: string | null;
    },
    tx: AngsuranTx,
    ctx: AngsuranContext,
  ): Promise<{ jurnalId: string; jumlahBaris: number }>;
}

/** Who is acting. Same shape as `JurnalContext` (spec 2 rule 3). */
export interface AngsuranContext {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  cabangDalamScope?: readonly string[];
}

export interface AngsuranEngineDeps {
  db: AngsuranDbPort;
  jurnal: PorterJurnalAngsuran;
  /** Injectable clock, so tests are not hostage to the wall clock. */
  jam?: () => Date;
}

// ---------------------------------------------------------------------------
// The engine (spec 7)
// ---------------------------------------------------------------------------

export interface AngsuranEngine {
  /**
   * Spec 7.1. Reads pokok/rate/metode/tenor/grace/start from `pumk_akad` and
   * the rounding, grace-jasa, day-basis and due-date parameters from
   * `konfigurasi`, writes `pumk_jadwal_versi` version 1 plus its
   * `pumk_jadwal_angsuran` rows in ONE transaction (the total-pokok trigger is
   * deferred), and asserts `SUM(pokok) = pokok_pinjaman` in code before COMMIT
   * rather than relying on the trigger ("Assert ini di kode, jangan hanya di
   * test").
   *
   * A second call for an akad that already has a version rejects with
   * `JADWAL_SUDAH_ADA`: changing a schedule is a reschedule (invariant 8).
   */
  generateJadwal(input: GenerateJadwalInput, ctx: AngsuranContext): Promise<Jadwal>;

  /**
   * Spec 7.4. Stores NOTHING and creates no journal. Must produce a table
   * IDENTICAL to `generateJadwal` for the same inputs (spec 7.5 item 11),
   * which is only achievable by calling the same pure kernel; a second copy of
   * the formulas is a defect even when it happens to agree.
   */
  simulasiJadwal(input: SimulasiInput, ctx: AngsuranContext): Promise<TabelJadwal>;

  /**
   * Spec 7.2, all eight steps in one transaction. The waterfall order comes
   * from `alokasi_setoran_preset` for the preset named by
   * `angsuran.urutan_alokasi_setoran_preset`; a surplus becomes a
   * `pumk_kelebihan` row and never a negative receivable (invariant 10); the
   * akad flips to LUNAS with `tanggal_lunas` when both outstandings reach
   * zero; and every component of the deposit lands in ONE journal.
   *
   * If the journal fails, everything rolls back and the call rejects with
   * `JURNAL_GAGAL`.
   */
  alokasikanSetoran(input: SetoranInput, ctx: AngsuranContext): Promise<HasilAlokasi>;

  /** Spec 7.3 step 1: creates the DRAFT. Changes nothing about the schedule. */
  ajukanReschedule(input: AjukanRescheduleInput, ctx: AngsuranContext): Promise<Reschedule>;

  /**
   * Spec 7.3 steps 2 to 8. Requires `pumk.approve`, and the approver must not
   * be the requester (spec 2 rule 1: reject, do not merely hide the button).
   * Deactivates the old version, marks its unpaid rows DIRESCHEDULE, leaves
   * its LUNAS rows untouched, generates the next version from the CURRENT
   * outstanding, sets the akad to RESCHEDULED (still an active receivable),
   * and creates no journal when the principal is unchanged.
   *
   * WHERE THE NEW VERSION'S DUE DATES START, which spec 7.3 does not say: at
   * the EARLIEST UNPAID due date of the version being superseded, then monthly
   * by the same rule as spec 7.1. The restructured schedule resumes where
   * collection was interrupted; dating it from the approval date instead would
   * silently forgive the instalment already in arrears, which is the opposite
   * of what a reschedule is for.
   */
  setujuiReschedule(rescheduleId: string, ctx: AngsuranContext): Promise<HasilReschedule>;

  /**
   * Gives back the accrued jasa a receipt consumed, so Piutang Jasa
   * Administrasi is restored to what it was before that receipt cleared it.
   *
   * THE HALF OF A RECEIPT REVERSAL THIS MODULE OWNS, and deliberately only
   * that half. Reversing a receipt end to end (un-allocating the schedule
   * rows, restoring the akad's outstanding, undoing a `pumk_kelebihan`) has no
   * implementation anywhere in this repository today: no `PembalikStateBisnis`
   * is registered for `referensi_tipe = 'pumk_angsuran'`, so
   * `reversalJurnal` REFUSES such a journal outright with
   * `PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR` rather than reversing the
   * accounting alone. When that reverser is built it MUST call this, because
   * the accrual balance is the one piece of receipt state that lives outside
   * both the ledger and the payment columns.
   *
   * Idempotent: the second call finds every consumption already restored and
   * changes nothing. Restores onto the ORIGINAL schedule row when it is still
   * on the active version, and onto the active version's earliest rows with
   * room when a reschedule has since retired it.
   */
  pulihkanAkrualSetoran(
    angsuranId: string,
    ctx: AngsuranContext,
  ): Promise<HasilPemulihanAkrual>;

  /**
   * The conversion helper docs/BUILD-PLAN.md requires: derive the FLAT rate
   * that is equivalent to a given EFEKTIF rate. Synchronous and pure, so it is
   * usable inside the schedule kernel and directly unit-testable.
   *
   * For `EFEKTIF_POKOK_RATA` the equivalence is definitional: the flat
   * schedule's total jasa must equal the equal-principal declining-balance
   * schedule's total jasa for the same pokok and tenor. That is the property
   * the tests assert; the resulting number is a consequence, not a policy.
   */
  rateFlatEkuivalen(input: KonversiRateInput): RateTahunan;

  /** Reads every version of an akad's schedule, newest version first (spec 7.3 step 8, spec 9.1 kartu piutang). */
  riwayatJadwal(akadId: string, ctx: AngsuranContext): Promise<Jadwal[]>;
}

/**
 * The one implementation site, kept here so a caller only ever names this
 * file. The logic lives in ./service.ts; see the note in
 * modules/jurnal/contract.ts on why the contract owns the factory and the
 * service owns the behaviour.
 *
 * The import below closes a cycle (contract -> service -> kesalahan ->
 * contract). It is safe, and it is kept safe on purpose: neither ./service.ts
 * nor ./kesalahan.ts touches a runtime binding of this file at module
 * evaluation time, so nothing here is read while it is still in its temporal
 * dead zone. ./kesalahan.ts says so at its message catalogue, which is written
 * with string-literal keys for exactly that reason.
 */
export function createAngsuranEngine(deps: AngsuranEngineDeps): AngsuranEngine {
  return buatEngineAngsuran(deps);
}

// ---------------------------------------------------------------------------
// Spec 7.2's named surface, `alokasikanSetoran(akadId, tanggal, jumlah)`.
//
// THE ENGINE IS A DEPENDENCY, NOT A MODULE-GLOBAL. An earlier draft of this
// file registered the wired engine in a module-level variable so this function
// could find it. modules/jurnal removed exactly that pattern after it bit:
// with a per-fixture app the global is re-pointed by whichever `createApp` ran
// last, so a call can land on another fixture's connection pool. So the engine
// is passed in, which also keeps this function honest about the two arguments
// the spec's signature omits: `pumk_angsuran.akun_kas_id` is NOT NULL, and
// authorisation needs a context.
// ---------------------------------------------------------------------------

export async function alokasikanSetoran(
  akadId: string,
  tanggal: string,
  jumlah: Uang,
  ctx: AngsuranContext,
  opsi: { engine: AngsuranEngine; akunKasId: string; noBukti?: string | null },
): Promise<HasilAlokasi> {
  return opsi.engine.alokasikanSetoran(
    { akadId, tanggal, jumlah, akunKasId: opsi.akunKasId, noBukti: opsi.noBukti ?? null },
    ctx,
  );
}
