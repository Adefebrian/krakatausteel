// Hono router for /laporan: THIRTY OF SPEC 10'S THIRTY-ONE REPORTS.
//
// The seven accounting statements (16 to 20, 22, 23) reach `engine`; the other
// twenty-three -- the eleven PUMK reports of 10.1, the four Non PUMK reports of
// 10.2, Rekap Jurnal, and the seven of 10.4 -- reach `operasional`. Report 24
// (RKA versus Realisasi) is NOT here: it is modules/rka's own comparison and
// reaches `rka_detail` through that module's repository, so registering a path
// for it here would put this file in charge of a report it cannot compute.
//
// TWO ENGINES, ONE ROUTER, ONE SET OF RULES. The split is where the FIGURES
// come from and stops there: `konteks()`, `Pemeriksa`, the single `lihat` guard
// pair and the refusal-passthrough below are shared by all thirty, so a report
// added to either engine cannot arrive with its own idea of branch scope, its
// own permission code, or its own error envelope.
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
import {
  BATAS_AUDIT_TRAIL_MAKS,
  type HasilAudit,
  type LaporanOperasionalEngine,
  type ModeLaporan,
} from "./kontrak-operasional";
import type { LaporanBaca } from "./baca";

export interface LaporanRoutesDeps {
  engine: LaporanEngine;
  /** The other twenty-three reports of spec 10; see ./engine-operasional.ts. */
  operasional: LaporanOperasionalEngine;
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
const POLA_TANGGAL_RUTE = /^\d{4}-\d{2}-\d{2}$/;
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

  /**
   * `mode` is BULANAN or KUMULATIF_YTD and NOTHING ELSE. Rejected at the
   * boundary rather than defaulted, because a screen that sent `ytd` and got a
   * monthly page would be wrong in a way no total on it could reveal.
   */
  opsionalMode(nilai: string | null, field: string): ModeLaporan | undefined {
    if (nilai === null) return undefined;
    if (nilai === "BULANAN" || nilai === "KUMULATIF_YTD") return nilai;
    this.tolak(field, "wajib BULANAN atau KUMULATIF_YTD");
    return undefined;
  }

  wajibTanggal(nilai: string | null, field: string): string {
    if (nilai === null || !POLA_TANGGAL_RUTE.test(nilai)) {
      this.tolak(field, "wajib tanggal YYYY-MM-DD");
      return "";
    }
    return nilai;
  }

  /** A bounded positive integer, or the default. Used for paging only. */
  opsionalCacah(nilai: string | null, field: string, min: number, maks: number): number | null {
    if (nilai === null) return null;
    const angka = Number(nilai);
    if (!Number.isInteger(angka) || angka < min || angka > maks) {
      this.tolak(field, `wajib bilangan bulat antara ${min} dan ${maks}`);
      return null;
    }
    return angka;
  }

