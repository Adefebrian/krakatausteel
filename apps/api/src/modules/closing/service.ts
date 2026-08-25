// apps/api/src/modules/closing/service.ts
//
// THE ENGINE IS NOT IMPLEMENTED. Every method below throws.
//
// This is the tests-first arrangement spec rule 5 asks for: ./contract.ts is
// the shape, the eight *.test.ts files in this folder are the specification,
// and this file is the hole they are pointed at. Fase 5 (docs/BUILD-PLAN.md)
// is written against a red suite and turns green one method at a time.
//
// WHY THE STUB THROWS A PLAIN `Error` AND NOT A `ClosingError`
// Deliberate, and the single most important line in this file.
// `tolakDengan` in ./test-support.ts asserts `instanceof ClosingError` AND a
// matching `kode`. If the stub raised a `ClosingError`, a rejection test could
// go GREEN against an unimplemented engine as soon as the code happened to
// match, which is the one failure mode a tests-first suite exists to prevent.
// A plain `Error` fails that assertion loudly, so every rejection test in this
// folder is red for the right reason today and can only go green when a real
// guard raises a real domain error.
//
// The message names the method and points at the contract, so a red test says
// what is missing rather than "not implemented".
import type {
  BarisKolektibilitas,
  ClosingContext,
  ClosingEngine,
  ClosingEngineDeps,
  DaftarPrasyarat,
  FilterSaldoAkunPeriode,
  HasilAkrual,
  HasilKolektibilitas,
  HasilTutupPeriode,
  JalankanAkrualInput,
  JalankanKolektibilitasInput,
  JalankanPenyisihanInput,
  PenyisihanPeriode,
  PeriodeClosing,
  PreviewKolektibilitas,
  ReopenPeriodeInput,
  RiwayatRunKolektibilitas,
  SaldoAkunPeriode,
  TutupPeriodeInput,
} from "./contract";

function belumDiimplementasikan(metode: string, specItem: string): never {
  throw new Error(
    `modules/closing: ${metode}() belum diimplementasikan (spec ${specItem}). ` +
      "Lihat ./contract.ts untuk kontraknya dan *.test.ts di folder ini untuk perilakunya.",
  );
}

/**
 * `deps` is accepted and deliberately unused. The wiring is part of what the
 * tests pin (a factory with no parameters would let a wrong composition
 * compile), and referencing it here keeps `noUnusedParameters` satisfied
 * without weakening the signature.
 */
export function buatEngineClosing(deps: ClosingEngineDeps): ClosingEngine {
  void deps;

  return {
    previewKolektibilitas(
      _input: JalankanKolektibilitasInput,
      _ctx: ClosingContext,
    ): Promise<PreviewKolektibilitas> {
      return belumDiimplementasikan("previewKolektibilitas", "8.1 preview mode");
    },

    jalankanKolektibilitas(
      _input: JalankanKolektibilitasInput,
      _ctx: ClosingContext,
    ): Promise<HasilKolektibilitas> {
      return belumDiimplementasikan("jalankanKolektibilitas", "8.1");
    },

    riwayatKolektibilitas(
      _periodeId: string,
      _ctx: ClosingContext,
    ): Promise<RiwayatRunKolektibilitas[]> {
      return belumDiimplementasikan("riwayatKolektibilitas", "9.3");
    },

    snapshotKolektibilitas(
      _input: { periodeId: string; cabangId?: string | null },
      _ctx: ClosingContext,
    ): Promise<BarisKolektibilitas[]> {
      return belumDiimplementasikan("snapshotKolektibilitas", "8.1 langkah 6");
    },

    hitungPenyisihan(
      _input: JalankanPenyisihanInput,
      _ctx: ClosingContext,
    ): Promise<PenyisihanPeriode[]> {
      return belumDiimplementasikan("hitungPenyisihan", "8.2 langkah 1-3");
    },

    jalankanPenyisihan(
      _input: JalankanPenyisihanInput,
      _ctx: ClosingContext,
    ): Promise<PenyisihanPeriode[]> {
      return belumDiimplementasikan("jalankanPenyisihan", "8.2 langkah 4-5");
    },

    jalankanAkrualJasaAdm(
      _input: JalankanAkrualInput,
      _ctx: ClosingContext,
    ): Promise<HasilAkrual> {
      return belumDiimplementasikan("jalankanAkrualJasaAdm", "8.3");
    },

    periksaPrasyarat(_periodeId: string, _ctx: ClosingContext): Promise<DaftarPrasyarat> {
      return belumDiimplementasikan("periksaPrasyarat", "8.4 checklist prasyarat");
    },

    tutupPeriode(
      _input: TutupPeriodeInput,
      _ctx: ClosingContext,
    ): Promise<HasilTutupPeriode> {
      return belumDiimplementasikan("tutupPeriode", "8.4 eksekusi");
    },

    bukaKembaliPeriode(
      _input: ReopenPeriodeInput,
      _ctx: ClosingContext,
    ): Promise<PeriodeClosing> {
      return belumDiimplementasikan("bukaKembaliPeriode", "8.4 reopen");
    },

    saldoAkunPeriode(
      _filter: FilterSaldoAkunPeriode,
      _ctx: ClosingContext,
    ): Promise<SaldoAkunPeriode[]> {
      return belumDiimplementasikan("saldoAkunPeriode", "8.4 saldo_akun_periode");
    },
  };
}
