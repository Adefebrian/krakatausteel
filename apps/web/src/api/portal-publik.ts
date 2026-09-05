// The THREE UNAUTHENTICATED endpoints of spec 9.5, and nothing else: the
// entity selector, the application, and the ticket status check.
//
// IT DOES NOT GO THROUGH ./http.ts, AND THAT IS THE POINT.
//
//   NO COOKIE IS SENT. `./http.ts` uses `credentials: "include"` because every
//   staff call needs the staff session. A public form must not carry one: a
//   member of the public filling in an application on a shared machine where
//   somebody left a staff session open would otherwise have that session's
//   cookie attached to their submission, and the server would then be looking
//   at a request that is anonymous by route and authenticated by header. Here
//   it is `credentials: "omit"`, so the request is anonymous as a property of
//   the transport rather than as a property of the handler.
//
//   A 401 IS NOT A LOGIN PROMPT. `./http.ts` throws `UnauthorizedError`, which
//   ../session.tsx turns into the STAFF login screen. On a public page that
//   would be an invitation to sign in to a system the reader has no account
//   for, so nothing here can produce it.
//
// TYPES COME FROM THE CONTRACT. `import type` is erased by Bun's transpiler,
// so no server code reaches the bundle, and a change to the public form's
// allowlist becomes a type error here rather than a 400 in front of a member
// of the public.
import type {
  AturanField,
  CekStatusInput,
  DokumenPengajuan,
  EntitasPublik,
  HasilPengajuan,
  JenisDokumen,
  JenisPengajuan,
  PengajuanInput,
  StatusPengajuan,
  StatusSubmission,
} from "@krakatausteel/api/src/modules/portal/contract";

export type {
  AturanField,
  CekStatusInput,
  DokumenPengajuan,
  EntitasPublik,
  HasilPengajuan,
  JenisDokumen,
  JenisPengajuan,
  PengajuanInput,
  StatusPengajuan,
  StatusSubmission,
};

const API_BASE = (globalThis as { __TJSL_API_BASE__?: string }).__TJSL_API_BASE__ ?? "/api";

/**
 * What went wrong, in the server's own Indonesian sentence.
 *
 * `galat` carries the per-field messages the engine returned so the form can
 * put each one under the field it belongs to. It is deliberately NOT used by
 * the status check screen: that endpoint answers with one sentence for every
 * failure mode, and splitting it per field would rebuild the oracle the server
 * refuses to be.
 */
export class PortalGagal extends Error {
  readonly status: number;
  readonly kode: string | null;
  readonly galat: Readonly<Record<string, string[]>>;

  constructor(
    status: number,
    message: string,
    kode: string | null,
    galat: Record<string, string[]> = {},
  ) {
    super(message);
    this.name = "PortalGagal";
    this.status = status;
    this.kode = kode;
    this.galat = galat;
  }
}

/** The network itself failed. Told apart from a refusal, always. */
export class PortalTidakTerhubung extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalTidakTerhubung";
  }
}

interface AmplopGalat {
  error?: unknown;
  code?: unknown;
  kode?: unknown;
  detail?: unknown;
}

function bacaGalat(body: AmplopGalat): Record<string, string[]> {
  const detail = body.detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return {};
  const keluar: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      keluar[key] = value as string[];
    }
  }
  return keluar;
}

async function kirim<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      // See the header: a public request carries no session, ever.
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PortalTidakTerhubung(
      "Server tidak dapat dihubungi. Periksa koneksi Anda lalu coba lagi.",
    );
  }

  const json = (res.headers.get("content-type") ?? "").includes("json");
  if (!res.ok) {
    if (!json) {
      throw new PortalTidakTerhubung(
        "Server tidak menjawab dengan data. Coba lagi beberapa saat lagi.",
      );
    }
    const amplop = (await res.json().catch(() => ({}))) as AmplopGalat;
    const pesan =
      typeof amplop.error === "string" && amplop.error.trim() !== ""
        ? amplop.error
        : `Permintaan ditolak server (${res.status}).`;
    const kode =
      typeof amplop.kode === "string"
        ? amplop.kode
        : typeof amplop.code === "string"
          ? amplop.code
          : null;
    throw new PortalGagal(res.status, pesan, kode, bacaGalat(amplop));
  }

  if (!json) {
    throw new PortalTidakTerhubung("Server tidak menjawab dengan data pada permintaan ini.");
  }
  return (await res.json()) as T;
}

/**
 * The entities a member of the public may apply to, code and name.
 *
 * A GET, and the only one on this surface, because it verifies no secret and
 * stores nothing: there is no credential here to keep out of an access log.
 * `credentials: "omit"` for the same reason as the two POSTs, and its own
 * request path rather than `kirim` because that helper posts a JSON body.
 *
 * WHAT THE CALLER DOES WITH A FAILURE IS THE POINT. This read replaces a text
 * box an applicant had to type a code into, and it must not become a way for
 * the form to stop working: ../portal/Pengajuan.tsx falls back to that text
 * box when this call fails or answers with nothing. A public form that cannot
 * be filled in because one request failed is worse than one that asks for a
 * code off a leaflet.
 */
export async function entitasPublik(): Promise<EntitasPublik[]> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/portal/entitas`, {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new PortalTidakTerhubung(
      "Daftar entitas tidak dapat diambil. Periksa koneksi Anda lalu coba lagi.",
    );
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) {
    throw new PortalTidakTerhubung("Daftar entitas tidak dapat diambil dari server.");
  }
  const amplop = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const data = amplop?.data;
  if (!Array.isArray(data)) {
    throw new PortalTidakTerhubung("Daftar entitas tidak terbaca dari jawaban server.");
  }
  // FILTERED HERE, NOT TRUSTED. The two columns are the two a printed form
  // already carries, and anything that is not a pair of non empty strings is
  // dropped rather than rendered as an option that would produce a 400 the
  // applicant cannot diagnose.
  return data.filter(
    (baris): baris is EntitasPublik =>
      typeof baris === "object" &&
      baris !== null &&
      typeof (baris as EntitasPublik).kode === "string" &&
      typeof (baris as EntitasPublik).nama === "string" &&
      (baris as EntitasPublik).kode.trim() !== "",
  );
}

/** Spec 9.5: submit an application without logging in. */
export function ajukan(input: PengajuanInput): Promise<HasilPengajuan> {
  return kirim<HasilPengajuan>("/portal/pengajuan", input);
}

/**
 * Spec 9.5: check a ticket. A POST because the verifier is a credential and a
 * credential in a query string lands in the access log, the browser history
 * and the `Referer` of every asset on the result page.
 */
export function cekStatus(input: CekStatusInput): Promise<StatusPengajuan> {
  return kirim<StatusPengajuan>("/portal/status", input);
}
