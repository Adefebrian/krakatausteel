// Spec 9.5, the public intake. THE ONLY UNAUTHENTICATED WRITE SURFACE IN THE
// SYSTEM, which is what every decision in this file is shaped by.
//
// FOUR RULES THIS MODULE HOLDS, and they are the reason it exists as its own
// module rather than as three routes bolted onto modules/pumk:
//
// 1. A SUBMISSION IS DATA, NEVER A COMMAND. `portal_submission` is the only
//    table this engine writes. It cannot create a mitra, a proposal, an akad
//    or a journal, and it takes no journal port, so invariant 11 is not
//    respected here, it is UNREACHABLE. Turning a submission into a PUMK
//    proposal is `pumk.konversiSubmissionPortal` under `portal.konversi`, a
//    STAFF act, and it stays that way.
//
// 2. THE FORM IS AN ALLOWLIST, NOT A BLOB. Every key the public may send is
//    named here with a type and a length ceiling, and an unknown key is a
//    REFUSAL rather than something quietly stored. A JSONB column with no
//    schema in front of it is an unbounded write primitive handed to the
//    internet.
//
// 3. THE STATUS CHECK IS A CREDENTIAL CHECK. Ticket plus NIK or date of birth
//    (spec 9.5) is a username and a password wearing different names, so it
//    gets the login treatment: one indistinguishable refusal for every failure
//    mode, constant work on the unknown-ticket path, and a per-ticket failure
//    budget that is consumed ONLY AFTER a wrong answer and reset by a right
//    one. See `KODE_PORTAL.TIKET_ATAU_PEMERIKSA_SALAH` and the note on
//    `cekStatus`.
//
// 4. THE VERIFIER IS NEVER STORED IN CLEARTEXT. Whichever of NIK / date of
//    birth the applicant chose becomes `pemeriksa_hash` (argon2id) and is
//    REMOVED from the form data. Keeping both the secret and its hash in one
//    row would make the hash decorative, and a table of citizens' NIKs behind
//    a public form is the single worst thing this module could accumulate.
//    The officer verifies identity against the uploaded KTP at conversion
//    time, which is where identity verification belongs anyway.
import type { QueryRunner } from "../../core/ports/db";

// ---------------------------------------------------------------------------
// Money and identifiers
// ---------------------------------------------------------------------------

/** Decimal string, exactly two fractional digits. Never a JS number. */
export type Uang = string;

export const POLA_UANG = /^\d{1,15}\.\d{2}$/;
export const POLA_TANGGAL = /^\d{4}-\d{2}-\d{2}$/;
export const POLA_NIK = /^\d{16}$/;
/** `TKT-YYYYMM-XXXXXXXXXX`, the second half unguessable. See `buatNoTiket`. */
export const POLA_TIKET = /^TKT-\d{6}-[0-9A-HJKMNP-TV-Z]{10}$/;

// ---------------------------------------------------------------------------
// Permissions (both SHIP in modules/auth's catalogue)
// ---------------------------------------------------------------------------

export const PERMISSION_PORTAL = {
  /** Reading the officer's intake queue. */
  LIHAT: "portal.view",
  /**
   * Acting on a submission: marking it under review or refusing it. The
   * CONVERSION itself is modules/pumk's, under this same code; nothing here
   * ever sets `DIKONVERSI`, because that status is a claim about a proposal
   * this module cannot create.
   */
  TINDAK: "portal.konversi",
} as const;

export type PermissionPortal = (typeof PERMISSION_PORTAL)[keyof typeof PERMISSION_PORTAL];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const KODE_PORTAL = {
  /** The chosen reporting entity does not exist or is not live. */
  ENTITAS_TIDAK_DITEMUKAN: "ENTITAS_TIDAK_DITEMUKAN",
  /** A field is missing, too long, of the wrong type, or simply not allowed. */
  FORMULIR_TIDAK_VALID: "FORMULIR_TIDAK_VALID",
  /** Neither NIK nor date of birth was supplied, or both were. */
  PEMERIKSA_WAJIB: "PEMERIKSA_WAJIB",
  /**
   * THE ONLY ANSWER A FAILED STATUS CHECK EVER GETS. Unknown ticket, wrong
   * NIK, wrong date of birth, deleted submission: one code, one message, one
   * status. Splitting them would turn the endpoint into an oracle for "does
   * this ticket exist", which is the whole question an attacker has.
   */
  TIKET_ATAU_PEMERIKSA_SALAH: "TIKET_ATAU_PEMERIKSA_SALAH",
  /** Too many submissions from one source. Answered as 429. */
  TERLALU_BANYAK_PENGAJUAN: "TERLALU_BANYAK_PENGAJUAN",
  /** Too many wrong answers for one ticket. Answered as 429. */
  TERLALU_BANYAK_PERCOBAAN: "TERLALU_BANYAK_PERCOBAAN",
  SUBMISSION_TIDAK_DITEMUKAN: "SUBMISSION_TIDAK_DITEMUKAN",
  /** A converted submission is finished; nothing may move it again. */
  SUBMISSION_SUDAH_DIKONVERSI: "SUBMISSION_SUDAH_DIKONVERSI",
  STATUS_TIDAK_BISA_DIUBAH: "STATUS_TIDAK_BISA_DIUBAH",
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  IZIN_BELUM_TERDAFTAR: "IZIN_BELUM_TERDAFTAR",
} as const;

