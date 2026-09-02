// The MITRA guard chain and the mitra cookie policy.
//
// NOTHING IN THIS FILE TOUCHES `core/principal.ts`. It does not call
// `setPrincipal`, so `getPrincipal(c)` stays null on a mitra request and every
// staff guard in the application refuses one. That is the mechanism behind the
// claim in ./contract.ts: a mitra principal cannot reach a staff route, not
// because a check says so, but because there is no code path that puts a mitra
// into the variable staff guards read.
//
// FOUR INDEPENDENT SEPARATIONS, so no single mistake collapses the two
// principal kinds into one:
//   1. cookie NAME     `tjsl_mitra` vs `tjsl_sid`
//   2. cookie PATH     `/mitra` -- the browser never even sends it to a staff
//                      route, so a stolen mitra cookie is not replayable there
//   3. Redis PREFIX    `tjsl:msess:` vs `tjsl:sess:` (./sesi.ts)
//   4. context KEY     `mitraPrincipal` vs `principal`
//
// EVERY DENIAL IS LOGGED, including the anonymous ones (spec 2 rule 5). The
// audit write is awaited before the refusal goes out and is not swallowed, the
// same rule modules/auth/guards.ts follows. `markDenialLogged` then keeps
// core/http.ts from writing a second row for the same request.
import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { clientIp } from "../../core/hardening";
import { markDenialLogged } from "../../core/http";
import { KODE_MITRA, MitraError, type MitraEngine, type MitraPrincipal, type PorterAuditMitra } from "./contract";

/** DIFFERENT NAME FROM THE STAFF COOKIE. Separation 1. */
export const MITRA_COOKIE = "tjsl_mitra";
/** DIFFERENT CONTEXT KEY FROM `PRINCIPAL_VAR`. Separation 4. */
export const MITRA_PRINCIPAL_VAR = "mitraPrincipal";
/** Separation 2: the browser scopes this cookie to the mitra routes alone. */
export const MITRA_COOKIE_PATH = "/mitra";

const POLA_NILAI_COOKIE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~/=:]*$/;

export interface OpsiCookieMitra {
  value: string;
  /** Seconds. 0 expires the cookie immediately (logout). */
  maxAge: number;
  secure: boolean;
}

/**
 * Serialised by hand for the two reasons modules/auth/cookie.ts gives: the
 * `Set-Cookie` header is not observable through `hono/cookie` under the
 * happy-dom globals this suite registers, and the attribute set is a security
 * decision worth reading in one place.
 */
export function serializeMitraCookie(opsi: OpsiCookieMitra): string {
  if (!POLA_NILAI_COOKIE.test(opsi.value)) {
    throw new Error("Nilai cookie sesi mitra memuat karakter yang tidak diizinkan");
  }
  return [
    `${MITRA_COOKIE}=${opsi.value}`,
    `Path=${MITRA_COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(opsi.maxAge))}`,
    "HttpOnly",
    // Lax, matching the staff cookie: no cookie on a cross-site POST, which is
    // the CSRF defence, with core/hardening.ts's Origin check as the second
    // lock. Strict would drop the cookie when a mitra arrives from the link in
    // a reminder email, which is the main way this portal gets opened.
    "SameSite=Lax",
    ...(opsi.secure ? ["Secure"] : []),
  ].join("; ");
}

export function getMitraPrincipal(c: Context): MitraPrincipal | null {
  return (c.get(MITRA_PRINCIPAL_VAR as never) as MitraPrincipal | undefined) ?? null;
}

export function requireMitraPrincipal(c: Context): MitraPrincipal {
  const p = getMitraPrincipal(c);
  if (!p) throw new MitraError(KODE_MITRA.SESI_MITRA_TIDAK_VALID, "Sesi tidak valid atau sudah berakhir.");
  return p;
}

export interface MitraGuards {
  /** Resolves the mitra cookie into a `MitraPrincipal`, or refuses with 401. */
  requireMitra: MiddlewareHandler;
  /**
   * Refuses every route except password change and logout while the account
   * still holds the password an officer handed over.
   */
  wajibSandiSendiri: MiddlewareHandler;
}

export interface MitraGuardDeps {
  engine: MitraEngine;
  audit: PorterAuditMitra;
}

export function createMitraGuards({ engine, audit }: MitraGuardDeps): MitraGuards {
  async function ditolak(
    c: Context,
    error: MitraError,
    entry: { akunId: string | null; keterangan: string },
  ): Promise<never> {
    // `userId` is NULL by necessity: `audit_log.user_id` is a foreign key to
    // `app_user` and a mitra is not one. See ./contract.ts reason 3.
    await audit.record({
      userId: null,
      ip: clientIp(c),
      userAgent: (c.req.header("user-agent") ?? null)?.slice(0, 512) ?? null,
      aksi: "mitra.akses",
      entitas: "portal_akun_mitra",
      entitasId: entry.akunId,
      nilaiBaru: { metode: c.req.method, path: c.req.path },
      hasil: "DITOLAK",
      keterangan: entry.keterangan,
    });
    markDenialLogged(c);
    throw error;
  }

  const requireMitra: MiddlewareHandler = async (c: Context, next: Next) => {
    if (getMitraPrincipal(c)) return next();

    const cookie = getCookie(c, MITRA_COOKIE);
    if (!cookie) {
      return ditolak(
        c,
        new MitraError(KODE_MITRA.SESI_MITRA_TIDAK_VALID, "Anda belum masuk."),
        { akunId: null, keterangan: "tidak ada cookie sesi mitra" },
      );
    }
    const principal = await engine.resolveSesi(cookie);
    if (!principal) {
      return ditolak(
        c,
        new MitraError(KODE_MITRA.SESI_MITRA_TIDAK_VALID, "Sesi tidak valid atau sudah berakhir."),
        {
          akunId: null,
          keterangan: "sesi mitra tidak ditemukan, kedaluwarsa, atau akun tidak aktif",
        },
      );
    }
    c.set(MITRA_PRINCIPAL_VAR as never, principal as never);
    return next();
  };

  const wajibSandiSendiri: MiddlewareHandler = async (c: Context, next: Next) => {
    const p = getMitraPrincipal(c);
    if (p?.harusGantiSandi) {
      return ditolak(
        c,
        new MitraError(
          KODE_MITRA.WAJIB_GANTI_SANDI,
          "Ganti kata sandi Anda dulu sebelum membuka halaman lain.",
        ),
        {
          akunId: p.akunId,
          keterangan: "akun masih memakai sandi sementara dari petugas",
        },
      );
    }
    return next();
  };

  return { requireMitra, wajibSandiSendiri };
}
