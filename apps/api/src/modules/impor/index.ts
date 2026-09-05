// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./csv.ts and ./routes.ts stay private.
//
// SPEC 9.6, THE WRITING HALF. modules/tools reads and only reads; this module
// writes, and ./contract.ts's header states the four rules it holds. The one
// worth repeating at the door: THIS MODULE HAS NO JOURNAL PORT. Every rupiah
// it moves moves through the instalment engine handed in as `angsuran`, which
// reaches the ledger through the journal engine, which is the single posting
// path invariant 11 rests on. A journal port here would be a second way in.
import { createImporEngine } from "./service";
import { createImporRoutes } from "./routes";
import type { Guards } from "../../core/principal";
import type { ImporEngine, ImporEngineDeps } from "./contract";

export { createImporEngine } from "./service";
export { parseCsv, dariMatriks, checksumTeks, KesalahanCsv } from "./csv";
export { parseXlsx, dariBase64, BATAS_IMPOR_XLSX, KesalahanXlsx } from "./xlsx";
export { EVENT_SALDO_AWAL_DEBIT, EVENT_SALDO_AWAL_KREDIT } from "./saldo-awal";
export {
  ImporError,
  KODE_IMPOR,
  FORMAT_IMPOR,
  JENIS_IMPOR,
  KOLOM_MITRA,
  KOLOM_ANGSURAN,
  KOLOM_SALDO_AWAL,
  BAGIAN_SALDO_AWAL,
  kolomUntuk,
  MAKS_BARIS,
  MAKS_ISI_BYTE,
  PERMISSION_IMPOR,
} from "./contract";
export type {
  BagianSaldoAwal,
  BarisDiterima,
  BarisDitolak,
  BerkasImpor,
  FormatImpor,
  HasilKomit,
  HasilPratinjau,
  ImporContext,
  ImporDbPort,
  ImporEngine,
  ImporEngineDeps,
  JenisImpor,
  KodeImpor,
  KomponenSaldoAwal,
  PabrikAngsuran,
  PermintaanImpor,
  PermintaanSaldoAwal,
  PorterAngsuranImpor,
  PorterJurnalSaldoAwal,
  RingkasanSaldoAwal,
} from "./contract";

/**
 * Builds the engine. THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for the
 * reason modules/jurnal records: a module-global instance gets re-pointed by
 * whichever `createApp` ran last, so with a per-fixture app a call can land on
 * another fixture's pool.
 */
export function createImporModule(deps: ImporEngineDeps): { engine: ImporEngine } {
  return { engine: createImporEngine(deps) };
}

export interface ImporHttpModuleDeps extends ImporEngineDeps {
  guards: Guards;
}

export function createImporHttpModule(deps: ImporHttpModuleDeps): {
  engine: ImporEngine;
  routes: ReturnType<typeof createImporRoutes>;
} {
  const engine = createImporEngine(deps);
  return { engine, routes: createImporRoutes({ engine, guards: deps.guards }) };
}
