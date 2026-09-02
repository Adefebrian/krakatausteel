// Hono router for /portal (spec 9.5).
//
// TWO OF THESE ROUTES ARE UNAUTHENTICATED, WHICH IS NEW IN THIS CODEBASE.
// Until Fase 7 every route in the app required a staff session and every read
// was branch-scoped. So the two public handlers below carry protections the
// staff routes get for free from the guard chain, and they are listed here
// rather than assumed:
//
//   OWN BODY CAP. `core/hardening.ts` caps a request at 1 MB, which is right
//   for an authenticated attachment upload and far too generous for a form
//   from the internet. `batasBadanPortal` caps these two at 32 KB and answers
//   413 in the API's own envelope.
//
//   OWN RATE LIMIT, FAIL CLOSED. The global limiter is fail-OPEN by design
//   (Redis down must not take the API down). That stance is wrong for a public
//   write and for a credential check, for the same reason it is wrong for
//   login: an attacker who can knock Redis over would otherwise get an
//   unmetered window. The middleware here is a COARSE flood shield sized well
//   above the engine's policy ceilings (contract.ts: BATAS_PENGAJUAN_PER_IP,
//   BATAS_CEK_PER_IP); it exists to refuse a flood BEFORE the JSON is parsed
//   and before argon2 runs, not to be the policy. The policy limits live in
//   the engine, where they can be tested and where a refusal writes its audit
//   row.
//
//   NO SESSION IS EVER CONSULTED. These handlers do not read a cookie, do not
//   call `requirePrincipal`, and hand the engine only `{ip, userAgent}`.
//
// The three staff routes below follow the same four rules modules/tools and
// modules/rka state: validate at the boundary before any engine call;
// authorise with CANONICAL permission codes so a typo fails at boot; never let
// the request decide scope (the engine takes `bumnId` from the session); and
// never catch a domain error, so `PortalError` reaches core/http.ts and the
// DITOLAK row of spec 2 rule 5 gets written.
import { Hono } from "hono";
import type { Context, MiddlewareHandler, Next } from "hono";
import { clientIp, rateLimit } from "../../core/hardening";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import type { RateLimiterPort } from "../../core/ports/ratelimit";
import {
  BATAS_BARIS_MAKS,
  type BatasPortal,
  type FilterSubmission,
  type JenisPengajuan,
  type PortalContext,
  type PortalEngine,
  type PortalPublikContext,
  type StatusSubmission,
  type TindakanPetugas,
} from "./contract";

/** Hard ceiling on a PUBLIC request body. See the header. */
export const MAKS_BADAN_PORTAL = 32 * 1024;

/** Coarse transport ceilings. Deliberately looser than the engine's policy. */
const LIMIT_AJUKAN = { limit: 30, windowSeconds: 60 * 60 } as const;
const LIMIT_CEK = { limit: 30, windowSeconds: 5 * 60 } as const;

const JENIS: readonly JenisPengajuan[] = ["PUMK", "NON_PUMK"];
const STATUS: readonly StatusSubmission[] = ["BARU", "DIPROSES", "DIKONVERSI", "DITOLAK"];
const TINDAKAN: readonly TindakanPetugas[] = ["DIPROSES", "DITOLAK"];
const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PortalRoutesDeps {
  engine: PortalEngine;
  guards: Guards;
  /** FAIL CLOSED. See the header, and core/ports/ratelimit.ts. */
  pembatas: RateLimiterPort;
  keyPrefix?: string;
  /** Harness cost knob only; production never sets it. See ./contract.ts. */
  batas?: BatasPortal;
}

/**
 * Rejects an oversized PUBLIC body before the handler runs.
 *
 * `Content-Length` is a claim, so this is not the whole story: the handler
 * also measures the text it actually read (`badanJson` below). Between them,
 * a chunked body that lies about its size is still capped.
 */
const batasBadanPortal: MiddlewareHandler = async (c: Context, next: Next) => {
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    const panjang = Number(declared);
    if (!Number.isFinite(panjang) || panjang < 0) {
      return c.json({ error: "Content-Length tidak valid", code: "VALIDASI" as const }, 400);
    }
    if (panjang > MAKS_BADAN_PORTAL) {
      return c.json(
        { error: "Data yang dikirim terlalu besar", code: "VALIDASI" as const },
        413,
      );
    }
  }
  return next();
};

