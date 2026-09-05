// Shared HTTP error taxonomy and the single error handler for the whole app.
//
// WHY THIS IS CENTRAL
// ADR 0002 puts the accounting invariants in Postgres triggers, each raising a
// message prefixed with a stable code (TJSL-SOD-001, TJSL-JRN-031, ...). A
// service that lets those bubble up untouched gives the SPA a 500 and a wall
// of plpgsql. The mapping from "database refused" to "409 with a sentence a
// finance user can act on" belongs in one place, so every phase inherits it
// instead of re-deriving it per route.
//
// Nothing here formats a stack trace into a response body: the client gets a
// code plus an Indonesian message, the detail goes to the server log.
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export type ErrorCode =
  | "VALIDASI"
  | "TIDAK_TERAUTENTIKASI"
  | "TIDAK_BERWENANG"
  | "TIDAK_DITEMUKAN"
  | "KONFLIK"
  | "SEGREGASI_TUGAS"
  | "TERLALU_BANYAK_PERMINTAAN"
  // A capability THIS DEPLOYMENT does not have, as opposed to a request this
  // system refuses. Added with the report export: a host with no browser
  // binary cannot produce a server-side PDF, and every existing code lies
  // about it -- 500 sends somebody hunting a bug in the report, 409 claims a
  // state conflict that does not exist, 404 claims the report is not there.
  // 503 is the honest answer, and the message carries the operator's actual
  // next step.
  | "LAYANAN_TIDAK_TERSEDIA"
  | "KESALAHAN_SERVER";

const STATUS_BY_CODE: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503> = {
  VALIDASI: 400,
  TIDAK_TERAUTENTIKASI: 401,
  TIDAK_BERWENANG: 403,
  TIDAK_DITEMUKAN: 404,
  KONFLIK: 409,
  SEGREGASI_TUGAS: 409,
  TERLALU_BANYAK_PERMINTAAN: 429,
  LAYANAN_TIDAK_TERSEDIA: 503,
  KESALAHAN_SERVER: 500,
};

export interface AppErrorBody {
  error: string;
  code: ErrorCode;
  /** Field-level detail for VALIDASI, keyed by field path. */
  detail?: Record<string, string[]> | undefined;
}

/** Domain error with an HTTP meaning. Services throw these, routes never catch them. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail?: Record<string, string[]> | undefined;

  constructor(code: ErrorCode, message: string, detail?: Record<string, string[]>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  toBody(): AppErrorBody {
    return { error: this.message, code: this.code, detail: this.detail };
  }
}

export const badRequest = (message: string, detail?: Record<string, string[]>): AppError =>
  new AppError("VALIDASI", message, detail);
export const unauthenticated = (message = "Sesi tidak valid"): AppError =>
  new AppError("TIDAK_TERAUTENTIKASI", message);
export const forbidden = (message = "Akses ditolak"): AppError =>
  new AppError("TIDAK_BERWENANG", message);
export const notFound = (message = "Data tidak ditemukan"): AppError =>
  new AppError("TIDAK_DITEMUKAN", message);
export const conflict = (message: string): AppError => new AppError("KONFLIK", message);
export const segregationOfDuties = (message: string): AppError =>
  new AppError("SEGREGASI_TUGAS", message);

/**
 * Database guard codes that mean "a business rule refused this", not "the
 * server broke". Each maps to 409 with the trigger's own message, which is
 * already written in Indonesian for the operator (ADR 0002).
 *
 * The service layer mirrors every one of these rules so the normal path never
 * reaches the trigger; this is the safety net for the paths it misses (a bulk
 * import, a concurrent race that slips past a read-then-write check).
 */
const DB_GUARD_RE = /TJSL-([A-Z]{3})-(\d{3}):\s*(.*)$/;

