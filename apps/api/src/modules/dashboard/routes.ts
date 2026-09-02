// Hono router for /dashboard (spec 11). Three GETs: the period picker, the
// whole page, and the rows behind one number.
//
// EVERY ROUTE HERE IS A GET, AND THAT IS THE WHOLE DESIGN. A dashboard is the
// one screen in the system with no reason ever to write, and the engine behind
// these routes takes no journal port and no audit port, so a POST added to this
// router would not merely be out of place: there would be nothing for it to
// call.
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
//   policy. `dashboard.view` gates all three routes and is held by every role;
//   the two evidence codes (`admin.rka.view`, `admin.closing.view`) are NOT
//   route guards, because gating the PAGE on them would hide the ten metrics a
//   Maker may see in order to protect the two it may not. The engine blanks
//   those two instead, with `IZIN_TIDAK_DIMILIKI` (contract rule 4).
//
//   NEVER DECIDE BRANCH SCOPE. No handler reads `cabangId` and uses it as
//   authority. `konteks()` carries what the SESSION resolved; the engine
//   intersects the filter with it and REFUSES a branch outside it.
//
//   NEVER CATCH A DOMAIN ERROR. `DashboardError` travels to core/http.ts,
//   which maps the code, keeps it in the body as `kodeDomain`, and writes the
//   DITOLAK audit row spec 2 rule 5 requires.
import { Hono } from "hono";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import {
  BATAS_RINCIAN_MAKS,
  type DashboardContext,
  type DashboardEngine,
} from "./contract";

export interface DashboardRoutesDeps {
  engine: DashboardEngine;
  guards: Guards;
}

/**
 * The session's own authority, translated into what the engine takes. Nothing
 * from the request reaches this.
 */
function konteks(principal: Principal): DashboardContext {
  return {
    userId: principal.userId,
    cabangId: principal.cabang.id,
    bumnId: principal.bumnId,
    permissions: principal.permissions,
    cabangDalamScope: principal.cabangTersedia.map((cabang) => cabang.id),
  };
}

const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Pemeriksa {
  private readonly galat: Record<string, string[]> = {};

  private tolak(field: string, pesan: string): void {
    (this.galat[field] ??= []).push(pesan);
  }

  opsionalUuid(nilai: string | null, field: string): string | null {
    if (nilai === null) return null;
    if (!POLA_UUID.test(nilai)) {
      this.tolak(field, "wajib berupa UUID");
      return null;
    }
    return nilai;
  }

  opsionalCacah(
    nilai: string | null,
    field: string,
    min: number,
    maks: number,
  ): number | null {
    if (nilai === null) return null;
    const angka = Number(nilai);
    if (!Number.isInteger(angka) || angka < min || angka > maks) {
      this.tolak(field, `wajib bilangan bulat antara ${min} dan ${maks}`);
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

  wajibTeks(nilai: string | null, field: string): string {
    if (nilai === null) {
      this.tolak(field, "wajib diisi");
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

export function createDashboardRoutes({ engine, guards }: DashboardRoutesDeps) {
  const { requireSession, requirePermission } = guards;

  const lihat = [requireSession, requirePermission("dashboard.view")] as const;

  return new Hono()
    /**
     * The period picker. Registered BEFORE `/`, and separate from the summary
     * because the page has to be able to offer months WITHOUT computing one:
     * loading every metric just to fill a dropdown is the kind of default that
     * makes a landing screen slow for everyone.
     */
    .get("/periode", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const tahun = cek.opsionalCacah(q(c.req.query("tahun")), "tahun", 1900, 2200);
      cek.selesai();
      return c.json({ data: await engine.daftarPeriode({ tahun }, konteks(p)) });
    })

    /**
     * The rows behind ONE number. `kunci` is a value the summary emitted, so a
     * client never constructs one; an unknown key is refused with
     * `RINCIAN_TIDAK_DIKENAL` rather than answered with an empty list.
     *
     * A QUERY PARAMETER, not a path segment, because the keys carry a colon
     * (`metrik:OUTSTANDING_PUMK`) and a path that has to be escaped by every
     * caller is a path that will eventually be escaped wrong.
     */
    .get("/rincian", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const kunci = cek.wajibTeks(q(c.req.query("kunci")), "kunci");
      const filter = {
        periodeId: cek.opsionalUuid(q(c.req.query("periodeId")), "periodeId"),
        tahun: cek.opsionalCacah(q(c.req.query("tahun")), "tahun", 1900, 2200),
        bulan: cek.opsionalCacah(q(c.req.query("bulan")), "bulan", 1, 12),
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        batasBaris: cek.opsionalCacah(
          q(c.req.query("batasBaris")),
          "batasBaris",
          1,
          BATAS_RINCIAN_MAKS,
        ),
      };
      cek.selesai();
      return c.json(await engine.rincian(kunci, filter, konteks(p)));
    })

    /**
     * Spec 11's whole page in ONE call. One request rather than eleven, because
     * every figure on it has to describe the SAME period and the same branch
     * scope: eleven independent requests can straddle a close and put a frozen
     * KPI next to a live one on the same screen.
     */
    .get("/", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        periodeId: cek.opsionalUuid(q(c.req.query("periodeId")), "periodeId"),
        tahun: cek.opsionalCacah(q(c.req.query("tahun")), "tahun", 1900, 2200),
        bulan: cek.opsionalCacah(q(c.req.query("bulan")), "bulan", 1, 12),
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
        hanyaMilikSaya: cek.opsionalBoolean(
          q(c.req.query("hanyaMilikSaya")),
          "hanyaMilikSaya",
          false,
        ),
      };
      cek.selesai();
      return c.json(await engine.ringkasan(filter, konteks(p)));
    })

    // The API's own 404 in the API's own envelope, rather than Hono's plain
    // text default: apps/web/src/api/http.ts branches on the JSON body.
    .all("/*", () => {
      throw notFound("Endpoint dashboard tidak ditemukan");
    });
}
