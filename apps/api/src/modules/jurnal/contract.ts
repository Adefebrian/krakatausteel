// apps/api/src/modules/jurnal/contract.ts
//
// TYPE CONTRACT FOR THE JOURNAL ENGINE (spec 6). Written BEFORE the
// implementation, per spec rule 5: the tests in this folder are the
// specification, and this file is the shape they were written against. It has
// not been widened, relaxed or renamed since; the engine was built to it.
// The behaviour now lives in ./service.ts, reached through
// `createJurnalEngine` below, which is still the single implementation site.
//
// -------------------------------------------------------------------------
// WHY MONEY IS A DECIMAL STRING AND NOT A `number`
// -------------------------------------------------------------------------
// Money in the schema is NUMERIC(20,2) (invariant 7: never float, never
// double). Two consequences drive the choice made here:
//
//   1. A JS `number` is an IEEE-754 double. 0.1 + 0.2 !== 0.3, so a ledger
//      built on `number` cannot satisfy invariant 1 ("SUM(debit) = SUM(kredit)
//      persis, tanpa toleransi"). Any tolerance at all is a bug in an
//      accounting system, so `number` is banned outright for amounts.
//   2. Integer minor units would fix the rounding but not the range:
//      NUMERIC(20,2) reaches 10^18 sen, and Number.MAX_SAFE_INTEGER is
//      ~9.007 x 10^15. A rupiah amount well inside what the column accepts
//      would silently lose precision as a JS integer. `bigint` would cover
//      the range, but it is not JSON-serialisable and every boundary
//      (HTTP body, pg driver, report export) would need a custom codec.
//
// So: `Uang` is a DECIMAL STRING with exactly two fractional digits,
// e.g. "1500000.00". This is also precisely what the Postgres driver returns
// for NUMERIC (verified: `select $1::numeric(20,2)` comes back as the string
// "1500000.50"), so the value crosses the DB boundary in both directions with
// zero conversion and therefore zero opportunity for precision loss.
// Arithmetic inside the engine must be done either in SQL (NUMERIC) or on
// BigInt minor units, never by parseFloat.
//
// -------------------------------------------------------------------------
// WHY SPEC 6.1'S SEVEN NAMES ARE METHODS AND NOT FREE FUNCTIONS
// -------------------------------------------------------------------------
// Spec 6.1 writes the surface as seven free functions. They exist here as the
// method set of `JurnalEngine`, which `createJurnalEngine(deps)` returns, and
// NOT also as module-level functions. There was a second, free-function
// surface; it delegated to a module-global engine that whichever `createApp`
// ran last had re-pointed, so with a per-fixture app (testing/harness.ts) the
// free functions could act on another fixture's pool. A ledger API whose
// target depends on construction order is not worth the convenience of
// skipping one argument. The engine is a dependency: build it once in the
// composition root, pass it where it is needed.

import type { DbPort, QueryRunner } from "../../core/ports/db";
import { buatEngineJurnal } from "./service";

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * A fixed-precision amount as a decimal string with exactly two fractional
 * digits and no thousands separator: "0.00", "1500000.00", "-12.34" is NOT
 * valid (amounts are never negative, invariant/validation 6.2.4).
 * See the file header for why this is not a `number`.
 */
export type Uang = string;

/** Matches a valid `Uang`: non-negative, exactly two decimal places. */
export const POLA_UANG = /^\d{1,18}\.\d{2}$/;

// ---------------------------------------------------------------------------
// Enumerations, mirrored from the CHECK constraints in migrations/0010_jurnal.sql
// ---------------------------------------------------------------------------

export type JenisJurnal =
  | "KAS_BANK"
  | "UMUM"
  | "PINBUK"
  | "OTOMATIS"
  | "PENYISIHAN"
  | "AKRUAL"
  | "REVERSAL"
  | "CLOSING"
  | "SALDO_AWAL";

export type StatusJurnal = "DRAFT" | "POSTED" | "REVERSED";

/**
 * Document number format, shared by the engine and its tests so the two can
 * never drift: `<JENIS>/<YYYYMM>/<5-digit sequence>`, e.g.
 * "UMUM/202602/00001". Spec 4.6: "no_jurnal (auto, per jenis per periode)",
 * so the sequence restarts per (jenis, periode) and is allocated atomically
 * (validation 6.2.9).
 */
export const POLA_NO_JURNAL = /^[A-Z_]+\/\d{6}\/\d{5}$/;