export function mapDatabaseError(err: unknown): AppError | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const match = DB_GUARD_RE.exec(message);
  if (match) {
    const [, group, , text] = match;
    const clean = (text ?? "").trim();
    return group === "SOD"
      ? segregationOfDuties(clean)
      : new AppError("KONFLIK", clean.length > 0 ? clean : message);
  }
  // Postgres SQLSTATEs worth translating rather than reporting as a 500.
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "23505": // unique_violation
      return conflict("Data dengan kunci yang sama sudah ada");
    case "23503": // foreign_key_violation
      return badRequest("Referensi data tidak valid");
    case "23514": // check_violation
      return badRequest("Nilai yang dikirim melanggar aturan validasi data");
    case "22P02": // invalid_text_representation, e.g. a non-UUID in a UUID column
      return badRequest("Format identitas tidak valid");
    default:
      return null;
  }
}

/**
 * A domain error carrying its own stable code, recognised STRUCTURALLY rather
 * than by class.
 *
 * The journal engine throws `JurnalError` (modules/jurnal/contract.ts), which
 * is not an `AppError`: it has a `kode` and no HTTP status, because the ledger
 * rules it names are older than any transport. Importing the class here would
 * point core/ at a module and close a cycle (core/http -> modules/jurnal ->
 * modules/auth -> core/http), so this matches on the shape the class
 * guarantees: `name` plus a string `kode`.
 *
 * `AngsuranError`, `PumkError` and `NonPumkError` follow the same convention
 * deliberately (each says so in its own file), and they are LISTED here rather than
 * matched by duck typing alone: an allowlist of names is what keeps an
 * unrelated library error that happens to carry a `kode` field from being
 * reported to a caller as a business refusal. Adding an engine is one line,
 * and forgetting it is visible immediately -- until modules/pumk was listed,
 * every branch-scope refusal it raised left the handler as an anonymous 500
 * with no code and no audit row.
 */
interface ErrorBerkode extends Error {
  kode: string;
  detail?: Record<string, unknown>;
  penyebabDb?: string;
}

export const NAMA_ERROR_BERKODE: ReadonlySet<string> = new Set([
  "JurnalError",
  "AngsuranError",
  "PumkError",
  "NonPumkError",
  // Fase 6. Both were absent when their routers landed, which is the exact
  // failure this list's comment above describes: every RKA scope refusal and
  // every report refusal left the handler as an anonymous 500 with no
  // `kodeDomain` and, worse, with no DITOLAK row in `audit_log`, because
  // `catatPenolakan` only runs for an error the handler can classify. Spec 16
  // scenario 24 was therefore passing on the engine and unenforced over HTTP.
  "RkaError",
  "LaporanError",
  // Fase 5's engine, whose routes landed last. THE THIRD TIME this omission
  // happened, which is why the set is now EXPORTED: three occurrences is a
  // structural trap, not bad luck. `modules/closing/closing-rute-kesalahan.test.ts`
  // sweeps every `export class *Error` under apps/api/src/modules and fails if
  // one is missing from here, so the fourth module cannot repeat it silently.
  "ClosingError",
  // Fase 7, listed WITH their routers rather than after them.
  "ToolsError",
  "DashboardError",
  // Fase 7, the public surface. Listed WITH their routers, and it matters more
  // here than anywhere else: an unregistered error class on an
  // UNAUTHENTICATED route would answer the internet with a bare 500 and leave
  // no DITOLAK row for the attempt that caused it.
  "PortalError",
  "MitraError",
  "ImporError",
]);

function errorBerkode(err: unknown): ErrorBerkode | null {
  if (!(err instanceof Error) || !NAMA_ERROR_BERKODE.has(err.name)) return null;
  const kode = (err as { kode?: unknown }).kode;
  return typeof kode === "string" ? (err as ErrorBerkode) : null;
}

/**
 * Domain code -> HTTP taxonomy. Anything absent is a validation refusal (400),
 * which is the right default: the codes are mostly spec 6.2 validations, and a
 * new one appearing as a 400 with its own message is a far better failure than
 * a 500 that discards it.
 */
