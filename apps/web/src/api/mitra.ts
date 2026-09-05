// The Mitra Binaan self-service surface (spec 4.9), the SECOND principal.
//
// IT DOES NOT GO THROUGH ./http.ts, AND THAT IS THE WHOLE POINT.
//
// ADR 0019 splits staff and mitra at every level the server has: a different
// cookie name, a different cookie path, a different Redis namespace, a
// different context key, a different guard chain and a principal with no field
// in common. The reason given is that one mechanism means one bug turns one
// principal into the other. A frontend that routed both through one fetch
// helper would put that single mechanism back on the client side: a 401 from
// `GET /mitra/saya` would raise `UnauthorizedError`, ../session.tsx would treat
// it as a staff session expiry, and a borrower would be shown the STAFF login
// form. So the transports are separate here too, and the duplication is the
// property, not an oversight.
//
// NO ROUTE HERE TAKES A MITRA ID, an akad number or a NIK in any position. The
// server made enumeration structurally impossible by binding `mitra_id` from
// the session into every WHERE clause; a client that could ask about another
// mitra would be an invitation for the server to grow a route that answers.
// The only identifier any function below accepts is an akad id, which the
// server checks against the session's own mitra and answers "not found" for
// when it is not theirs, exactly as it answers for an akad that does not exist.
import type {
  AkadMitra,
  BarisJadwalMitra,
  JadwalMitra,
  PembayaranMitra,
  ProfilMitra,
} from "@krakatausteel/api/src/modules/mitra/contract";

export type { AkadMitra, BarisJadwalMitra, JadwalMitra, PembayaranMitra, ProfilMitra };

const API_BASE = (globalThis as { __TJSL_API_BASE__?: string }).__TJSL_API_BASE__ ?? "/api";

/** The session is gone, or was never there. Never a staff login prompt. */
export class MitraTidakMasuk extends Error {
  constructor(message = "Sesi Anda sudah berakhir. Masuk kembali untuk melanjutkan.") {
    super(message);
    this.name = "MitraTidakMasuk";
  }
}

/** The account still holds the password an officer handed over. */
export class MitraWajibGantiSandi extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MitraWajibGantiSandi";
  }
}

/** A refusal with the server's own sentence. */
export class MitraGagal extends Error {
  readonly status: number;
  readonly kode: string | null;

  constructor(status: number, message: string, kode: string | null) {
    super(message);
    this.name = "MitraGagal";
    this.status = status;
    this.kode = kode;
  }
}

/** The network itself failed, told apart from a refusal, always. */
export class MitraTidakTerhubung extends Error {
  constructor(message = "Server tidak dapat dihubungi. Periksa koneksi Anda lalu coba lagi.") {
    super(message);
    this.name = "MitraTidakTerhubung";
  }
}

async function kirim<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/mitra${path}`, {
      ...init,
      // The MITRA cookie, and only because the browser decides which cookie
      // matches this path. Nothing here reads or writes a cookie by hand.
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new MitraTidakTerhubung();
  }

  const json = (res.headers.get("content-type") ?? "").includes("json");
  if (!res.ok) {
    const amplop = json
      ? ((await res.json().catch(() => ({}))) as {
          error?: unknown;
          code?: unknown;
          kodeDomain?: unknown;
        })
      : {};
    const pesan =
      typeof amplop.error === "string" && amplop.error.trim() !== ""
        ? amplop.error
        : `Permintaan ditolak server (${res.status}).`;
    const kode = typeof amplop.kodeDomain === "string" ? amplop.kodeDomain : null;

    if (res.status === 401) throw new MitraTidakMasuk(pesan);
    if (kode === "WAJIB_GANTI_SANDI") throw new MitraWajibGantiSandi(pesan);
    throw new MitraGagal(res.status, pesan, kode);
  }

  if (res.status === 204) return undefined as T;
  if (!json) throw new MitraTidakTerhubung("Server tidak menjawab dengan data pada permintaan ini.");
  return (await res.json()) as T;
}

export interface HasilMasukMitra {
  profil: ProfilMitra;
  harusGantiSandi: boolean;
}

export function masuk(email: string, sandi: string): Promise<HasilMasukMitra> {
  return kirim<HasilMasukMitra>("/login", {
    method: "POST",
    body: JSON.stringify({ email, sandi }),
  });
}

/** Ends the server side session. A failure here is reported, never swallowed:
 *  a browser that cleared its own view of the session while the server kept it
 *  alive would be telling the mitra a comforting lie. */
export function keluar(): Promise<void> {
  return kirim<void>("/logout", { method: "POST" });
}

export function gantiSandi(sandiLama: string, sandiBaru: string): Promise<void> {
  return kirim<void>("/ganti-sandi", {
    method: "POST",
    body: JSON.stringify({ sandiLama, sandiBaru }),
  });
}

/** The session bootstrap. A 401 here is the ordinary not-signed-in case. */
export function profil(): Promise<ProfilMitra> {
  return kirim<ProfilMitra>("/saya");
}

export function daftarAkad(): Promise<{ data: AkadMitra[] }> {
  return kirim<{ data: AkadMitra[] }>("/akad");
}

export function jadwalAkad(akadId: string): Promise<JadwalMitra> {
  return kirim<JadwalMitra>(`/akad/${encodeURIComponent(akadId)}/jadwal`);
}

export function pembayaranAkad(akadId: string): Promise<{ data: PembayaranMitra[] }> {
  return kirim<{ data: PembayaranMitra[] }>(`/akad/${encodeURIComponent(akadId)}/pembayaran`);
}
