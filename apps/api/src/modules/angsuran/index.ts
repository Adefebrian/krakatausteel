// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./jadwal.ts, ./alokasi.ts, ./kesalahan.ts
// and ./uang.ts stay private.
//
// NO HTTP SURFACE YET, deliberately. Fase 2 (spec 14) is the instalment engine
// and its tests; the PUMK screens of spec 9.1 come later and will add routes.ts
// here. Business modules must reach the schedule and the allocation through the
// engine exported below and never write pumk_jadwal_angsuran rows themselves
// (invariant 8), and never write jurnal rows themselves (invariant 11).
import { createAngsuranEngine, type AngsuranEngine, type AngsuranEngineDeps } from "./contract";

export {
  createAngsuranEngine,
  AngsuranError,
  KODE_ANGSURAN,
  KUNCI_KONFIGURASI,
  PERMISSION_ANGSURAN,
  POLA_RATE,
  POLA_UANG,
  UNIT_PEMBULATAN,
  alokasikanSetoran,
} from "./contract";
export type {
  AjukanRescheduleInput,
  AngsuranContext,
  AngsuranDbPort,
  AngsuranEngine,
  AngsuranEngineDeps,
  AngsuranTx,
  BarisJadwal,
  BasisEkuivalensi,
  GenerateJadwalInput,
  HasilAlokasi,
  HasilReschedule,
  Jadwal,
  JenisReschedule,
  KebijakanJasaGrace,
  KodeAngsuran,
  KomponenAlokasi,
  KomponenJurnal,
  KonversiRateInput,
  MetodePerhitungan,
  ParameterTerpakai,
  PorterJurnalAngsuran,
  RateTahunan,
  Reschedule,
  RincianAlokasiBaris,
  RingkasanJadwal,
  SetoranInput,
  SimulasiInput,
  StatusAkad,
  StatusBarisJadwal,
  StatusReschedule,
  TabelJadwal,
  Uang,
} from "./contract";

/**
 * Builds the engine. Called from the composition root
 * (apps/api/src/core/app.ts), which is the only place allowed to know both a
 * module and an adapter, and which wires the journal port as
 * `createAngsuranModule({ db, jurnal: jurnal.engine })`: the object
 * `createJurnalModule` returns already satisfies `PorterJurnalAngsuran`, so
 * there is no adapter in between and invariant 11 holds structurally.
 *
 * THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for the reason modules/jurnal
 * records: a module-global instance gets re-pointed by whichever `createApp`
 * ran last, so with a per-fixture app a call can land on another fixture's
 * pool.
 */
export function createAngsuranModule(deps: AngsuranEngineDeps): { engine: AngsuranEngine } {
  return { engine: createAngsuranEngine(deps) };
}
