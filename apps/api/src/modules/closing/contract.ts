// apps/api/src/modules/closing/contract.ts
//
// TYPE CONTRACT FOR THE CLOSING ENGINE (spec 8). Written BEFORE the
// implementation, per spec rule 5: the tests in this folder are the
// specification, and this file is the shape they were written against.
// ./service.ts currently throws from every method; nothing here may be widened
// or renamed to make an implementation fit more easily.
//
// -------------------------------------------------------------------------
// THE ONE THING THIS MODULE MUST NOT GET WRONG
// -------------------------------------------------------------------------
// `saldo_akun_periode` is FROZEN at close and every past-period report reads
// it instead of recomputing (invariant 14). It must therefore be computed from
// `v_ledger_baris`, whose predicate is `status IN ('POSTED','REVERSED')`, and
// NEVER from `status = 'POSTED'` alone.
//
// Why, concretely (ADR 0010, and migrations/0018 flagged this module by name):
// a reversal ADDS two rows and REMOVES none. Marking the original REVERSED
// drops its lines out of a POSTED-only sum while the reversing journal is
// still subtracting, so the correction is counted twice. Every journal still
// balances, the trial balance still sums to zero, and the reconciliation
// report faithfully prints the wrong number. Because closing FREEZES the
// figure, the error is not transient: it is baked into that period forever and
// into every report that reads the snapshot.
//
// ./closing-saldo-ledger.test.ts posts a journal, reverses it, closes the
// period, and asserts the frozen figure matches the ledger predicate and
// DIFFERS from the naive one. That test is the whole reason this note exists.
//
// -------------------------------------------------------------------------
// MONEY
// -------------------------------------------------------------------------
// `Uang` is a decimal string with exactly two fractional digits, the same
// convention modules/jurnal fixed and for the same reasons (invariant 7: never
// float, never double; NUMERIC(20,2) outruns Number.MAX_SAFE_INTEGER). Rates
// are NUMERIC(9,6) and are also strings, for the same reason: 0.1 + 0.2 does
// not equal 0.3 and an allowance rate multiplies a balance-sheet figure.
//
// At the SQL boundary, remember that `coalesce(sum(x), 0)` returns the string
// '0' and not '0.00'. Cast to `::numeric(20,2)` BEFORE `::text` or the value
// fails `POLA_UANG` and every equality assertion against it.
//
// -------------------------------------------------------------------------
// POLICY IS DATA, NOT CODE
// -------------------------------------------------------------------------
// Spec 5's preamble makes every number in sections 5.1, 5.2, 5.3 and 5.6 a
// DEFAULT AWAITING CLIENT CONFIRMATION, and docs/REGULASI.md found the spec's
// penyisihan rate table (0/25/75/100 percent) is not what the regulation in
// force says: audited PUMK statements use collective impairment from at least
// two years of collection history. docs/BUILD-PLAN.md therefore requires TWO
// MODES, selected by `akuntansi.mode_penyisihan`, not one table with different
// numbers in it.
//
// So: day ranges come from `kolektibilitas_range`, rates from
// `penyisihan_rate` or from history, and the recognition method from
// `akuntansi.metode_pengakuan_jasa_adm`. No test in this folder asserts that
// any policy number is CORRECT; every test asserts the MECHANIC, that changing
// the row changes the behaviour. A missing row is a refusal
// (`KONFIGURASI_TIDAK_ADA`), never a literal fallback: a fallback rate is a
// wrong number in a client's audited accounts that nobody can trace.
import type { DbPort, QueryRunner } from "../../core/ports/db";
import type { DimensiBaris, Jurnal, JurnalContext, JurnalTx } from "../jurnal/index";
import { buatEngineClosing } from "./service";

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Decimal string, exactly two fractional digits. May be negative: spec 8.2's
 *  `beban_penyisihan_periode` is signed (negative = pemulihan) and
 *  `saldo_akun_periode` is debit-positive, so a credit-balance account carries
 *  a negative figure. */
export type Uang = string;

/** Matches a valid `Uang`, including the negative form. */
export const POLA_UANG = /^-?\d{1,18}\.\d{2}$/;

/** NUMERIC(9,6) as a string, e.g. "0.250000". Never a JS number. */
export type Rate = string;

export const POLA_RATE = /^\d{1,3}\.\d{6}$/;

/** Mirrors the CHECK on `kolektibilitas_kelas.kode` (migrations/0004). */
export type KelasKolektibilitas = "LANCAR" | "KURANG_LANCAR" | "DIRAGUKAN" | "MACET";

/** Mirrors the CHECK on `periode.status` (migrations/0007). */
export type StatusPeriode = "OPEN" | "CLOSING_IN_PROGRESS" | "CLOSED";

/** Mirrors the CHECK on `closing_kolektibilitas.status` (migrations/0011). */
export type StatusRunKolektibilitas = "PREVIEW" | "SELESAI" | "GAGAL" | "DIBATALKAN";

/** spec 5.6 `metode_pengakuan_jasa_adm`. */
export type MetodePengakuanJasa = "CASH_BASIS" | "ACCRUAL";

/** spec 5.2, mirrored by `kolektibilitas_snapshot.dasar_perhitungan`. */
export type DasarPerhitunganPenyisihan =
  | "OUTSTANDING_POKOK"
  | "OUTSTANDING_POKOK_PLUS_JASA";

/**
 * docs/BUILD-PLAN.md "Dampak temuan regulasi ke kemampuan engine": both must
 * exist as capabilities, the live one chosen by `konfigurasi`, not by a deploy.
 */
