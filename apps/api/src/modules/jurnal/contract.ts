// apps/api/src/modules/jurnal/contract.ts
//
// TYPE CONTRACT FOR THE JOURNAL ENGINE (spec 6). Written BEFORE the
// implementation, per spec rule 5. Every function here is a stub that throws
// `not implemented`; the tests in this folder are the specification and they
// are expected to fail until the engine is built against this file.
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
// WHY THE SPEC 6.1 SURFACE IS EXPOSED TWICE
// -------------------------------------------------------------------------
// Spec 6.1 names seven free functions. They are declared below verbatim, and
// they are ALSO the method set of `JurnalEngine`, which is what
// `createJurnalEngine(deps)` returns. The engine object is the unit under
// test: the tests must inject a real transactional DB port (the accounting
// invariants live in Postgres triggers, so a fake proves nothing), and a free
// function cannot have a port injected. The free functions are thin app-level
// wiring over an engine built from the core DbPort; there is exactly one
// implementation site, `createJurnalEngine`.

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
  BUAT: "jurnal.create",
  UBAH: "jurnal.update",
  VERIFIKASI: "jurnal.verify",
  POSTING: "jurnal.post",
  HAPUS: "jurnal.delete",
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
 * reads. The Bun Postgres driver exposes the SQLSTATE as `err.errno` and the
 * constraint name as `err.constraint`; map on those, not on message text.
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

/** A handle that runs statements on ONE connection inside ONE transaction. */
export interface JurnalTx {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * The database port the engine needs. Wider than `core/ports/db.ts` on
 * purpose: this engine cannot be built on autocommit queries.
 *
 *   - `postingBatch` is "atomik, semua atau tidak ada" (spec 6.1).
 *   - Reversal must revert business state IN THE SAME TRANSACTION (spec 6.3,
 *     called out as the number one source of corrupt data).
 *   - The balance/min-2-lines check is a DEFERRED CONSTRAINT TRIGGER, so it
 *     fires at COMMIT, not at the offending statement. `transaction()` must
 *     therefore surface a COMMIT failure as a rejected promise, and the engine
 *     must translate it into `TIDAK_BALANCE` / `MINIMAL_DUA_BARIS`.
 *   - The concurrent-post guard needs `SELECT ... FOR UPDATE` on one
 *     connection (spec 6.6.9).
 */
export interface JurnalDbPort extends JurnalTx {
  transaction<T>(jalankan: (tx: JurnalTx) => Promise<T>): Promise<T>;
}

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

export interface JurnalEngineDeps {
  db: JurnalDbPort;
  /**
   * Injectable clock. Used for `posted_at`/`verified_at` and, critically, to
   * date a reversal (see `reversalJurnal`). Injectable so tests are not
   * hostage to the wall clock.
   */
  jam?: () => Date;
  pembalikStateBisnis?: readonly PembalikStateBisnis[];
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
   */
  postingEvent(eventCode: string, payload: EventPayload, ctx: JurnalContext): Promise<Jurnal>;
}

const BELUM = "not implemented";

/**
 * The one implementation site. Returns an engine whose every method throws
 * until the backend agent implements it.
 */
export function createJurnalEngine(deps: JurnalEngineDeps): JurnalEngine {
  void deps;
  return {
    async buatJurnal() {
      throw new Error(BELUM);
    },
    async ubahJurnalDraft() {
      throw new Error(BELUM);
    },
    async verifikasiJurnal() {
      throw new Error(BELUM);
    },
    async postingJurnal() {
      throw new Error(BELUM);
    },
    async batalkanJurnalDraft() {
      throw new Error(BELUM);
    },
    async reversalJurnal() {
      throw new Error(BELUM);
    },
    async postingBatch() {
      throw new Error(BELUM);
    },
    async postingEvent() {
      throw new Error(BELUM);
    },
  };
}

// ---------------------------------------------------------------------------
// Spec 6.1 free-function surface. App-level wiring over an engine built from
// the core DbPort adapter; see the file header for why the engine object, not
// these, is what the tests drive.
// ---------------------------------------------------------------------------

export async function buatJurnal(input: BuatJurnalInput, ctx: JurnalContext): Promise<Jurnal> {
  void input;
  void ctx;
  throw new Error(BELUM);
}

export async function verifikasiJurnal(id: string, ctx: JurnalContext): Promise<Jurnal> {
  void id;
  void ctx;
  throw new Error(BELUM);
}

export async function postingJurnal(id: string, ctx: JurnalContext): Promise<Jurnal> {
  void id;
  void ctx;
  throw new Error(BELUM);
}

export async function batalkanJurnalDraft(id: string, ctx: JurnalContext): Promise<void> {
  void id;
  void ctx;
  throw new Error(BELUM);
}

export async function reversalJurnal(id: string, alasan: string, ctx: JurnalContext): Promise<Jurnal> {
  void id;
  void alasan;
  void ctx;
  throw new Error(BELUM);
}

export async function postingBatch(ids: string[], ctx: JurnalContext): Promise<Jurnal[]> {
  void ids;
  void ctx;
  throw new Error(BELUM);
}

export async function postingEvent(
  eventCode: string,
  payload: EventPayload,
  ctx: JurnalContext,
): Promise<Jurnal> {
  void eventCode;
  void payload;
  void ctx;
  throw new Error(BELUM);
}
