// Hono router for /tools (spec 9.6). The HTTP surface of the two diagnostic
// pages: the integrity health check and the receivable reconciliation.
//
// EVERY ROUTE HERE IS A GET, AND THAT IS THE WHOLE DESIGN. Spec 9.6 also names
// three import tools; those WRITE and are not in this module. What is here
// diagnoses and nothing else, so an Auditor can open every one of these and
// change nothing (spec 16 scenario 23) without relying on the read-only guard
// to save it. A POST added to this router would be the moment somebody
// invented a repair path around `postingEvent`.
//
// IT FOLLOWS modules/rka/routes.ts DELIBERATELY, and restates the four rules
// that file states, because they are what this file is FOR:
//
//   VALIDATE at the boundary, before any engine call, answering
//   `400 VALIDASI` with per-field detail and collecting EVERY bad field into
//   one response. Hand written rather than zod, because this repo carries no
//   schema library and modules/konfigurasi, modules/pumk, modules/nonpumk and
//   modules/rka all validate this way: adding a dependency is an API-WIDE
//   decision, not one this module gets to make on its own.
//
//   AUTHORISE with `requirePermission` using CANONICAL codes, so a typo is a
//   BOOT failure (`resolveRequiredPermissions`) and never a 403 that reads
//   like policy. `tools.integritas` (ADMIN_CABANG, ADMIN_PUSAT) gates the
//   health check; `tools.rekonsiliasi` (CHECKER, ADMIN_CABANG, ADMIN_PUSAT)
//   gates the reconciliation. They are NOT interchangeable: reading the books
//   for a difference and reading the database for corruption are different
//   jobs held by different people.
//
//   NEVER DECIDE BRANCH SCOPE. No handler reads `cabangId` and uses it as
//   authority. `konteks()` carries what the SESSION resolved; the engine
//   intersects the filter with it and REFUSES a branch outside it.
//
//   NEVER CATCH A DOMAIN ERROR. `ToolsError` travels to core/http.ts, which
//   maps the code, keeps it in the body as `kodeDomain`, and writes the DITOLAK
//   audit row spec 2 rule 5 requires.
import { Hono } from "hono";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import {
  BATAS_BARIS_MAKS,
  PEMERIKSAAN_INTEGRITAS,
  type KodePemeriksaan,
  type ToolsContext,
  type ToolsEngine,
} from "./contract";

export interface ToolsRoutesDeps {
  engine: ToolsEngine;
  guards: Guards;
}

/**
 * The session's own authority, translated into what the engine takes. Nothing
 * from the request reaches this.
 */
function konteks(principal: Principal): ToolsContext {
  return {
    userId: principal.userId,
    cabangId: principal.cabang.id,
    bumnId: principal.bumnId,
    permissions: principal.permissions,
    cabangDalamScope: principal.cabangTersedia.map((cabang) => cabang.id),
  };
}

const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KODE_PEMERIKSAAN = Object.values(PEMERIKSAAN_INTEGRITAS) as readonly KodePemeriksaan[];

class Pemeriksa {
  private readonly galat: Record<string, string[]> = {};

  private tolak(field: string, pesan: string): void {
    (this.galat[field] ??= []).push(pesan);
  }

  opsionalUuid(nilai: unknown, field: string): string | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    if (typeof nilai !== "string" || !POLA_UUID.test(nilai)) {
      this.tolak(field, "wajib berupa UUID");
      return null;
    }
    return nilai;
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

  opsionalBoolean(nilai: string | null, field: string, bawaan: boolean): boolean {
    if (nilai === null) return bawaan;
    if (nilai === "true") return true;
    if (nilai === "false") return false;
    this.tolak(field, "wajib true atau false");
    return bawaan;
  }

  wajibPilihan<T extends string>(nilai: unknown, field: string, pilihan: readonly T[]): T {
    if (typeof nilai !== "string" || !(pilihan as readonly string[]).includes(nilai)) {
      this.tolak(field, `wajib salah satu dari: ${pilihan.join(", ")}`);
      return pilihan[0] as T;
    }
    return nilai as T;
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

export function createToolsRoutes({ engine, guards }: ToolsRoutesDeps) {
  const { requireSession, requirePermission } = guards;

  const integritas = [requireSession, requirePermission("tools.integritas")] as const;
  const rekonsiliasi = [requireSession, requirePermission("tools.rekonsiliasi")] as const;

  return new Hono()
    /**
     * The catalogue, so a page can render its rows (and its "guarded by a
     * database constraint" notes) before any check has run.
     */
    .get("/integritas/katalog", ...integritas, async (c) => {
      const p = requirePrincipal(c);
      return c.json({ data: await engine.katalogPemeriksaan(konteks(p)) });
    })

    /**
     * Registered BEFORE `/integritas/:kode`, or `katalog` would be matched as
     * a check code and refused as unknown.
     *
     * Every check, each with its count, its verdict, and the offending rows
     * with their ids. A health check that reports "3 failures" without saying
     * WHICH rows is a page nobody can act on, which is why `baris` is part of
     * the answer rather than a second call.
     */
    .get("/integritas", ...integritas, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        batasBaris: cek.opsionalCacah(
          q(c.req.query("batasBaris")),
          "batasBaris",
          BATAS_BARIS_MAKS,
        ),
      };
      cek.selesai();
      return c.json(await engine.jalankanIntegritas(filter, konteks(p)));
    })

    /** One check, so a page can refresh a single row or widen its row limit. */
    .get("/integritas/:kode", ...integritas, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const kode = cek.wajibPilihan(c.req.param("kode"), "kode", KODE_PEMERIKSAAN);
      const filter = {
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        batasBaris: cek.opsionalCacah(
          q(c.req.query("batasBaris")),
          "batasBaris",
          BATAS_BARIS_MAKS,
        ),
      };
      cek.selesai();
      return c.json(await engine.jalankanPemeriksaan(kode, filter, konteks(p)));
    })

    /**
     * Spec 8.4 check 10 as an operator's page. `hanyaSelisih` defaults TRUE:
     * the page exists to show what is wrong, and the full portfolio is an
     * export, not an answer to "what do I fix".
     */
    .get("/rekonsiliasi/piutang", ...rekonsiliasi, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        hanyaSelisih: cek.opsionalBoolean(
          q(c.req.query("hanyaSelisih")),
          "hanyaSelisih",
          true,
        ),
        batasBaris: cek.opsionalCacah(
          q(c.req.query("batasBaris")),
          "batasBaris",
          BATAS_BARIS_MAKS,
        ),
      };
      cek.selesai();
      return c.json(await engine.rekonsiliasiPiutang(filter, konteks(p)));
    })

    // The API's own 404 in the API's own envelope, rather than Hono's plain
    // text default: apps/web/src/api/http.ts branches on the JSON body.
    .all("/*", () => {
      throw notFound("Endpoint tools tidak ditemukan");
    });
}
