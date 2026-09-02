// Typed client for the accounting report catalogue, spec 10.3 reports 16 to
// 20, 22 and 23.
//
// TYPES COME FROM THE CONTRACT, NOT FROM THIS FILE, the way ./pumk.ts,
// ./nonpumk.ts and ./rka.ts already do. `import type` is erased by Bun's
// transpiler, so no server code reaches the bundle, and a drift in the
// contract becomes a type error here instead of a wrong number on a page an
// accountant signs.
//
// EVERY ROUTE UNDER `/laporan` IS A GET, and this file has no non GET function
// on purpose. A report that could write would defeat the one guarantee spec 16
// scenario 23 asks of it: an Auditor opens all of them and finds nothing that
// changes anything.
//
// NO EXPORT TO EXCEL OR PDF LIVES HERE. The specification requires both, the
// permission does not exist yet, and a client function for an endpoint that
// does not exist would put a button on a screen that lies about what it does.
import type {
  FilterBukuBesar,
  FilterLaporan,
  HeaderLaporan,
  LaporanAktivitas,
  LaporanArusKas,
  LaporanBaganAkun,
  LaporanBukuBesar,
  LaporanNeracaLajur,
  LaporanPerubahanAsetNeto,
  LaporanPosisiKeuangan,
  Angka,
  BarisArusKas,
  BarisBaganAkun,
  BarisBukuBesar,
  BarisNeracaLajur,
  BarisPerubahanAsetNeto,
  BarisStatement,
  KolomPembanding,
  SeksiAktivitas,
  SeksiArusKas,
  StatusPeriode,
  SumberData,
  SumberTemplate,
} from "@krakatausteel/api/src/modules/laporan/contract";
import type {
  EntriKatalogLaporan,
  FilterCabangLaporan,
  OpsiCabangLaporan,
  OpsiPeriode,
} from "@krakatausteel/api/src/modules/laporan/baca";
import { apiGet, buildQuery } from "./http";

export type {
  Angka,
  BarisArusKas,
  BarisBaganAkun,
  BarisBukuBesar,
  BarisNeracaLajur,
  BarisPerubahanAsetNeto,
  BarisStatement,
  EntriKatalogLaporan,
  FilterBukuBesar,
  FilterCabangLaporan,
  FilterLaporan,
  HeaderLaporan,
  KolomPembanding,
  LaporanAktivitas,
  LaporanArusKas,
  LaporanBaganAkun,
  LaporanBukuBesar,
  LaporanNeracaLajur,
  LaporanPerubahanAsetNeto,
  LaporanPosisiKeuangan,
  OpsiCabangLaporan,
  OpsiPeriode,
  SeksiAktivitas,
  SeksiArusKas,
  StatusPeriode,
  SumberData,
  SumberTemplate,
};

interface Daftar<T> {
  data: T[];
}

// ---------------------------------------------------------------------------
// Referensi: what every report screen loads before it can ask for anything
// ---------------------------------------------------------------------------

export function katalogLaporan(): Promise<Daftar<EntriKatalogLaporan>> {
  return apiGet<Daftar<EntriKatalogLaporan>>("/laporan/katalog");
}

/**
 * The period picker. Each entry carries its status and the source a report for
 * it would read, which is what lets a screen say "frozen" or "live" BEFORE the
 * report is asked for rather than after.
 */
export function periodeLaporan(tahun?: number | null): Promise<Daftar<OpsiPeriode>> {
  return apiGet<Daftar<OpsiPeriode>>(`/laporan/periode${buildQuery({ tahun })}`);
}

/**
 * The branch filter, and whether this caller may ask for all of them.
 * `bolehSemuaCabang` is the server's answer, never the screen's guess: a
 * branch user offered a Semua Cabang option would print a page headed with it
 * that in fact showed one branch.
 */
export function cabangLaporan(): Promise<FilterCabangLaporan> {
  return apiGet<FilterCabangLaporan>("/laporan/cabang");
}

// ---------------------------------------------------------------------------
// The reports
// ---------------------------------------------------------------------------

/** 16. The chart of accounts. The one report with no period: a chart is a
 *  structure, not a balance. */
export function baganAkun(hanyaAktif = false): Promise<LaporanBaganAkun> {
  return apiGet<LaporanBaganAkun>(`/laporan/bagan-akun${buildQuery({ hanyaAktif })}`);
}

/** 17. Cumulative from the first day of the financial year to the period end,
 *  beside the same SPAN one year earlier. */
export function laporanAktivitas(filter: FilterLaporan): Promise<LaporanAktivitas> {
  return apiGet<LaporanAktivitas>(`/laporan/aktivitas${queryLaporan(filter)}`);
}

/** 18. Direct method. Its comparative is a SPAN, like report 17's. */
export function laporanArusKas(filter: FilterLaporan): Promise<LaporanArusKas> {
  return apiGet<LaporanArusKas>(`/laporan/arus-kas${queryLaporan(filter)}`);
}

/** 19. Position at the period end, beside the POINT at the end of the
 *  preceding financial year. Not the same kind of comparative as 17 and 18,
 *  and the screens say so rather than making them look alike. */
export function laporanPosisiKeuangan(
  filter: FilterLaporan,
): Promise<LaporanPosisiKeuangan> {
  return apiGet<LaporanPosisiKeuangan>(`/laporan/posisi-keuangan${queryLaporan(filter)}`);
}

/** 20. Saldo awal, perubahan, saldo akhir per aset neto category. */
export function laporanPerubahanAsetNeto(
  filter: FilterLaporan,
): Promise<LaporanPerubahanAsetNeto> {
  return apiGet<LaporanPerubahanAsetNeto>(
    `/laporan/perubahan-aset-neto${queryLaporan(filter)}`,
  );
}

/** 22. The only report that takes an account. Every movement carries
 *  `jurnalId` and `jurnalBarisId`, which is what makes the drill down to the
 *  entry exact rather than a search that can find the wrong one. */
export function bukuBesar(filter: FilterBukuBesar): Promise<LaporanBukuBesar> {
  return apiGet<LaporanBukuBesar>(
    `/laporan/buku-besar${buildQuery({
      periodeId: filter.periodeId,
      cabangId: filter.cabangId ?? null,
      akunId: filter.akunId,
    })}`,
  );
}

/** 23. Six columns, three pairs, and the footing balances in all three. */
export function neracaLajur(filter: FilterLaporan): Promise<LaporanNeracaLajur> {
  return apiGet<LaporanNeracaLajur>(`/laporan/neraca-lajur${queryLaporan(filter)}`);
}

/**
 * The two filters spec 10's preamble puts above every statement. An ABSENT
 * `cabangId` is Semua Cabang and is sent as an absent parameter, never
 * defaulted to the caller's own branch: a page headed "Semua Cabang" that in
 * fact showed one branch would say nothing about it on the paper.
 */
function queryLaporan(filter: FilterLaporan): string {
  return buildQuery({ periodeId: filter.periodeId, cabangId: filter.cabangId ?? null });
}
