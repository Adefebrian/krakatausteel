// apps/api/src/modules/laporan/service.ts
//
// THE CORE ACCOUNTING REPORTS (spec 10.3 reports 16 to 20, 22, 23).
// UNIMPLEMENTED ON PURPOSE. This is the tests-first pass: ./contract.ts states
// the shape and the *.test.ts files in this folder state the behaviour, and
// both were written before a line of this file existed.
//
// EVERY METHOD THROWS A PLAIN `Error`, DELIBERATELY, NOT A `LaporanError`.
// The tests that assert a REFUSAL (`tolakDengan(..., "CABANG_DILUAR_SCOPE")`)
// check both the error TYPE and its `kode`, so a stub that threw a
// `LaporanError` with a convenient code would make an authorisation test pass
// against an engine that does nothing. A plain `Error` cannot satisfy them.
// That is the one failure mode a tests-first suite exists to prevent.
//
// WHAT THE IMPLEMENTATION MUST DO, in the order the tests demand it:
//
//  1. AUTHORISE FIRST. `laporan.view` from the SHIPPED catalogue, then branch
//     scope (spec 16 scenario 24). A permission code missing from the
//     catalogue fails closed with `IZIN_BELUM_TERDAFTAR`; it is never treated
//     as granted.
//
//  2. PICK THE PATH, DO NOT MIX THEM. `periode.status = 'CLOSED'` reads
//     `saldo_akun_periode` (and `kolektibilitas_snapshot`, for the reports of
//     a later pass); OPEN computes live. Report `sumberData` honestly. A
//     CLOSED period with no frozen rows REFUSES with
//     `SALDO_PERIODE_BELUM_DIBEKUKAN` rather than recomputing, because a
//     silent recomputation is invariant 14's failure mode and is invisible in
//     the output.
//
//  3. LIVE MEANS `v_ledger_baris`. Never `status = 'POSTED'` alone. ADR 0010,
//     and migrations/0018 audited every other consumer for exactly this. A
//     POSTED-only reading still balances everywhere, so no total in this
//     module can detect the mistake.
//
//  4. LAYOUT COMES FROM `baris_laporan`. There is no caption list, no
//     `switch (kode)`, and no compiled-in ordering in this file. Spec 4.2 asks
//     for the layout to change without a deploy; docs/BUILD-PLAN.md needs two
//     templates alive at once for PSAK 45 versus ISAK 335.
//
//  5. RENDER EVERY FIGURE. `Angka.tampil` is produced here, not by a caller,
//     and zero renders as `0,00` (spec 10). The Excel and PDF exports of a
//     later pass consume `tampil`; they must not re-implement it.
//
//  6. WRITE NOTHING. No INSERT, no UPDATE, no DELETE, ever. Spec 16 scenario
//     23: the Auditor opens every report and can change nothing.
import type {
  FilterBaganAkun,
  FilterBukuBesar,
  FilterLaporan,
  LaporanAktivitas,
  LaporanArusKas,
  LaporanBaganAkun,
  LaporanBukuBesar,
  LaporanContext,
  LaporanEngine,
  LaporanEngineDeps,
  LaporanNeracaLajur,
  LaporanPerubahanAsetNeto,
  LaporanPosisiKeuangan,
} from "./contract";

const BELUM = (metode: string): never => {
  throw new Error(
    `modules/laporan: ${metode} belum diimplementasi (Fase 6, spec 10.3). ` +
      "Kontrak dan test ditulis lebih dulu; lihat ./contract.ts.",
  );
};

export function buatEngineLaporan(_deps: LaporanEngineDeps): LaporanEngine {
  return {
    async baganAkun(_filter: FilterBaganAkun, _ctx: LaporanContext): Promise<LaporanBaganAkun> {
      return BELUM("baganAkun");
    },
    async laporanAktivitas(
      _filter: FilterLaporan,
      _ctx: LaporanContext,
    ): Promise<LaporanAktivitas> {
      return BELUM("laporanAktivitas");
    },
    async laporanArusKas(_filter: FilterLaporan, _ctx: LaporanContext): Promise<LaporanArusKas> {
      return BELUM("laporanArusKas");
    },
    async laporanPosisiKeuangan(
      _filter: FilterLaporan,
      _ctx: LaporanContext,
    ): Promise<LaporanPosisiKeuangan> {
      return BELUM("laporanPosisiKeuangan");
    },
    async laporanPerubahanAsetNeto(
      _filter: FilterLaporan,
      _ctx: LaporanContext,
    ): Promise<LaporanPerubahanAsetNeto> {
      return BELUM("laporanPerubahanAsetNeto");
    },
    async bukuBesar(_filter: FilterBukuBesar, _ctx: LaporanContext): Promise<LaporanBukuBesar> {
      return BELUM("bukuBesar");
    },
    async neracaLajur(_filter: FilterLaporan, _ctx: LaporanContext): Promise<LaporanNeracaLajur> {
      return BELUM("neracaLajur");
    },
  };
}
