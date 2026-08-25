// The shared fetch helper every resource client in this folder is built on.
//
// It exists so the three outcomes ./auth.ts already separates stay separated
// for every other endpoint too, and so no page ever writes its own fetch:
//
//   200/204  the API answered. Return the parsed body.
//   401      the session is gone. Throw UnauthorizedError; ../session.tsx
//            turns that into the login screen, never into an error banner.
//   403      the permission or the branch scope refused. Throw ApiRequestError
//            with the server's own Indonesian sentence, because the user can
//            act on it (ask an admin, switch branch) and it is NOT a bug.
//   anything else, a non JSON body, or a thrown fetch: ApiRequestError or
//            ApiUnreachableError. The page renders ErrorState.
//
// A ROUTE THAT DOES NOT EXIST YET IS NOT A SPECIAL CASE. The PUMK module has
// no HTTP surface at the time these screens were written (see
// apps/api/src/modules/pumk/index.ts), so every call below currently comes
// back 404. That renders exactly the same honest failure as a database outage
// would, on purpose: this codebase does not carry a stub data path, because
// the last one hid two production bugs. A double may stand in for a failure,
// never for a validation.
import { ApiRequestError, ApiUnreachableError, UnauthorizedError } from "./auth";

const API_BASE = (globalThis as { __TJSL_API_BASE__?: string }).__TJSL_API_BASE__ ?? "/api";

export interface QueryParams {
  [key: string]: string | number | boolean | null | undefined;
}

/** Drops empty filters, so "semua sektor" does not become `sektorId=`. */
export function buildQuery(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered === "" ? "" : `?${rendered}`;
}

function isJson(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("json");
}

/** The API's error envelope, apps/api/src/core/http.ts's `AppErrorBody`. */
async function messageOf(res: Response, fallback: string): Promise<string> {
  if (!isJson(res)) return fallback;
  try {
    const body = (await res.json()) as { error?: unknown; kode?: unknown; code?: unknown };
    const kode = typeof body.kode === "string" ? body.kode : typeof body.code === "string" ? body.code : null;
    const pesan = typeof body.error === "string" && body.error.trim() !== "" ? body.error : fallback;
    return kode ? `${pesan} (${kode})` : pesan;
  } catch {
    return fallback;
  }
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiUnreachableError(`Server tidak dapat dihubungi saat memanggil ${path}`);
  }

  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      await messageOf(res, `Permintaan ke ${path} ditolak server (${res.status})`),
    );
  }
  if (res.status === 204) return undefined as T;
  if (!isJson(res)) {
    // HTML from a proxy fallback, or a plain text 404 body. Whatever it is, it
    // is not the API answering, so it must not be parsed as if it were.
    throw new ApiUnreachableError(`Server tidak menjawab dengan data pada ${path}`);
  }
  return (await res.json()) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return send<T>(path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return send<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return send<T>(path, {
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Multipart upload. The content type header is deliberately NOT set: the
 * browser has to add its own boundary, and forcing application/json here is
 * how an upload silently arrives as an unparseable body.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: "POST", body: form, credentials: "include" });
  } catch {
    throw new ApiUnreachableError(`Server tidak dapat dihubungi saat mengunggah ke ${path}`);
  }
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new ApiRequestError(res.status, await messageOf(res, `Unggahan ke ${path} ditolak (${res.status})`));
  }
  if (!isJson(res)) throw new ApiUnreachableError(`Server tidak menjawab dengan data pada ${path}`);
  return (await res.json()) as T;
}

/** The sentence a page shows for a thrown error, whatever its class. */
export function pesanKesalahan(cause: unknown): string {
  if (cause instanceof ApiRequestError) return cause.message;
  if (cause instanceof ApiUnreachableError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return "Terjadi kesalahan tak terduga";
}

export { ApiRequestError, ApiUnreachableError, UnauthorizedError };
