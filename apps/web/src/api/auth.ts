// Thin auth client. The only network module the Fase 0 UI has, and it has no
// fallback: every answer on this screen comes from apps/api.
//
// Contract with apps/api (apps/api/src/modules/auth/routes.ts):
//
//   POST /auth/login    { username, password }  -> 200 SessionPayload | 400 | 401 | 429
//   GET  /auth/session                          -> 200 SessionPayload | 401
//   POST /auth/logout                           -> 204 (also on an invalid cookie)
//
// The session lives in an HttpOnly SameSite=Lax cookie that this module can
// never read, so `credentials: "include"` is what carries it and there is no
// client side session state to go stale.
//
// `permissions` is authoritative: the UI never derives permissions from the
// role name, it reads the array the server sends.
//
// THREE OUTCOMES, NEVER CONFLATED
//   200  a session. Render the shell.
//   401  no session. Render the login screen ("silakan masuk").
//   anything else, including a thrown fetch, a 502 from the proxy, or a body
//        that is not JSON: the server could not answer. Render the retry
//        screen ("server tidak dapat dihubungi"). An accounting user has to be
//        able to tell "log in again" from "the server is down", so 401 maps to
//        UnauthorizedError and nothing else ever does.
import type { Role } from "../permissions";

export interface SessionUser {
  id: string;
  username: string;
  /** Primary role, for display. The permission array is what gates the UI. */
  role: Role | string;
  nama: string;
}

export interface SessionCabang {
  id: string;
  kode: string;
  nama: string;
}

export interface SessionPeriode {
  tahun: number;
  bulan: number;
  status: "OPEN" | "CLOSING_IN_PROGRESS" | "CLOSED";
}

export interface Session {
  user: SessionUser;
  cabang: SessionCabang;
  /** Cabang the user may switch between. One entry for a cabang scoped role. */
  cabangTersedia: readonly SessionCabang[];
  periode: SessionPeriode;
  permissions: readonly string[];
  /** Every role held. `user.role` is the primary one. */
  roles: readonly string[];
  readOnly: boolean;
  lintasCabang: boolean;
}

/** Thrown on a 401. The UI must show the login screen, never a fake session. */
export class UnauthorizedError extends Error {
  constructor(message = "Sesi tidak valid") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Thrown when the API could not be reached, or answered something else. */
export class ApiUnreachableError extends Error {
  constructor(message = "Server tidak dapat dihubungi") {
    super(message);
    this.name = "ApiUnreachableError";
  }
}

/** Thrown when the API refused the request for a reason the user can act on. */
export class ApiRequestError extends Error {
  readonly status: number;
  /**
   * The API's own JSON body, verbatim, when it sent one.
   *
   * IT IS CARRIED BECAUSE THREE REFUSALS ARE THE PRODUCT AND NOT THE FAILURE.
   * `core/http.ts` answers `{error, code, detail}` for a boundary validation,
   * where `detail` is keyed by field path and belongs on the field rather than
   * in a banner; it answers `{error, code, kodeDomain}` for a domain refusal,
   * where the code is what a form branches on to decide WHICH field to blame
   * (`KAS_BANK_TANPA_AKUN_KAS` is about the account picker, not about the
   * date); and `POST /impor/:jenis/komit` answers a 400 whose `laporan` field
   * carries every rejected row with its line number, which is the entire point
   * of the screen that asked.
   *
   * Flattening all three into one sentence, which is what `message` alone is,
   * throws the actionable half away. `message` still carries the server's
   * sentence, so nothing that ignores this field changes behaviour.
   */
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body ?? null;
  }
}

// The API sits behind the same origin under /api, both in production (Caddy
// strips the prefix, see infra/Caddyfile) and in development (apps/web/server.ts
// proxies the same prefix). One origin means the session cookie is a first
// party cookie and CORS never enters the picture. Override by setting
// `globalThis.__TJSL_API_BASE__` before the bundle runs for a deployment where
// the API sits on another host.
const API_BASE = (globalThis as { __TJSL_API_BASE__?: string }).__TJSL_API_BASE__ ?? "/api";

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    // DNS failure, connection refused, offline, TLS error. Not a credential
    // problem, so it must never surface as "please log in".
    throw new ApiUnreachableError();
  }
}

function isJson(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("json");
}

/** The API's error envelope, core/http.ts's `AppErrorBody`. */
async function messageOf(res: Response, fallback: string): Promise<string> {
  if (!isJson(res)) return fallback;
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() !== "" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Turn a 200 into a Session, or throw. A body that is not JSON means something
 * other than the API answered (a misconfigured proxy serving index.html, a
 * captive portal), which is an unreachable API, not a rejected login.
 */
async function readSession(res: Response): Promise<Session> {
  if (!isJson(res)) throw new ApiUnreachableError("Server tidak menjawab dengan data sesi");
  return (await res.json()) as Session;
}

export async function fetchSession(): Promise<Session> {
  const res = await request("/auth/session");
  // A 401 is a real answer: the user is not signed in. This is the ordinary
  // first load of the app, not an error worth a screen of its own.
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new ApiUnreachableError(await messageOf(res, `Gagal memuat sesi (${res.status})`));
  return readSession(res);
}

export async function login(username: string, password: string): Promise<Session> {
  const res = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

  if (res.status === 401) {
    throw new UnauthorizedError(await messageOf(res, "Nama pengguna atau kata sandi salah"));
  }
  // 400 validation and 429 rate limit both carry an Indonesian sentence the
  // user can act on, so pass the server's own wording through rather than
  // flattening them into "server tidak dapat dihubungi".
  if (res.status === 400 || res.status === 429 || res.status === 403) {
    throw new ApiRequestError(res.status, await messageOf(res, "Permintaan masuk ditolak"));
  }
  if (!res.ok) throw new ApiUnreachableError(await messageOf(res, `Gagal masuk (${res.status})`));
  return readSession(res);
}

/**
 * Ends the server side session. The API answers 204 even for an already
 * invalid cookie, and clears the cookie either way, so there is nothing to
 * retry and nothing left client side to clear.
 */
export async function logout(): Promise<void> {
  await request("/auth/logout", { method: "POST" });
}