export type ModePenyisihan = "RATE_TABLE" | "KOLEKTIF_HISTORIS";

/**
 * WHERE A SNAPSHOT'S RATE CAME FROM.
 *
 * docs/REGULASI.md is explicit ("Tambahkan kolom `sumber_rate`"): with two
 * modes live, `kolektibilitas_snapshot.rate_penyisihan` alone cannot say
 * whether 0.400000 was typed into `penyisihan_rate` or derived from collection
 * history, so a closed period's Laporan Perhitungan Penyisihan stops being
 * reproducible the moment the mode is switched (invariant 14).
 *
 * migrations/0011 ships `dasar_perhitungan` but NOT `sumber_rate`. That is a
 * FINDING, pinned by ./closing-fixture.test.ts, not a column this module may
 * invent in a fixture.
 */
export type SumberRate = "TABEL_KONFIGURASI" | "KOLEKTIF_HISTORIS";

// ---------------------------------------------------------------------------
// Permissions (spec 2, spec 9.3)
// ---------------------------------------------------------------------------

/**
 * The codes this engine checks. Resolved against the SHIPPED catalogue in
 * modules/auth; a code absent from it must make the operation FAIL CLOSED
 * with `IZIN_BELUM_TERDAFTAR` rather than be silently treated as granted.
 * That mechanism has already caught two real gaps (`pumk.cluster`,
 * `nonpumk.lpj.verifikasi`).
 *
 * Spec 2 puts "eksekusi closing" on the Approver and "reopen periode" on Admin
 * Pusat, and the shipped matrix agrees: APPROVER holds
 * `admin.closing.kolektibilitas` and `admin.closing.periode`, and only
 * ADMIN_PUSAT holds `admin.periode.reopen`.
 *
 * PENYISIHAN AND AKRUAL DELIBERATELY REUSE `admin.closing.periode` rather than
 * getting codes of their own. Spec 9.3 lists exactly two closing screens,
 * "Closing Kolektibilitas" and "Closing Periode"; the allowance and the
 * accrual are steps inside the second, not a third menu. Inventing
 * `admin.closing.penyisihan` here would be this module deciding an
 * authorisation question the specification already answered.
 */
export const PERMISSION_CLOSING = {
  /** spec 9.3 "Closing Kolektibilitas": jalankan, preview, riwayat. */
  KOLEKTIBILITAS: "admin.closing.kolektibilitas",
  /** spec 9.3 "Closing Periode": eksekusi, and the penyisihan/akrual steps. */
  PERIODE: "admin.closing.periode",
  /** spec 8.4 reopen: Admin Pusat only, with a written reason. */
  REOPEN: "admin.periode.reopen",
  /**
   * READING the prerequisite checklist, the migration matrix and a closed
   * period's frozen balances, WITHOUT the right to run anything.
   *
   * NOT IN THE SHIPPED CATALOGUE. That is a FINDING, filed by
   * ./closing-otorisasi.test.ts as a fail-closed pin, and it is the same shape
   * as `pumk.cluster` and `nonpumk.lpj.verifikasi` before them:
   *
   *   Spec 2 gives the Auditor "read only penuh termasuk semua laporan dan
   *   audit trail" and spec 16 scenario 23 tests it. How a period was closed,
   *   and against which checklist, is the auditor's primary object; it is not
   *   one of the 31 reports in spec 10, so `laporan.view` does not reach it.
   *   With no read-only code, the only ways to let an Auditor see the
   *   checklist are to grant a WRITE code (`admin.closing.periode`) to a
   *   role that must never write, or to lock the auditor out of the evidence.
   *   Neither is acceptable, so this module names the code it needs and
   *   refuses until the catalogue carries it.
   *
   * Until then every read path here fails closed with `IZIN_BELUM_TERDAFTAR`.
   * Do NOT add this string to a fixture's permission list to make a test
   * green; that is the exact move the two earlier findings survived.
   */
  LIHAT: "admin.closing.view",
} as const;

export type PermissionClosing = (typeof PERMISSION_CLOSING)[keyof typeof PERMISSION_CLOSING];

// ---------------------------------------------------------------------------
// Configuration this module READS. Never a hardcoded policy number.
// ---------------------------------------------------------------------------

/**
 * Keys resolved bumn-scoped first, then global (`bumn_id IS NULL`), the same
 * resolution modules/angsuran and modules/nonpumk use. Every one of these is
 * in the shipped catalogue (modules/konfigurasi/katalog.ts); a MISSING row is
 * still a refusal, because "shipped" is a claim about the seed and an operator
 * can soft-delete a row.
 */
export const KUNCI_KONFIGURASI_CLOSING = {
  /** spec 5.6. Decides whether 8.3 runs at all and whether check 6 applies. */
  METODE_PENGAKUAN_JASA: { grup: "akuntansi", kunci: "metode_pengakuan_jasa_adm" },
  /** spec 5.6, JSON array of `KelasKolektibilitas`. Default `["LANCAR"]`. */
  AKRUAL_HANYA_UNTUK: { grup: "akuntansi", kunci: "akrual_hanya_untuk_kolektibilitas" },
  /** spec 5.2, the base the allowance rate multiplies. */
  DASAR_PENYISIHAN: { grup: "akuntansi", kunci: "dasar_perhitungan_penyisihan" },
  /** BUILD-PLAN: RATE_TABLE or KOLEKTIF_HISTORIS. */
  MODE_PENYISIHAN: { grup: "akuntansi", kunci: "mode_penyisihan" },
  /** Months of collection history KOLEKTIF_HISTORIS needs before it may run. */
  MIN_BULAN_HISTORI: { grup: "akuntansi", kunci: "penyisihan_min_bulan_histori" },
  /** spec 5.6. false makes `bukaKembaliPeriode` refuse outright. */
  IZINKAN_REOPEN: { grup: "akuntansi", kunci: "izinkan_reopen_periode" },
  /** spec 8.1 step 7. */
  TANDAI_MITRA_BERMASALAH: {
    grup: "kolektibilitas",
    kunci: "tandai_mitra_bermasalah_saat_macet",
  },
  /** spec 8.4 check 8: negative cash is a warning, not a blocker, unless this
   *  says otherwise. Either way the user must confirm. */
  IZINKAN_KAS_NEGATIF: { grup: "kas", kunci: "izinkan_saldo_kas_negatif" },
} as const;

