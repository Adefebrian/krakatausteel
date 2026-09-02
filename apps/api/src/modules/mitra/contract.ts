// A SECOND KIND OF PRINCIPAL (spec 4.9, spec 9.5).
//
// ---------------------------------------------------------------------------
// WHY A MITRA IS NOT AN `app_user`, AND WHY NOTHING HERE TOUCHES core/principal
// ---------------------------------------------------------------------------
//
// The temptation is obvious: `Principal` already exists, `Guards` already
// exist, `requirePermission` already exists, so give a mitra a role with no
// permissions and reuse the lot. That is the change this module refuses to
// make, for five reasons, in order of how badly each one would end:
//
// 1. IT WOULD WEAKEN STAFF AUTHENTICATION TO FIT. `core/principal.ts` states
//    that every field on a `Principal` is an authorisation fact re-read from
//    Postgres per request: a home branch, a role list, a permission list, a
//    cross-branch flag. A mitra has none of them and would need every one
//    filled with a lie (an empty role list, an empty permission list, a branch
//    it must NOT be able to read). `assertCabangAllowed` would then be deciding
//    a borrower's access with a rule written for employees, and every future
//    `requirePermission` call would be one catalogue mistake away from
//    granting a borrower something.
//
// 2. THE SESSION MECHANISM IS THE SAME MECHANISM. One cookie name and one
//    Redis namespace for both principal kinds means a bug anywhere in
//    resolution turns one into the other. Here they share NOTHING that can be
//    confused: a different cookie name (`tjsl_mitra` vs `tjsl_sid`), a
//    different Redis prefix (`tjsl:msess:` vs `tjsl:sess:`), a different
//    context key, a different guard, and a much shorter lifetime. A mitra
//    session id pasted into the staff cookie resolves to nothing, because the
//    staff store looks under a prefix the id was never written to.
//
// 3. `audit_log.user_id` IS A FOREIGN KEY TO `app_user` (migrations/0014).
//    Making a mitra an `app_user` to satisfy that FK would put a borrower in
//    the table `konfigurasi.user` administers and `user_role` grants from. So
//    a mitra's actions audit with `user_id = NULL` and the account named in
//    `entitas` / `entitas_id`, which is honest, and the FK stays a guarantee
//    that a `user_id` in the audit trail is an employee.
//
// 4. READ-ONLY IS STRUCTURAL HERE, NOT A ROLE FLAG. Every mitra read route is
//    a GET whose SQL is filtered by the session's own `mitra_id`; there is no
//    parameter anywhere on this surface that names a mitra. The two POSTs are
//    "change my own password" and "log out". A mitra cannot write business
//    data because no code path exists, not because a flag says so.
//
// 5. THE ONE THING A MITRA MAY WRITE IS ITS OWN PASSWORD, and that is guarded
//    by a rule staff do not have: while `harus_ganti_sandi` is true the
//    session reaches `/mitra/ganti-sandi` and `/mitra/logout` and NOTHING
//    else, because the password it logged in with is one an officer knows.
//
// WHAT A MITRA CAN SEE, EXHAUSTIVELY: its own profile, its own akad, the
// schedule of its own akad, and the receipts against its own akad. Spec 4.9:
// "Mitra yang sudah punya akad bisa login untuk cek sisa angsuran dan jadwal."
import type { QueryRunner } from "../../core/ports/db";

/** Decimal string, exactly two fractional digits. Never a JS number. */
export type Uang = string;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const KODE_MITRA = {
  /**
   * THE ONLY ANSWER A FAILED MITRA LOGIN EVER GETS. Unknown email, wrong
   * password, deactivated account, an account whose mitra was soft-deleted:
   * one code, one message. The distinction goes to `audit_log`.
   */
  KREDENSIAL_MITRA_SALAH: "KREDENSIAL_MITRA_SALAH",
  SESI_MITRA_TIDAK_VALID: "SESI_MITRA_TIDAK_VALID",
  /** The first password an officer handed over may only change itself. */
  WAJIB_GANTI_SANDI: "WAJIB_GANTI_SANDI",
  SANDI_TIDAK_MEMENUHI_SYARAT: "SANDI_TIDAK_MEMENUHI_SYARAT",
  TERLALU_BANYAK_PERCOBAAN_MASUK: "TERLALU_BANYAK_PERCOBAAN_MASUK",
  /**
   * THE ONLY ANSWER FOR AN AKAD THAT IS NOT THIS MITRA'S. Identical to the
   * answer for an akad that does not exist at all, and that is the point: a
   * 403 here would confirm that the id names a real contract belonging to
   * somebody else, which is the whole question an enumerating caller has.
   */
  AKAD_TIDAK_DITEMUKAN: "AKAD_TIDAK_DITEMUKAN",
  MITRA_TIDAK_DITEMUKAN: "MITRA_TIDAK_DITEMUKAN",
  AKUN_MITRA_SUDAH_ADA: "AKUN_MITRA_SUDAH_ADA",
  AKUN_MITRA_TIDAK_DITEMUKAN: "AKUN_MITRA_TIDAK_DITEMUKAN",
  EMAIL_TIDAK_VALID: "EMAIL_TIDAK_VALID",
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  CABANG_DILUAR_SCOPE: "CABANG_DILUAR_SCOPE",
} as const;

