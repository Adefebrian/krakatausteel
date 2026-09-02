// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts and this folder's ./test-support.ts stay
// private.
//
// SPEC 9.6, THE DIAGNOSTIC HALF. The import tools of spec 9.6 write and are
// not here; this module reads and only reads. It takes no journal port, no
// audit port and opens no transaction, so there is no path from here to a
// `jurnal` row at all: invariant 11 is not merely respected, it is
// unreachable, and mounting the routes does not change that because every one
// of them is a GET.
//
// THE CHECKS ARE THE SEED'S CHECKS. `apps/api/src/seed/demo-dunia/periksa.ts`
// implements spec 9.6 as SQL and the demo seed fails on a non-zero count; this
// module makes those same predicates runnable by a person, with the offending
// rows attached. `./tools-integritas.test.ts` runs the seed's own
// `periksaIntegritas` against the same world and asserts the two agree, so a
// future edit to either one that makes them disagree fails the suite instead
// of leaving two things that both claim to check the same invariant.
import { createToolsEngine, type ToolsEngine, type ToolsEngineDeps } from "./contract";
import { createToolsRoutes } from "./routes";
import type { Guards } from "../../core/principal";

export {
  createToolsEngine,
  ToolsError,
  BATAS_BARIS_BAWAAN,
  BATAS_BARIS_MAKS,
  KODE_TOOLS,
  PEMERIKSAAN_INTEGRITAS,
  PERMISSION_TOOLS,
  POLA_UANG,
} from "./contract";
export type {
  BarisPemeriksaan,
  BarisRekonsiliasiPiutang,
  FilterIntegritas,
  FilterRekonsiliasi,
  HasilPemeriksaan,
  KatalogPemeriksaan,
  KodePemeriksaan,
  KodeTools,
  LaporanIntegritas,
  LaporanRekonsiliasiPiutang,
  PermissionTools,
  RingkasanCabangRekonsiliasi,
  SumberPemeriksaan,
  ToolsContext,
  ToolsDbPort,
  ToolsEngine,
  ToolsEngineDeps,
  Uang,
} from "./contract";

/**
 * Builds the tools engine. Called from the composition root
 * (apps/api/src/core/app.ts). THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for
 * the reason modules/jurnal records: a module-global instance gets re-pointed
 * by whichever `createApp` ran last, so with a per-fixture app a call can land
 * on another fixture's pool.
 */
export function createToolsModule(deps: ToolsEngineDeps): { engine: ToolsEngine } {
  return { engine: createToolsEngine(deps) };
}

export interface ToolsModuleDeps extends ToolsEngineDeps {
  guards: Guards;
}

/**
 * The module WITH its HTTP surface, for the composition root. Kept separate
 * from `createToolsModule` so a caller that only needs the engine (a seed, a
 * later batch job, this folder's own fixtures) does not have to invent a guard
 * set to get one.
 */
export function createToolsHttpModule(deps: ToolsModuleDeps): {
  engine: ToolsEngine;
  routes: ReturnType<typeof createToolsRoutes>;
} {
  const engine = createToolsEngine(deps);
  return { engine, routes: createToolsRoutes({ engine, guards: deps.guards }) };
}