const KODE_KE_HTTP: Readonly<Record<string, ErrorCode>> = {
  TIDAK_BERWENANG: "TIDAK_BERWENANG",
  // Spec 2 rule 3 / spec 16 scenario 24. A row in another branch is a
  // REFUSAL, not a bad request: it must be a 403 so the error handler writes
  // the DITOLAK audit row that spec 2 rule 5 requires.
  CABANG_DILUAR_SCOPE: "TIDAK_BERWENANG",
  // The operation names a permission the catalogue does not know, so no role
  // could hold it. Fail closed, and let the audit row carry the reason.
  IZIN_BELUM_TERDAFTAR: "TIDAK_BERWENANG",
  MAKER_TIDAK_BOLEH_CHECKER: "SEGREGASI_TUGAS",
  JURNAL_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  // State conflicts: the request was well formed, the ledger simply refuses it
  // in its current state, and a retry with the same body would refuse again.
  JURNAL_TIDAK_DRAFT: "KONFLIK",
  JURNAL_BELUM_POSTED: "KONFLIK",
  JURNAL_SUDAH_REVERSED: "KONFLIK",
  POSTING_BENTROK: "KONFLIK",
  BATCH_GAGAL: "KONFLIK",
  PERIODE_TIDAK_OPEN: "KONFLIK",
  TIDAK_ADA_PERIODE_OPEN: "KONFLIK",
  NOMOR_JURNAL_DUPLIKAT: "KONFLIK",
  JURNAL_IDEMPOTENSI_DUPLIKAT: "KONFLIK",
  PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR: "KONFLIK",
  EVENT_MAPPING_TIDAK_DITEMUKAN: "KONFLIK",

  // --- modules/angsuran (spec 7) and modules/pumk (spec 9.1) ---------------
  //
  // Everything absent from this table is a 400, which is the right default for
  // the input validations both engines are mostly made of. Listed here are
  // only the codes where 400 would be a LIE: a lookup that found nothing, a
  // segregation refusal, and a state the ledger simply will not leave.
  PROPOSAL_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  MITRA_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  AKAD_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  SEKTOR_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  CLUSTER_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  SUBMISSION_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  JADWAL_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  RESCHEDULE_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  PRESET_ALOKASI_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",

  // --- modules/nonpumk (spec 9.2) -----------------------------------------
  //
  // Same rule as above: everything absent is a 400, and only the codes where
  // 400 would be a LIE are listed. A lookup that found nothing is not a
  // malformed request, and a grant whose staging is already closed will refuse
  // the identical body again however it is rewritten.
  BIDANG_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  SDG_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  PENYALURAN_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  LPJ_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  // The proposal has no approved amount yet, so there is no ceiling to
  // disburse against: a state problem, not a body problem.
  BELUM_DISETUJUI: "KONFLIK",
  TERMIN_SUDAH_ADA: "KONFLIK",
  LPJ_SUDAH_DIAJUKAN: "KONFLIK",
  LPJ_BELUM_DIAJUKAN: "KONFLIK",
  // Refused AHEAD of the deferred TJSL-NPK-002 and BEFORE the ledger is
  // called. A 409 rather than a 400 because whether the same termin is
  // acceptable depends on what has already gone out, not on how it was typed.
  PLAFON_PENYALURAN_TERLAMPAUI: "KONFLIK",

  // --- modules/rka (spec 9.3, spec 10.3 report 24) -------------------------
  //
  // Same rule again: absent means 400, and only the codes where 400 would be a
  // LIE are listed. An approved baseline that cannot be edited will refuse the
  // identical body however it is rewritten, and a scope with no approved
  // version is a missing DOCUMENT rather than a malformed request.
  RKA_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  VERSI_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  BASELINE_TIDAK_ADA: "TIDAK_DITEMUKAN",
  PERIODE_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  AKUN_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  RKA_SUDAH_DISETUJUI: "KONFLIK",
  RKA_BUKAN_DRAFT: "KONFLIK",
  REVISI_HARUS_DARI_DISETUJUI: "KONFLIK",
  REVISI_MASIH_TERBUKA: "KONFLIK",
  VERSI_GANDA: "KONFLIK",
  BASELINE_GANDA: "KONFLIK",
  // Fail-closed refusals about the SYSTEM's readiness, never about the body:
  // a closed period with no frozen figure to read the realisation from, and a
  // dimension the frozen table does not carry at all.
  SKEMA_BELUM_LENGKAP: "KONFLIK",
  SALDO_PERIODE_TIDAK_ADA: "KONFLIK",
  // Spec 2's segregation, applied to the budget through the configurable
  // `rka.pemisahan_tugas_persetujuan`.
  KONFLIK_MAKER_APPROVER: "SEGREGASI_TUGAS",

  // --- modules/laporan (spec 10.3 reports 16 to 20, 22, 23) ----------------
  //
  // Every one of these is the report REFUSING TO PRINT rather than the caller
  // mistyping a filter, so 400 would put the blame in the wrong place and send
  // an accountant looking for a field to correct. They are the fail-closed
  // refusals the module exists to make: a template nobody configured, an
  // account that maps onto no line, a cash movement with no classification, a
  // closed period whose balances were never frozen, and a statement that does
  // not add up.
  CABANG_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  TEMPLATE_LAPORAN_KOSONG: "KONFLIK",
  TEMPLATE_LAPORAN_TIDAK_VALID: "KONFLIK",
  AKUN_TIDAK_TERPETAKAN: "KONFLIK",
  KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP: "KONFLIK",
  SEKSI_ASET_NETO_TIDAK_DIKENAL: "KONFLIK",
  SALDO_PERIODE_BELUM_DIBEKUKAN: "KONFLIK",
  // The same shape one table over: the period exists, the request is well
  // formed, and Closing Kolektibilitas simply has not run for it yet. A retry
  // with the same query refuses again until somebody runs the step, which is
  // what KONFLIK means here and why it is not a 400.
  SNAPSHOT_KOLEKTIBILITAS_BELUM_ADA: "KONFLIK",
  LAPORAN_TIDAK_BALANCE: "KONFLIK",
  // modules/laporan/ekspor.ts. A bad `format` or an unknown report code is a
  // VALIDASI by the default rule and needs no row; these two do.
  EKSPOR_PDF_TIDAK_TERSEDIA: "LAYANAN_TIDAK_TERSEDIA",
  EKSPOR_PDF_GAGAL: "LAYANAN_TIDAK_TERSEDIA",

  // --- modules/closing (spec 8) -------------------------------------------
  //
  // Same rule as everywhere above: absent means 400, and only the codes where
  // 400 would be a LIE are listed. `ALASAN_WAJIB`, `NILAI_BUKAN_DESIMAL` and
  // `TANGGAL_TIDAK_VALID` are deliberately absent -- each of those IS a problem
  // with the body, and the caller fixes it by rewriting the request.
  //
  // Everything below is the opposite: the request was well formed and the
  // LEDGER'S STATE refuses it, so an identical retry refuses identically. That
  // difference is what an accountant reads off the status code: 400 means "fix
  // the form", 409 means "fix the books".
  PERIODE_SUDAH_CLOSED: "KONFLIK",
  PERIODE_BELUM_CLOSED: "KONFLIK",
  URUTAN_PERIODE: "KONFLIK",
  REOPEN_BUKAN_PERIODE_TERAKHIR: "KONFLIK",
  REOPEN_TIDAK_DIIZINKAN: "KONFLIK",
  // The ten-item checklist of spec 8.4 refused the close. `detail.gagal`
  // carries every failing check with its number and a readable reason, which is
  // the whole product of the refusal (spec 16 scenario 12).
  PRASYARAT_GAGAL: "KONFLIK",
  // Check 8 stands unconfirmed. A 409 rather than a 400 because whether the
  // confirmation is required at all depends on the cash balance, not on how the
  // body was typed.
  KONFIRMASI_KAS_NEGATIF_WAJIB: "KONFLIK",
  KOLEKTIBILITAS_BELUM_DIJALANKAN: "KONFLIK",
  // Fail-closed refusals about the SYSTEM's readiness, never about the body: a
  // day count no configured band covers, two bands that overlap, a class with
  // no rate, and not enough history for the collective mode. Defaulting any of
  // them would silently under-provision the whole portfolio.
  RANGE_KOLEKTIBILITAS_TIDAK_LENGKAP: "KONFLIK",
  RANGE_KOLEKTIBILITAS_TUMPANG_TINDIH: "KONFLIK",
  RATE_PENYISIHAN_TIDAK_ADA: "KONFLIK",
  HISTORI_TIDAK_CUKUP: "KONFLIK",

  // Spec 2 rules 1 and 2, ahead of TJSL-SOD-001 / TJSL-SOD-002.
  KONFLIK_MAKER_CHECKER: "SEGREGASI_TUGAS",
  KONFLIK_CHECKER_APPROVER: "SEGREGASI_TUGAS",
  APPROVER_TIDAK_BOLEH_MAKER: "SEGREGASI_TUGAS",

  // State conflicts: well formed, refused in the current state, and a retry
  // with the same body would be refused again.
  TRANSISI_TIDAK_VALID: "KONFLIK",
  STATUS_TERMINAL: "KONFLIK",
  MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF: "KONFLIK",
  SURVEY_SUDAH_ADA: "KONFLIK",
  SURVEY_BELUM_ADA: "KONFLIK",
  AKAD_SUDAH_ADA: "KONFLIK",
  JADWAL_BELUM_SIAP: "KONFLIK",
  JADWAL_SUDAH_ADA: "KONFLIK",
  JADWAL_IMMUTABLE: "KONFLIK",
  PENCAIRAN_SUDAH_ADA: "KONFLIK",
  PENGAKHIRAN_SUDAH_ADA: "KONFLIK",
  AKAD_TIDAK_BISA_DIAKHIRI: "KONFLIK",
  AKAD_TIDAK_BISA_DIANGSUR: "KONFLIK",
  MITRA_SUDAH_DI_CLUSTER: "KONFLIK",
  MITRA_BUKAN_ANGGOTA_CLUSTER: "KONFLIK",
  SUBMISSION_SUDAH_DIKONVERSI: "KONFLIK",
  RESCHEDULE_SUDAH_DIPROSES: "KONFLIK",
  RESCHEDULE_BELUM_DISETUJUI: "KONFLIK",
  OUTSTANDING_NEGATIF: "KONFLIK",
  TOTAL_POKOK_TIDAK_COCOK: "KONFLIK",
  // migrations/0030: jasa already accrued into Piutang Jasa Administrasi does
  // not fit on the rows it has to move to. The request is well formed and the
  // refusal is about ledger state, so KONFLIK and never a 400.
  AKRUAL_TIDAK_TERTAMPUNG: "KONFLIK",

  // A collaborating engine refused, so nothing was written. The caller cannot
  // fix the body; the state has to change first.
  JADWAL_GAGAL: "KONFLIK",
  SETORAN_GAGAL: "KONFLIK",
  JURNAL_GAGAL: "KONFLIK",

  // Fail-closed refusals: an undecided policy or a missing sanctioned event
  // mapping. Never a 400, because the request was fine and the SYSTEM is the
  // one that is not ready.
  EVENT_MAPPING_BELUM_ADA: "KONFLIK",
  KEBIJAKAN_BELUM_DIPUTUSKAN: "KONFLIK",
  BASIS_EKUIVALENSI_BELUM_DIPUTUSKAN: "KONFLIK",
  KONFIGURASI_TIDAK_ADA: "KONFLIK",
  KONFIGURASI_TIDAK_VALID: "KONFLIK",

  // --- modules/tools (spec 9.6) and modules/dashboard (spec 11) ------------
  //
  // Same rule as everywhere above: absent means 400, which is right for
  // `PEMERIKSAAN_TIDAK_DIKENAL` (a check code that is not in the catalogue is
  // a malformed path) and for `RINCIAN_TIDAK_DIKENAL` (a drill-down key the
  // dashboard never emitted). Listed here are only the
  // codes where 400 would be a LIE: the SYSTEM is not ready, and no rewriting
  // of the request will help.
  //
  // `MAPPING_PIUTANG_TIDAK_ADA` is the reconciliation refusing to run because
  // `event_jurnal_mapping` names no receivable account. Answering it with
  // zeroes would report "no difference" when the truth is "nothing was
  // compared", which is the one wrong answer an operator would act on.
  MAPPING_PIUTANG_TIDAK_ADA: "KONFLIK",
  PERIODE_TIDAK_ADA: "TIDAK_DITEMUKAN",

  // --- modules/portal (spec 9.5), the PUBLIC surface -----------------------
  //
  // Same rule as everywhere above: absent means 400, which is right for
  // `FORMULIR_TIDAK_VALID` and `PEMERIKSA_WAJIB` (both are problems with the
  // body, fixed by rewriting the form).
  //
  // `TIKET_ATAU_PEMERIKSA_SALAH` IS A 404 ON PURPOSE, AND IT IS THE ONLY
  // ANSWER A FAILED STATUS CHECK GETS. Unknown ticket, wrong NIK, wrong date
  // of birth: one code, one message, one status. A 401 for "wrong verifier"
  // and a 404 for "no such ticket" would turn the endpoint into an oracle for
  // whether an application exists, which is exactly the question the check is
  // supposed to protect.
  TIKET_ATAU_PEMERIKSA_SALAH: "TIDAK_DITEMUKAN",
  ENTITAS_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",
  TERLALU_BANYAK_PENGAJUAN: "TERLALU_BANYAK_PERMINTAAN",
  TERLALU_BANYAK_PERCOBAAN: "TERLALU_BANYAK_PERMINTAAN",
  STATUS_TIDAK_BISA_DIUBAH: "KONFLIK",

  // --- modules/mitra (spec 4.9), the SECOND PRINCIPAL ----------------------
  //
  // `KREDENSIAL_MITRA_SALAH` and `SESI_MITRA_TIDAK_VALID` are 401s so the
  // error handler writes the DITOLAK row spec 2 rule 5 requires for an
  // authentication refusal; `WAJIB_GANTI_SANDI` is a 403 for the same reason,
  // because a session that is being held back from the rest of the portal is
  // an authorisation decision worth having in the trail.
  //
  // `AKAD_TIDAK_DITEMUKAN` is a 404 and is deliberately the ONLY answer for an
  // akad that belongs to another mitra. A 403 there would confirm that the id
  // names a real contract, which is the enumeration this module exists to
  // prevent.
  KREDENSIAL_MITRA_SALAH: "TIDAK_TERAUTENTIKASI",
  SESI_MITRA_TIDAK_VALID: "TIDAK_TERAUTENTIKASI",
  WAJIB_GANTI_SANDI: "TIDAK_BERWENANG",
  TERLALU_BANYAK_PERCOBAAN_MASUK: "TERLALU_BANYAK_PERMINTAAN",
  AKUN_MITRA_SUDAH_ADA: "KONFLIK",
  AKUN_MITRA_TIDAK_DITEMUKAN: "TIDAK_DITEMUKAN",

  // --- modules/impor (spec 9.6) -------------------------------------------
  //
  // Absent means 400, which is right for every "fix the file" refusal:
  // `BERKAS_KOSONG`, `BERKAS_TERLALU_BESAR`, `TERLALU_BANYAK_BARIS`,
  // `HEADER_TIDAK_LENGKAP`, `JENIS_TIDAK_DIKENAL`, and `ADA_BARIS_DITOLAK`
  // (whose `detail.ditolak` carries every rejection with its line number, and
  // which is the whole product of the refusal).
  //
  // The one listed here is the one where 400 would be a LIE: the file is
  // perfectly well formed and has simply already been imported, so an
  // identical retry refuses identically.
  BERKAS_SUDAH_DIIMPOR: "KONFLIK",
};

