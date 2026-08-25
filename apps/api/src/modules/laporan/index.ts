// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts and this folder's ./test-support.ts stay private.
//
// NO HTTP SURFACE YET, deliberately, and no ./kesalahan.ts either.
//
// Every sibling module has a `kesalahan.ts` because every sibling module
// WRITES, and a write means a constraint, a trigger and a raw Postgres refusal
// that must be translated before it reaches a finance user. This module writes
// nothing: it issues SELECTs and it renders. There is no DB refusal to
// translate, so the file would be an empty ceremony. If a later pass adds a
// materialised cache or an export artefact row, it arrives with the refusal
// mapping it needs.
//
// ./routes.ts arrives with the implementation, wired with the guard set from
// modules/auth. Spec 16 scenario 23 is a standing constraint on those routes:
// every one of them is a GET, so an Auditor holding `laporan.view` can open
// all seven and change nothing.
import { createLaporanEngine, type LaporanEngine, type LaporanEngineDeps } from "./contract";

export {
  createLaporanEngine,
  LaporanError,
  KODE_LAPORAN,
  KUNCI_KONFIGURASI_LAPORAN,
  NAMA_LAPORAN,
  NOL_TAMPIL,
  PERMISSION_LAPORAN,
  POLA_TAMPIL,
  POLA_TANGGAL,
  POLA_UANG,
} from "./contract";
export type {
  Angka,
  BarisArusKas,
  BarisBaganAkun,
  BarisBukuBesar,
  BarisNeracaLajur,
  BarisPerubahanAsetNeto,
  BarisStatement,
  FilterBaganAkun,
  FilterBukuBesar,
  FilterLaporan,
  HeaderLaporan,
  JenisLaporanBaris,
  KlasifikasiArusKas,
  KodeLaporan,
  KolomPembanding,
  LaporanAktivitas,
  LaporanArusKas,
  LaporanBaganAkun,
  LaporanBukuBesar,
  LaporanContext,
  LaporanDbPort,
  LaporanEngine,
  LaporanEngineDeps,
  LaporanNeracaLajur,
  LaporanPerubahanAsetNeto,
  LaporanPosisiKeuangan,
  LaporanTx,
  PermissionLaporan,
  SaldoNormal,
  SeksiAktivitas,
  SeksiArusKas,
  StatusPeriode,
  SumberData,
  TanggalIso,
  TipeAkun,
  TipeBaris,
  TotalNeracaLajur,
  Uang,
} from "./contract";

/**
 * Builds the report engine. Called from the composition root
 * (apps/api/src/core/app.ts), which is the only place allowed to know both a
 * module and an adapter: `createLaporanModule({ db })`.
 *
 * THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for the reason modules/jurnal
 * records: a module-global instance gets re-pointed by whichever `createApp`
 * ran last, so with a per-fixture app a call can land on another fixture's
 * pool.
 *
 * NO LEDGER PORT. Unlike modules/closing and modules/angsuran, this module
 * takes no `PorterJurnal`: it never posts. Invariant 11 is not merely
 * respected here, it is unreachable.
 */
export function createLaporanModule(deps: LaporanEngineDeps): { engine: LaporanEngine } {
  return { engine: createLaporanEngine(deps) };
}
