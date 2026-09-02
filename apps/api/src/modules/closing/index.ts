// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./baca.ts, ./kesalahan.ts and this folder's
// ./test-support.ts stay private.
//
// THE HTTP SURFACE IS HERE NOW (./routes.ts), wired with the guard set from
// modules/auth exactly as every other module's router is. The module was built
// tests-first: kolektibilitas with its preview and its idempotency, the
// allowance, the accrual, the ten-item closing checklist, the frozen trial
// balance and the reopen rules were specified and pinned by failing tests
// before a line of behaviour existed, and the routes were added last, over an
// engine that already refused everything it had to refuse.
//
// The engine reaches the ledger ONLY through `PorterJurnalClosing`, which the
// object `createJurnalModule` returns already satisfies. Invariant 11 therefore
// holds by construction: there is no path from this module to a `jurnal` row
// that does not go through `postingEvent`.
import { buatClosingBaca, type ClosingBaca } from "./baca";
import { createClosingEngine, type ClosingEngine, type ClosingEngineDeps } from "./contract";
import { createClosingRoutes } from "./routes";
import type { Guards } from "../../core/principal";

export {
  createClosingEngine,
  ClosingError,
  EVENT_CLOSING,
  KODE_CLOSING,
  KUNCI_KONFIGURASI_CLOSING,
  PERMISSION_CLOSING,
  POLA_RATE,
  POLA_UANG,
  PRASYARAT_CLOSING,
} from "./contract";
export type {
  BarisAkrual,
  BarisKolektibilitas,
  ClosingContext,
  ClosingDbPort,
  ClosingEngine,
  ClosingEngineDeps,
  ClosingTx,
  DaftarPrasyarat,
  DasarPerhitunganPenyisihan,
  FilterSaldoAkunPeriode,
  HasilAkrual,
  HasilHitungKolektibilitas,
  HasilKolektibilitas,
  HasilPrasyarat,
  HasilTutupPeriode,
  JalankanAkrualInput,
  JalankanKolektibilitasInput,
  JalankanPenyisihanInput,
  KelasKolektibilitas,
  KontribusiJurnalPenyisihan,
  KodeClosing,
  KodePrasyarat,
  MetodePengakuanJasa,
  ModePenyisihan,
  PencatatAuditClosing,
  PenyisihanPeriode,
  PeriodeClosing,
  PermissionClosing,
  PorterJurnalClosing,
  PreviewKolektibilitas,
  Rate,
  ReopenPeriodeInput,
  RingkasanKelas,
  RiwayatRunKolektibilitas,
  SaldoAkunPeriode,
  SelKematriks,
  StatusPeriode,
  StatusPrasyarat,
  StatusRunKolektibilitas,
  SumberRate,
  TutupPeriodeInput,
  Uang,
} from "./contract";

/**
 * Builds the closing engine. Called from the composition root
 * (apps/api/src/core/app.ts), which is the only place allowed to know both a
 * module and an adapter. `jurnal.engine` satisfies `PorterJurnalClosing`
 * structurally, so the wiring is
 * `createClosingModule({ db, jurnal: jurnal.engine, audit: audit.service })`
 * with no adapter in between.
 *
 * THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for the reason modules/jurnal
 * records: a module-global instance gets re-pointed by whichever `createApp`
 * ran last, so with a per-fixture app a call can land on another fixture's pool.
 */
export function createClosingModule(deps: ClosingEngineDeps): { engine: ClosingEngine } {
  return { engine: createClosingEngine(deps) };
}

export type { ClosingBaca };
export type {
  FilterPeriodeClosing,
  KapabilitasClosing,
  OpsiCabangClosing,
  OpsiPeriodeClosing,
  ReferensiClosing,
} from "./baca";

export interface ClosingModuleDeps extends ClosingEngineDeps {
  guards: Guards;
}

/**
 * The module WITH its HTTP surface, for the composition root. Kept separate
 * from `createClosingModule` above so a caller that only needs the engine (a
 * seed, a batch job, this folder's own fixtures) does not have to invent a
 * guard set to get one.
 */
export function createClosingHttpModule(deps: ClosingModuleDeps): {
  engine: ClosingEngine;
  baca: ClosingBaca;
  routes: ReturnType<typeof createClosingRoutes>;
} {
  const engine = createClosingEngine(deps);
  const baca = buatClosingBaca({ db: deps.db });
  return { engine, baca, routes: createClosingRoutes({ engine, baca, guards: deps.guards }) };
}