// ---------------------------------------------------------------------------
// Event codes this module posts (spec 6.4, via modules/jurnal only)
// ---------------------------------------------------------------------------

/**
 * Invariant 11: every one of these goes through `postingEvent`, so the
 * ACCOUNTS come from `event_jurnal_mapping` and never from this module.
 *
 * `HAPUS_BUKU_PIUTANG` IS NOT HERE AND MUST NOT BE. A write-off belongs to
 * modules/pumk and must go through `postingHapusBukuPiutang`, which consumes
 * the allowance that actually exists and routes the remainder to
 * `HAPUS_BUKU_KEKURANGAN_PENYISIHAN`. Posting the spec's raw event instead
 * debits the contra-asset for the full outstanding and drives it into a debit
 * balance, presenting as receivables OVERSTATED by exactly the amount that was
 * supposed to leave the balance sheet (docs/REGULASI.md finding 4,
 * modules/jurnal/contract.ts). The closing engine's obligation is narrower and
 * sharper: read `saldo_penyisihan_awal` FROM THE LEDGER, so a write-off that
 * already consumed the allowance is visible in the next period's requirement.
 */
export const EVENT_CLOSING = {
  BEBAN_PENYISIHAN: "BEBAN_PENYISIHAN",
  PEMULIHAN_PENYISIHAN: "PEMULIHAN_PENYISIHAN",
  AKRUAL_JASA_ADM: "AKRUAL_JASA_ADM",
} as const;

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * Several of these invariants are enforced by Postgres triggers
 * (`TJSL-PER-001` sequential close, `TJSL-PER-002` reopen order,
 * `TJSL-PER-003` mandatory reason, `TJSL-JRN-004` posting into a closed
 * period). The engine MUST validate first and expect to be the one refusing;
 * when the database refuses anyway it maps the SQLSTATE and the trigger's own
 * code prefix onto these, keeping the raw text in `penyebabDb`. A string like
 * 'TJSL-PER-001: tidak bisa closing 2026-3 ...' must never reach a caller.
 *
 * READ THE SQLSTATE FROM BOTH DRIVER SHAPES: `bun:sql` puts it in `err.errno`,
 * node-postgres in `err.code`, and `err.code` on a `bun:sql` error is not a
 * SQLSTATE at all (modules/jurnal/kesalahan.ts does this in one place).
 */