export type KodeMitra = (typeof KODE_MITRA)[keyof typeof KODE_MITRA];

/**
 * Registered in `NAMA_ERROR_BERKODE` in core/http.ts WITH this file. Four
 * modules have shipped a router without that registration and each one turned
 * its refusals into anonymous 500s with no audit denial row; on an
 * authentication surface that would be the worst possible place for it.
 */
export class MitraError extends Error {
  readonly kode: KodeMitra;
  readonly detail?: Record<string, unknown> | undefined;
  readonly penyebabDb?: string | undefined;

  constructor(
    kode: KodeMitra,
    message: string,
    detail?: Record<string, unknown>,
    penyebabDb?: string,
  ) {
    super(message);
    this.name = "MitraError";
    this.kode = kode;
    this.detail = detail;
    this.penyebabDb = penyebabDb;
  }
}

// ---------------------------------------------------------------------------
// The principal
// ---------------------------------------------------------------------------

/**
 * Everything an authorisation decision about a MITRA needs, and nothing else.
 *
 * Note what is absent and cannot be added: `permissions`, `roles`,
 * `lintasCabang`, `cabangTersedia`, `userId`. There is no field here that any
 * staff guard reads, so this object cannot accidentally satisfy one.
 *
 * `cabangId` is present for the audit trail and for nothing else. It is NEVER
 * used to widen a read: every query is filtered by `mitraId`, so two mitra of
 * the SAME branch are as isolated from each other as two of different
 * branches. Branch scope is the staff rule; it is not the mitra rule, and
 * using it here would make every borrower in a branch visible to every other.
 */
export interface MitraPrincipal {
  sessionId: string;
  akunId: string;
  mitraId: string;
  cabangId: string;
  bumnId: string;
  email: string;
  namaMitra: string;
  kodeMitra: string;
  /** True while the account still holds the password an officer handed over. */
  harusGantiSandi: boolean;
}

// ---------------------------------------------------------------------------
// What a mitra may read
// ---------------------------------------------------------------------------

export interface ProfilMitra {
  kodeMitra: string;
  namaLengkap: string;
  namaUsaha: string | null;
  email: string;
  cabang: { kode: string; nama: string };
  status: string;
  harusGantiSandi: boolean;
}

export interface AkadMitra {
  id: string;
  noAkad: string;
  tanggalAkad: string;
  pokokPinjaman: Uang;
  tenorBulan: number;
  metodePerhitungan: string;
  tanggalMulaiAngsuran: string;
  tanggalJatuhTempoAkhir: string;
  status: string;
  outstandingPokok: Uang;
  outstandingJasa: Uang;
  tanggalLunas: string | null;
}

export interface BarisJadwalMitra {
  angsuranKe: number;
  tanggalJatuhTempo: string;
  pokok: Uang;
  jasaAdm: Uang;
  total: Uang;
  pokokTerbayar: Uang;
  jasaTerbayar: Uang;
  status: string;
  tanggalLunas: string | null;
}

export interface JadwalMitra {
  akadId: string;
  noAkad: string;
  versi: number;
  outstandingPokok: Uang;
  outstandingJasa: Uang;
  baris: BarisJadwalMitra[];
}

export interface PembayaranMitra {
  tanggalTerima: string;
  jumlahDiterima: Uang;
  alokasiPokok: Uang;
  alokasiJasa: Uang;
  alokasiKelebihan: Uang;
  noBukti: string | null;
}

// ---------------------------------------------------------------------------
// Staff-side provisioning
// ---------------------------------------------------------------------------

/**
 * Creating the account is a STAFF act under `konfigurasi.user`.
 *
 * Why that code and not a new one: `konfigurasi.user` is "User dan Role" (spec
 * 9.4), the credential-administration permission, held by ADMIN_CABANG and
 * ADMIN_PUSAT. A mitra portal account is a credential for an external party
 * issued by a branch, so it belongs with the same people. Inventing a new code
 * would mean editing the shared catalogue AND its SPA mirror for one route,
 * and reusing `portal.konversi` would put credential issuance in the hands of
 * every Maker.
 *
 * THERE IS NO SELF-REGISTRATION, deliberately. A form that creates a login by
 * naming a mitra would be an account-takeover primitive for anyone who knows
 * a borrower's email, and spec 4.9 scopes portal accounts to mitra who already
 * have an akad, which only staff can establish.
 */
export const PERMISSION_MITRA = {
  KELOLA_AKUN: "konfigurasi.user",
} as const;

export interface BuatAkunInput {
  mitraId: string;
  email: string;
}

