// Hono router for /ai (spec 12, Fase 8). The HTTP surface of the assistant.
//
// THREE OF THE FIVE ROUTES ARE GETs, AND THE TWO POSTs WRITE ONLY `ai_saran`.
// `POST /ai/ekstraksi` asks a model to read a document and answers with a
// proposal; it creates no mitra, no proposal, no attachment and no journal.
// `POST /ai/saran/:id/konfirmasi` records that a person looked at a proposal
// and what they decided. Neither of them can reach the ledger, because the
// engine behind them holds no port that does (contract.ts rule 1). A route
// added here that changed business state would be the moment the assistant
// acquired write authority.
//
// IT FOLLOWS modules/tools/routes.ts DELIBERATELY, and restates the four rules
// that file states, because they are what this file is FOR:
//
//   VALIDATE at the boundary, before any engine call, answering
//   `400 VALIDASI` with per-field detail and collecting EVERY bad field into
//   one response. Hand written rather than zod, because this repo carries no
//   schema library and modules/konfigurasi, modules/pumk, modules/nonpumk,
//   modules/rka and modules/tools all validate this way: adding a dependency is
//   an API-WIDE decision, not one this module gets to make on its own.
//
//   AUTHORISE with `requirePermission` using CANONICAL codes, so a typo is a
//   BOOT failure (`resolveRequiredPermissions`) and never a 403 that reads like
//   policy. `ai.ekstraksi` (MAKER, ADMIN_CABANG, ADMIN_PUSAT) gates the
//   document assistant; `ai.anomali` (CHECKER, APPROVER, AUDITOR, ADMIN_CABANG,
//   ADMIN_PUSAT) gates the review queue. They are NOT interchangeable: filling
//   a form faster and deciding which entries to read first are different jobs
//   held by different people.
//
//   NEVER DECIDE BRANCH SCOPE. No handler reads `cabangId` and uses it as
//   authority. `konteks()` carries what the SESSION resolved; the engine
//   intersects the filter with it and REFUSES a branch outside it.
//
//   NEVER CATCH A DOMAIN ERROR. `AiError` travels to core/http.ts, which maps
//   the code, keeps it in the body as `kodeDomain`, and writes the DITOLAK
//   audit row spec 2 rule 5 requires.
//
// PLUS ONE RULE THAT IS THIS MODULE'S OWN: THE CEILINGS ARE HERE TOO.
// The engine spends a per-USER budget in Redis. This file adds a per-ROUTE,
// per-IP ceiling on top, for the same reason modules/portal does: the engine's
// counter is only reached after the body has been parsed and the session
// resolved, and a flood should be refused before that. Both limiters are the
// FAIL-CLOSED one, which is the opposite of the global policy and is argued in
// contract.ts's `AiEngineDeps`: an extraction that does not happen costs a
// Maker one form typed by hand, while an uncounted extraction endpoint is a
// bill with no ceiling.
import { Hono } from "hono";
import { rateLimit } from "../../core/hardening";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import type { RateLimiterPort } from "../../core/ports/ratelimit";
import {
  BATAS_RUTE_ANOMALI,
  BATAS_RUTE_EKSTRAKSI,
  BATAS_TEMUAN_MAKS,
  JENDELA_RUTE_DETIK,
  JENIS_DOKUMEN,
  MAKS_KARAKTER_DOKUMEN,
  type AiContext,
  type AiEngine,
  type JenisDokumen,
  type KeputusanSaran,
} from "./contract";

export interface AiRoutesDeps {
  engine: AiEngine;
  guards: Guards;
  /** The FAIL-CLOSED limiter. See this file's header. */
  pembatas?: RateLimiterPort;
  keyPrefix?: string;
  /** Cost knob for the harness only. Production never sets it. */
  batasRute?: { ekstraksi?: number; anomali?: number };
}

/**
 * The session's own authority, translated into what the engine takes. Nothing
 * from the request reaches this.
 */
function konteks(principal: Principal): AiContext {
  return {
    userId: principal.userId,
    cabangId: principal.cabang.id,
    bumnId: principal.bumnId,
    permissions: principal.permissions,
    cabangDalamScope: principal.cabangTersedia.map((cabang) => cabang.id),
  };
}

const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEPUTUSAN: readonly KeputusanSaran[] = ["DITERIMA", "DITOLAK", "SEBAGIAN"];