export const KODE_CLOSING = {
  // --- lookup -------------------------------------------------------------
  PERIODE_TIDAK_DITEMUKAN: "PERIODE_TIDAK_DITEMUKAN",
  CABANG_TIDAK_DITEMUKAN: "CABANG_TIDAK_DITEMUKAN",
  AKAD_TIDAK_DITEMUKAN: "AKAD_TIDAK_DITEMUKAN",

  // --- period state -------------------------------------------------------
  /** Running a closing step against a period that is not OPEN (spec 8.1
   *  idempotency: "hanya boleh dijalankan ulang selama periode masih OPEN"). */
  PERIODE_TIDAK_OPEN: "PERIODE_TIDAK_OPEN",
  /** Closing a period that is already CLOSED. */
  PERIODE_SUDAH_CLOSED: "PERIODE_SUDAH_CLOSED",
  /** Reopening a period that was never closed. */
  PERIODE_BELUM_CLOSED: "PERIODE_BELUM_CLOSED",
  /** Backstop for TJSL-PER-001; the engine should refuse at check 1 first. */
  URUTAN_PERIODE: "URUTAN_PERIODE",
  /** spec 8.4 reopen: only the most recently closed period. TJSL-PER-002. */
  REOPEN_BUKAN_PERIODE_TERAKHIR: "REOPEN_BUKAN_PERIODE_TERAKHIR",
  /** spec 8.4 reopen: a written reason is mandatory. TJSL-PER-003. */
  ALASAN_WAJIB: "ALASAN_WAJIB",
  /** `akuntansi.izinkan_reopen_periode` is false. */
  REOPEN_TIDAK_DIIZINKAN: "REOPEN_TIDAK_DIIZINKAN",

  // --- the checklist (spec 8.4) -------------------------------------------
  /** One or more prerequisite checks failed. `detail.gagal` carries them, each
   *  with its `KodePrasyarat`, its number and a readable reason. */
  PRASYARAT_GAGAL: "PRASYARAT_GAGAL",
  /** Check 8 is a warning, but spec 8.4 says it is "wajib dikonfirmasi user".
   *  Closing without `konfirmasiKasNegatif` refuses with this. */
  KONFIRMASI_KAS_NEGATIF_WAJIB: "KONFIRMASI_KAS_NEGATIF_WAJIB",

  // --- kolektibilitas (spec 8.1) ------------------------------------------
  /** 8.3 and 8.2 both need the snapshot; running them first is a refusal. */
  KOLEKTIBILITAS_BELUM_DIJALANKAN: "KOLEKTIBILITAS_BELUM_DIJALANKAN",
  /** A day count that falls in NO configured range. Refuse; do not default to
   *  LANCAR, which would silently under-provision the whole portfolio. */
  RANGE_KOLEKTIBILITAS_TIDAK_LENGKAP: "RANGE_KOLEKTIBILITAS_TIDAK_LENGKAP",
  /** Two configured ranges cover the same day count, so classification is
   *  ambiguous. migrations/0004 deliberately does not constrain this. */
  RANGE_KOLEKTIBILITAS_TUMPANG_TINDIH: "RANGE_KOLEKTIBILITAS_TUMPANG_TINDIH",

  // --- penyisihan (spec 8.2) ----------------------------------------------
  /** No `penyisihan_rate` row for a class that a snapshot needs. */
  RATE_PENYISIHAN_TIDAK_ADA: "RATE_PENYISIHAN_TIDAK_ADA",
  /** KOLEKTIF_HISTORIS with less history than `penyisihan_min_bulan_histori`. */
  HISTORI_TIDAK_CUKUP: "HISTORI_TIDAK_CUKUP",

  // --- configuration ------------------------------------------------------
  KONFIGURASI_TIDAK_ADA: "KONFIGURASI_TIDAK_ADA",
  KONFIGURASI_TIDAK_VALID: "KONFIGURASI_TIDAK_VALID",
  /** No active `event_jurnal_mapping` row for an event this step must post. */
  EVENT_MAPPING_BELUM_ADA: "EVENT_MAPPING_BELUM_ADA",
  /** A schema capability the engine needs is absent, so it refuses rather than
   *  writing a snapshot it cannot later explain (see `SumberRate`). */
  SKEMA_BELUM_LENGKAP: "SKEMA_BELUM_LENGKAP",

  // --- collaborators ------------------------------------------------------
  /** The ledger refused; the whole step rolls back. */
  JURNAL_GAGAL: "JURNAL_GAGAL",

  // --- values -------------------------------------------------------------
  NILAI_BUKAN_DESIMAL: "NILAI_BUKAN_DESIMAL",
  TANGGAL_TIDAK_VALID: "TANGGAL_TIDAK_VALID",

  // --- authorisation (spec 2) ---------------------------------------------
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
  /** A permission this module needs is not in the shipped catalogue, so the
   *  operation fails closed instead of treating an unknown code as granted. */
  IZIN_BELUM_TERDAFTAR: "IZIN_BELUM_TERDAFTAR",
} as const;

export type KodeClosing = (typeof KODE_CLOSING)[keyof typeof KODE_CLOSING];

/** The one error type this module raises. */
export class ClosingError extends Error {
  readonly kode: KodeClosing;
  readonly detail: Readonly<Record<string, unknown>>;
  /** Raw driver/trigger text, for the SERVER LOG ONLY. Never rendered. */
  readonly penyebabDb?: string;

