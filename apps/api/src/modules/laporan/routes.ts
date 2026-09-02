// Hono router for /laporan (spec 10, reports 16 to 20, 22 and 23). The HTTP
// surface of the core accounting statements: the chart of accounts, Laporan
// Aktivitas, Laporan Arus Kas, Laporan Posisi Keuangan, Laporan Perubahan Aset
// Neto, Buku Besar and Neraca Lajur.
//
// IT FOLLOWS modules/pumk/routes.ts AND modules/nonpumk/routes.ts, and departs
// from them in exactly one way that matters: THERE IS NO WRITE PATH HERE AT
// ALL. Not one route below is anything but a GET, and that is structural rather
// than incidental -- the engine this file calls takes no journal port and no
// audit port (see ./contract.ts and ./index.ts), so there is nothing in the
// module to write with. Spec 16 scenario 23 says an Auditor opens every report
// and finds no control that changes data; here that is not a promise about the
// UI, it is a property of the module. A route added later that needed a write
// path would be the point at which this stopped being true, and it must not be
// added to make a route convenient.
//
// THE OTHER FOUR RULES, restated because they are what this file is FOR:
//
//   VALIDATE at the boundary. Every handler checks its query string BEFORE any
//   engine call and answers `400 VALIDASI` with per-field detail, collecting
//   every bad field into one response. Hand written rather than zod, because
//   this repo carries no schema library and four other modules validate this
//   way: adding a dependency is an API-WIDE decision, not one this module gets
//   to make on its own.
//
//   AUTHORISE with `requirePermission`, using CANONICAL codes from
//   modules/auth's catalogue. An unknown code throws at ROUTE-REGISTRATION time
//   (`resolveRequiredPermissions`), so a typo is a boot failure and never a 403
//   that reads like policy. There is ONE code here, `laporan.view`, which spec
//   2 grants to all six roles: the specification gives one reporting privilege,
//   and inventing `laporan.posisi_keuangan.view` would be this module answering
//   an authorisation question the specification already answered.
//
//   NEVER DECIDE BRANCH SCOPE. `konteks()` carries the branches the SESSION
//   resolved; the engine compares a requested branch against them and REFUSES
//   one outside, rather than quietly narrowing it. That difference is the whole
//   of spec 16 scenario 24 for a report: an empty statement reads as "that
//   branch did nothing", which is a wrong answer presented as a right one.
//
//   NEVER CATCH A DOMAIN ERROR. `LaporanError` travels to core/http.ts's
//   handler, which maps each code onto its HTTP status and keeps the code in
//   the body as `kodeDomain`. That matters more here than anywhere: this
//   module's refusals ARE its product. "The template has no active line", "this
//   account maps onto no line", "this cash movement has no classification",
//   "this closed period was never frozen" and "the statement does not balance"
//   are each a specific thing an operator must fix, and a try/catch here would
//   flatten all five into one anonymous 500.
//
// TWO THINGS SPEC 10 PUTS ON EVERY REPORT, AND WHERE THEY ARE:
//
//   THE HEADER. "nama BUMN, nama laporan, periode, cabang, tanggal cetak, dan
//   nama pencetak", plus which of spec 10's two data paths produced the page.
//   Built by the ENGINE, not here: `dicetakOleh` is `app_user.nama` read from
//   the database for `ctx.userId`, so a caller cannot print somebody else's
//   name onto a statement by sending it, and `tanggalCetak` comes from the
//   engine's injected clock so a printed page is reproducible in a test.
//
//   THE PERIOD AND BRANCH FILTERS. `periodeId` selects the month; `cabangId`
//   ABSENT is spec 10's Semua Cabang and is allowed only to a scope covering
//   every branch. `GET /laporan/cabang` says which branches this caller may
//   pick and whether Semua Cabang is among them, so the screen offers exactly
//   what the engine would accept.
//
// AND THE ONE PARAMETER THIS FILE REFUSES TO HAVE. There is NO way to ask for
// a particular data SOURCE. A CLOSED period is read from the frozen
// `saldo_akun_periode` and an OPEN one is computed live from `v_ledger_baris`;
// the engine decides that from the period's own status and says which it used
// in `header.sumberData`. A parameter that overrode it would let somebody
// recompute a closed month from today's ledger and present the result as the
// statement -- invariant 14 broken, and undetectable from the printed page,
// which is precisely why the field is reported rather than accepted.
import { Hono } from "hono";
import { badRequest, notFound } from "../../core/http";
import { requirePrincipal, type Guards, type Principal } from "../../core/principal";
import type { LaporanContext, LaporanEngine } from "./contract";
import type { LaporanBaca } from "./baca";