/** Provenance labels a caller may attach. An allowlist, not free text. */
const KONTEKS_TIPE: readonly string[] = [
  "pumk_proposal",
  "nonpumk_program",
  "nonpumk_lpj",
  "mitra",
  "lampiran",
];

class Pemeriksa {
  private readonly galat: Record<string, string[]> = {};

  private tolak(field: string, pesan: string): void {
    (this.galat[field] ??= []).push(pesan);
  }

  wajibPilihan<T extends string>(nilai: unknown, field: string, pilihan: readonly T[]): T {
    if (typeof nilai !== "string" || !(pilihan as readonly string[]).includes(nilai)) {
      this.tolak(field, `wajib salah satu dari: ${pilihan.join(", ")}`);
      return pilihan[0] as T;
    }
    return nilai as T;
  }

  opsionalPilihan<T extends string>(
    nilai: unknown,
    field: string,
    pilihan: readonly T[],
  ): T | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    return this.wajibPilihan(nilai, field, pilihan);
  }

  wajibUuid(nilai: unknown, field: string): string {
    if (typeof nilai !== "string" || !POLA_UUID.test(nilai)) {
      this.tolak(field, "wajib berupa UUID");
      return "00000000-0000-0000-0000-000000000000";
    }
    return nilai;
  }

  opsionalUuid(nilai: unknown, field: string): string | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    return this.wajibUuid(nilai, field);
  }

  opsionalCacah(nilai: string | null, field: string, maks: number): number | null {
    if (nilai === null) return null;
    const angka = Number(nilai);
    if (!Number.isInteger(angka) || angka < 1 || angka > maks) {
      this.tolak(field, `wajib bilangan bulat antara 1 dan ${maks}`);
      return null;
    }
    return angka;
  }

  /**
   * The document text. THE ONLY LARGE INPUT THIS MODULE ACCEPTS, and therefore
   * the one that has to be bounded here rather than downstream: the ceiling is
   * a cost control, and a cost control applied after the work is not one.
   */
  teksDokumen(nilai: unknown, field: string): string {
    if (typeof nilai !== "string") {
      this.tolak(field, "wajib berupa teks");
      return "";
    }
    if (nilai.trim().length === 0) {
      this.tolak(field, "tidak boleh kosong");
      return "";
    }
    if (nilai.length > MAKS_KARAKTER_DOKUMEN) {
      this.tolak(field, `maksimal ${MAKS_KARAKTER_DOKUMEN} karakter`);
      return "";
    }
    return nilai;
  }

  selesai(): void {
    if (Object.keys(this.galat).length > 0) {
      throw badRequest("Data yang dikirim belum valid", this.galat);
    }
  }
}

/** A query-string filter value, trimmed and length-capped, or null. */
function q(nilai: string | undefined, maks = 200): string | null {
  if (nilai === undefined) return null;
  const bersih = nilai.trim();
  if (bersih === "") return null;
  return bersih.slice(0, maks);
}

async function badanJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  const isi = await c.req.json().catch(() => null);
  if (typeof isi !== "object" || isi === null || Array.isArray(isi)) {
    throw badRequest("Body wajib berupa objek JSON");
  }
  return isi as Record<string, unknown>;
}

