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
  | "KESALAHAN_SERVER";

const STATUS_BY_CODE: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 429 | 500> = {
  VALIDASI: 400,
  TIDAK_TERAUTENTIKASI: 401,
  TIDAK_BERWENANG: 403,
  TIDAK_DITEMUKAN: 404,
  KONFLIK: 409,
  SEGREGASI_TUGAS: 409,
  TERLALU_BANYAK_PERMINTAAN: 429,
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
 * guarantees: `name` plus a string `kode`. Any later engine that follows the
 * same convention is handled without touching this file.
 */
interface ErrorBerkode extends Error {
  kode: string;
  detail?: Record<string, unknown>;
  penyebabDb?: string;
}

const NAMA_ERROR_BERKODE = new Set(["JurnalError"]);

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
  async function catatPenolakan(c: Context, error: AppError): Promise<unknown> {
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
        keterangan: `${error.code}: ${error.message}`,
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