export type KodePortal = (typeof KODE_PORTAL)[keyof typeof KODE_PORTAL];

/**
 * The module's domain error. Registered in `NAMA_ERROR_BERKODE` in
 * core/http.ts WITH this file, not after the router landed: four modules
 * shipped without that registration and each one produced anonymous 500s with
 * no audit denial row.
 */
export class PortalError extends Error {
  readonly kode: KodePortal;
  readonly detail?: Record<string, unknown> | undefined;
  readonly penyebabDb?: string | undefined;

  constructor(
    kode: KodePortal,
    message: string,
    detail?: Record<string, unknown>,
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "PortalError";
    this.kode = kode;
    this.detail = detail;
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// The public form
// ---------------------------------------------------------------------------

export type JenisPengajuan = "PUMK" | "NON_PUMK";

export type StatusSubmission = "BARU" | "DIPROSES" | "DIKONVERSI" | "DITOLAK";

/** What a form field may be, and how far it may go. */
export type AturanField =
  | { jenis: "teks"; maks: number; wajib: boolean }
  | { jenis: "uang"; maksSen: bigint; wajib: boolean }
  | { jenis: "bulat"; min: number; maks: number; wajib: boolean };

/**
 * SPEC 9.5's multi-step form, as an allowlist.
 *
 * The PUMK keys are exactly the ones `pumk.konversiSubmissionPortal` reads
 * (`jumlah_diajukan`, `tenor_diajukan`, `tujuan_penggunaan`) plus the
 * descriptive fields an officer needs to recognise the applicant. Adding a key
 * here is a deliberate act; sending one that is not here is a 400.
 */
export const FIELD_PUMK: Readonly<Record<string, AturanField>> = {
  nama_lengkap: { jenis: "teks", maks: 120, wajib: true },
  nama_usaha: { jenis: "teks", maks: 120, wajib: true },
  sektor: { jenis: "teks", maks: 60, wajib: false },
  alamat: { jenis: "teks", maks: 240, wajib: true },
  // 1 trillion rupiah in sen. Not a business ceiling (that is
  // `pumk.plafon_maksimum`, checked at conversion): a ceiling on what a public
  // form may put in a NUMERIC(20,2) column.
  jumlah_diajukan: { jenis: "uang", maksSen: 100_000_000_000_000n, wajib: true },
  tenor_diajukan: { jenis: "bulat", min: 1, maks: 120, wajib: true },
  tujuan_penggunaan: { jenis: "teks", maks: 500, wajib: true },
};

export const FIELD_NON_PUMK: Readonly<Record<string, AturanField>> = {
  nama_pemohon: { jenis: "teks", maks: 120, wajib: true },
  nama_lembaga: { jenis: "teks", maks: 120, wajib: false },
  judul_program: { jenis: "teks", maks: 160, wajib: true },
  alamat: { jenis: "teks", maks: 240, wajib: true },
  jumlah_diajukan: { jenis: "uang", maksSen: 100_000_000_000_000n, wajib: true },
  penerima_manfaat_estimasi: { jenis: "bulat", min: 0, maks: 10_000_000, wajib: false },
  deskripsi: { jenis: "teks", maks: 1000, wajib: true },
};

export function aturanFormulir(jenis: JenisPengajuan): Readonly<Record<string, AturanField>> {
  return jenis === "PUMK" ? FIELD_PUMK : FIELD_NON_PUMK;
}

/** Attachment kinds, mirroring `mitra_dokumen.jenis` (migrations/0006). */
export const JENIS_DOKUMEN = [
  "KTP",
  "KK",
  "NPWP",
  "SIUP",
  "NIB",
  "FOTO_USAHA",
  "SURAT_KETERANGAN_USAHA",
  "LAINNYA",
] as const;

export type JenisDokumen = (typeof JENIS_DOKUMEN)[number];

export const MAKS_DOKUMEN = 10;
export const MAKS_NAMA_FILE = 160;

/**
 * A declared attachment. The portal records that a document was OFFERED; it
 * does not accept bytes on this endpoint. Anonymous uploads into the object
 * store are a separate decision with a separate threat model, and shipping
 * them together with the first public route would have been two new risks in
 * one commit. Reported as not shipped.
 */
export interface DokumenPengajuan {
  jenis: JenisDokumen;
  namaFile: string;
}

export interface PengajuanInput {
  /** `bumn.kode` of the entity being applied to. A selector, never authority. */
  kodeEntitas: string;
  jenis: JenisPengajuan;
  emailKontak?: string | null;
  teleponKontak?: string | null;
  /** EXACTLY ONE of these two. Hashed, then dropped; see rule 4 in the header. */
  nik?: string | null;
  tanggalLahir?: string | null;
  formulir: Record<string, unknown>;
  dokumen?: DokumenPengajuan[];
}

/** What the browser is told after a submit. No id, no branch, no internals. */
export interface HasilPengajuan {
  noTiket: string;
  jenis: JenisPengajuan;
  tanggalSubmit: string;
  status: StatusSubmission;
  pesan: string;
}

export interface CekStatusInput {
  noTiket: string;
  nik?: string | null;
  tanggalLahir?: string | null;
}

/**
 * The public status answer. Deliberately NOT carrying: the submission id, the
 * converted proposal id or number, `catatan_petugas` (internal free text
 * written by an officer for other officers), the form data, the contact
 * details, or any timestamp finer than a date.
 */
export interface StatusPengajuan {
  noTiket: string;
  jenis: JenisPengajuan;
  tanggalSubmit: string;
  status: StatusSubmission;
  /** A fixed sentence per status, chosen here, never typed by an officer. */
  pesan: string;
}

// ---------------------------------------------------------------------------
// The officer's queue
// ---------------------------------------------------------------------------

export interface RingkasanSubmission {
  id: string;
  noTiket: string;
  jenis: JenisPengajuan;
  tanggalSubmit: string;
  status: StatusSubmission;
  namaPemohon: string | null;
  jumlahDiajukan: Uang | null;
  emailKontak: string | null;
  teleponKontak: string | null;
  sudahDikonversi: boolean;
}

export interface DetailSubmission extends RingkasanSubmission {
  formulir: Record<string, unknown>;
  dokumen: DokumenPengajuan[];
  catatanPetugas: string | null;
  convertedProposalId: string | null;
}

export interface FilterSubmission {
  jenis?: JenisPengajuan | null;
  status?: StatusSubmission | null;
  /** Free-text search over the ticket number only. Never over the form data. */
  noTiket?: string | null;
  batasBaris?: number | null;
}

export const BATAS_BARIS_BAWAAN = 100;
export const BATAS_BARIS_MAKS = 500;

/** The two transitions an officer may make here. `DIKONVERSI` is not one. */
export type TindakanPetugas = "DIPROSES" | "DITOLAK";

export interface TindakInput {
  tindakan: TindakanPetugas;
  catatan?: string | null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** What an ANONYMOUS caller is: an address and a user agent, nothing more. */
export interface PortalPublikContext {
  ip: string | null;
  userAgent: string | null;
}

/** A staff caller, resolved from the session and never from the request. */
export interface PortalContext {
  userId: string;
  cabangId: string;
  bumnId: string;
  permissions: readonly string[];
  cabangDalamScope?: readonly string[];
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface PortalDbPort extends QueryRunner {
  transaction<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T>;
}

/** The minimum this module needs of the audit service. */
export interface PorterAuditPortal {
  record(entry: {
    userId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    aksi: string;
    entitas: string;
    entitasId?: string | null;
    nilaiBaru?: unknown;
    hasil: "SUKSES" | "DITOLAK";
    keterangan?: string | null;
  }, runner?: QueryRunner): Promise<string>;
}

/** The rate limiter, FAIL CLOSED. See createPortalEngine's note. */
export interface PembatasPortal {
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }>;
  reset(key: string): Promise<void>;
}

/**
 * Every anti-spam ceiling, overridable IN ONE PLACE.
 *
 * A COST KNOB for the harness and nothing else: production never sets it, so
 * the constants below apply. It exists for the same reason
 * `AuthServiceDeps.loginLimits` does. A test file makes far more calls from
 * one (absent) client address than a member of the public ever would, and
 * without this every portal test would be a test of the rate limiter. The
 * ceilings themselves are proved against a fixture that does NOT raise them,
 * in ./portal-batas.test.ts.
 */
export interface BatasPortal {
  pengajuanPerIp?: number;
  pengajuanPerIpHarian?: number;
  jendelaPengajuanDetik?: number;
  cekPerIp?: number;
  cekPerTiket?: number;
  jendelaCekDetik?: number;
  /** Coarse transport ceilings on the two public routes (see ./routes.ts). */
  rutePengajuan?: number;
  ruteCek?: number;
}

export interface PortalEngineDeps {
  db: PortalDbPort;
  audit: PorterAuditPortal;
  pembatas: PembatasPortal;
  /** Redis namespace, so one test run cannot inherit another's counters. */
  keyPrefix?: string;
  /** argon2id cost for the status-check verifier. Lowered by tests only. */
  passwordOptions?: { memoryCost?: number; timeCost?: number };
  batas?: BatasPortal;
  jam?: () => Date;
}

// ---------------------------------------------------------------------------
// Anti-spam ceilings (spec 9.5: "Rate limiting dan proteksi anti spam wajib")
// ---------------------------------------------------------------------------

/** Submissions one address may make inside `JENDELA_PENGAJUAN_DETIK`. */
export const BATAS_PENGAJUAN_PER_IP = 5;
export const JENDELA_PENGAJUAN_DETIK = 60 * 60;
/**
 * A second, DURABLE ceiling read from `portal_submission` itself, over 24
 * hours. The Redis counter bounds a burst; this one survives a Redis flush and
 * is what makes "500 applications overnight" impossible rather than merely
 * inconvenient.
 */
export const BATAS_PENGAJUAN_PER_IP_HARIAN = 20;

/** Status checks one address may make inside `JENDELA_CEK_DETIK`. */
export const BATAS_CEK_PER_IP = 10;
export const JENDELA_CEK_DETIK = 5 * 60;
/** WRONG answers one ticket may collect inside the same window. */
export const BATAS_CEK_PER_TIKET = 5;

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface PortalEngine {
  /**
   * ANONYMOUS. Validates against the allowlist, hashes the verifier, drops it
   * from the form, allocates an unguessable ticket, and writes ONE
   * `portal_submission` row. Nothing else in the database changes.
   */
  ajukan(input: PengajuanInput, ctx: PortalPublikContext): Promise<HasilPengajuan>;

  /**
   * ANONYMOUS. Ticket plus one verifier.
   *
   * ONE REFUSAL FOR EVERY FAILURE MODE, and the unknown-ticket path still pays
   * for an argon2id verification against a throwaway hash so it is not
   * measurably faster than a wrong one.
   *
   * THE PER-TICKET FAILURE BUDGET IS CONSUMED AFTER THE CHECK, ON FAILURE
   * ONLY, AND A SUCCESS RESETS IT. core/hardening.ts records what happens when
   * a counter like this is consumed BEFORE verification: the login limiter was
   * an account-lockout weapon, because six wrong guesses at a name refused the
   * real owner's correct answer for the rest of the window. The same shape
   * here would let anyone lock an applicant out of their own ticket. So the
   * budget throttles WRONG ANSWERS, never attempts, and a correct answer
   * always wins.
   */
  cekStatus(input: CekStatusInput, ctx: PortalPublikContext): Promise<StatusPengajuan>;

  /** Officer queue. Requires `portal.view`. */
  daftar(filter: FilterSubmission, ctx: PortalContext): Promise<RingkasanSubmission[]>;

  /** One submission in full, for the verification screen. Requires `portal.view`. */
  detail(id: string, ctx: PortalContext): Promise<DetailSubmission>;

  /**
   * Marks a submission under review or refused. Requires `portal.konversi`.
   * Cannot reach `DIKONVERSI`: that transition belongs to
   * `pumk.konversiSubmissionPortal`, which is the only thing that can create
   * the proposal such a status claims to point at.
   */
  tindak(id: string, input: TindakInput, ctx: PortalContext): Promise<DetailSubmission>;
}
