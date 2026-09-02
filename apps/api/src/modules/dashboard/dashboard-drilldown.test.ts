// EVERY NUMBER IS DRILLABLE, OR IT IS NOT SHOWN (contract rule 1, spec 11:
// "Semua angka wajib bisa diklik untuk drill down ... Angka yang tidak bisa
// ditelusuri asalnya tidak dipercaya user").
//
// This file SWEEPS. It builds a world with something in every panel, asks for
// the whole summary, and then calls `rincian` on EVERY key the summary emitted
// -- metrics, kolektibilitas classes and queue stages alike. A metric added
// without a drill-down fails here rather than on the page.
//
// It sweeps BOTH SOURCES. The same sweep runs over a CLOSED month (frozen rows)
// and an OPEN one (live rows), because the drill-down branches on exactly the
// boolean the figures branch on, and a drill-down that only works for an open
// month is a link that dies the day the month is closed.
//
// AND IT CHECKS THE ROWS ADD UP. A drill-down that answers with plausible but
// unrelated rows is worse than none: it looks like corroboration. For every
// money metric whose page is not truncated, the rows are summed and compared to
// the figure that was clicked.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buatDuniaDashboard, rp, type DuniaDashboard } from "./test-support";
import { DashboardError } from "./contract";
import type { RingkasanDashboard } from "./contract";

function sen(nilai: string): bigint {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(nilai);
  if (!m) throw new Error(`bukan Uang: ${nilai}`);
  const besar = BigInt(m[2] as string) * 100n + BigInt(m[3] as string);
  return m[1] === "-" ? -besar : besar;
}

/** Every drill-down key a summary offers, in the order the page shows them. */
function kunciDari(r: RingkasanDashboard): string[] {
  return [
    ...r.metrik.map((m) => m.rincian).filter((k): k is string => k !== null),
    ...r.kolektibilitas.map((k) => k.rincian),
    ...r.antrian.map((a) => a.rincian),
  ];
}