/**
 * Context flag: "a DITOLAK row for this request has already been written".
 *
 * Set by the guard chain (modules/auth/guards.ts `denied`), read by the error
 * handler below. Without it, a permission refusal would be logged twice; with
 * it, the handler only fills the gaps.
 */
export const DENIAL_LOGGED_VAR = "denialLogged";

export function markDenialLogged(c: Context): void {
  c.set(DENIAL_LOGGED_VAR as never, true as never);
}

export function denialAlreadyLogged(c: Context): boolean {
  return c.get(DENIAL_LOGGED_VAR as never) === true;
}

/**
 * The minimum this file needs of the audit service, so core/ does not depend on
 * a module. `modules/audit`'s service satisfies it structurally.
 */
export interface DenialAuditSink {
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
  }): Promise<string>;
}

export interface ErrorHandlerDeps {
  audit?: DenialAuditSink;
  /** Resolves the acting user id and client facts for an audit row. */
  actor?: (c: Context) => { userId: string | null; ip: string | null; userAgent: string | null };
}

/**
 * Builds the app-wide error handler. Registered once in core/app.ts.
 *
 * Order matters: AppError first (the intentional path), then coded domain
 * errors, then database guards, then Hono's own HTTPException, then a genuine
 * 500 with nothing leaked.
 *
 * WHY AUTHORISATION REFUSALS ARE LOGGED HERE AND NOT ONLY IN THE GUARD
 * Spec 2 rule 5 requires every authorisation denial to reach `audit_log`, and
 * the guard chain only sees the denials it makes itself. The ones it never
 * sees are the branch-scope refusals, which are thrown from a SERVICE
 * (`assertCabangAllowed`) after the guard has already let the request through
 * on permissions. Those are precisely the denials spec 16 scenario 24 exists
 * to prove, and they were leaving no trace at all.
 *
 * Doing it in the error handler covers them, covers the Origin refusal, and
 * covers every 403 a later phase throws from anywhere, without each service
 * having to remember. `DENIAL_LOGGED_VAR` keeps the guard's own rows from
 * being duplicated.
 */