/** Permission codes this engine checks (spec 6.3 + spec 2). */
export const PERMISSION_JURNAL = {
  /**
   * Reading a journal document. Not checked by any method of `JurnalEngine`,
   * because the engine only ever reads inside the transaction it is about to
   * write in, and it has already demanded the write code by then. It is the
   * code ./baca.ts and the GET routes of ./routes.ts are gated by, and it is
   * the ONLY journal code the read-only Auditor holds: every operational role
   * has it (`LIHAT` in modules/auth/permissions.ts) and it grants no power to
   * create, verify, post or reverse anything.
   */
  LIHAT: "jurnal.view",
  BUAT: "jurnal.create",
  UBAH: "jurnal.update",
  VERIFIKASI: "jurnal.verify",
  POSTING: "jurnal.post",
  HAPUS: "jurnal.delete",
  /**
   * Reversal is its OWN right, not a by-product of `jurnal.post`. The auth
   * catalogue carries `jurnal.reversal` and a nav item is driven by it, so
   * checking `jurnal.post` here would have left that permission granting
   * nothing while every posting right silently included the power to reverse a
   * posted journal. In the shipped RBAC the Approver role holds both, so this
   * changes no real user's ability today; what it changes is that the two can
   * be separated tomorrow, which is the whole reason the code exists.
   */
  REVERSAL: "jurnal.reversal",
} as const;

/**
 * Configuration keys the engine must READ rather than hardcode. Spec 5's
 * preamble and docs/BUILD-PLAN.md both say policy numbers/lists are the
 * client accounting team's decision, so the engine reads them from
 * `konfigurasi` and the tests assert the MECHANIC (changing the row changes
 * the behaviour), never the policy value itself.
 */
