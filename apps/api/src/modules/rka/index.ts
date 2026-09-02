// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./baca.ts, ./kesalahan.ts and this folder's
// ./test-support.ts stay private.
//
// THE HTTP SURFACE IS HERE NOW (./routes.ts), wired with the guard set from
// modules/auth exactly as every other module's router is. The module was built
// tests-first: the versioning rules, the authorisation rules and above all the
// SOURCE of every realisation figure were specified and pinned by failing tests
// before a line of behaviour existed, and the routes were added last, over an
// engine that already refused everything it had to refuse.
//
// THIS MODULE NEVER WRITES TO THE LEDGER and takes no journal port, unlike
// every other engine here. An RKA is a target, not a transaction. It only
// reads, and it reads the two shipped artefacts: `v_ledger_baris` for an OPEN
// period and `saldo_akun_periode` for a CLOSED one. See ./contract.ts's header
// for why that distinction is the whole point of the module. No route added
// here may hand it a way to post.
import { buatRkaBaca, type RkaBaca } from "./baca";
import { createRkaEngine, type RkaEngine, type RkaEngineDeps } from "./contract";
import { createRkaRoutes } from "./routes";
import type { Guards } from "../../core/principal";

export {
  createRkaEngine,
  RkaError,
  DIMENSI_UNTUK_JENIS,
  KODE_RKA,
  KUNCI_KONFIGURASI_RKA,
  NAMA_LAPORAN_RKA,
  PERMISSION_RKA,
  POLA_PERSEN,
  POLA_UANG,
} from "./contract";
export type {
  BarisRka,
  BarisRkaInput,
  BarisRkaVsRealisasi,
  BuatRevisiInput,
  BuatRkaInput,
  DimensiRka,
  FilterLaporanRka,
  FilterRka,
  HeaderLaporanRka,
  JenisRka,
  KodeRka,
  LaporanRkaVsRealisasi,
  MetodeRealisasi,
  ModeLaporanRka,
  PencatatAuditRka,
  Persen,
  PermissionRka,
  Rka,
  RkaContext,
  RkaDbPort,
  RkaEngine,
  RkaEngineDeps,
  RkaLengkap,
  RkaTx,
  SetujuiRkaInput,
  SimpanBarisRkaInput,
  StatusRka,
  SumberPeriode,
  SumberRealisasi,
  TotalRkaVsRealisasi,
  Uang,
} from "./contract";

/**
 * Builds the RKA engine. Called from the composition root
 * (apps/api/src/core/app.ts), which is the only place allowed to know both a
 * module and an adapter. The wiring is
 * `createRkaModule({ db, audit: audit.service })`, with no adapter in between.
 *
 * THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for the reason modules/jurnal
 * records: a module-global instance gets re-pointed by whichever `createApp`
 * ran last, so with a per-fixture app a call can land on another fixture's pool.
 */
export function createRkaModule(deps: RkaEngineDeps): { engine: RkaEngine } {
  return { engine: createRkaEngine(deps) };
}

export type { RkaBaca };
export type {
  OpsiCabangRka,
  OpsiDimensiRka,
  OpsiPeriodeRka,
  ReferensiRka,
} from "./baca";

export interface RkaModuleDeps extends RkaEngineDeps {
  guards: Guards;
}

/**
 * The module WITH its HTTP surface, for the composition root. Kept separate
 * from `createRkaModule` above so a caller that only needs the engine (a seed,
 * a later batch job, this folder's own fixtures) does not have to invent a
 * guard set to get one.
 */
export function createRkaHttpModule(deps: RkaModuleDeps): {
  engine: RkaEngine;
  baca: RkaBaca;
  routes: ReturnType<typeof createRkaRoutes>;
} {
  const engine = createRkaEngine(deps);
  const baca = buatRkaBaca({ db: deps.db });
  return { engine, baca, routes: createRkaRoutes({ engine, baca, guards: deps.guards }) };
}