export function createAiRoutes({
  engine,
  guards,
  pembatas,
  keyPrefix,
  batasRute,
}: AiRoutesDeps) {
  const { requireSession, requirePermission } = guards;

  const ekstraksi = [requireSession, requirePermission("ai.ekstraksi")] as const;
  const anomali = [requireSession, requirePermission("ai.anomali")] as const;

  // THE NAMESPACE IS NOT DECORATION, IT IS THE BUCKET.
  //
  // `rateLimit` keys on `<prefix>:<path>:<ip>`, and `applyHardening` already
  // registered the GLOBAL limiter with the app's own prefix. Registering a
  // second limiter here on that same prefix gives both of them THE SAME KEY:
  // every request then consumes the counter twice, and the tighter of the two
  // ceilings bites at half the request count it advertises. It was found by a
  // test asserting a 429 carried `kodeDomain`, and getting the middleware's
  // anonymous body instead -- the route limiter had fired at 10 requests
  // against a stated ceiling of 20, because the global limiter was counting
  // into the same key.
  //
  // A distinct suffix gives this router its own bucket, so the global ceiling
  // and the AI ceiling are two ceilings rather than one shared miscount.
  const prefixRute = `${keyPrefix ?? "tjsl"}:ai-rute`;
  const batasEkstraksi = rateLimit({
    limit: batasRute?.ekstraksi ?? BATAS_RUTE_EKSTRAKSI,
    windowSeconds: JENDELA_RUTE_DETIK,
    ...(pembatas ? { limiter: pembatas } : {}),
    keyPrefix: prefixRute,
  });
  const batasAnomali = rateLimit({
    limit: batasRute?.anomali ?? BATAS_RUTE_ANOMALI,
    windowSeconds: JENDELA_RUTE_DETIK,
    ...(pembatas ? { limiter: pembatas } : {}),
    keyPrefix: prefixRute,
  });

  return new Hono()
    /**
     * Whether the assistant is on, what model it uses, and what its ceilings
     * are. Session only, no permission: a screen has to be able to find out
     * that there is no button to draw, and knowing the layer is off is not a
     * privilege. With the flag off this is the endpoint that says so, which is
     * why it is not itself behind the flag.
     */
    .get("/status", requireSession, (c) => {
      const p = requirePrincipal(c);
      return c.json(engine.status(konteks(p)));
    })

    /**
     * Spec 12 priority 1. Reads a document and PROPOSES fields, each with a
     * confidence and the span it was read from. Saves nothing but the proposal
     * itself; the Maker edits and submits the ordinary form.
     *
     * NEVER ANSWERS 5xx FOR A MODEL FAILURE. A slow, absent or babbling
     * provider produces a 200 with `status: "GAGAL"` and an empty field list,
     * so the screen shows "assistant unavailable, fill it in yourself" instead
     * of an error dialog over a form that still works perfectly.
     */
    .post("/ekstraksi", ...ekstraksi, batasEkstraksi, async (c) => {
      const p = requirePrincipal(c);
      const body = await badanJson(c);
      const cek = new Pemeriksa();
      const input = {
        jenis: cek.wajibPilihan<JenisDokumen>(body.jenis, "jenis", JENIS_DOKUMEN),
        teks: cek.teksDokumen(body.teks, "teks"),
        konteksTipe: cek.opsionalPilihan(body.konteksTipe, "konteksTipe", KONTEKS_TIPE),
        konteksId: cek.opsionalUuid(body.konteksId, "konteksId"),
      };
      cek.selesai();
      return c.json(await engine.ekstrakDokumen(input, konteks(p)));
    })

    /**
     * Spec 12: "siapa yang mengonfirmasi". Records a person's decision about a
     * suggestion, on `ai_saran` and nowhere else. Confirming creates no
     * proposal and no mitra: the Maker does that by submitting the ordinary
     * form, which is the human act this whole phase is built around.
     */
    .post("/saran/:id/konfirmasi", ...ekstraksi, async (c) => {
      const p = requirePrincipal(c);
      const body = await badanJson(c);
      const cek = new Pemeriksa();
      const id = cek.wajibUuid(c.req.param("id"), "id");
      const keputusan = cek.wajibPilihan<KeputusanSaran>(
        body.keputusan,
        "keputusan",
        KEPUTUSAN,
      );
      cek.selesai();
      return c.json(await engine.konfirmasiSaran(id, keputusan, konteks(p)));
    })

    /**
     * Registered BEFORE `/anomali`, so the literal path is not shadowed. The
     * rule catalogue, so a page can render its columns and its weights before
     * a scan has run.
     */
    .get("/anomali/katalog", ...anomali, (c) => {
      const p = requirePrincipal(c);
      return c.json({ data: engine.katalogAnomali(konteks(p)) });
    })

    /**
     * Spec 12 priority 2. The review queue for one period, ordered worst first.
     * A GET, and an ordering aid: nothing here refuses a posting, a close or an
     * approval, and a flagged journal is a valid journal.
     */
    .get("/anomali", ...anomali, batasAnomali, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        periodeId: cek.wajibUuid(q(c.req.query("periodeId")), "periodeId"),
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        batas: cek.opsionalCacah(q(c.req.query("batas")), "batas", BATAS_TEMUAN_MAKS),
      };
      cek.selesai();
      return c.json(await engine.deteksiAnomali(filter, konteks(p)));
    })

    // The API's own 404 in the API's own envelope, rather than Hono's plain
    // text default: apps/web/src/api/http.ts branches on the JSON body.
    .all("/*", () => {
      throw notFound("Endpoint AI tidak ditemukan");
    });
}
