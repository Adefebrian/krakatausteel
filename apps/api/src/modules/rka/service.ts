// apps/api/src/modules/rka/service.ts
//
// THE ENGINE IS NOT IMPLEMENTED. Every method below throws.
//
// This is the tests-first arrangement: ./contract.ts is the shape, the six
// *.test.ts files in this folder are the specification, and this file is the
// hole they are pointed at. Fase 6 (spec 9.3 and spec 10.3 report 24) is
// written against a red suite and turns green one method at a time.
//
// WHY THE STUB THROWS A PLAIN `Error` AND NOT AN `RkaError`
// Deliberate, and the single most important line in this file.
// `tolakDengan` in ./test-support.ts asserts `instanceof RkaError` AND a
// matching `kode`. If the stub raised an `RkaError`, a rejection test could go
// GREEN against an unimplemented engine as soon as the code happened to match,
// which is the one failure mode a tests-first suite exists to prevent. A plain
// `Error` fails that assertion loudly, so every rejection test in this folder
// is red for the right reason today and can only go green when a real guard
// raises a real domain error.
//
// The message names the method and points at the contract, so a red test says
// what is missing rather than "not implemented".
import type {
  BuatRevisiInput,
  BuatRkaInput,
  FilterLaporanRka,
  FilterRka,
  JenisRka,
  LaporanRkaVsRealisasi,
  MetodeRealisasi,
  Rka,
  RkaContext,
  RkaEngine,
  RkaEngineDeps,
  RkaLengkap,
  SetujuiRkaInput,
  SimpanBarisRkaInput,
} from "./contract";

function belumDiimplementasikan(metode: string, specItem: string): never {
  throw new Error(
    `modules/rka: ${metode}() belum diimplementasikan (spec ${specItem}). ` +
      "Lihat ./contract.ts untuk kontraknya dan *.test.ts di folder ini untuk perilakunya.",
  );
}

/**
 * `deps` is accepted and deliberately unused. The wiring is part of what the
 * tests pin (a factory with no parameters would let a wrong composition
 * compile), and referencing it here keeps `noUnusedParameters` satisfied
 * without weakening the signature.
 */
export function buatEngineRka(deps: RkaEngineDeps): RkaEngine {
  void deps;

  return {
    buatRka(_input: BuatRkaInput, _ctx: RkaContext): Promise<RkaLengkap> {
      return belumDiimplementasikan("buatRka", "9.3 Input RKA");
    },

    simpanBaris(_input: SimpanBarisRkaInput, _ctx: RkaContext): Promise<RkaLengkap> {
      return belumDiimplementasikan("simpanBaris", "9.3 Input RKA, 4.8 rka_detail");
    },

    setujuiRka(_input: SetujuiRkaInput, _ctx: RkaContext): Promise<Rka> {
      return belumDiimplementasikan("setujuiRka", "9.3 RKA DISETUJUI jadi baseline");
    },

    buatRevisi(_input: BuatRevisiInput, _ctx: RkaContext): Promise<RkaLengkap> {
      return belumDiimplementasikan("buatRevisi", "9.3 revisi membuat versi baru");
    },

    daftarRka(_filter: FilterRka, _ctx: RkaContext): Promise<Rka[]> {
      return belumDiimplementasikan("daftarRka", "9.3 RKA punya versi dan status");
    },

    bacaRka(_rkaId: string, _ctx: RkaContext): Promise<RkaLengkap> {
      return belumDiimplementasikan("bacaRka", "4.8 rka + rka_detail");
    },

    baseline(
      _input: { tahun: number; jenis: JenisRka; cabangId: string | null },
      _ctx: RkaContext,
    ): Promise<Rka | null> {
      return belumDiimplementasikan("baseline", "9.3 baseline pembanding");
    },

    laporanRkaVsRealisasi(
      _filter: FilterLaporanRka,
      _ctx: RkaContext,
    ): Promise<LaporanRkaVsRealisasi> {
      return belumDiimplementasikan("laporanRkaVsRealisasi", "10.3 laporan 24");
    },

    metodeRealisasi(
      _input: { periodeId: string; jenis: JenisRka },
      _ctx: RkaContext,
    ): Promise<MetodeRealisasi> {
      return belumDiimplementasikan("metodeRealisasi", "10 sumber realisasi, ADR 0010");
    },
  };
}
