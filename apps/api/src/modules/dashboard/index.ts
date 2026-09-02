// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts and this folder's ./test-support.ts stay
// private.
//
// SPEC 11, THE LANDING SCREEN. Aggregated figures, every one of them drillable,
// and nothing else: this module takes no journal port and no audit port, opens
// no transaction and exposes only GETs, so there is no path from here to a
// `jurnal` row at all. Invariant 11 is not merely respected here, it is
// unreachable.
//
// IT OWNS NO DEFINITION IT DID NOT INVENT. The RKA baseline, the LPJ lateness
// threshold and spec 8.4's ten closing checks belong to modules/rka,
// modules/nonpumk and modules/closing, and each arrives through a PORT declared
// in ./contract.ts that the owning engine satisfies STRUCTURALLY. Nothing here
// imports those modules, so there is no cycle, no deep import, and a module
// being edited elsewhere cannot break this one by moving a file.
//
// EVERY PORT IS OPTIONAL. The engine must be constructible with a database and
// nothing else (this folder's fixtures do exactly that), and an absent port
// produces `alasanKosong: "SUMBER_TIDAK_TERPASANG"` rather than a zero that
// reads as "there is nothing to do today".
import {
  createDashboardEngine,
  type DashboardEngine,
  type DashboardEngineDeps,
} from "./contract";
import { createDashboardRoutes } from "./routes";
import type { Guards } from "../../core/principal";

export {
  createDashboardEngine,
  DashboardError,
  BATAS_RINCIAN_BAWAAN,
  BATAS_RINCIAN_MAKS,
  KODE_DASHBOARD,
  METRIK_DASHBOARD,
  PERMISSION_DASHBOARD,
  POLA_PERSEN,
  POLA_UANG,
  TAHAP_ANTRIAN,
} from "./contract";
export type {
  AlasanKosong,
  BarisAntrian,
  BarisKolektibilitas,
  BarisPrasyaratDashboard,
  BarisRincian,
  CabangDashboard,
  DashboardContext,
  DashboardDbPort,
  DashboardEngine,
  DashboardEngineDeps,
  FilterDashboard,
  FilterRincian,
  JenisAngka,
  KodeDashboard,
  KunciMetrik,
  Metrik,
  PeriodeDashboard,
  PermissionDashboard,
  Persen,
  PorterClosingDashboard,
  PorterNonPumkDashboard,
  PorterRkaDashboard,
  RincianDashboard,
  RingkasanDashboard,
  StatusClosingDashboard,
  StatusPeriode,
  SumberAngka,
  TahapAntrian,
  Uang,
} from "./contract";

/**
 * Builds the dashboard engine. Called from the composition root
 * (apps/api/src/core/app.ts). THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for
 * the reason modules/jurnal records: a module-global instance gets re-pointed
 * by whichever `createApp` ran last, so with a per-fixture app a call can land
 * on another fixture's pool.
 */
export function createDashboardModule(deps: DashboardEngineDeps): {
  engine: DashboardEngine;
} {
  return { engine: createDashboardEngine(deps) };
}

export interface DashboardModuleDeps extends DashboardEngineDeps {
  guards: Guards;
}

/**
 * The module WITH its HTTP surface, for the composition root. Kept separate
 * from `createDashboardModule` so a caller that only needs the engine (this
 * folder's own fixtures, a later export job) does not have to invent a guard
 * set to get one.
 */
export function createDashboardHttpModule(deps: DashboardModuleDeps): {
  engine: DashboardEngine;
  routes: ReturnType<typeof createDashboardRoutes>;
} {
  const engine = createDashboardEngine(deps);
  return { engine, routes: createDashboardRoutes({ engine, guards: deps.guards }) };
}
