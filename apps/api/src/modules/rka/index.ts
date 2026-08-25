// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./kesalahan.ts and this folder's ./test-support.ts
// stay private.
//
// NO HTTP SURFACE YET, deliberately. This is the tests-first contract that
// opens Fase 6 (spec 9.3's three budget types with their versions and status,
// and spec 10.3 report 24): the versioning rules, the authorisation rules and
// above all the SOURCE of every realisation figure are specified and pinned by
// failing tests before a line of behaviour is written. ./routes.ts arrives with
// the implementation, wired with the guard set from modules/auth.
//
// THIS MODULE NEVER WRITES TO THE LEDGER and takes no journal port, unlike
// every other engine here. An RKA is a target, not a transaction. It only
// reads, and it reads the two shipped artefacts: `v_ledger_baris` for an OPEN
// period and `saldo_akun_periode` for a CLOSED one. See ./contract.ts's header
// for why that distinction is the whole point of the module.
import { createRkaEngine, type RkaEngine, type RkaEngineDeps } from "./contract";

export {
  createRkaEngine,
  RkaError,
  DIMENSI_UNTUK_JENIS,
  KODE_RKA,
  KUNCI_KONFIGURASI_RKA,
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
