// Typed client for the dashboard module, spec 11.
//
// TYPES COME FROM THE CONTRACT, NOT FROM THIS FILE. Every shape below is
// imported, type only, from apps/api/src/modules/dashboard/contract.ts, exactly
// as ./closing.ts, ./rka.ts and ./laporan.ts already do. `import type` is
// erased by Bun's transpiler, so no server code, no pg and no Redis client
// reaches the bundle, and a drift on either side becomes a type error here
// instead of a wrong screen. Nothing is redeclared.
//
// THE PATHS ARE READ OFF apps/api/src/modules/dashboard/routes.ts, which
// core/app.ts mounts at `/dashboard`. Three GETs, and three things about them
// this file keeps visible rather than smoothing away:
//
//   THE PAGE IS ONE REQUEST. `ringkasanDashboard` fetches every figure, every
//   panel and the closing checklist in a single call, because every number on
//   the screen has to describe the SAME period and the same branch scope.
//   Eleven independent requests can straddle a close and put a frozen KPI next
//   to a live one on one screen. There is deliberately no per-metric fetcher
//   here, so a screen cannot fan the page out by accident.
//
//   THE PERIOD PICKER IS ITS OWN CALL, and it is cheap. `daftarPeriodeDashboard`
//   fills the month dropdown without computing a single metric, which is why
//   the route exists separately at all.
//
//   A DRILL-DOWN KEY IS NEVER CONSTRUCTED BY A SCREEN. `rincianDashboard` takes
//   a `kunci` the summary emitted (`metrik:OUTSTANDING_PUMK`,
//   `kolektibilitas:MACET`, `antrian:PUMK_SURVEY`). The server refuses an
//   unknown key with `RINCIAN_TIDAK_DIKENAL` rather than answering with an
//   empty list, so a hand written key fails loudly; the key travels as a QUERY
//   PARAMETER because it carries a colon, and `buildQuery` encodes it.
import type {
  AlasanKosong,
  BarisAntrian,
  BarisKolektibilitas,
  BarisPrasyaratDashboard,
  BarisRincian,
  CabangDashboard,
  JenisAngka,
  KunciMetrik,
  Metrik,
  Persen,
  PeriodeDashboard,
  RincianDashboard,
  RingkasanDashboard,
  StatusClosingDashboard,
  StatusPeriode,
  SumberAngka,
  TahapAntrian,
  Uang,
} from "@krakatausteel/api/src/modules/dashboard/contract";
import { apiGet, buildQuery } from "./http";

export type {
  AlasanKosong,
  BarisAntrian,
  BarisKolektibilitas,
  BarisPrasyaratDashboard,
  BarisRincian,
  CabangDashboard,
  JenisAngka,
  KunciMetrik,
  Metrik,
  Persen,
  PeriodeDashboard,
  RincianDashboard,
  RingkasanDashboard,
  StatusClosingDashboard,
  StatusPeriode,
  SumberAngka,
  TahapAntrian,
  Uang,
};

/** The list envelope the period route answers with. */
interface Daftar<T> {
  data: T[];
}

/**
 * The month picker, newest first. A separate, cheap call: loading every metric
 * to fill a dropdown is the kind of default that makes a landing screen slow
 * for everybody.
 */
export function daftarPeriodeDashboard(
  filter: { tahun?: number | null } = {},
): Promise<Daftar<PeriodeDashboard>> {
  return apiGet<Daftar<PeriodeDashboard>>(
    `/dashboard/periode${buildQuery({ tahun: filter.tahun ?? null })}`,
  );
}

export interface FilterRingkasan {
  periodeId?: string | null;
  /** A narrowing filter, never authority. The server refuses one out of scope. */
  cabangId?: string | null;
  /** Spec 11 panel 7: only the stages this caller may act on. */
  hanyaMilikSaya?: boolean;
}

/**
 * SPEC 11'S WHOLE PAGE IN ONE CALL. `hanyaMilikSaya` is sent only when it is
 * true: the route's own default is false, and sending `false` explicitly would
 * put a parameter in every shareable dashboard URL that says nothing.
 */
export function ringkasanDashboard(filter: FilterRingkasan = {}): Promise<RingkasanDashboard> {
  return apiGet<RingkasanDashboard>(
    `/dashboard${buildQuery({
      periodeId: filter.periodeId ?? null,
      cabangId: filter.cabangId ?? null,
      hanyaMilikSaya: filter.hanyaMilikSaya === true ? "true" : null,
    })}`,
  );
}

export interface FilterRincianDashboard extends FilterRingkasan {
  batasBaris?: number | null;
}

/**
 * The rows behind ONE number, with their ids, so a figure can be followed to
 * the records that make it up. `kunci` is always a value the summary emitted.
 */
export function rincianDashboard(
  kunci: string,
  filter: FilterRincianDashboard = {},
): Promise<RincianDashboard> {
  return apiGet<RincianDashboard>(
    `/dashboard/rincian${buildQuery({
      kunci,
      periodeId: filter.periodeId ?? null,
      cabangId: filter.cabangId ?? null,
      batasBaris: filter.batasBaris ?? null,
    })}`,
  );
}
