// Hono router for /mitra (spec 4.9, spec 9.5).
//
// TWO GUARD CHAINS ON ONE ROUTER, AND THEY NEVER MEET.
//
//   `...milikSendiri` = the MITRA chain (./guards.ts). Reads the `tjsl_mitra`
//   cookie, resolves it against the mitra session store, and puts the result
//   in a context key no staff guard reads. Used by the self-service routes.
//
//   `...petugas` = the STAFF chain (core/principal.ts `Guards`). Reads the
//   `tjsl_sid` cookie and `konfigurasi.user`. Used by the two provisioning
//   routes.
//
// A caller holding one cannot satisfy the other, and not because a check says
// so: the cookies have different NAMES, so the browser does not even send the
// mitra cookie to a staff route (it is scoped `Path=/mitra`), and the two
// session stores use different Redis prefixes, so an id from one is a miss in
// the other. `modules/mitra/mitra-isolasi.test.ts` proves both directions
// against every staff permission family.
//
// NO ROUTE HERE TAKES A MITRA ID. Not in the path, not in the query, not in
// the body. The only mitra id that exists on this surface comes from the
// session, which is what makes enumeration by id, by akad number, by NIK or by
// anything else structurally impossible rather than blocked by a check.
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { queueSetCookie } from "../../core/cookies";
import { clientIp, rateLimit } from "../../core/hardening";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import type { RateLimiterPort } from "../../core/ports/ratelimit";
import { MAKS_PANJANG_SANDI, type MitraEngine } from "./contract";
import {
  createMitraGuards,
  MITRA_COOKIE,
  requireMitraPrincipal,
  serializeMitraCookie,
  type MitraGuards,
} from "./guards";
import type { PorterAuditMitra } from "./contract";

/** Coarse transport ceiling on the public login route. Policy is in the engine. */
const LIMIT_MASUK = { limit: 30, windowSeconds: 5 * 60 } as const;
const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export interface MitraRoutesDeps {
  engine: MitraEngine;
  audit: PorterAuditMitra;
  /** The STAFF guards, for the two provisioning routes only. */
  guards: Guards;
  /** FAIL CLOSED, exactly like the staff login limiter. */
  pembatas: RateLimiterPort;
  keyPrefix?: string;
}

/** The staff session's own authority. Nothing from the request reaches this. */
function konteksPetugas(p: Principal): {
  userId: string;
  bumnId: string;
  permissions: readonly string[];
  cabangDalamScope: readonly string[];
} {
  return {
    userId: p.userId,
    bumnId: p.bumnId,
    permissions: p.permissions,
    // Empty for a cross-branch role, which the engine reads as "no branch
    // restriction", matching core/principal.ts's `allowedCabangIds`.
    cabangDalamScope: p.lintasCabang ? [] : p.cabangTersedia.map((c) => c.id),
  };
}

async function badan(c: Context): Promise<Record<string, unknown>> {
  const nilai = await c.req.json<unknown>().catch(() => ({}));
  if (typeof nilai !== "object" || nilai === null || Array.isArray(nilai)) {
    throw badRequest("Body harus berupa objek JSON");
  }
  return nilai as Record<string, unknown>;
}