/**
 * Reads and parses a public JSON body, MEASURING WHAT ACTUALLY ARRIVED.
 *
 * TWO REFUSALS, ON PURPOSE, and they differ because the two situations differ.
 * A body that DECLARES an oversize `Content-Length` is refused 413 by the
 * middleware above, before a byte is read. A body that declares nothing (or
 * lies) reaches here and is refused 400 VALIDASI after measurement, because by
 * then it has already been read and the honest description is "the data you
 * sent is not acceptable" rather than "I refused to read it". Both cap at
 * MAKS_BADAN_PORTAL; neither lets an unbounded public body through.
 */
async function badanJson(c: Context): Promise<Record<string, unknown>> {
  const teks = await c.req.text().catch(() => "");
  if (teks.length > MAKS_BADAN_PORTAL) {
    throw badRequest("Data yang dikirim terlalu besar");
  }
  if (teks.trim().length === 0) return {};
  let nilai: unknown;
  try {
    nilai = JSON.parse(teks);
  } catch {
    throw badRequest("Body harus berupa JSON yang valid");
  }
  if (typeof nilai !== "object" || nilai === null || Array.isArray(nilai)) {
    throw badRequest("Body harus berupa objek JSON");
  }
  return nilai as Record<string, unknown>;
}

/** What an anonymous caller is. Nothing here comes from the body. */
function publik(c: Context): PortalPublikContext {
  return {
    ip: clientIp(c),
    // Attacker-controlled free text, read by humans, so it is truncated.
    userAgent: (c.req.header("user-agent") ?? null)?.slice(0, 512) ?? null,
  };
}

/** The session's own authority. Nothing from the request reaches this. */
function konteks(principal: Principal): PortalContext {
  return {
    userId: principal.userId,
    cabangId: principal.cabang.id,
    bumnId: principal.bumnId,
    permissions: principal.permissions,
    cabangDalamScope: principal.cabangTersedia.map((cabang) => cabang.id),
  };
}

function pilihan<T extends string>(nilai: unknown, daftar: readonly T[]): T | null {
  return typeof nilai === "string" && (daftar as readonly string[]).includes(nilai)
    ? (nilai as T)
    : null;
}