  constructor(
    kode: KodeClosing,
    message: string,
    detail: Record<string, unknown> = {},
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "ClosingError";
    this.kode = kode;
    this.detail = Object.freeze({ ...detail });
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// spec 8.4, the ten prerequisite checks
// ---------------------------------------------------------------------------

/**
 * One code per check, numbered exactly as spec 8.4 numbers them, so a failing
 * test names the spec item and a UI can render the list in the spec's order.
 *
 * THREE OF THE TEN CAN ONLY EVER REPORT PASS, and that is worth stating rather
 * than discovering:
 *   3  every journal balances   the balance guard is a DEFERRED CONSTRAINT
 *                               TRIGGER (migrations/0010) and migrations/0020
 *                               tripwires any write that did not come through
 *                               the engine, so an unbalanced journal cannot be
 *                               constructed to fail this check.
 *   7  whole-ledger balance     follows from 3, per journal, summed.
 *   9  no negative outstanding  `pumk_akad.outstanding_pokok` carries
 *                               `CHECK (outstanding_pokok >= 0)`.
 * They stay in the checklist as defence in depth (a future migration could
 * relax any of the three, and an operator needs to SEE the line pass), but no
 * test in this folder claims to exercise their failure branch, because none
 * can without defeating a database guard.
 */
export const PRASYARAT_CLOSING = {
  PERIODE_SEBELUMNYA_BELUM_CLOSED: 1,
  ADA_JURNAL_DRAFT: 2,
  JURNAL_TIDAK_BALANCE: 3,
  KOLEKTIBILITAS_BELUM_DIJALANKAN: 4,
  PENYISIHAN_BELUM_POSTED: 5,
  AKRUAL_BELUM_POSTED: 6,
  NERACA_LAJUR_TIDAK_BALANCE: 7,
  SALDO_KAS_NEGATIF: 8,
  OUTSTANDING_POKOK_NEGATIF: 9,
  SUB_LEDGER_TIDAK_COCOK: 10,
} as const;

export type KodePrasyarat = keyof typeof PRASYARAT_CLOSING;

/**
 * PASS blocks nothing. GAGAL blocks closing. PERINGATAN blocks closing only
 * until the user confirms it: spec 8.4 check 8 is "warning, bukan blocker,
 * tapi wajib dikonfirmasi user", which is neither of the other two.
 */
export type StatusPrasyarat = "PASS" | "GAGAL" | "PERINGATAN";

export interface HasilPrasyarat {
  /** 1..10, exactly as spec 8.4 numbers them. */
  nomor: number;
  kode: KodePrasyarat;
  status: StatusPrasyarat;
  /**
   * Readable Indonesian, for an accountant, free of driver internals and
   * trigger codes. Spec 16 scenario 12 requires the DRAFT refusal to arrive
   * "dengan alasan yang jelas", so this is part of the contract, not polish.
   */
  alasan: string;
  /**
   * The drill-down. Check 10 in particular MUST carry the offending akad list
   * ("tampilkan daftar akad yang menyebabkan selisih"); check 2 carries the
   * DRAFT journal numbers.
   */
  detail: Readonly<Record<string, unknown>>;
}

export interface DaftarPrasyarat {
  periodeId: string;
  tahun: number;
  bulan: number;
  /** true when nothing is GAGAL. A PERINGATAN leaves this true. */
  boleh: boolean;
  /** true when at least one check is PERINGATAN, so closing needs a
   *  confirmation flag. */
  perluKonfirmasi: boolean;
  /** All ten, in spec order, PASS included. The UI renders the whole list. */
  hasil: HasilPrasyarat[];
}

// ---------------------------------------------------------------------------
// spec 8.1, kolektibilitas
// ---------------------------------------------------------------------------

/** One akad's classification at the period end. Mirrors `kolektibilitas_snapshot`. */
export interface BarisKolektibilitas {
  akadId: string;
  noAkad: string;
  mitraId: string;
  cabangId: string;
  sektorId: string | null;
  /** Due date of the OLDEST unpaid instalment already due at period end.
   *  null means no arrears at all. */
  tanggalJatuhTempoTertunggakTertua: string | null;
  /** `tanggal_akhir_periode - tanggal_jatuh_tempo`, 0 when there are none. */
  hariTunggakan: number;
  kolektibilitas: KelasKolektibilitas;
  /** spec 8.1 step 6, the input to the quality-migration report. */
  kolektibilitasPeriodeLalu: KelasKolektibilitas | null;
  outstandingPokok: Uang;
  outstandingJasa: Uang;
  tunggakanPokok: Uang;
  tunggakanJasa: Uang;
  /** The rate ACTUALLY USED, stored per row so a later config change cannot
   *  alter a closed period's figures (invariant 14). */
  ratePenyisihan: Rate;
  dasarPerhitungan: DasarPerhitunganPenyisihan;
  /** See `SumberRate`: the column this needs does not exist yet. */
  sumberRate: SumberRate;
  nilaiPenyisihan: Uang;
}

/**
 * spec 8.1: "ringkasan perpindahan kolektibilitas", the feature the spec calls
 * "yang paling dihargai user akuntansi". One row per (from, to) pair that
 * actually occurred; `dari` is null for an akad with no previous snapshot.
 */
export interface SelKematriks {
  dari: KelasKolektibilitas | null;
  ke: KelasKolektibilitas;
  jumlahAkad: number;
  outstandingPokok: Uang;
}

export interface RingkasanKelas {
  kelas: KelasKolektibilitas;
  jumlahAkad: number;
  outstandingPokok: Uang;
  nilaiPenyisihan: Uang;
}

export interface JalankanKolektibilitasInput {
  periodeId: string;
  /** null or absent = every branch at once (spec 8.1 opening line). */
  cabangId?: string | null;
}

/** What a preview and a committed run share. */
export interface HasilHitungKolektibilitas {
  periodeId: string;
  cabangId: string | null;
  /** The date the arrears are measured at: the period's `tanggal_akhir`. */
  tanggalAkhirPeriode: string;
  modePenyisihan: ModePenyisihan;
  dasarPerhitungan: DasarPerhitunganPenyisihan;
  totalAkadDiproses: number;
  baris: BarisKolektibilitas[];
  matriks: SelKematriks[];
  ringkasanPerKelas: RingkasanKelas[];
  /** SUM of `nilaiPenyisihan`; spec 8.2 step 1 consumes exactly this. */
  totalPenyisihanDibutuhkan: Uang;
}

/**
 * spec 8.1 "Preview mode wajib ada". NOTHING IS WRITTEN: no snapshot, no
 * `closing_kolektibilitas` row with status SELESAI, no mitra flipped to
 * BERMASALAH. `tersimpan: false` is a literal type so a preview result can
 * never be mistaken for a committed one at a call site.
 */
export interface PreviewKolektibilitas extends HasilHitungKolektibilitas {
  tersimpan: false;
}

export interface HasilKolektibilitas extends HasilHitungKolektibilitas {
  tersimpan: true;
  /** The `closing_kolektibilitas` row, status SELESAI. */
  closingId: string;
  /** Mitra ids flipped to BERMASALAH by spec 8.1 step 7. Empty when
   *  `kolektibilitas.tandai_mitra_bermasalah_saat_macet` is false. */
  mitraDitandaiBermasalah: string[];
  /** true when this run REPLACED an earlier committed run for the same scope.
   *  Invariant 13: the earlier snapshots are rewritten, never duplicated. */
  menggantikanRunSebelumnya: boolean;
}

export interface RiwayatRunKolektibilitas {
  id: string;
  periodeId: string;
  cabangId: string | null;
  tanggalJalan: string;
  status: StatusRunKolektibilitas;
  dijalankanOleh: string | null;
  totalAkadDiproses: number;
}

// ---------------------------------------------------------------------------
// spec 8.2, penyisihan
// ---------------------------------------------------------------------------

/** Mirrors `penyisihan_periode`, plus the event that was actually posted. */
export interface PenyisihanPeriode {
  /** null on a `hitungPenyisihan` preview: no row was written. */
  id: string | null;
  periodeId: string;
  cabangId: string;
  /**
   * spec 8.2 step 2, the allowance account's balance at the END OF THE
   * PREVIOUS PERIOD.
   *
   * READ FROM THE LEDGER (`v_ledger_baris`), for the account the
   * `BEBAN_PENYISIHAN` mapping row credits, and NEVER recomputed as the SUM of
   * the previous period's `nilai_penyisihan`. Those two are equal only until
   * something else touches the allowance: a write-off consumes it
   * (`HAPUS_BUKU_PIUTANG`), and a snapshot sum would not see that, so the next
   * period's expense would be understated by exactly the amount written off
   * while the balance sheet still showed the allowance as intact.
   */
  saldoPenyisihanAwal: Uang;
  /** spec 8.2 step 1: SUM of `nilai_penyisihan` over this period's snapshots. */
  penyisihanDibutuhkan: Uang;
  /** step 3, SIGNED. Negative means a recovery. */
  bebanPenyisihanPeriode: Uang;
  /** step 4. null when the movement is exactly zero and no journal is posted. */
  eventCode: "BEBAN_PENYISIHAN" | "PEMULIHAN_PENYISIHAN" | null;
  /**
   * THE PERIOD'S PROVISION, AS THE SET OF ENTRIES THAT ACTUALLY CARRIED IT.
   *
   * Correction is by DELTA, not by reversal (a reversal in this system MEANS a
   * mistake was made, spec 6.3), so a re-run at a corrected rate leaves the
   * movement spread across several journals: 10.200.000 then +1.200.000 is a
   * period expense of 11.400.000 carried by two entries. migrations/0026 makes
   * that a join table and enforces, deferred and from both sides, that
   * `SUM(nilai)` here equals `bebanPenyisihanPeriode`. Signed, because both
   * events post under `jenis = 'PENYISIHAN'` and the direction cannot be read
   * off the journal.
   *
   * THIS, NOT `jurnalId`, IS WHAT A REPORT MUST READ. Spec 16 scenario 17 has
   * an operator reconcile Laporan Perhitungan Penyisihan against the period's
   * provision journal; summing this set reconciles, following a single link
   * does not.
   */
  jurnal: ReadonlyArray<KontribusiJurnalPenyisihan>;
  /**
   * The entry the MOST RECENT movement was posted to, or null when nothing has
   * been posted for this period and branch.
   *
   * DELIBERATELY NOT "the period's provision journal", and the difference is
   * the whole content of migrations/0026: after a delta correction this names
   * the delta while `bebanPenyisihanPeriode` states the total, so the two do
   * not reconcile with each other and are not supposed to. It is kept because
   * an operator correcting a run needs to reach the entry that run produced
   * (reversing it, opening it on screen), which is a question about ONE journal
   * and is unanswerable from a set. `penyisihan_periode.jurnal_id` itself is
   * gone from the schema, so nothing can follow this link by accident from SQL.
   */
  jurnalId: string | null;
  tanggal: string;
}

/**
 * One journal's signed contribution to a period's provision movement. Mirrors
 * `penyisihan_periode_jurnal` (migrations/0026). `nilai` is never zero: a
 * journal that moved nothing is not part of the movement, and spec 8.2 step 4
 * posts none.
 */
export interface KontribusiJurnalPenyisihan {
  jurnalId: string;
  /** Positive = formation, negative = recovery. `abs` equals the journal total. */
  nilai: Uang;
}

export interface JalankanPenyisihanInput {
  periodeId: string;
  /** Absent = every branch that has snapshots, one `penyisihan_periode` row
   *  and one journal each (spec 8.2 step 5 keys on cabang). */
  cabangId?: string | null;
}

// ---------------------------------------------------------------------------
// spec 8.3, akrual jasa administrasi
// ---------------------------------------------------------------------------

/** Mirrors `akrual_jasa_snapshot`. */
export interface BarisAkrual {
  akadId: string;
  noAkad: string;
  cabangId: string;
  kolektibilitas: KelasKolektibilitas;
  /** Jasa administrasi falling due inside this period, from the ACTIVE
   *  schedule version. */
  jasaJatuhTempoPeriode: Uang;
  /** Of that, how much arrived as cash inside this period. */
  jasaDiterimaPeriode: Uang;
  /** The difference, floored at zero. Never negative: an overpayment is not a
   *  negative accrual, it is a `pumk_kelebihan` row (invariant 10). */
  jasaDiakrual: Uang;
}

export interface HasilAkrual {
  periodeId: string;
  /** The method that was in force for THIS run, read from config. */
  metode: MetodePengakuanJasa;
  /** The classes the accrual was restricted to, read from config. */
  kelasDiakrual: readonly KelasKolektibilitas[];
  /**
   * true under CASH_BASIS: no snapshot, no journal, and prerequisite check 6
   * PASSES. A skipped step is a legitimate outcome here, NOT a silent skip:
   * `metode` says which policy produced it.
   */
  dilewati: boolean;
  baris: BarisAkrual[];
  /** spec 8.3 step 2: "posting event AKRUAL_JASA_ADM ... per cabang". */
  totalPerCabang: Array<{ cabangId: string; total: Uang; jurnalId: string | null }>;
}

export interface JalankanAkrualInput {
  periodeId: string;
  cabangId?: string | null;
}

// ---------------------------------------------------------------------------
// spec 8.4, closing and the frozen balances
// ---------------------------------------------------------------------------

export interface PeriodeClosing {
  id: string;
  bumnId: string;
  tahun: number;
  bulan: number;
  tanggalMulai: string;
  tanggalAkhir: string;
  status: StatusPeriode;
  closedBy: string | null;
  closedAt: string | null;
  reopenedBy: string | null;
  reopenedAt: string | null;
  alasanReopen: string | null;
}

/**
 * Mirrors `saldo_akun_periode`. ALL FOUR AMOUNTS ARE DEBIT-POSITIVE, which is
 * the convention migrations/0011 states and enforces
 * (`saldo_akhir = saldo_awal + mutasi_debit - mutasi_kredit`). A credit-balance
 * account therefore carries a NEGATIVE `saldoAwal`/`saldoAkhir`; presentation
 * flips the sign using `akun.saldo_normal`. One convention for every account
 * type is what lets a trial balance be asserted as "the sum over all accounts
 * is 0.00" instead of as two numbers that have to be compared.
 */
export interface SaldoAkunPeriode {
  periodeId: string;
  cabangId: string;
  akunId: string;
  akunKode: string;
  saldoAwal: Uang;
  mutasiDebit: Uang;
  mutasiKredit: Uang;
  saldoAkhir: Uang;
}

export interface TutupPeriodeInput {
  periodeId: string;
  /**
   * spec 8.4 check 8: negative cash is "wajib dikonfirmasi user". Absent or
   * false with a PERINGATAN outstanding refuses with
   * `KONFIRMASI_KAS_NEGATIF_WAJIB`, so the confirmation is a deliberate act
   * recorded in the audit log rather than a checkbox nobody read.
   */
  konfirmasiKasNegatif?: boolean;
}

export interface HasilTutupPeriode {
  periode: PeriodeClosing;
  /** The checklist as it stood at the moment of closing, all ten, so the audit
   *  log records what was true rather than what is true now. */
  prasyarat: DaftarPrasyarat;
  /** The frozen trial balance, one row per (cabang, akun) that has movement or
   *  an opening balance. */
  saldo: SaldoAkunPeriode[];
}

export interface ReopenPeriodeInput {
  periodeId: string;
  /** spec 8.4: mandatory, written, recorded. Blank refuses with `ALASAN_WAJIB`. */
  alasan: string;
}

export interface FilterSaldoAkunPeriode {
  periodeId: string;
  cabangId?: string | null;
  akunId?: string | null;
}

// ---------------------------------------------------------------------------
// Ports the engine consumes
// ---------------------------------------------------------------------------

/** A handle bound to ONE connection inside ONE transaction. */
export type ClosingTx = QueryRunner;

/**
 * Wider than a query-only port on purpose. A kolektibilitas re-run deletes the
 * old snapshots and writes the new ones; a period close writes every
 * `saldo_akun_periode` row and flips the period; a reopen deletes them and
 * flips it back. Each of those is all-or-nothing, and the sequential-close
 * trigger is a BEFORE UPDATE that can abort mid-way.
 */
export type ClosingDbPort = DbPort;

/**
 * The ledger, as a port. Structurally satisfied by the engine
 * `createJurnalModule` returns, so the composition root wires
 * `createClosingModule({ db, jurnal: jurnal.engine })` with no adapter in
 * between and invariant 11 holds by construction.
 *
 * DECLARED HERE RATHER THAN IMPORTED WHOLE for the reason modules/angsuran
 * records: `bun tools/check-boundaries.ts` allows only `../jurnal/index`, and
 * the rollback requirement is only testable if a test can inject a poster that
 * FAILS. A double may arm a collaborator's failure; it may never answer in the
 * real engine's place, which is why the fixture's wrapper delegates every
 * successful call to the real engine.
 *
 * NARROW ON PURPOSE. `postingEvent` is the only capability here. There is no
 * write-off method, because closing does not write anything off, and no
 * `buatJurnal`, because closing never composes a journal by hand.
 */
export interface PorterJurnalClosing {
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
      mitraId?: string | null;
      akadId?: string | null;
      referensiTipe?: string | null;
      referensiId?: string | null;
      dimensi?: DimensiBaris;
      /** Invariant 13. A closing journal ALWAYS carries one. */
      kunciIdempotensi?: string | null;
    },
    ctx: JurnalContext,
    tx?: JurnalTx,
  ): Promise<Jurnal>;
}

