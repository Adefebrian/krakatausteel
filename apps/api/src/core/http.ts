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
 * The app-wide error handler. Registered once in core/app.ts.
 *
 * Order matters: AppError first (the intentional path), then database guards,
 * then Hono's own HTTPException, then a genuine 500 with nothing leaked.
 */
export const errorHandler: ErrorHandler = (err, c: Context) => {
  if (err instanceof AppError) {
    return c.json(err.toBody(), err.status as 400);
  }
  const mapped = mapDatabaseError(err);
  if (mapped) {
    // Logged because a guard firing means the service-layer mirror let
    // something through, which is a bug worth seeing even though the response
    // is a clean 409.
    console.error(`[db-guard] ${c.req.method} ${c.req.path}:`, err);
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