export function createMitraRoutes(deps: MitraRoutesDeps) {
  const { engine, guards } = deps;
  const mitraGuards: MitraGuards = createMitraGuards({ engine, audit: deps.audit });
  const milikSendiri = [mitraGuards.requireMitra, mitraGuards.wajibSandiSendiri] as const;
  const petugas = [guards.requireSession, guards.requirePermission("konfigurasi.user")] as const;
  const batasMasuk = rateLimit({
    ...LIMIT_MASUK,
    limiter: deps.pembatas,
    ...(deps.keyPrefix ? { keyPrefix: deps.keyPrefix } : {}),
  });

  return (
    new Hono()
      // ------------------------------------------------------ staff routes
      //
      // REGISTERED FIRST so `/akun` is never shadowed by a mitra route, and
      // kept on their own path segment so the two surfaces are visible as two
      // surfaces in the route table.
      /**
       * Issues a portal account for a mitra. Answers with a one-time password,
       * ONCE; it is not stored in cleartext anywhere and not written to
       * `audit_log`, and the account is created with `harus_ganti_sandi` set,
       * so it can only ever be used to replace itself.
       */
      .post("/akun", ...petugas, async (c) => {
        const p = requirePrincipal(c);
        const body = await badan(c);
        const galat: Record<string, string[]> = {};
        const mitraId = typeof body.mitraId === "string" ? body.mitraId : "";
        if (!POLA_UUID.test(mitraId)) galat.mitraId = ["wajib berupa UUID"];
        const email = typeof body.email === "string" ? body.email.trim() : "";
        if (email.length === 0 || email.length > 200) galat.email = ["wajib diisi, maksimal 200 karakter"];
        if (Object.keys(galat).length > 0) throw badRequest("Data yang dikirim belum valid", galat);

        return c.json(await engine.buatAkun({ mitraId, email }, konteksPetugas(p)), 201);
      })

      /** Enables or disables a mitra's portal account. Takes effect at once. */
      .post("/akun/:mitraId/status", ...petugas, async (c) => {
        const p = requirePrincipal(c);
        const mitraId = c.req.param("mitraId");
        const body = await badan(c);
        const galat: Record<string, string[]> = {};
        if (!POLA_UUID.test(mitraId)) galat.mitraId = ["wajib berupa UUID"];
        if (typeof body.aktif !== "boolean") galat.aktif = ["wajib true atau false"];
        if (Object.keys(galat).length > 0) throw badRequest("Data yang dikirim belum valid", galat);

        return c.json(await engine.setAktifAkun(mitraId, body.aktif as boolean, konteksPetugas(p)));
      })

      // ------------------------------------------------------ mitra routes
      .post("/login", batasMasuk, async (c) => {
        const body = await badan(c);
        const hasil = await engine.masuk({
          email: typeof body.email === "string" ? body.email : "",
          sandi: typeof body.sandi === "string" ? body.sandi.slice(0, MAKS_PANJANG_SANDI + 1) : "",
          ip: clientIp(c),
          userAgent: c.req.header("user-agent") ?? null,
        });
        queueSetCookie(
          c,
          serializeMitraCookie({
            value: hasil.sesi.id,
            // The idle TTL, taken from the record itself rather than from a
            // wall clock, so an injected clock in a test and the real store
            // agree about when the browser should drop the cookie.
            maxAge: Math.max(
              1,
              Math.floor(
                (Date.parse(hasil.sesi.idleExpiresAt) - Date.parse(hasil.sesi.createdAt)) / 1000,
              ),
            ),
            secure: isProduction(),
          }),
        );
        c.header("Cache-Control", "no-store");
        return c.json({ profil: hasil.profil, harusGantiSandi: hasil.principal.harusGantiSandi }, 200);
      })

      /**
       * Deliberately NOT behind `requireMitra`: an expired or already invalid
       * cookie must still be able to clear itself, or the browser has no way
       * out of a broken session.
       */
      .post("/logout", async (c) => {
        const nilai = getCookie(c, MITRA_COOKIE);
        if (nilai) {
          await engine.keluar(nilai, clientIp(c), c.req.header("user-agent") ?? null);
        }
        queueSetCookie(c, serializeMitraCookie({ value: "", maxAge: 0, secure: isProduction() }));
        return c.body(null, 204);
      })

      /**
       * Behind `requireMitra` but NOT behind `wajibSandiSendiri`: this is the
       * one thing an account on a handed-over password may do.
       */
      .post("/ganti-sandi", mitraGuards.requireMitra, async (c) => {
        const p = requireMitraPrincipal(c);
        const body = await badan(c);
        await engine.gantiSandi(p, {
          sandiLama: typeof body.sandiLama === "string" ? body.sandiLama : "",
          sandiBaru: typeof body.sandiBaru === "string" ? body.sandiBaru : "",
          ip: clientIp(c),
          userAgent: c.req.header("user-agent") ?? null,
        });
        return c.body(null, 204);
      })

      .get("/saya", ...milikSendiri, async (c) => {
        const p = requireMitraPrincipal(c);
        c.header("Cache-Control", "no-store");
        return c.json(await engine.profil(p));
      })

      .get("/akad", ...milikSendiri, async (c) => {
        const p = requireMitraPrincipal(c);
        c.header("Cache-Control", "no-store");
        return c.json({ data: await engine.daftarAkad(p) });
      })

      .get("/akad/:id/jadwal", ...milikSendiri, async (c) => {
        const p = requireMitraPrincipal(c);
        c.header("Cache-Control", "no-store");
        return c.json(await engine.jadwal(c.req.param("id"), p));
      })

      .get("/akad/:id/pembayaran", ...milikSendiri, async (c) => {
        const p = requireMitraPrincipal(c);
        c.header("Cache-Control", "no-store");
        return c.json({ data: await engine.pembayaran(c.req.param("id"), p) });
      })

      // The API's own 404 in the API's own envelope, rather than Hono's plain
      // text default: apps/web/src/api/http.ts branches on the JSON body.
      .all("/*", () => {
        throw notFound("Endpoint mitra tidak ditemukan");
      })
  );
}