/**
 * The audit trail, as a port. Structurally satisfied by modules/audit's
 * service. Optional, for the reason modules/jurnal gives: the engine must be
 * constructible with a database and nothing else, and a closing must never be
 * lost because an audit sink was not wired. Spec 8.4 nonetheless REQUIRES an
 * audit row for a close and for a reopen, so the tests wire it and assert it.
 */
export interface PencatatAuditClosing {
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
    runner?: ClosingTx,
  ): Promise<string>;
}

/**
 * Who is acting. Same shape as `JurnalContext` (spec 2 rule 3), so a context
 * flows into the ledger engine unchanged and the branch scope cannot be
 * widened on the way through.
 */
export interface ClosingContext {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  /** Branches beyond the user's own. Admin Pusat / Auditor get every branch. */
  cabangDalamScope?: readonly string[];
}

export interface ClosingEngineDeps {
  db: ClosingDbPort;
  jurnal: PorterJurnalClosing;
  /** Injectable clock. Dates the penyisihan and akrual journals when the
   *  period end is not the intended posting date, and stamps `closed_at`. */
  jam?: () => Date;
  audit?: PencatatAuditClosing;
}

// ---------------------------------------------------------------------------
// The engine (spec 8)
// ---------------------------------------------------------------------------

export interface ClosingEngine {
  // --- 8.1 kolektibilitas -------------------------------------------------

