// Typed client for the tools module, spec 9.6: the integrity health check and
// the receivable reconciliation.
//
// TYPES COME FROM THE CONTRACT, NOT FROM THIS FILE, type only, exactly as
// ./closing.ts and ./dashboard.ts do. Nothing is redeclared, so a drift on
// either side is a type error here rather than a wrong screen.
//
// EVERY FUNCTION BELOW IS A GET, AND THAT IS THE WHOLE POINT. These two pages
// DIAGNOSE and never repair: the engine behind them has no journal port and no
// transaction, so there is nothing for a POST to call. If a screen ever needs
// to fix something it finds here, it does it on the page that owns the record
// (a reversing journal, a reschedule, a re-run of the closing step), never from
// this client.
//
// THE PATHS ARE READ OFF apps/api/src/modules/tools/routes.ts, which
// core/app.ts mounts at `/tools`. Two permissions, not one: `tools.integritas`
// gates the health check and `tools.rekonsiliasi` gates the reconciliation, and
// they are not interchangeable.
import type {
  BarisPemeriksaan,
  BarisRekonsiliasiPiutang,
  HasilPemeriksaan,
  KatalogPemeriksaan,
  KodePemeriksaan,
  LaporanIntegritas,
  LaporanRekonsiliasiPiutang,
  RingkasanCabangRekonsiliasi,
  SumberPemeriksaan,
  Uang,
} from "@krakatausteel/api/src/modules/tools/contract";
import { apiGet, buildQuery } from "./http";

export type {
  BarisPemeriksaan,
  BarisRekonsiliasiPiutang,
  HasilPemeriksaan,
  KatalogPemeriksaan,
  KodePemeriksaan,
  LaporanIntegritas,
  LaporanRekonsiliasiPiutang,
  RingkasanCabangRekonsiliasi,
  SumberPemeriksaan,
  Uang,
};

interface Daftar<T> {
  data: T[];
}

export interface FilterIntegritasWeb {
  cabangId?: string | null;
  batasBaris?: number | null;
}

/**
 * The catalogue alone, without running anything. It carries `dijagaDatabase`
 * and `terikatCabang`, which is what lets the page explain a permanently green
 * row and a row a branch filter cannot narrow.
 */
export function katalogPemeriksaan(): Promise<Daftar<KatalogPemeriksaan>> {
  return apiGet<Daftar<KatalogPemeriksaan>>("/tools/integritas/katalog");
}

/**
 * Every check, in catalogue order, each with its verdict, its count and the
 * offending rows WITH THEIR IDS. One call: a health check that reported "3
 * failures" and then needed nine more requests to say which rows would be a
 * page nobody could act on.
 */
export function jalankanIntegritas(
  filter: FilterIntegritasWeb = {},
): Promise<LaporanIntegritas> {
  return apiGet<LaporanIntegritas>(
    `/tools/integritas${buildQuery({
      cabangId: filter.cabangId ?? null,
      batasBaris: filter.batasBaris ?? null,
    })}`,
  );
}

/** One check, so a page can refresh a single row or widen its row limit. */
export function jalankanPemeriksaan(
  kode: KodePemeriksaan,
  filter: FilterIntegritasWeb = {},
): Promise<HasilPemeriksaan> {
  return apiGet<HasilPemeriksaan>(
    `/tools/integritas/${encodeURIComponent(kode)}${buildQuery({
      cabangId: filter.cabangId ?? null,
      batasBaris: filter.batasBaris ?? null,
    })}`,
  );
}

export interface FilterRekonsiliasiWeb {
  cabangId?: string | null;
  /** The server's own default is true. Sent explicitly only when narrowed off. */
  hanyaSelisih?: boolean;
  batasBaris?: number | null;
}

/**
 * Spec 8.4 check 10 as an operator's page: per cabang, per akad, with the
 * difference on each row. The per akad list is the operational product here; a
 * total alone nets two offsetting errors to zero and tells nobody what to fix.
 */
export function rekonsiliasiPiutang(
  filter: FilterRekonsiliasiWeb = {},
): Promise<LaporanRekonsiliasiPiutang> {
  return apiGet<LaporanRekonsiliasiPiutang>(
    `/tools/rekonsiliasi/piutang${buildQuery({
      cabangId: filter.cabangId ?? null,
      hanyaSelisih: filter.hanyaSelisih === false ? "false" : null,
      batasBaris: filter.batasBaris ?? null,
    })}`,
  );
}