export function createPortalRoutes({ engine, guards, pembatas, keyPrefix, batas }: PortalRoutesDeps) {
  const { requireSession, requirePermission } = guards;

  const lihat = [requireSession, requirePermission("portal.view")] as const;
  const tindak = [requireSession, requirePermission("portal.konversi")] as const;

  const batasAjukan = rateLimit({
    ...LIMIT_AJUKAN,
    ...(batas?.rutePengajuan !== undefined ? { limit: batas.rutePengajuan } : {}),
    limiter: pembatas,
    ...(keyPrefix ? { keyPrefix } : {}),
  });
  const batasCek = rateLimit({
    ...LIMIT_CEK,
    ...(batas?.ruteCek !== undefined ? { limit: batas.ruteCek } : {}),
    limiter: pembatas,
    ...(keyPrefix ? { keyPrefix } : {}),
  });

  return new Hono()
    // ------------------------------------------------------------- PUBLIC
    /**
     * Spec 9.5: submit without logging in. Answers with the ticket number and
     * nothing else that could be used to reach the row again: no id, no
     * branch, no entity id.
     */
    .post("/pengajuan", batasBadanPortal, batasAjukan, async (c) => {
      const body = await badanJson(c);
      const hasil = await engine.ajukan(
        {
          kodeEntitas: typeof body.kodeEntitas === "string" ? body.kodeEntitas : "",
          jenis: body.jenis as JenisPengajuan,
          emailKontak: typeof body.emailKontak === "string" ? body.emailKontak : null,
          teleponKontak: typeof body.teleponKontak === "string" ? body.teleponKontak : null,
          nik: typeof body.nik === "string" ? body.nik : null,
          tanggalLahir: typeof body.tanggalLahir === "string" ? body.tanggalLahir : null,
          formulir:
            typeof body.formulir === "object" && body.formulir !== null
              ? (body.formulir as Record<string, unknown>)
              : {},
          dokumen: Array.isArray(body.dokumen) ? (body.dokumen as never[]) : [],
        },
        publik(c),
      );
      return c.json(hasil, 201);
    })

    /**
     * Spec 9.5: check the status with the ticket plus NIK or date of birth.
     *
     * A POST AND NOT A GET, deliberately. The verifier is a credential; in a
     * query string it would land in the access log, the browser history, the
     * `Referer` of every asset on the result page, and any proxy in between.
     * It is not a violation of "GET is for reads": this endpoint verifies a
     * secret, which is the same reason POST /auth/login is a POST.
     */
    .post("/status", batasBadanPortal, batasCek, async (c) => {
      const body = await badanJson(c);
      const hasil = await engine.cekStatus(
        {
          noTiket: typeof body.noTiket === "string" ? body.noTiket : "",
          nik: typeof body.nik === "string" ? body.nik : null,
          tanggalLahir: typeof body.tanggalLahir === "string" ? body.tanggalLahir : null,
        },
        publik(c),
      );
      // no-store: the answer is about one identified applicant and must not sit
      // in a shared cache or in the browser's back/forward cache.
      c.header("Cache-Control", "no-store");
      return c.json(hasil, 200);
    })

    // -------------------------------------------------------------- STAFF
    /** The officer's intake queue. Scoped to the session's entity by the engine. */
    .get("/submission", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const galat: Record<string, string[]> = {};

      const jenisQ = c.req.query("jenis");
      const jenis = jenisQ === undefined ? null : pilihan(jenisQ, JENIS);
      if (jenisQ !== undefined && jenis === null) galat.jenis = [`wajib salah satu dari: ${JENIS.join(", ")}`];

      const statusQ = c.req.query("status");
      const status = statusQ === undefined ? null : pilihan(statusQ, STATUS);
      if (statusQ !== undefined && status === null) {
        galat.status = [`wajib salah satu dari: ${STATUS.join(", ")}`];
      }

      const batasQ = c.req.query("batasBaris");
      let batasBaris: number | null = null;
      if (batasQ !== undefined) {
        const n = Number(batasQ);
        if (!Number.isInteger(n) || n < 1 || n > BATAS_BARIS_MAKS) {
          galat.batasBaris = [`wajib bilangan bulat antara 1 dan ${BATAS_BARIS_MAKS}`];
        } else {
          batasBaris = n;
        }
      }

      const tiketQ = c.req.query("noTiket");
      if (tiketQ !== undefined && (tiketQ.length === 0 || tiketQ.length > 40)) {
        galat.noTiket = ["maksimal 40 karakter"];
      }

      if (Object.keys(galat).length > 0) throw badRequest("Data yang dikirim belum valid", galat);

      const filter: FilterSubmission = {
        jenis,
        status,
        noTiket: tiketQ ?? null,
        batasBaris,
      };
      return c.json({ data: await engine.daftar(filter, konteks(p)) });
    })

    .get("/submission/:id", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const id = c.req.param("id");
      if (!POLA_UUID.test(id)) throw badRequest("Data yang dikirim belum valid", { id: ["wajib berupa UUID"] });
      return c.json(await engine.detail(id, konteks(p)));
    })

    /**
     * Verify or refuse. `DIKONVERSI` is NOT reachable here, and the engine
     * refuses it: converting is `POST /pumk/portal/konversi`, which is the
     * only thing that can create the proposal that status claims exists.
     */
    .post("/submission/:id/tindak", ...tindak, async (c) => {
      const p = requirePrincipal(c);
      const id = c.req.param("id");
      const galat: Record<string, string[]> = {};
      if (!POLA_UUID.test(id)) galat.id = ["wajib berupa UUID"];

      const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
      const tindakan = pilihan(body.tindakan, TINDAKAN);
      if (!tindakan) galat.tindakan = [`wajib salah satu dari: ${TINDAKAN.join(", ")}`];
      const catatan = typeof body.catatan === "string" ? body.catatan : null;
      if (catatan !== null && catatan.length > 1000) galat.catatan = ["maksimal 1000 karakter"];

      if (Object.keys(galat).length > 0) throw badRequest("Data yang dikirim belum valid", galat);

      return c.json(await engine.tindak(id, { tindakan: tindakan!, catatan }, konteks(p)));
    })

    // The API's own 404 in the API's own envelope, rather than Hono's plain
    // text default: apps/web/src/api/http.ts branches on the JSON body.
    .all("/*", () => {
      throw notFound("Endpoint portal tidak ditemukan");
    });
}