export interface HasilBuatAkun {
  akunId: string;
  mitraId: string;
  email: string;
  /**
   * SHOWN ONCE, HERE, AND NEVER AGAIN. Generated by the server rather than
   * typed by the officer: an officer-chosen password is reused across mitra,
   * and a mitra-chosen one cannot be handed over safely. `harusGantiSandi` is
   * true on the new row, so this value can only be used to replace itself.
   */
  sandiSementara: string;
}

/** Minimum length for a mitra-chosen password. */
export const MIN_PANJANG_SANDI = 12;
export const MAKS_PANJANG_SANDI = 200;

// ---------------------------------------------------------------------------
// Ports and limits
// ---------------------------------------------------------------------------

export interface MitraDbPort extends QueryRunner {
  transaction<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T>;
}

export interface PorterAuditMitra {
  record(
    entry: {
      userId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      aksi: string;
      entitas: string;
      entitasId?: string | null;
      nilaiBaru?: unknown;
      hasil: "SUKSES" | "DITOLAK";
      keterangan?: string | null;
    },
    runner?: QueryRunner,
  ): Promise<string>;
}

export interface PembatasMitra {
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }>;
  reset(key: string): Promise<void>;
}

/** Login attempts allowed per client IP inside the window, success or not. */
export const BATAS_MASUK_PER_IP = 10;
/**
 * FAILED attempts allowed per email inside the window. Consumed ONLY on
 * failure and reset on success, so it can never refuse a correct password.
 * core/hardening.ts records what the other shape cost: consuming a per-subject
 * counter before verification made the staff login endpoint a remote
 * account-lockout weapon.
 */
export const BATAS_MASUK_PER_EMAIL = 5;
export const JENDELA_MASUK_DETIK = 300;

/**
 * SHORTER THAN A STAFF SESSION (8h idle / 24h absolute) on purpose. A mitra
 * signs in from a personal phone on a shared network to look at a schedule; it
 * has no reason to hold a live session for a working day.
 */
export const IDLE_TTL_MITRA_DETIK = 30 * 60;
export const ABSOLUTE_TTL_MITRA_DETIK = 8 * 60 * 60;

export interface MitraEngineDeps {
  db: MitraDbPort;
  audit: PorterAuditMitra;
  /** FAIL CLOSED, exactly like the staff login limiter. */
  pembatas: PembatasMitra;
  sesi: MitraSessionStore;
  keyPrefix?: string;
  passwordOptions?: { memoryCost?: number; timeCost?: number };
  /**
   * Login ceilings. A COST KNOB for the harness and nothing else: production
   * never sets it, so the constants above apply. It exists for the same reason
   * `AuthServiceDeps.loginLimits` does -- a test file makes far more login
   * calls from one (absent) client address than a human ever would, and
   * without this the whole file would be testing the rate limiter.
   */
  batasMasuk?: { perIp?: number; perEmail?: number; windowSeconds?: number };
  jam?: () => Date;
}

// ---------------------------------------------------------------------------
// Session store (implemented in ./sesi.ts)
// ---------------------------------------------------------------------------

export interface MitraSessionRecord {
  id: string;
  akunId: string;
  createdAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface MitraSessionStore {
  create(input: { akunId: string; ip: string | null; userAgent: string | null }): Promise<MitraSessionRecord>;
  touch(sessionId: string): Promise<MitraSessionRecord | null>;
  destroy(sessionId: string): Promise<boolean>;
  readonly idleTtlSeconds: number;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface MasukInput {
  email: string;
  sandi: string;
  ip: string | null;
  userAgent: string | null;
}

export interface HasilMasuk {
  sesi: MitraSessionRecord;
  principal: MitraPrincipal;
  profil: ProfilMitra;
}

export interface MitraEngine {
  masuk(input: MasukInput): Promise<HasilMasuk>;
  keluar(sessionId: string, ip: string | null, userAgent: string | null): Promise<void>;
  /** Resolves a cookie value into a mitra principal, or null. Slides the session. */
  resolveSesi(sessionId: string): Promise<MitraPrincipal | null>;

  profil(p: MitraPrincipal): Promise<ProfilMitra>;
  daftarAkad(p: MitraPrincipal): Promise<AkadMitra[]>;
  jadwal(akadId: string, p: MitraPrincipal): Promise<JadwalMitra>;
  pembayaran(akadId: string, p: MitraPrincipal): Promise<PembayaranMitra[]>;

  gantiSandi(
    p: MitraPrincipal,
    input: { sandiLama: string; sandiBaru: string; ip: string | null; userAgent: string | null },
  ): Promise<void>;

  // --- staff side --------------------------------------------------------
  buatAkun(
    input: BuatAkunInput,
    ctx: { userId: string; bumnId: string; permissions: readonly string[]; cabangDalamScope?: readonly string[] },
  ): Promise<HasilBuatAkun>;
  setAktifAkun(
    mitraId: string,
    aktif: boolean,
    ctx: { userId: string; bumnId: string; permissions: readonly string[]; cabangDalamScope?: readonly string[] },
  ): Promise<{ mitraId: string; aktif: boolean }>;
}
