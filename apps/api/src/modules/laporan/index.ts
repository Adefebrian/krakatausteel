// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./baca.ts and this folder's
// ./test-support.ts stay private.
//
// THE HTTP SURFACE IS HERE NOW (./routes.ts), and still no ./kesalahan.ts.
//
// Every sibling module has a `kesalahan.ts` because every sibling module
// WRITES, and a write means a constraint, a trigger and a raw Postgres refusal
// that must be translated before it reaches a finance user. This module writes
// nothing: it issues SELECTs and it renders. There is no DB refusal to
// translate, so the file would be an empty ceremony. If a later pass adds a
// materialised cache or an export artefact row, it arrives with the refusal
// mapping it needs.
//
// Spec 16 scenario 23 is a standing constraint on those routes and it holds:
// every one of them is a GET, so an Auditor holding `laporan.view` opens all
// THIRTY and changes nothing. That is not a promise about the router either --
// BOTH engines below are constructed with a database and a clock and NOTHING
// ELSE, so there is no port in this module through which a route could write
// even if one were added carelessly.
//
// TWO ENGINES ARE EXPORTED AND THAT IS NOT A SECOND MODULE. `LaporanEngine`
// answers the seven accounting statements of spec 10.3 and
// `LaporanOperasionalEngine` answers the other twenty-three; they share
// ./dasar.ts's permission check, branch resolution, period lookup and header
// builder, which is the only thing that would have been worth keeping together
// anyway. The alternative -- one interface with thirty methods -- would have
// meant every existing consumer of `LaporanEngine` recompiling against a shape
// it does not use, and every fixture in this folder constructing all thirty
// reports to test one.
import { buatLaporanBaca, type LaporanBaca } from "./baca";
import { createLaporanEngine, type LaporanEngine, type LaporanEngineDeps } from "./contract";
import { buatEngineOperasional } from "./engine-operasional";
import type { LaporanOperasionalEngine } from "./kontrak-operasional";
import { createLaporanRoutes } from "./routes";
import type { Guards } from "../../core/principal";

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
export function createLaporanModule(deps: LaporanEngineDeps): {
  engine: LaporanEngine;
  operasional: LaporanOperasionalEngine;
} {
  return { engine: createLaporanEngine(deps), operasional: buatEngineOperasional(deps) };
}

/**
 * The other twenty-three reports of spec 10 (10.1, 10.2, 10.4 and report 21),
 * on their own, for a caller that wants them without the accounting
 * statements. Same deps, same clock, same absence of any write port.
 */
export function createLaporanOperasionalEngine(
  deps: LaporanEngineDeps,
): LaporanOperasionalEngine {
  return buatEngineOperasional(deps);
}

// The operational catalogue's own vocabulary. Exported from the index because
// ./kontrak-operasional.ts is private the way ./contract.ts is, and a screen or
// a sibling module reaching into it directly is what
// `bun run check:boundaries` refuses.
export {
  BATAS_AUDIT_TRAIL_BAWAAN,
  BATAS_AUDIT_TRAIL_MAKS,
  BUCKET_AGING,
  EMBER_KOSONG,
  KELAS_BARU,
  KELOMPOK_LAMA_USAHA,
  KELOMPOK_OMZET,
  KELOMPOK_TENAGA_KERJA,
  KELOMPOK_USIA,
  NAMA_LAPORAN_OPERASIONAL,
  POLA_PERSEN,
  SDG_TIDAK_DIPETAKAN,
  WILAYAH_TIDAK_DIKETAHUI,
} from "./kontrak-operasional";
export type {
  BarisAging,
  BarisAkrualJasa,
  BarisAuditTrail,
  BarisBebanPenyisihan,
  BarisBidang,
  BarisJatuhTempo,
  BarisKolektibilitas,
  BarisMatriks,
  BarisMonitoringLpj,
  BarisPenerimaanAngsuran,
  BarisPenyaluranNonPumk,
  BarisPerhitunganPenyisihan,
  BarisPortal,
  BarisRekapJurnal,
  BarisRekapPermohonan,
  BarisRekapRealisasi,
  BarisSdg,
  BarisSektor,
  BarisWilayah,
  DasarWilayah,
  DistribusiDemografi,
  EmberDemografi,
  FilterAuditTrail,
  FilterJatuhTempo,
  FilterKartuPiutang,
  FilterPeriodeLaporan,
  HasilAudit,
  KartuAkad,
  KodeBucketAging,
  LaporanAgingPiutang,
  LaporanAkrualJasa,
  LaporanAuditTrail,
  LaporanBebanPenyisihan,
  LaporanDemografiMitra,
  LaporanJatuhTempo,
  LaporanKartuPiutang,
  LaporanKolektibilitas,
  LaporanMonitoringLpj,
  LaporanOperasionalEngine,
  LaporanPemetaanSdg,
  LaporanPenerimaanAngsuran,
  LaporanPenyaluranNasional,
  LaporanPenyaluranNonPumk,
  LaporanPerhitunganPenyisihan,
  LaporanPerpindahanKolektibilitas,
  LaporanPortal,
  LaporanRealisasiSektor,
  LaporanRealisasiWilayah,
  LaporanRekapBidang,
  LaporanRekapJurnal,
  LaporanRekapPermohonan,
  LaporanRekapRealisasi,
  ModeLaporan,
  Persen,
  SelMatriks,
  SelPerpindahan,
  StatusAkad,
  StatusJadwal,
  StatusLpj,
  StatusPortal,
} from "./kontrak-operasional";

export type { LaporanBaca };
export type {
  EntriKatalogLaporan,
  FilterCabangLaporan,
  OpsiCabangLaporan,
  OpsiPeriode,
} from "./baca";

export interface LaporanModuleDeps extends LaporanEngineDeps {
  guards: Guards;
}

/**
 * The module WITH its HTTP surface, for the composition root. Kept separate
 * from `createLaporanModule` above so a caller that only needs the engine (a
 * later export job, this folder's own fixtures) does not have to invent a guard
 * set to get one.
 *
 * STILL NO LEDGER PORT AND NO AUDIT PORT. Adding `guards` adds an
 * authorisation decision, not a capability: nothing reachable from here can
 * insert, update or delete.
 */
export function createLaporanHttpModule(deps: LaporanModuleDeps): {
  engine: LaporanEngine;
  operasional: LaporanOperasionalEngine;
  baca: LaporanBaca;
  routes: ReturnType<typeof createLaporanRoutes>;
} {
  const engine = createLaporanEngine(deps);
  const operasional = buatEngineOperasional(deps);
  const baca = buatLaporanBaca({ db: deps.db });
  return {
    engine,
    operasional,
    baca,
    routes: createLaporanRoutes({ engine, operasional, baca, guards: deps.guards }),
  };
}