export interface LaporanRoutesDeps {
  engine: LaporanEngine;
  baca: LaporanBaca;
  guards: Guards;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The session's own authority, translated into what the engine takes. Nothing
 * from the request reaches this: `cabangId` is the user's home branch and
 * `cabangDalamScope` is what the session resolved, so a caller cannot widen
 * their own scope by sending a branch id, and `userId` is what the header's
 * `dicetakOleh` is resolved from.
 */
function konteks(principal: Principal): LaporanContext {
  return {
    userId: principal.userId,
    cabangId: principal.cabang.id,
    bumnId: principal.bumnId,
    permissions: principal.permissions,
    cabangDalamScope: principal.cabangTersedia.map((cabang) => cabang.id),
  };
}

// ---------------------------------------------------------------------------
// Boundary validation
// ---------------------------------------------------------------------------

const POLA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAHUN_MIN = 2000;
const TAHUN_MAX = 2100;

class Pemeriksa {
  private readonly galat: Record<string, string[]> = {};

  private tolak(field: string, pesan: string): void {
    (this.galat[field] ??= []).push(pesan);
  }

  wajibUuid(nilai: unknown, field: string): string {
    if (typeof nilai !== "string" || !POLA_UUID.test(nilai)) {
      this.tolak(field, "wajib berupa UUID");
      return "";
    }
    return nilai;
  }

  opsionalUuid(nilai: unknown, field: string): string | null {
    if (nilai === undefined || nilai === null || nilai === "") return null;
    return this.wajibUuid(nilai, field);
  }

  opsionalTahun(nilai: string | null, field: string): number | null {
    if (nilai === null) return null;
    const angka = Number(nilai);
    if (!Number.isInteger(angka) || angka < TAHUN_MIN || angka > TAHUN_MAX) {
      this.tolak(field, `wajib tahun antara ${TAHUN_MIN} dan ${TAHUN_MAX}`);
      return null;
    }
    return angka;
  }

  opsionalBoolean(nilai: unknown, field: string, bawaan: boolean): boolean {
    if (nilai === undefined || nilai === null || nilai === "") return bawaan;
    if (nilai === true || nilai === "true") return true;
    if (nilai === false || nilai === "false") return false;
    this.tolak(field, "wajib true atau false");
    return bawaan;
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

/**
 * The two filters spec 10's preamble puts above every statement, parsed once.
 *
 * `cabangId` ABSENT means Semua Cabang, and that is passed through as `null`
 * rather than defaulted to the caller's own branch. Defaulting would be worse
 * than a refusal: a branch user would print a page headed "Semua Cabang" that
 * in fact showed one branch, and nothing on the paper would say so.
 */
function filterLaporan(c: {
  req: { query: (k: string) => string | undefined };
}): { periodeId: string; cabangId: string | null } {
  const cek = new Pemeriksa();
  const filter = {
    periodeId: cek.wajibUuid(q(c.req.query("periodeId")), "periodeId"),
    cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
  };
  cek.selesai();
  return filter;
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function createLaporanRoutes({ engine, baca, guards }: LaporanRoutesDeps) {
  const { requireSession, requirePermission } = guards;

  /**
   * The ONLY guard set in this file, and there is no `ubah(...)` counterpart
   * because there is nothing to change. `rejectReadOnlyMutation` is absent for
   * the same reason: it rejects non-GET requests, and every route here is a
   * GET, so it would guard nothing. The global guard in core/app.ts still
   * refuses a read-only role any non-GET reaching this prefix, which is what
   * answers a POST to a report path.
   */
  const lihat = [requireSession, requirePermission("laporan.view")] as const;

  return new Hono()
    // ------------------------------------------------------------- referensi
    //
    // What a report screen loads before it can ask for anything: which reports
    // exist here, which periods may be chosen and what each one's status is,
    // and which branches this caller may report on.
    .get("/katalog", ...lihat, async (c) => {
      return c.json({ data: await baca.katalog(konteks(requirePrincipal(c))) });
    })

    .get("/periode", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const tahun = cek.opsionalTahun(q(c.req.query("tahun")), "tahun");
      cek.selesai();
      return c.json({ data: await baca.daftarPeriode({ tahun }, konteks(p)) });
    })

    .get("/cabang", ...lihat, async (c) => {
      return c.json(await baca.filterCabang(konteks(requirePrincipal(c))));
    })

    // -------------------------------------------------- 16. Bagan Akun
    //
    // The one report with no period: a chart of accounts is a structure, not a
    // balance. `hanyaAktif` defaults to FALSE because spec 10.3 report 16 asks
    // for a `status` column, which only means something if inactive accounts
    // are shown with it.
    .get("/bagan-akun", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const hanyaAktif = cek.opsionalBoolean(q(c.req.query("hanyaAktif")), "hanyaAktif", false);
      cek.selesai();
      return c.json(await engine.baganAkun({ hanyaAktif }, konteks(p)));
    })

    // -------------------------------------------------- 17. Laporan Aktivitas
    //
    // Cumulative from the first day of the financial year to the period end,
    // with the comparative column for the same span one year earlier. Where the
    // financial year starts is `akuntansi.tahun_buku_mulai_bulan`, read by the
    // engine and never assumed to be January.
    .get("/aktivitas", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.laporanAktivitas(filterLaporan(c), konteks(p)));
    })