  satuDari<T extends string>(nilai: string | null, field: string, pilihan: readonly T[]): T | null {
    if (nilai === null) return null;
    if ((pilihan as readonly string[]).includes(nilai)) return nilai as T;
    this.tolak(field, `wajib salah satu dari ${pilihan.join(", ")}`);
    return null;
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
interface Kueri {
  req: { query: (k: string) => string | undefined };
}

/**
 * THE COLLECTING FORM, which takes the checker instead of owning it.
 *
 * A REPORT THAT TAKES A THIRD PARAMETER MUST STILL REPORT ALL THREE FIELDS.
 * `filterLaporan` used to build its own `Pemeriksa` and call `selesai()`
 * itself, so `GET /laporan/kartu-piutang?periodeId=x&cabangId=y&mitraId=z` with
 * all three malformed answered with TWO of them and the caller learned about
 * the third only on the next round trip. That contradicted this file's own
 * stated rule ("collecting every bad field into one response") and it was
 * measured, not theorised: ./laporan-rute-operasional.test.ts pins all three.
 */
function bacaFilterLaporan(
  cek: Pemeriksa,
  c: Kueri,
): { periodeId: string; cabangId: string | null } {
  return {
    periodeId: cek.wajibUuid(q(c.req.query("periodeId")), "periodeId"),
    cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
  };
}

function filterLaporan(c: Kueri): { periodeId: string; cabangId: string | null } {
  const cek = new Pemeriksa();
  const filter = bacaFilterLaporan(cek, c);
  cek.selesai();
  return filter;
}

/**
 * The same two filters plus spec 10.3 report 24's `mode`, which the twenty-one
 * period-scoped operational reports share.
 *
 * `mode` ABSENT IS BULANAN, decided by the engine and not here, so a caller
 * that omits it gets the same window whichever route they came in through.
 */
function filterPeriodeMode(
  c: Kueri,
): { periodeId: string; cabangId: string | null; mode?: ModeLaporan } {
  const cek = new Pemeriksa();
  const filter = {
    ...bacaFilterLaporan(cek, c),
    mode: cek.opsionalMode(q(c.req.query("mode")), "mode"),
  };
  cek.selesai();
  return filter;
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function createLaporanRoutes({ engine, operasional, baca, guards }: LaporanRoutesDeps) {
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
      // ONE checker for all three fields, so a request with three malformed
      // parameters is answered once with three of them.
      const cek = new Pemeriksa();
      const filter = {
        ...bacaFilterLaporan(cek, c),
        akunId: cek.wajibUuid(q(c.req.query("akunId")), "akunId"),
      };
      cek.selesai();
      return c.json(await engine.bukuBesar(filter, konteks(p)));
    })

    // --------------------------------------------------- 23. Neraca Lajur
    //
    // Six columns, three pairs, and the footing must balance in all three. The
    // engine refuses to return one that does not.
    .get("/neraca-lajur", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await engine.neracaLajur(filterLaporan(c), konteks(p)));
    })

    // ================================================================= 10.1
    //
    // THE ELEVEN PUMK REPORTS. Reports 1, 2, 3 and 7 are four views of ONE
    // figure -- the disbursement lines of `v_ledger_baris` -- and reports 8,
    // 10, 11 and 28 are four views of ONE artefact, `kolektibilitas_snapshot`.
    // They are separate PATHS and not separate READS, which is what lets the
    // tests assert that they agree with each other instead of trusting eight
    // implementations.

    // ------------------------------------------- 1. Realisasi per wilayah
    .get("/realisasi-wilayah", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.realisasiWilayah(filterPeriodeMode(c), konteks(p)));
    })

    // --------------------------------------------- 2. Realisasi per sektor
    .get("/realisasi-sektor", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.realisasiSektor(filterPeriodeMode(c), konteks(p)));
    })

    // ------------------------------------------ 3. Penyaluran Nasional
    .get("/penyaluran-nasional", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.penyaluranNasional(filterPeriodeMode(c), konteks(p)));
    })

    // ----------------------------------------- 4. Penerimaan Angsuran
    .get("/penerimaan-angsuran", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.penerimaanAngsuran(filterPeriodeMode(c), konteks(p)));
    })

    // ----------------------------------------------------- 5. Jatuh Tempo
    //
    // THE ONLY REPORT WHOSE WINDOW IS NOT A PERIOD. Spec 10.1 report 5 asks
    // for "rentang tanggal jatuh tempo ke depan", so it takes two dates; the
    // engine refuses a window whose end precedes its start rather than
    // returning the empty worksheet that reads as "nothing falls due".
    .get("/jatuh-tempo", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        dariTanggal: cek.wajibTanggal(q(c.req.query("dariTanggal")), "dariTanggal"),
        sampaiTanggal: cek.wajibTanggal(q(c.req.query("sampaiTanggal")), "sampaiTanggal"),
        cabangId: cek.opsionalUuid(q(c.req.query("cabangId")), "cabangId"),
      };
      cek.selesai();
      return c.json(await operasional.jatuhTempo(filter, konteks(p)));
    })

    // ---------------------------------------------- 6. Rekap Permohonan
    .get("/rekap-permohonan", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.rekapPermohonanPumk(filterPeriodeMode(c), konteks(p)));
    })

    // ------------------------------------------------ 7. Rekap Realisasi
    //
    // No `mode`: this report is a table of MONTHS and is always the financial
    // year to the reported one. The engine forces it, so a caller that sends
    // `mode=BULANAN` still gets the report spec 10.1 describes.
    .get("/rekap-realisasi", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.rekapRealisasiPumk(filterLaporan(c), konteks(p)));
    })

    // -------------------------------------------------- 8. Aging Piutang
    .get("/aging-piutang", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.agingPiutang(filterLaporan(c), konteks(p)));
    })

    // -------------------------------------------------- 9. Kartu Piutang
    .get("/kartu-piutang", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        ...bacaFilterLaporan(cek, c),
        mitraId: cek.wajibUuid(q(c.req.query("mitraId")), "mitraId"),
      };
      cek.selesai();
      return c.json(await operasional.kartuPiutang(filter, konteks(p)));
    })

    // ------------------------------------------------- 10. Kolektibilitas
    .get("/kolektibilitas", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.kolektibilitas(filterLaporan(c), konteks(p)));
    })

    // ------------------------------------ 11. Perpindahan Kolektibilitas
    .get("/perpindahan-kolektibilitas", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.perpindahanKolektibilitas(filterLaporan(c), konteks(p)));
    })

    // ================================================================= 10.2
    //
    // ----------------------------------------- 12. Penyaluran Non PUMK
    .get("/penyaluran-non-pumk", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.penyaluranNonPumk(filterPeriodeMode(c), konteks(p)));
    })

    // ---------------------------------------------------- 13. Rekap Bidang
    .get("/rekap-bidang", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.rekapBidang(filterPeriodeMode(c), konteks(p)));
    })

    // ---------------------------------------------------- 14. Pemetaan SDG
    .get("/pemetaan-sdg", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.pemetaanSdg(filterPeriodeMode(c), konteks(p)));
    })

    // -------------------------------------------------- 15. Monitoring LPJ
    .get("/monitoring-lpj", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.monitoringLpj(filterPeriodeMode(c), konteks(p)));
    })

    // ================================================== 21. Rekap Jurnal
    .get("/rekap-jurnal", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.rekapJurnal(filterPeriodeMode(c), konteks(p)));
    })

    // ================================================================= 10.4
    //
    // --------------------------------------------- 25 and 26. Portal
    //
    // TWO PATHS, ONE HANDLER, because they are one report over two values of
    // `portal_submission.jenis`. A `jenis` QUERY PARAMETER would have been the
    // obvious alternative and is worse: the catalogue would carry one entry
    // for two reports the specification numbers separately, and a screen would
    // have to know that one path means two menu items.
    .get("/portal-pumk", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(
        await operasional.portal({ ...filterPeriodeMode(c), jenis: "PUMK" }, konteks(p)),
      );
    })

    .get("/portal-non-pumk", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(
        await operasional.portal({ ...filterPeriodeMode(c), jenis: "NON_PUMK" }, konteks(p)),
      );
    })

    // ------------------------------------------------ 27. Demografi Mitra
    .get("/demografi-mitra", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.demografiMitra(filterLaporan(c), konteks(p)));
    })

    // ----------------------------------------- 28. Perhitungan Penyisihan
    .get("/perhitungan-penyisihan", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.perhitunganPenyisihan(filterLaporan(c), konteks(p)));
    })

    // ---------------------------------------------- 29. Beban Penyisihan
    .get("/beban-penyisihan", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.bebanPenyisihan(filterPeriodeMode(c), konteks(p)));
    })

    // -------------------------------------------------- 30. Akrual Jasa
    .get("/akrual-jasa", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      return c.json(await operasional.akrualJasa(filterLaporan(c), konteks(p)));
    })

    // -------------------------------------------------- 31. Audit Trail
    //
    // PAGED, because an audit log is unbounded by construction and a report
    // that returned all of it would be a denial of service against the
    // reader's own browser. The engine caps `batas` again on its own evidence:
    // this check is the boundary's, not the engine's.
    .get("/audit-trail", ...lihat, async (c) => {
      const p = requirePrincipal(c);
      const cek = new Pemeriksa();
      const filter = {
        dariTanggal: cek.wajibTanggal(q(c.req.query("dariTanggal")), "dariTanggal"),
        sampaiTanggal: cek.wajibTanggal(q(c.req.query("sampaiTanggal")), "sampaiTanggal"),
        userId: cek.opsionalUuid(q(c.req.query("userId")), "userId"),
        entitas: q(c.req.query("entitas"), 100),
        aksi: q(c.req.query("aksi"), 100),
        hasil: cek.satuDari<HasilAudit>(q(c.req.query("hasil")), "hasil", [
          "SUKSES",
          "DITOLAK",
        ]),
        batas: cek.opsionalCacah(q(c.req.query("batas")), "batas", 1, BATAS_AUDIT_TRAIL_MAKS),
        offset: cek.opsionalCacah(q(c.req.query("offset")), "offset", 0, 1_000_000),
      };
      cek.selesai();
      return c.json(await operasional.auditTrail(filter, konteks(p)));
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