export function createErrorHandler(deps: ErrorHandlerDeps = {}): ErrorHandler {
  const { audit, actor } = deps;

  /** Returns null when the row was written (or was not needed), else the failure. */
  async function catatPenolakan(
    c: Context,
    error: { code: ErrorCode; message: string },
    kodeDomain?: string,
  ): Promise<unknown> {
    if (!audit) return null;
    if (error.code !== "TIDAK_BERWENANG" && error.code !== "TIDAK_TERAUTENTIKASI") return null;
    if (denialAlreadyLogged(c)) return null;
    const who = actor?.(c) ?? { userId: null, ip: null, userAgent: null };
    try {
      await audit.record({
        ...who,
        aksi: "auth.otorisasi",
        entitas: "sesi",
        entitasId: who.userId,
        nilaiBaru: { metode: c.req.method, path: c.req.path },
        hasil: "DITOLAK",
        keterangan: `${kodeDomain ?? error.code}: ${error.message}`,
      });
      markDenialLogged(c);
      return null;
    } catch (gagal) {
      return gagal;
    }
  }

  const handler: ErrorHandler = async (err, c: Context) => {
    if (err instanceof AppError) {
      const gagalAudit = await catatPenolakan(c, err);
      if (gagalAudit) {
        // An unrecorded denial is the failure this exists to prevent, so it
        // becomes a visible 500 rather than a quiet 403 with no evidence.
        console.error(`[audit-gagal] ${c.req.method} ${c.req.path}:`, gagalAudit);
        return c.json(
          { error: "Terjadi kesalahan pada server", code: "KESALAHAN_SERVER" as const },
          500,
        );
      }
      return c.json(err.toBody(), err.status as 400);
    }

    // A DENIAL FROM AN ENGINE IS STILL A DENIAL (spec 2 rule 5).
    //
    // The branch-scope refusals of spec 16 scenario 24 are thrown by a SERVICE
    // as a coded domain error (`PumkError` with `CABANG_DILUAR_SCOPE`), not as
    // an `AppError`, so before this branch existed they took the untouched
    // path below and left NO audit_log row at all. Precisely the denials the
    // rule cares about were the ones going unrecorded, and the 403 looked
    // identical from the outside either way.
    const berkode = errorBerkode(err);
    if (berkode) {
      const code = KODE_KE_HTTP[berkode.kode] ?? "VALIDASI";
      const gagalAudit = await catatPenolakan(
        c,
        { code, message: berkode.message },
        berkode.kode,
      );
      if (gagalAudit) {
        console.error(`[audit-gagal] ${c.req.method} ${c.req.path}:`, gagalAudit);
        return c.json(
          { error: "Terjadi kesalahan pada server", code: "KESALAHAN_SERVER" as const },
          500,
        );
      }
    }
    return handleTanpaAudit(err, c);
  };
  return handler;
}

