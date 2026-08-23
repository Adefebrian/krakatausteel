// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./kesalahan.ts and ./uang.ts stay private.
//
// NO HTTP SURFACE YET, deliberately. Fase 1 (spec 14) is the engine and its
// tests; the journal screens of spec 9 come later and will add routes.ts here.
// Business modules (PUMK, Non PUMK, closing) must reach the ledger through
// `postingEvent` on the engine exported here and never write jurnal rows
// themselves (invariant 11).
import { createJurnalEngine, type JurnalEngine, type JurnalEngineDeps } from "./contract";
import { pasangEngineJurnal } from "./service";

export { createJurnalEngine, JurnalError, KODE_JURNAL, KUNCI_KONFIGURASI, PERMISSION_JURNAL, POLA_NO_JURNAL, POLA_UANG } from "./contract";
export {
  buatJurnal,
  verifikasiJurnal,
  postingJurnal,
  batalkanJurnalDraft,
  reversalJurnal,
  postingBatch,
  postingEvent,
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
  JurnalTx,
  KodeJurnal,
  PembalikStateBisnis,
  StatusJurnal,
  Uang,
} from "./contract";

/**
 * Builds the engine and registers it as the one the spec 6.1 free functions
 * run on. Called from the composition root (apps/api/src/core/app.ts), which
 * is the only place allowed to know both a module and an adapter.
 */
export function createJurnalModule(deps: JurnalEngineDeps): { engine: JurnalEngine } {
  const engine = createJurnalEngine(deps);
  pasangEngineJurnal(engine);
  return { engine };
}
