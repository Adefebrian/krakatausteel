// Thin auth client. The only network module the Fase 0 UI has.
//
// Contract with apps/api (owned by another agent, not yet shipped):
//
//   POST /auth/login    { username, password }  -> 200 Session | 401
//   GET  /auth/session                          -> 200 Session | 401
//   POST /auth/logout                           -> 204
//
// Session is the shape below. `permissions` is authoritative: the UI never
// derives permissions from the role name, it reads the array the server sends.
//
// While /auth/* does not exist, the DEMO STUB at the bottom of this file
// answers instead, and only on localhost. Deleting the one marked block turns
// this module into a plain fetch client with no fallback left behind.
import { PERMISSIONS_BY_ROLE, type Role } from "../permissions";

export interface SessionUser {
  id: string;
  username: string;
  nama: string;
  role: Role;
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
  /** True while the demo stub is answering instead of the API. */
  demo?: boolean;
}

/** Thrown on a 401. The UI must show the login screen, never a fake session. */
export class UnauthorizedError extends Error {
  constructor(message = "Sesi tidak valid") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Thrown when the API could not be reached at all. */
export class ApiUnreachableError extends Error {
  constructor(message = "Server tidak dapat dihubungi") {
    super(message);
    this.name = "ApiUnreachableError";
  }
}

// Same origin by default, so the app works on whatever port it is served
// from. Override by setting `globalThis.__TJSL_API_BASE__` before the bundle
// runs, for a deployment where the API sits on another host.
const API_BASE =
  (globalThis as { __TJSL_API_BASE__?: string }).__TJSL_API_BASE__ ??
  globalThis.location?.origin ??
  "";

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiUnreachableError();
  }
}

/**
 * True when the response is not the JSON the auth contract promises, which is
 * how "the endpoint does not exist yet" actually shows up in development: the
 * SPA server answers any unmatched path with index.html and a 200, so the
 * status code alone does not reveal a missing route.
 */
function isMissingEndpoint(res: Response): boolean {
  if (res.status === 404) return true;
  const type = res.headers.get("content-type") ?? "";
  return !type.includes("json");
}

export async function fetchSession(): Promise<Session> {
  let res: Response;
  try {
    res = await request("/auth/session");
  } catch (error) {
    const stub = stubSessionFromStorage();
    if (stub) return stub;
    throw error;
  }

  // A 401 is a real answer: the user is not signed in. Never substitute a stub
  // session for it, that would mean faking a login the server refused.
  if (res.status === 401) throw new UnauthorizedError();

  if (isMissingEndpoint(res)) {
    const stub = stubSessionFromStorage();
    if (stub) return stub;
    // No endpoint and no demo session: the honest state is "not signed in".
    throw new UnauthorizedError();
  }

  if (!res.ok) throw new ApiUnreachableError(`Gagal memuat sesi (${res.status})`);
  return (await res.json()) as Session;
}

export async function login(username: string, password: string): Promise<Session> {
  let res: Response;
  try {
    res = await request("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return stubLogin(username, password);
  }

  if (res.status === 401) throw new UnauthorizedError("Nama pengguna atau kata sandi salah");
  if (isMissingEndpoint(res)) return stubLogin(username, password);
  if (!res.ok) throw new ApiUnreachableError(`Gagal masuk (${res.status})`);
  return (await res.json()) as Session;
}

export async function logout(): Promise<void> {
  clearStubSession();
  try {
    await request("/auth/logout", { method: "POST" });
  } catch {
    // Nothing to do: the local session is already cleared either way.
  }
}

// ===========================================================================
// DEMO STUB, DELETE THIS BLOCK WHEN apps/api SHIPS /auth/*
// ---------------------------------------------------------------------------
// It exists so Fase 0 UI is reviewable before the API lands, and it is fenced
// three ways so it can never stand in for real authentication:
//
//   1. It only answers when the endpoint is unreachable or does not answer with
//      JSON at all. A real 401 always surfaces as a failed login.
//   2. It only runs on localhost, so a deployed build has no stub path at all.
//   3. Every session it mints carries `demo: true`, and the shell renders a
//      visible "Mode demo" marker whenever that flag is set.
//
// Removing this block leaves the fetch client above with no fallback.
// ===========================================================================

const STUB_STORAGE_KEY = "tjsl.demo.session";

const STUB_CABANG: readonly SessionCabang[] = [
  { id: "cbg-pusat", kode: "00", nama: "Kantor Pusat" },
  { id: "cbg-clg", kode: "01", nama: "Cabang Cilegon" },
  { id: "cbg-srg", kode: "02", nama: "Cabang Serang" },
];

/** Demo accounts, one per role, so nav filtering can be reviewed per role. */
const STUB_USERS: readonly { username: string; nama: string; role: Role; cabang: string }[] = [
  { username: "maker", nama: "Pengguna Demo Maker", role: "MAKER", cabang: "cbg-clg" },
  { username: "checker", nama: "Pengguna Demo Checker", role: "CHECKER", cabang: "cbg-clg" },
  { username: "approver", nama: "Pengguna Demo Approver", role: "APPROVER", cabang: "cbg-clg" },
  {
    username: "admincabang",
    nama: "Pengguna Demo Admin Cabang",
    role: "ADMIN_CABANG",
    cabang: "cbg-clg",
  },
  {
    username: "adminpusat",
    nama: "Pengguna Demo Admin Pusat",
    role: "ADMIN_PUSAT",
    cabang: "cbg-pusat",
  },
  { username: "auditor", nama: "Pengguna Demo Auditor", role: "AUDITOR", cabang: "cbg-pusat" },
];

export const DEMO_USERNAMES = STUB_USERS.map((user) => user.username);

function stubAllowed(): boolean {
  const host = globalThis.location?.hostname ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "" || host === "[::1]";
}

function buildStubSession(user: (typeof STUB_USERS)[number]): Session {
  const cabang = STUB_CABANG.find((entry) => entry.id === user.cabang) ?? STUB_CABANG[0];
  const lintas = user.role === "ADMIN_PUSAT" || user.role === "AUDITOR";
  const now = new Date();
  return {
    user: { id: `demo-${user.username}`, username: user.username, nama: user.nama, role: user.role },
    cabang,
    cabangTersedia: lintas ? STUB_CABANG : [cabang],
    periode: { tahun: now.getFullYear(), bulan: now.getMonth() + 1, status: "OPEN" },
    permissions: PERMISSIONS_BY_ROLE[user.role],
    demo: true,
  };
}

function stubLogin(username: string, password: string): Session {
  if (!stubAllowed()) throw new ApiUnreachableError();
  const user = STUB_USERS.find(
    (candidate) => candidate.username === username.trim().toLowerCase(),
  );
  if (!user || password.trim() === "") {
    throw new UnauthorizedError("Nama pengguna atau kata sandi salah");
  }
  const session = buildStubSession(user);
  try {
    globalThis.sessionStorage?.setItem(STUB_STORAGE_KEY, user.username);
  } catch {
    // sessionStorage unavailable, the demo session simply will not survive a
    // reload. Not worth failing the login over.
  }
  return session;
}

function stubSessionFromStorage(): Session | null {
  if (!stubAllowed()) return null;
  let username: string | null = null;
  try {
    username = globalThis.sessionStorage?.getItem(STUB_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!username) return null;
  const user = STUB_USERS.find((candidate) => candidate.username === username);
  return user ? buildStubSession(user) : null;
}

function clearStubSession(): void {
  try {
    globalThis.sessionStorage?.removeItem(STUB_STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}