/** Everything that is not an AppError. Split out to keep the handler readable. */
const handleTanpaAudit: ErrorHandler = (err, c: Context) => {
  const berkode = errorBerkode(err);
  if (berkode) {
    const code = KODE_KE_HTTP[berkode.kode] ?? "VALIDASI";
    const status = STATUS_BY_CODE[code];
    // `penyebabDb` is where the engine parks the raw trigger/driver text. It
    // belongs in the log and NOWHERE ELSE: the whole point of the domain error
    // is that the caller never sees a constraint name.
    if (berkode.penyebabDb) {
      console.error(
        `[domain-db] ${c.req.method} ${c.req.path}: ${berkode.kode} <- ${berkode.penyebabDb}`,
      );
    } else if (status >= 500) {
      console.error(`[domain] ${c.req.method} ${c.req.path}: ${berkode.kode}`, err);
    } else {
      console.warn(`[domain] ${c.req.method} ${c.req.path}: ${berkode.kode} ${berkode.message}`);
    }
    // `kodeDomain` is additive: `code` stays the HTTP taxonomy every client
    // already branches on, and the precise ledger reason travels beside it
    // instead of being flattened away.
    return c.json(
      { error: berkode.message, code, kodeDomain: berkode.kode },
      status as 400,
    );
  }
  const mapped = mapDatabaseError(err);
  if (mapped) {
    if (mapped.status >= 500 || mapped.code === "KONFLIK" || mapped.code === "SEGREGASI_TUGAS") {
      // A guard firing means the service-layer mirror let something through,
      // which is a bug worth the full stack even though the response is a
      // clean 409.
      console.error(`[db-guard] ${c.req.method} ${c.req.path}:`, err);
    } else {
      // Client-caused (a malformed id in the URL, a bad enum value). One line:
      // logging a whole pg error object per bad request is how a log becomes
      // unreadable during an incident.
      console.warn(
        `[db-input] ${c.req.method} ${c.req.path}: ${(err as { code?: string }).code ?? "?"} ${mapped.message}`,
      );
    }
    return c.json(mapped.toBody(), mapped.status as 409);
  }
  if (err instanceof HTTPException) {
    return c.json(
      { error: err.message, code: err.status === 404 ? "TIDAK_DITEMUKAN" : "KESALAHAN_SERVER" },
      err.status,
    );
  }
  console.error(`[unhandled] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: "Terjadi kesalahan pada server", code: "KESALAHAN_SERVER" as const }, 500);
};

/**
 * The handler with no audit sink attached. Kept for a caller that has no audit
 * service to hand (a unit test of the mapping); the app always uses
 * `createErrorHandler({ audit, actor })`, because a 403 that writes no
 * `audit_log` row violates spec 2 rule 5.
 */
export const errorHandler: ErrorHandler = createErrorHandler();