describe("dashboard: setiap angka bisa ditelusuri", () => {
  let d: DuniaDashboard;
  let beku: RingkasanDashboard;
  let hidup: RingkasanDashboard;

  beforeAll(async () => {
    d = await buatDuniaDashboard();

    // --- month 1, which will be CLOSED ------------------------------------
    await d.alokasiKas({ cabangId: d.cabangA.id, nilai: rp(80_000_000), bulan: 1 });
    const akadSatu = await d.buatAkad({
      cabangId: d.cabangA.id,
      pokok: rp(12_000_000),
      jasa: rp(360_000),
      bulan: 1,
    });
    await d.cairkan(akadSatu, { bulan: 1 });
    const hibahSatu = await d.salurkanNonPumk({
      cabangId: d.cabangA.id,
      nilai: rp(6_000_000),
      bulan: 1,
    });
    await d.kembalikanNonPumk(hibahSatu, { nilai: rp(1_000_000), bulan: 1 });
    // The instalment of `akadSatu` falls due in month 2; paid in full, so the
    // collection ratio for month 2 has both legs non-zero.
    await d.bayarJadwal(akadSatu, { pokok: rp(12_000_000), jasa: rp(360_000) });
    await d.tutupPeriode(1);

    // --- month 3, which stays OPEN ----------------------------------------
    await d.alokasiKas({ cabangId: d.cabangA.id, nilai: rp(25_000_000), bulan: 3 });
    const akadDua = await d.buatAkad({
      cabangId: d.cabangA.id,
      pokok: rp(9_000_000),
      jasa: rp(270_000),
      bulan: 3,
    });
    await d.cairkan(akadDua, { bulan: 3 });
    const hibahDua = await d.salurkanNonPumk({
      cabangId: d.cabangA.id,
      nilai: rp(4_000_000),
      bulan: 3,
    });
    await d.kembalikanNonPumk(hibahDua, { nilai: rp(500_000), bulan: 3 });
    // An akad from month 2 whose single instalment falls due in month 3, so
    // TINGKAT_PENGEMBALIAN has rows to divide.
    const akadTiga = await d.buatAkad({
      cabangId: d.cabangA.id,
      pokok: rp(5_000_000),
      jasa: rp(150_000),
      bulan: 2,
    });
    await d.cairkan(akadTiga, { bulan: 2 });
    await d.bayarJadwal(akadTiga, { pokok: rp(2_000_000), jasa: rp(0) });

    // One document parked at every stage the queue panel knows about.
    for (const status of [
      "SURVEY_PENDING",
      "REVIEW_CHECKER",
      "MENUNGGU_PERSETUJUAN",
      "DISETUJUI",
      "AKAD_DIBUAT",
      "JADWAL_SIAP",
    ]) {
      await d.proposalPumkDi({ cabangId: d.cabangA.id, status });
    }
    for (const status of [
      "PENILAIAN",
      "REVIEW_CHECKER",
      "MENUNGGU_PERSETUJUAN",
      "DISETUJUI",
      "LPJ_DIAJUKAN",
    ]) {
      await d.proposalNonPumkDi({ cabangId: d.cabangA.id, status });
    }

    await d.buatBaselineNonPumk({ cabangId: null, bulan: 3, jumlah: rp(10_000_000) });

    beku = await d.engine.ringkasan({ periodeId: d.periode(1).id }, d.ctx.adminPusat);
    hidup = await d.engine.ringkasan({ periodeId: d.periode(3).id }, d.ctx.adminPusat);
  });

  afterAll(async () => {
    await d.tutup();
  });

  test("periode OPEN menawarkan kunci untuk setiap panel yang terisi", () => {
    const kunci = kunciDari(hidup);
    expect(kunci).toContain("metrik:PENYALURAN_PUMK");
    expect(kunci).toContain("metrik:REALISASI_NON_PUMK");
    expect(kunci).toContain("metrik:ANGGARAN_NON_PUMK");
    expect(kunci).toContain("metrik:EFEKTIVITAS_NON_PUMK");
    expect(kunci).toContain("metrik:TINGKAT_PENGEMBALIAN");
    expect(kunci).toContain("metrik:LPJ_TERLAMBAT");
    expect(kunci).toContain("antrian:PUMK_SURVEY");
    expect(kunci).toContain("antrian:NONPUMK_LPJ_VERIFIKASI");
  });

  test("periode CLOSED menawarkan kunci kolektibilitas", () => {
    expect(kunciDari(beku)).toContain("kolektibilitas:LANCAR");
    expect(beku.sumberPeriode).toBe("SALDO_AKUN_PERIODE");
  });

  test("SAPUAN periode OPEN: setiap kunci yang ditawarkan menjawab", async () => {
    const kunci = kunciDari(hidup);
    expect(kunci.length).toBeGreaterThan(10);
    for (const k of kunci) {
      const r = await d.engine.rincian(
        k,
        { periodeId: d.periode(3).id },
        d.ctx.adminPusat,
      );
      expect(r.kunci).toBe(k);
      expect(r.nama.length).toBeGreaterThan(0);
      expect(r.sumber).not.toBeNull();
      expect(r.jumlah).toBe(r.baris.length);
      for (const baris of r.baris) {
        expect(baris.id.length).toBeGreaterThan(0);
        expect(baris.entitas.length).toBeGreaterThan(0);
      }
    }
  });

  test("SAPUAN periode CLOSED: setiap kunci yang ditawarkan menjawab", async () => {
    const kunci = kunciDari(beku);
    expect(kunci.length).toBeGreaterThan(10);
    for (const k of kunci) {
      const r = await d.engine.rincian(
        k,
        { periodeId: d.periode(1).id },
        d.ctx.adminPusat,
      );
      expect(r.kunci).toBe(k);
      expect(r.jumlah).toBe(r.baris.length);
    }
  });

  test("baris rincian uang berjumlah persis angka yang diklik", async () => {
    const uangSaja = hidup.metrik.filter(
      (m) => m.jenis === "UANG" && m.rincian !== null && m.nilai !== null,
    );
    expect(uangSaja.length).toBeGreaterThan(3);
    for (const m of uangSaja) {
      const r = await d.engine.rincian(
        m.rincian as string,
        { periodeId: d.periode(3).id },
        d.ctx.adminPusat,
      );
      expect(r.terpotong).toBe(false);
      expect(r.total).toBe(m.nilai);
      const jumlah = r.baris.reduce(
        (akumulasi, b) => akumulasi + sen(b.nilai ?? "0.00"),
        0n,
      );
      expect(jumlah).toBe(sen(m.nilai as string));
    }
  });

  test("baris rincian uang periode CLOSED juga berjumlah persis", async () => {
    const uangSaja = beku.metrik.filter(
      (m) => m.jenis === "UANG" && m.rincian !== null && m.nilai !== null,
    );
    for (const m of uangSaja) {
      const r = await d.engine.rincian(
        m.rincian as string,
        { periodeId: d.periode(1).id },
        d.ctx.adminPusat,
      );
      // BOTH frozen artefacts are legitimate here and they are not
      // interchangeable: money comes from the frozen trial balance, the
      // portfolio from the frozen snapshot. What must never appear is a LIVE
      // source on a closed month.
      expect(["SALDO_AKUN_PERIODE", "KOLEKTIBILITAS_SNAPSHOT"]).toContain(r.sumber);
      const jumlah = r.baris.reduce(
        (akumulasi, b) => akumulasi + sen(b.nilai ?? "0.00"),
        0n,
      );
      expect(jumlah).toBe(sen(m.nilai as string));
    }
  });

  test("tingkat pengembalian: 2.000.000 diterima dari 5.150.000 jatuh tempo", async () => {
    const m = hidup.metrik.find((x) => x.kunci === "TINGKAT_PENGEMBALIAN")!;
    // 2.000.000 / 5.150.000 = 38,8349...% -> 38,83
    expect(m.nilai).toBe("38.83");
    // No frozen artefact exists for a schedule row, and the metric says so
    // rather than pretending the sub ledger is one.
    expect(m.sumber).toBe("SUB_LEDGER");
    const r = await d.engine.rincian(
      "metrik:TINGKAT_PENGEMBALIAN",
      { periodeId: d.periode(3).id },
      d.ctx.adminPusat,
    );
    expect(r.total).toBe(rp(5_150_000));
    expect(r.baris).toHaveLength(1);
    expect(r.baris[0]!.fakta.terbayar).toBe(rp(2_000_000));
  });

  test("efektivitas: realisasi 3.500.000 atas anggaran 10.000.000", () => {
    const realisasi = hidup.metrik.find((x) => x.kunci === "REALISASI_NON_PUMK")!;
    const anggaran = hidup.metrik.find((x) => x.kunci === "ANGGARAN_NON_PUMK")!;
    const efektivitas = hidup.metrik.find((x) => x.kunci === "EFEKTIVITAS_NON_PUMK")!;
    expect(realisasi.nilai).toBe(rp(3_500_000));
    expect(anggaran.nilai).toBe(rp(10_000_000));
    expect(anggaran.sumber).toBe("RKA");
    expect(efektivitas.nilai).toBe("35.00");
  });

  test("batasBaris memotong, dan mengatakannya", async () => {
    const r = await d.engine.rincian(
      "metrik:OUTSTANDING_PUMK",
      { periodeId: d.periode(3).id, batasBaris: 1 },
      d.ctx.adminPusat,
    );
    expect(r.baris).toHaveLength(1);
    expect(r.terpotong).toBe(true);
    // The TOTAL is still the whole population's, not the page's: a truncated
    // page that also truncated its total would silently disagree with the KPI
    // it was opened from.
    // 12.000.000 + 9.000.000 + 5.000.000, the whole live sub ledger.
    expect(r.total).toBe(rp(26_000_000));
  });

  test("kunci yang tidak dikenal: DITOLAK, bukan daftar kosong", async () => {
    for (const salah of ["", "metrik", "metrik:TIDAK_ADA", "antrian:X", "sembarang"]) {
      const janji = d.engine.rincian(
        salah,
        { periodeId: d.periode(3).id },
        d.ctx.adminPusat,
      );
      await expect(janji).rejects.toBeInstanceOf(DashboardError);
      await janji.catch((err: unknown) => {
        expect((err as DashboardError).kode).toBe("RINCIAN_TIDAK_DIKENAL");
      });
    }
  });
});