  /**
   * spec 8.1 "Preview mode wajib ada": the full calculation and the migration
   * matrix, with NOTHING WRITTEN. Requires `admin.closing.kolektibilitas`.
   *
   * Running it twice must produce identical output, and running it must not
   * change what a subsequent commit produces.
   */
  previewKolektibilitas(
    input: JalankanKolektibilitasInput,
    ctx: ClosingContext,
  ): Promise<PreviewKolektibilitas>;

  /**
   * spec 8.1 steps 1..7, committed. Day ranges come from
   * `kolektibilitas_range` and rates from `penyisihan_rate` (or from history
   * under KOLEKTIF_HISTORIS); neither may appear as an `if` in the code.
   *
   * IDEMPOTENT (invariant 13): a re-run for the same scope DELETES that
   * period's snapshots and writes them again, in one transaction. Snapshot
   * count and journal count are unchanged by a second run (spec 8.5 test 5).
   * Refuses with `PERIODE_TIDAK_OPEN` once the period is CLOSED, because a
   * closed period's numbers are frozen.
   */
  jalankanKolektibilitas(
    input: JalankanKolektibilitasInput,
    ctx: ClosingContext,
  ): Promise<HasilKolektibilitas>;

  /** spec 9.3 "lihat riwayat". Read path; see `PERMISSION_CLOSING.LIHAT`. */
  riwayatKolektibilitas(
    periodeId: string,
    ctx: ClosingContext,
  ): Promise<RiwayatRunKolektibilitas[]>;