export const KUNCI_KONFIGURASI = {
  /** JSON array of allowed Pinbuk activity categories (spec 6.5). */
  KATEGORI_PINBUK: { grup: "JURNAL", kunci: "kategori_kegiatan_pinbuk" },
  /**
   * What a write-off does with the part of the outstanding the allowance does
   * not cover: `BEBAN_PERIODE` charges it to the current period through
   * `HAPUS_BUKU_KEKURANGAN_PENYISIHAN`, `TOLAK` refuses the write-off until an
   * allowance is formed. Seeded by apps/api/src/seed/konfigurasi.ts from the
   * konfigurasi catalogue; NOT defaulted in this module, because a default in
   * code cannot be changed without a deploy.
   */
  KEKURANGAN_PENYISIHAN: { grup: "akuntansi", kunci: "kekurangan_penyisihan_hapus_buku" },
} as const;

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * Every rejection the engine produces carries one of these codes. Several of
 * these invariants are enforced by Postgres triggers (see
 * migrations/0010_jurnal.sql). When the DB raises, the engine MUST catch the
 * driver error and re-raise it as a `JurnalError` with the matching code: a
 * raw trigger string like
 *   'TJSL-JRN-031: jurnal UMUM/202602/00001 tidak balance: ...'
 * must never reach a caller, an HTTP response, or a log line that a user
 * reads. Map on the SQLSTATE and the constraint name, not on message text, and
 * READ THE SQLSTATE FROM BOTH DRIVER SHAPES: `bun:sql` (the tests' port) puts
 * it in `err.errno`, node-postgres (core/adapters/db.ts, i.e. the running
 * server) puts it in `err.code`, and `err.code` on a `bun:sql` error is not a
 * SQLSTATE at all. ./kesalahan.ts does this in one place; an earlier version
 * read only `errno`, which left the whole concurrency branch dead in
 * production while every test stayed green.
 */
export const KODE_JURNAL = {
  // spec 6.2 validations, in the order the spec lists them
  PERIODE_TIDAK_OPEN: "PERIODE_TIDAK_OPEN", // 6.2.1
  MINIMAL_DUA_BARIS: "MINIMAL_DUA_BARIS", // 6.2.2
  SATU_SISI_PER_BARIS: "SATU_SISI_PER_BARIS", // 6.2.3
  NILAI_NEGATIF: "NILAI_NEGATIF", // 6.2.4
  TIDAK_BALANCE: "TIDAK_BALANCE", // 6.2.5
  AKUN_TIDAK_VALID: "AKUN_TIDAK_VALID", // 6.2.6 (missing, inactive, or not postable)
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE", // 6.2.7
  DIMENSI_PIUTANG_SALAH_AKUN: "DIMENSI_PIUTANG_SALAH_AKUN", // 6.2.8
  NOMOR_JURNAL_DUPLIKAT: "NOMOR_JURNAL_DUPLIKAT", // 6.2.9
  NILAI_BUKAN_DESIMAL: "NILAI_BUKAN_DESIMAL", // amount is not a valid Uang

  // state machine
  JURNAL_TIDAK_DITEMUKAN: "JURNAL_TIDAK_DITEMUKAN",
  JURNAL_TIDAK_DRAFT: "JURNAL_TIDAK_DRAFT", // edit/cancel/post of a non-DRAFT
  JURNAL_BELUM_POSTED: "JURNAL_BELUM_POSTED", // reversal of a DRAFT
  JURNAL_SUDAH_REVERSED: "JURNAL_SUDAH_REVERSED", // spec 6.6.7
  POSTING_BENTROK: "POSTING_BENTROK", // spec 6.6.9, the losing concurrent post
  BATCH_GAGAL: "BATCH_GAGAL", // spec 6.6.8
  // Invariant 13: a second journal for a scope that already has one. The
  // closing engine owns the idempotency logic; this code exists so the
  // database's unique index cannot surface as an unexplained fault meanwhile.
  JURNAL_IDEMPOTENSI_DUPLIKAT: "JURNAL_IDEMPOTENSI_DUPLIKAT",

  // authorisation
  TIDAK_BERWENANG: "TIDAK_BERWENANG", // spec 6.3, missing jurnal.post etc.
  MAKER_TIDAK_BOLEH_CHECKER: "MAKER_TIDAK_BOLEH_CHECKER", // spec 2 rule 1

  // reversal (spec 6.3)
  ALASAN_WAJIB: "ALASAN_WAJIB",
  TIDAK_ADA_PERIODE_OPEN: "TIDAK_ADA_PERIODE_OPEN",
  PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR: "PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR",

  // event posting (spec 6.4)
  EVENT_MAPPING_TIDAK_DITEMUKAN: "EVENT_MAPPING_TIDAK_DITEMUKAN",
  EVENT_PAYLOAD_TIDAK_LENGKAP: "EVENT_PAYLOAD_TIDAK_LENGKAP",
  // Write-off with an allowance short of the outstanding, when the client's
  // policy row says TOLAK rather than BEBAN_PERIODE. Not a spec code: the spec
  // never contemplates a short allowance (see KUNCI_KONFIGURASI above).
  PENYISIHAN_TIDAK_CUKUP: "PENYISIHAN_TIDAK_CUKUP",

  // manual journal types (spec 6.5)
  KAS_BANK_TANPA_AKUN_KAS: "KAS_BANK_TANPA_AKUN_KAS",
  PINBUK_AKUN_SALAH: "PINBUK_AKUN_SALAH",
  PINBUK_TANPA_TAUTAN: "PINBUK_TANPA_TAUTAN",
  PINBUK_KATEGORI_TIDAK_VALID: "PINBUK_KATEGORI_TIDAK_VALID",
} as const;

export type KodeJurnal = (typeof KODE_JURNAL)[keyof typeof KODE_JURNAL];

/**
 * The only error type this module throws. `message` is user-facing Indonesian
 * prose and must stay free of driver/trigger internals; `penyebabDb` is the
 * place for the raw DB text, for logs only.
 */
export class JurnalError extends Error {
  readonly kode: KodeJurnal;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly penyebabDb?: string;

  constructor(
    kode: KodeJurnal,
    message: string,
    detail: Record<string, unknown> = {},
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "JurnalError";
    this.kode = kode;
    this.detail = detail;
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// Input and output shapes
// ---------------------------------------------------------------------------

/**
 * Analytic dimensions on a line (`jurnal_baris.dimensi_json`): sektor, bidang,
 * SDG, program, plus the Pinbuk fields.
 *
 * NOTE, and this matters for validation 6.2.8: the Mitra/Cluster link of a
 * PINBUK journal belongs HERE (`mitraId` / `clusterId`), not in the
 * `jurnal_baris.mitra_id` column. That column is the piutang sub-ledger
 * dimension (spec 4.6 says so verbatim) and a line carrying it must be a
 * receivable account. A Pinbuk expense line is not a receivable, so putting
 * the mitra link in the column would make 6.2.8 unsatisfiable.
 */
export interface DimensiBaris {
  sektorId?: string;
  bidangId?: string;
  sdgId?: string;
  programId?: string;
  /** PINBUK: link to the Mitra Binaan being coached (spec 6.5). */
  mitraId?: string;
  /** PINBUK: link to the Cluster being coached (spec 6.5). */
  clusterId?: string;
  /** PINBUK: activity category; allowed values come from `konfigurasi`. */
  kategoriKegiatan?: string;
  [kunci: string]: unknown;
}

export interface BarisJurnalInput {
  akunId: string;
  /** Exactly one of debit/kredit must be present and greater than "0.00". */
  debit?: Uang;
  kredit?: Uang;
  keterangan?: string | null;
  /** Piutang sub-ledger only. Requires a receivable account (6.2.8). */
  mitraId?: string | null;
  /** Piutang sub-ledger only. Requires a receivable account (6.2.8). */
  akadId?: string | null;
  dimensi?: DimensiBaris;
}

export interface BuatJurnalInput {
  cabangId: string;
  jenis: JenisJurnal;
  /** ISO date, `YYYY-MM-DD`. The PERIOD IS RESOLVED FROM THIS, never from the input date (invariant 5). */
  tanggalTransaksi: string;
  keterangan?: string | null;
  referensiTipe?: string | null;
  referensiId?: string | null;
  baris: BarisJurnalInput[];
  isAutoGenerated?: boolean;
  /** Closing idempotency key (invariant 13). NULL for manual journals. */
  kunciIdempotensi?: string | null;
}

export interface BarisJurnal {
  id: string;
  urutan: number;
  akunId: string;
  debit: Uang;
  kredit: Uang;
  keterangan: string | null;
  mitraId: string | null;
  akadId: string | null;
  dimensi: DimensiBaris;
}

export interface Jurnal {
  id: string;
  bumnId: string;
  cabangId: string;
  noJurnal: string;
  jenis: JenisJurnal;
  tanggalTransaksi: string;
  periodeId: string;
  keterangan: string | null;
  referensiTipe: string | null;
  referensiId: string | null;
  totalDebit: Uang;
  totalKredit: Uang;
  status: StatusJurnal;
  isAutoGenerated: boolean;
  reversalOfJurnalId: string | null;
  reversedByJurnalId: string | null;
  kunciIdempotensi: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  postedBy: string | null;
  postedAt: string | null;
  version: number;
  baris: BarisJurnal[];
}

/**
 * Who is acting. Spec 6.3 requires `jurnal.post` for posting and spec 2 rule 3
 * binds every read/write to a branch scope, so both travel with the call
 * rather than being re-derived inside the engine.
 */
export interface JurnalContext {
  userId: string;
  /** The user's own branch. Header `cabangId` must be in scope (6.2.7). */
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  /**
   * Branches the user may act in beyond their own. Empty for a
   * single-branch user; Admin Pusat / Auditor get every branch. Absent means
   * "only `cabangId`".
   */
  cabangDalamScope?: readonly string[];
}

/**
 * Payload for `postingEvent`. Deliberately generic: the ACCOUNTS come from
 * `event_jurnal_mapping`, never from this payload except for the legs the
 * mapping row marks as `debit_dari_payload` / `kredit_dari_payload`
 * (PENYALURAN_NON_PUMK debits a per-bidang account, BEBAN_OPERASIONAL debits
 * a per-type account) and the optional cash-account override.
 */
export interface EventPayload {
  cabangId: string;
  tanggalTransaksi: string;
  nilai: Uang;
  keterangan?: string | null;
  /** Supplies the leg whose mapping row has `debit_dari_payload = true`. */
  akunDebitId?: string;
  /** Supplies the leg whose mapping row has `kredit_dari_payload = true`. */
  akunKreditId?: string;
  /**
   * Overrides whichever leg of the mapping is an `is_kas` account (the cash
   * account picked on the form). Absent means "use the mapping row's account".
   */
  akunKasId?: string;
  /** Written to the piutang sub-ledger columns on the receivable leg only. */
  mitraId?: string | null;
  akadId?: string | null;
  referensiTipe?: string | null;
  referensiId?: string | null;
  dimensi?: DimensiBaris;
  kunciIdempotensi?: string | null;
}

// ---------------------------------------------------------------------------
// Ports the engine consumes
// ---------------------------------------------------------------------------

/**
 * ONE definition, not two. These are now ALIASES of `core/ports/db.ts`, which
 * grew the identical `transaction<T>` after this contract was written.
 *
 * The names stay because they say what the engine needs them for, and because
 * the tests and `test-support.ts` are written against them; the shapes are the
 * core port's, so there is nothing left to drift. Keeping a second structurally
 * identical declaration is how two error layers in this repo ended up
 * disagreeing about which driver they were on, which is a bug class worth
 * removing at the root rather than commenting about.
 *
 * What the engine needs from the port, and why autocommit queries cannot serve:
 *   - `postingBatch` is "atomik, semua atau tidak ada" (spec 6.1).
 *   - Reversal must revert business state IN THE SAME TRANSACTION (spec 6.3,
 *     called out as the number one source of corrupt data).
 *   - The balance/min-2-lines check is a DEFERRED CONSTRAINT TRIGGER, so it
 *     fires at COMMIT, not at the offending statement, so `transaction()` must
 *     surface a COMMIT failure as a rejected promise and the engine must
 *     translate it into `TIDAK_BALANCE` / `MINIMAL_DUA_BARIS`.
 *   - The concurrent-post guard needs `SELECT ... FOR UPDATE` on one
 *     connection (spec 6.6.9).
 */
/** A handle that runs statements on ONE connection inside ONE transaction. */
export type JurnalTx = QueryRunner;

/** The database port the engine consumes. */
export type JurnalDbPort = DbPort;

/**
 * Spec 6.3, the business-state half of a reversal: "Kalau jurnal berasal dari
 * peristiwa bisnis (pencairan, angsuran), reversal juga harus mengembalikan
 * state bisnisnya ... dalam satu transaksi database yang sama."
 *
 * The business modules (PUMK, Non PUMK) do not exist yet, so the engine takes
 * a registry keyed by `jurnal.referensi_tipe`. Contract for the implementer:
 * if a POSTED journal has a non-null `referensi_tipe` and no handler is
 * registered for it, `reversalJurnal` MUST REFUSE with
 * `PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR` rather than reverse the accounting
 * alone. Refusing is the safe failure; a half-reversal is not.
 */
export interface PembalikStateBisnis {
  referensiTipe: string;
  balikkan(
    input: { jurnalAsli: Jurnal; alasan: string },
    tx: JurnalTx,
    ctx: JurnalContext,
  ): Promise<void>;
}

/**
 * The audit trail, as a port. Structurally satisfied by
 * `modules/audit`'s `AuditService`, so the composition root passes that
 * instance straight in and this module never imports it.
 *
 * Optional on purpose: the engine must be constructible with a database and
 * nothing else (the tests do exactly that), and a ledger write must never be
 * lost because an audit sink was not wired. What IS guaranteed when it is
 * wired: the audit row is written on the SAME handle as the ledger change, so
 * a rolled back posting leaves no audit row claiming it happened.
 *
 * `ip` and `userAgent` are absent from every entry this engine writes, and
 * that is the boundary, not an omission: the engine records WHAT happened to
 * the ledger, the HTTP layer records WHO asked and from where (it is the only
 * layer that has a request). Rejections are the HTTP layer's to record for the
 * same reason, and because a refused operation has no transaction left to
 * write into.
 */
export interface PencatatAudit {
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
    runner?: JurnalTx,
  ): Promise<string>;
}

export interface JurnalEngineDeps {
  db: JurnalDbPort;
  /**
   * Injectable clock. Used for `posted_at`/`verified_at` and, critically, to
   * date a reversal (see `reversalJurnal`). Injectable so tests are not
   * hostage to the wall clock.
   */
  jam?: () => Date;
  pembalikStateBisnis?: readonly PembalikStateBisnis[];
  audit?: PencatatAudit;
}

// ---------------------------------------------------------------------------
// Combined event posting (spec 7.2 step 8)
// ---------------------------------------------------------------------------

/**
 * One component of a combined journal, named by its spec 6.4 event code. The
 * ACCOUNTS still come from `event_jurnal_mapping` (invariant 11); a component
 * only says which event it is and how much.
 */
export interface KomponenEvent {
  eventCode: string;
  nilai: Uang;
  /** Written to the piutang sub-ledger columns on this component's receivable leg only. */
  mitraId?: string | null;
  akadId?: string | null;
  /** Supplies the leg whose mapping row has `debit_dari_payload = true`. */
  akunDebitId?: string;
  /** Supplies the leg whose mapping row has `kredit_dari_payload = true`. */
  akunKreditId?: string;
  keterangan?: string | null;
  dimensi?: DimensiBaris;
}

export interface PostingGabunganInput {
  cabangId: string;
  tanggalTransaksi: string;
  komponen: KomponenEvent[];
  keterangan?: string | null;
  referensiTipe?: string | null;
  referensiId?: string | null;
  /** Overrides the cash leg of every component's mapping. */
  akunKasId?: string | null;
  kunciIdempotensi?: string | null;
}

/**
 * The result of a combined posting. A full `Jurnal`, plus `jurnalId` and
 * `jumlahBaris`: those two are what a business module needs (it stores the id
 * on its own row and asserts the line count), and carrying them here makes
 * this engine structurally satisfy the port `modules/angsuran` declared for it
 * without an adapter in between. `jurnalId` always equals `id`, and
 * `jumlahBaris` always equals `baris.length`.
 */
export interface JurnalGabungan extends Jurnal {
  jurnalId: string;
  jumlahBaris: number;
}

// ---------------------------------------------------------------------------
// Write-off (penghapusbukuan) with an allowance that may not cover it
// ---------------------------------------------------------------------------

/**
 * Input for `postingHapusBukuPiutang`. `outstanding` is the WHOLE amount
 * leaving the balance sheet; how it splits between the allowance and the
 * period's expense is computed here, never by the caller.
 */
export interface HapusBukuPiutangInput {
  cabangId: string;
  tanggalTransaksi: string;
  /** The full outstanding pokok being written off. */
  outstanding: Uang;
  mitraId?: string | null;
  akadId?: string | null;
  keterangan?: string | null;
  referensiTipe?: string | null;
  referensiId?: string | null;
  kunciIdempotensi?: string | null;
  /**
   * Ceiling on how much allowance THIS write-off may consume, for the
   * `RATE_TABLE` mode where the allowance is computed per akad while the
   * ledger holds it as one pooled contra account (no akad dimension is allowed
   * on it, see `DIMENSI_PIUTANG_SALAH_AKUN`). Absent means the whole pooled
   * balance is available. The ledger balance is always the harder limit: this
   * can only lower the amount consumed, never raise it above what exists.
   */
  penyisihanMaksimal?: Uang;
}

/** The journal, plus the split that produced it, so a caller can record it. */
export interface HapusBukuPiutang extends JurnalGabungan {
  /** Charged to the allowance via `HAPUS_BUKU_PIUTANG`. */
  dariPenyisihan: Uang;
  /** Charged to the period via `HAPUS_BUKU_KEKURANGAN_PENYISIHAN`. Often "0.00". */
  kekurangan: Uang;
  /** Allowance balance the split was computed against, at `tanggalTransaksi`. */
  penyisihanTersedia: Uang;
}

// ---------------------------------------------------------------------------
// The engine (spec 6.1)
// ---------------------------------------------------------------------------

export interface JurnalEngine {
  /**
   * Always born DRAFT. Runs the nine validations of spec 6.2 in the order
   * listed there and rejects the whole operation on the first failure.
   * Allocates `no_jurnal` atomically (6.2.9).
   */
  buatJurnal(input: BuatJurnalInput, ctx: JurnalContext): Promise<Jurnal>;

  /**
   * Spec 6.3: "Jurnal DRAFT boleh diedit. Setiap edit menaikkan `version`."
   * Not named in the spec 6.1 list, but required to express spec 6.6.5 ("Edit
   * jurnal POSTED ditolak") at the engine surface instead of at the SQL
   * surface. A non-DRAFT target rejects with `JURNAL_TIDAK_DRAFT`; the header
   * `jenis` and `no_jurnal` are immutable across an edit.
   */
  ubahJurnalDraft(id: string, input: BuatJurnalInput, ctx: JurnalContext): Promise<Jurnal>;

  /**
   * Checker marks the DRAFT verified. Requires `jurnal.verify`, and the
   * verifier must not be the journal's `created_by` (spec 2 rule 1:
   * "Sistem harus menolak, bukan hanya menyembunyikan tombol").
   */
  verifikasiJurnal(id: string, ctx: JurnalContext): Promise<Jurnal>;

  /**
   * DRAFT -> POSTED. Requires `jurnal.post` (spec 6.3). Stamps `posted_by` and
   * `posted_at`. Must lock the row (`FOR UPDATE`) so two concurrent calls
   * produce exactly one POSTED journal, the loser rejecting with
   * `POSTING_BENTROK` (spec 6.6.9).
   */
  postingJurnal(id: string, ctx: JurnalContext): Promise<Jurnal>;

  /** DRAFT -> soft delete (`deleted_at` + `deleted_by`). A POSTED journal can never be soft-deleted. */
  batalkanJurnalDraft(id: string, ctx: JurnalContext): Promise<void>;

  /**
   * Spec 6.3. Creates the reversing journal, `jenis = 'REVERSAL'`, with:
   *   - debit and credit swapped line for line, same amounts, same accounts,
   *     same sub-ledger dimensions;
   *   - `tanggal_transaksi` in the CURRENT OPEN PERIOD, not the original date
   *     (the original period may be closed). "Current open period" is defined
   *     as: the OPEN period containing `jam()`'s date if there is one,
   *     otherwise the latest OPEN period, dated at its `tanggal_akhir`. If no
   *     OPEN period exists, `TIDAK_ADA_PERIODE_OPEN`;
   *   - `keterangan` containing the original `no_jurnal` verbatim;
   *   - `reversal_of_jurnal_id` set, and the original marked REVERSED with
   *     `reversed_by_jurnal_id` set;
   *   - the business state reverted through `PembalikStateBisnis` in the SAME
   *     transaction when the original has a `referensi_tipe`.
   * `alasan` is mandatory (`ALASAN_WAJIB` on empty/blank). A journal that is
   * already REVERSED rejects with `JURNAL_SUDAH_REVERSED` (spec 6.6.7); a
   * DRAFT rejects with `JURNAL_BELUM_POSTED`.
   */
  reversalJurnal(id: string, alasan: string, ctx: JurnalContext): Promise<Jurnal>;

  /**
   * Atomic, all or nothing (spec 6.1, tested by spec 6.6.8). One invalid
   * member leaves NOTHING posted and rejects with `BATCH_GAGAL`, whose
   * `detail` carries `{ jurnalIdGagal, kodePenyebab }`.
   */
  postingBatch(ids: string[], ctx: JurnalContext): Promise<Jurnal[]>;

  /**
   * Spec 6.4, the single central path for every automatic journal
   * (invariant 11). Accounts are read from `event_jurnal_mapping` for the
   * given `bumn_id` + `eventCode` where `aktif` and not soft-deleted; an
   * absent or inactive row rejects with `EVENT_MAPPING_TIDAK_DITEMUKAN`.
   *
   * `eventCode` is a plain `string`, NOT a TypeScript union: the event
   * catalogue is table data (ADR 0004), so adding a row must not require a
   * type change or a redeploy.
   *
   * The journal is created and POSTED in one transaction, so the caller
   * receives a POSTED journal.
   *
   * NO `jurnal.post` CHECK ON THIS PATH, deliberately. Spec 2 gives Maker
   * "input pencairan, input penerimaan angsuran" while only Approver holds
   * `jurnal.post`, so gating the automatic journal on `jurnal.post` would mean
   * no single role can complete a PUMK disbursement: the business action would
   * be authorised and its ledger consequence refused. An automatic journal is
   * a consequence of a business action the caller already authorised, not a
   * second act of posting. What IS still enforced here is branch scope (spec 2
   * rule 3) and every spec 6.2 validation. Manual posting (`postingJurnal`,
   * `postingBatch`) keeps demanding `jurnal.post`, which is where the
   * segregation of duties actually lives.
   */
  postingEvent(eventCode: string, payload: EventPayload, ctx: JurnalContext): Promise<Jurnal>;

  /**
   * Spec 7.2 step 8: SEVERAL mapped events, ONE journal. A deposit allocation
   * splits into pokok, jasa administrasi and any kelebihan, and the spec is
   * explicit that those land as "satu jurnal dengan beberapa baris, bukan tiga
   * jurnal terpisah". `postingEvent` produces one whole journal per call, so
   * three components would be three journals; this is the capability that
   * closes that gap, and `modules/angsuran` declared the shape it needs.
   *
   * Three things make it different from `postingEvent`, all of them required
   * rather than convenient:
   *
   *   - IT TAKES THE CALLER'S TRANSACTION. Spec 7.2: "Seluruh langkah 1 sampai
   *     8 dalam satu transaksi database. Kalau jurnal gagal, alokasi harus
   *     rollback." So it must not open its own; the schedule updates, the akad
   *     outstanding and this journal commit together or not at all.
   *   - LEGS THAT AGREE ARE MERGED. One deposit debits cash once, not once per
   *     component, so legs sharing account, side and sub-ledger dimensions are
   *     summed into a single line. A three-component allocation is therefore
   *     four lines: one cash receipt against piutang, pendapatan jasa and
   *     kelebihan.
   *   - IT DOES NOT DEMAND `jurnal.post`. See the note on `postingEvent`.
   *
   * Each component's accounts are read from its own `event_jurnal_mapping` row
   * (one lookup per component), so invariant 11 holds and no account pair
   * moves into code. Balance is asserted over the assembled lines before the
   * write, and the deferred database guard is forced to fire before this
   * method returns rather than at the caller's COMMIT, so a refusal arrives as
   * a `JurnalError` from HERE instead of as raw driver text from a commit the
   * caller cannot translate.
   */
  postingEventGabungan(
    input: PostingGabunganInput,
    tx: JurnalTx,
    ctx: JurnalContext,
  ): Promise<JurnalGabungan>;

  /**
   * Penghapusbukuan, with the allowance consumed FIRST and only the remainder
   * charged to the period. The one operation in this engine that computes an
   * amount instead of posting the one it is handed, and it exists because the
   * spec's own journal is defective without it.
   *
   * WHAT THE SPEC SAYS AND WHY IT IS NOT ENOUGH. Spec 6.4's
   * `HAPUS_BUKU_PIUTANG` debits Penyisihan Penurunan Nilai Piutang for the
   * FULL outstanding. That is only correct when the allowance covers the
   * outstanding, which holds at a 100 percent Macet rate but not under the
   * collective-impairment basis docs/REGULASI.md found to be the basis
   * actually in force. With a smaller allowance, the spec's journal drives a
   * contra-ASSET account into a debit balance, which presents as a NEGATIVE
   * deduction from receivables, i.e. as receivables overstated by the very
   * amount that was supposed to leave the balance sheet. It balances, and it
   * is wrong.
   *
   * WHAT THIS DOES:
   *   - reads the allowance balance from the ledger, at `tanggalTransaksi`,
   *     for the account the `HAPUS_BUKU_PIUTANG` mapping row names (so an
   *     accountant repointing that row moves this read too, invariant 11);
   *   - consumes `min(allowance, outstanding)` through `HAPUS_BUKU_PIUTANG`;
   *   - routes the remainder through `HAPUS_BUKU_KEKURANGAN_PENYISIHAN`
   *     (debit Beban Penyisihan, credit Piutang Pokok);
   *   - emits ONE journal, because both components credit the same receivable
   *     for the same akad and merge into a single credit line of the full
   *     outstanding, which is what a write-off is;
   *   - never emits a component worth "0.00", so an allowance that covers the
   *     write-off produces exactly the spec's two-line journal and an
   *     allowance of zero produces the shortfall journal alone.
   *
   * The allowance can therefore reach zero and never crosses it. It is read
   * over POSTED **and REVERSED** journals, because a reversed formation's
   * lines are still in the ledger and are offset by its reversal; counting
   * only POSTED would subtract the reversal without adding the original and
   * report an allowance that never existed.
   *
   * WHAT IS POLICY AND STAYS OUT OF CODE: whether a shortfall may be charged
   * at all is `akuntansi.kekurangan_penyisihan_hapus_buku`. `BEBAN_PERIODE`
   * splits, `TOLAK` refuses with `PENYISIHAN_TIDAK_CUKUP` so the allowance is
   * formed first. Absent configuration is a configuration fault and throws,
   * rather than quietly picking a treatment for the client's accounts.
   *
   * Takes the CALLER'S transaction, like `postingEventGabungan`: a write-off
   * also closes an akad, and the two must commit together or not at all.
   */
  postingHapusBukuPiutang(
    input: HapusBukuPiutangInput,
    tx: JurnalTx,
    ctx: JurnalContext,
  ): Promise<HapusBukuPiutang>;
}

/**
 * The one implementation site. The engine itself lives in ./service.ts; this
 * stays the single named entry point so nothing outside the module has to know
 * which file the logic is in.
 *
 * The import below closes a cycle (contract -> service -> kesalahan ->
 * contract). It is safe, and it is kept safe on purpose: neither ./service.ts
 * nor ./kesalahan.ts touches a runtime binding of this file at module
 * evaluation time, so nothing here is read while it is still in its temporal
 * dead zone. ./kesalahan.ts says so at its message catalogue, which is written
 * with string-literal keys for exactly that reason.
 */
export function createJurnalEngine(deps: JurnalEngineDeps): JurnalEngine {
  return buatEngineJurnal(deps);
}
