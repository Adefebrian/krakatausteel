// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./kesalahan.ts and ./uang.ts stay private.
//
// NO HTTP SURFACE YET, deliberately. Fase 1 (spec 14) is the engine and its
// tests; the journal screens of spec 9 come later and will add routes.ts here.
// Business modules (PUMK, Non PUMK, closing) must reach the ledger through
// `postingEvent` or `postingEventGabungan` on the engine built here, and never
// write jurnal rows themselves (invariant 11).
//
// THE ENGINE IS A DEPENDENCY, NOT A SINGLETON. There is no module-global
// instance and no free-function surface over one: an earlier version had both,
// and the global was re-pointed by whichever `createApp` ran last, so with a
// per-fixture app (testing/harness.ts) a call could land on another fixture's
// pool. `createJurnalModule` builds one engine and hands it back; the caller
// decides who gets it.
import { createJurnalEngine, type JurnalEngine, type JurnalEngineDeps } from "./contract";

export {
  createJurnalEngine,
  JurnalError,
  KODE_JURNAL,
  KUNCI_KONFIGURASI,
  PERMISSION_JURNAL,
  POLA_NO_JURNAL,
  POLA_UANG,
} from "./contract";
export type {
  BarisJurnal,
  BarisJurnalInput,
  BuatJurnalInput,
  DimensiBaris,
  EventPayload,
  JenisJurnal,
  Jurnal,
  JurnalContext,
  JurnalDbPort,
  JurnalEngine,
  JurnalEngineDeps,
  JurnalGabungan,
  JurnalTx,
  KodeJurnal,
  KomponenEvent,
  PembalikStateBisnis,
  PencatatAudit,
  PostingGabunganInput,
  StatusJurnal,
  Uang,
} from "./contract";

/**
 * Builds the journal engine. Called from the composition root
 * (apps/api/src/core/app.ts), which is the only place allowed to know both a
 * module and an adapter.
 *
 * The returned engine also satisfies the journal port `modules/angsuran`
 * declares (`PorterJurnalAngsuran`), because `postingEventGabungan` returns
 * `jurnalId` and `jumlahBaris` alongside the full journal. So the wiring is
 * `createAngsuranModule({ db, jurnal: jurnal.engine })` with no adapter in
 * between, and invariant 11 holds structurally: the only way into the ledger
 * is this object.
 */
export function createJurnalModule(deps: JurnalEngineDeps): { engine: JurnalEngine } {
  return { engine: createJurnalEngine(deps) };
}