  /** The stored snapshot for a period, which is what the reports read. */
  snapshotKolektibilitas(
    input: { periodeId: string; cabangId?: string | null },
    ctx: ClosingContext,
  ): Promise<BarisKolektibilitas[]>;

  // --- 8.2 penyisihan -----------------------------------------------------

  /**
   * spec 8.2 steps 1..3 WITHOUT posting: the accountant sees the movement
   * before it becomes a journal. `id` and `jurnalId` are null.
   */
  hitungPenyisihan(
    input: JalankanPenyisihanInput,
    ctx: ClosingContext,
  ): Promise<PenyisihanPeriode[]>;

  /**
   * spec 8.2 steps 4..5. ONE journal per branch, through `postingEvent`, with
   * an idempotency key derived from (periode, cabang) so a second run cannot
   * double it (invariant 13). Zero movement posts nothing and is not an error.
   *
   * `saldoPenyisihanAwal` comes from the LEDGER, not from the previous
   * period's snapshots. See the field's own note: that is what keeps a
   * write-off visible.
   */
  jalankanPenyisihan(
    input: JalankanPenyisihanInput,
    ctx: ClosingContext,
  ): Promise<PenyisihanPeriode[]>;

  // --- 8.3 akrual jasa administrasi ---------------------------------------

  /**
   * spec 8.3. Reads `akuntansi.metode_pengakuan_jasa_adm`; under CASH_BASIS it
   * writes nothing, posts nothing, and returns `dilewati: true`. Under ACCRUAL
   * it restricts to the classes in `akuntansi.akrual_hanya_untuk_kolektibilitas`
   * and posts `AKRUAL_JASA_ADM` per branch.
   *
   * NO TEST IN THIS FOLDER ASSERTS WHICH METHOD IS CORRECT. Spec 5's preamble
   * makes it the client accounting team's decision (OPEN-QUESTIONS.md); the
   * tests assert only that the configured method is the one that runs.
   */
  jalankanAkrualJasaAdm(
    input: JalankanAkrualInput,
    ctx: ClosingContext,
  ): Promise<HasilAkrual>;

  // --- 8.4 closing periode ------------------------------------------------

  /**
   * All ten checks of spec 8.4, ALWAYS all ten, in the spec's order, each with
   * a readable reason. Never short-circuits on the first failure: an
   * accountant needs the whole list, and spec 8.4 asks for it "sebagai daftar
   * dengan status di UI".
   *
   * Pure read. Writes nothing, not even a CLOSING_IN_PROGRESS marker.
   */
  periksaPrasyarat(periodeId: string, ctx: ClosingContext): Promise<DaftarPrasyarat>;

  /**
   * spec 8.4 execution. Re-runs the checklist inside the transaction (a check
   * that passed a minute ago is not evidence), sets the period CLOSED with
   * `closed_by`/`closed_at`, writes the audit row, and FREEZES
   * `saldo_akun_periode` from `v_ledger_baris`.
   *
   * Refuses with `PRASYARAT_GAGAL` when anything is GAGAL, carrying the failing
   * checks in `detail.gagal`, and with `KONFIRMASI_KAS_NEGATIF_WAJIB` when a
   * PERINGATAN stands unconfirmed.
   */
  tutupPeriode(input: TutupPeriodeInput, ctx: ClosingContext): Promise<HasilTutupPeriode>;

  /**
   * spec 8.4 reopen. Requires `admin.periode.reopen` (Admin Pusat), a
   * non-blank `alasan`, `akuntansi.izinkan_reopen_periode`, and the target
   * being the LATEST closed period. DELETES that period's
   * `saldo_akun_periode` rows, which is safe precisely because they are
   * derived data regenerable from the ledger, and writes an audit row.
   */
  bukaKembaliPeriode(input: ReopenPeriodeInput, ctx: ClosingContext): Promise<PeriodeClosing>;

  /** The frozen trial balance of a closed period. Read path. */
  saldoAkunPeriode(
    filter: FilterSaldoAkunPeriode,
    ctx: ClosingContext,
  ): Promise<SaldoAkunPeriode[]>;
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
export function createClosingEngine(deps: ClosingEngineDeps): ClosingEngine {
  return buatEngineClosing(deps);
}