    // --------------------------------------------------- 18. Laporan Arus Kas
    //
    // Direct method. Kas Akhir here must equal `kasDanSetaraKas` in report 19
    // for the same period and the same branch filter; that identity is spec
    // 10.3 report 18's own words and it is asserted over HTTP in
    // ./laporan-rute.test.ts rather than only against the engine.
    .get("/arus-kas", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.laporanArusKas(filterLaporan(c), konteks(p)));
    })

    // -------------------------------------------- 19. Laporan Posisi Keuangan
    //
    // Total Aset = Total Liabilitas + Aset Neto, at the period end, with the
    // comparative at the end of the preceding financial year. The engine
    // REFUSES to print a statement that does not balance
    // (`LAPORAN_TIDAK_BALANCE`) rather than showing the discrepancy.
    .get("/posisi-keuangan", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.laporanPosisiKeuangan(filterLaporan(c), konteks(p)));
    })

    // --------------------------------------- 20. Laporan Perubahan Aset Neto
    .get("/perubahan-aset-neto", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.laporanPerubahanAsetNeto(filterLaporan(c), konteks(p)));
    })

    // ---------------------------------------------------- 22. Buku Besar
    //
    // The only report that takes an account. Every movement carries `jurnalId`
    // and `jurnalBarisId` so the screen can drill down to the entry itself;
    // spec 11's "angka yang tidak bisa ditelusuri asalnya tidak dipercaya user"
    // is the reason, and returning only `noJurnal` would force a search that
    // can find the wrong entry.
    .get("/buku-besar", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const dasar = filterLaporan(c);
      const cek = new Pemeriksa();
      const akunId = cek.wajibUuid(q(c.req.query("akunId")), "akunId");
      cek.selesai();
      return c.json(await engine.bukuBesar({ ...dasar, akunId }, konteks(p)));
    })

    // --------------------------------------------------- 23. Neraca Lajur
    //
    // Six columns, three pairs, and the footing must balance in all three. The
    // engine refuses to return one that does not.
    .get("/neraca-lajur", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.neracaLajur(filterLaporan(c), konteks(p)));
    })

    // A 404 that is the API's own, in the API's own envelope, rather than
    // Hono's plain-text default: apps/web/src/api/http.ts branches on the JSON
    // body and a bare text 404 would be reported as "the server did not answer"
    // instead of "that path does not exist".
    //
    // `.all` rather than `.get`: a POST to a report path that does not exist is
    // still a 404, and one to a path that DOES exist never reaches here because
    // no method other than GET is registered on any of them.
    .all("/*", () => {
      throw notFound("Endpoint laporan tidak ditemukan");
    });
}
