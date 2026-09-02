// LAPORAN AKTIVITAS (spec 10.3 report 17).
//
// "Format entitas nirlaba. Bagian Perubahan Aset Neto Tidak Terikat:
//  Pendapatan (...), lalu Beban (...), lalu Kenaikan atau Penurunan Aset Neto
//  Tidak Terikat. Bagian Perubahan Aset Neto Terikat Temporer. Kolom tahun ini
//  dan tahun lalu bersebelahan."
//
// WHAT THIS FILE DOES NOT ASSERT, DELIBERATELY.
// Not one test here claims that "Aset Neto Tidak Terikat" is the right caption
// or the right concept. docs/REGULASI.md finding 1: PSAK 45 was withdrawn and
// ISAK 335 says "tanpa pembatasan" / "dengan pembatasan"; an amendment
// effective 2027 moves the format again; audited BUMN practice is split; and
// docs/BUILD-PLAN.md records that the decision belongs to the client's
// accounting team and that TWO templates must be able to live side by side.
// The specification's own caption list is therefore SEED DATA.
//
// WHAT IT ASSERTS INSTEAD IS THE MECHANIC. The lines printed are the
// `baris_laporan` rows for AKTIVITAS, in that table's order, fed by the
// accounts whose `klasifikasi_akun` maps onto them, grouped by that table's
// `seksi`. Which rows exist is a configuration question with no deploy
// attached; ./laporan-struktur-data.test.ts proves that by editing them.
//
// THE SPAN IS THE FINANCIAL YEAR TO DATE, and both spans are RETURNED. The
// comparative column is the SAME SPAN one year earlier, which is a different
// convention from Laporan Posisi Keuangan's (preceding year END), and a caller
// must not have to guess which it got.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HARAPAN,
  KODE_BARIS,
  SEKSI,
  TAHUN_INI,
  TAHUN_LALU,
  buatDunia,
  headerSah,
  jumlahUang,
  keSen,
  kurangUang,
  rp,
  semuaAngkaSah,
  type DuniaLaporan,
} from "./test-support";
import { NAMA_LAPORAN, NOL_TAMPIL, type LaporanAktivitas } from "./contract";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterAll(async () => {
  await d?.tutup();
});

function aktivitas(cabangId: string | null = null): Promise<LaporanAktivitas> {
  return d.engine.laporanAktivitas(
    { periodeId: d.periodeLaporan().id, cabangId: cabangId ?? d.cabangId },
    d.ctx.adminPusat,
  );
}

describe("angka pokok: pendapatan, beban, kenaikan aset neto", () => {
  test("ketiganya bukan nol dan kenaikan = pendapatan - beban", async () => {
    const l = await aktivitas();
    const pendapatan = l.seksi.reduce(
      (t, s) => jumlahUang(t, s.totalPendapatanTahunIni.nilai),
      rp(0),
    );
    const beban = l.seksi.reduce((t, s) => jumlahUang(t, s.totalBebanTahunIni.nilai), rp(0));

    // NON-VACUOUS FIRST: a report with no revenue and no expense satisfies the
    // subtraction below.
    expect(keSen(pendapatan)).toBeGreaterThan(0n);
    expect(keSen(beban)).toBeGreaterThan(0n);
    expect(pendapatan).toBe(HARAPAN.pendapatanTahunIni);
    expect(beban).toBe(HARAPAN.bebanTahunIni);
    expect(kurangUang(pendapatan, beban)).toBe(l.kenaikanAsetNetoTahunIni.nilai);
    expect(l.kenaikanAsetNetoTahunIni.nilai).toBe(HARAPAN.kenaikanAsetNetoTahunIni);
  });

  test("kolom tahun lalu bergerak juga, dengan angka yang berbeda", async () => {
    const l = await aktivitas();
    expect(l.kenaikanAsetNetoTahunLalu.nilai).toBe(HARAPAN.kenaikanAsetNetoTahunLalu);
    expect(keSen(l.kenaikanAsetNetoTahunLalu.nilai)).toBeGreaterThan(0n);
    // If the two columns were the same query, this would be equal.
    expect(l.kenaikanAsetNetoTahunLalu.nilai).not.toBe(l.kenaikanAsetNetoTahunIni.nilai);
  });

  test("bottom line ini adalah kenaikan aset neto periode berjalan di Posisi Keuangan", async () => {
    // Report 17's bottom line, report 19's current-year movement and report
    // 20's total change are ONE number seen three ways. Asserting the tie here
    // is what stops each report from being separately plausible and jointly
    // wrong.
    const l = await aktivitas();
    const posisi = await d.engine.laporanPosisiKeuangan(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(posisi.kenaikanAsetNetoPeriodeBerjalanTahunIni.nilai).toBe(
      l.kenaikanAsetNetoTahunIni.nilai,
    );
    expect(keSen(l.kenaikanAsetNetoTahunIni.nilai)).toBeGreaterThan(0n);
  });
});

describe("seksi: dari baris_laporan.seksi, satu per kategori aset neto", () => {
  test("dua seksi, masing masing dengan kenaikannya sendiri, menjumlah ke total", async () => {
    const l = await aktivitas();
    expect(l.seksi.map((s) => s.kode).sort()).toEqual([SEKSI.terikat, SEKSI.tidakTerikat].sort());

    const tidakTerikat = l.seksi.find((s) => s.kode === SEKSI.tidakTerikat)!;
    const terikat = l.seksi.find((s) => s.kode === SEKSI.terikat)!;
    expect(tidakTerikat.kenaikanAsetNetoTahunIni.nilai).toBe(
      HARAPAN.kenaikanAsetNetoTidakTerikatTahunIni,
    );
    expect(terikat.kenaikanAsetNetoTahunIni.nilai).toBe(HARAPAN.kenaikanAsetNetoTerikatTahunIni);
    // NON-VACUOUS: both sections carry money, so a report that put everything
    // in one bucket cannot pass.
    expect(keSen(tidakTerikat.kenaikanAsetNetoTahunIni.nilai)).toBeGreaterThan(0n);
    expect(keSen(terikat.kenaikanAsetNetoTahunIni.nilai)).toBeGreaterThan(0n);
    expect(
      jumlahUang(
        tidakTerikat.kenaikanAsetNetoTahunIni.nilai,
        terikat.kenaikanAsetNetoTahunIni.nilai,
      ),
    ).toBe(l.kenaikanAsetNetoTahunIni.nilai);
  });

  test("seksi terikat kosong di tahun lalu, dan tetap dicetak sebagai 0,00", async () => {
    // The restricted contribution is 2026 only. Spec 10: the prior-year cell
    // prints 0,00, "karena tim akuntansi memakainya untuk cross check".
    const l = await aktivitas();
    const terikat = l.seksi.find((s) => s.kode === SEKSI.terikat)!;
    expect(terikat.kenaikanAsetNetoTahunLalu.nilai).toBe(rp(0));
    expect(terikat.kenaikanAsetNetoTahunLalu.tampil).toBe(NOL_TAMPIL);
    expect(terikat.totalPendapatanTahunLalu.tampil).toBe(NOL_TAMPIL);
  });

  test("beban masuk seksi tidak terikat, dan pendapatan terikat tidak dikurangi beban", async () => {
    const l = await aktivitas();
    const terikat = l.seksi.find((s) => s.kode === SEKSI.terikat)!;
    expect(terikat.totalBebanTahunIni.nilai).toBe(rp(0));
    expect(terikat.totalPendapatanTahunIni.nilai).toBe(rp(25_000_000));
    const tidakTerikat = l.seksi.find((s) => s.kode === SEKSI.tidakTerikat)!;
    expect(tidakTerikat.totalBebanTahunIni.nilai).toBe(HARAPAN.bebanTahunIni);
  });
});

describe("struktur baris: dari baris_laporan, bukan dari kode", () => {
  test("baris dicetak dalam urutan tabel dan menamai akun yang mengisinya", async () => {
    const l = await aktivitas();
    const tabel = (await d.bacaBarisLaporan("AKTIVITAS")).filter((b) => b.aktif);
    expect(l.baris.map((b) => b.kode)).toEqual(tabel.map((b) => b.kode));
    for (const b of l.baris) {
      const row = tabel.find((t) => t.kode === b.kode)!;
      expect(b.barisLaporanId).toBe(row.id);
      expect(b.nama).toBe(row.nama);
      expect(b.seksi).toBe(row.seksi);
    }
    const pendapatan = l.baris.find((b) => b.kode === KODE_BARIS.pendapatan)!;
    // Four revenue accounts point at this line in the shipped seed; only two
    // carry a balance, and the drill-down lists the ones that fed the figure.
    expect(pendapatan.akunKode).toContain(d.akun.pendapatanAlokasi.kode);
    expect(pendapatan.akunKode).toContain(d.akun.pendapatanJasaAdm.kode);
    expect(pendapatan.akunKode).not.toContain(d.akun.pendapatanTerikat.kode);
  });

  test("baris pendapatan dan baris beban keduanya positif: tanda ada di seksinya", async () => {
    // A revenue line printing 329 juta and an expense line printing 24 juta is
    // what an accountant reads; the subtraction happens at the section total.
    // A report that returned the expense as negative would double the
    // deduction at the section level.
    const l = await aktivitas();
    const pendapatan = l.baris.find((b) => b.kode === KODE_BARIS.pendapatan)!;
    const beban = l.baris.find((b) => b.kode === KODE_BARIS.beban)!;
    expect(pendapatan.nilaiTahunIni.nilai).toBe(rp(304_000_000));
    expect(beban.nilaiTahunIni.nilai).toBe(HARAPAN.bebanTahunIni);
    expect(keSen(beban.nilaiTahunIni.nilai)).toBeGreaterThan(0n);
    expect(pendapatan.tanda).toBe(1);
    expect(beban.tanda).toBe(1);
  });
});

describe("kolom pembanding: rentang yang sama satu tahun lebih awal", () => {
  test("kedua rentang dikembalikan, dan tahun lalu bukan akhir tahun", async () => {
    const l = await aktivitas();
    expect(l.kolom.dariTahunIni).toBe(`${TAHUN_INI}-01-01`);
    expect(l.kolom.sampaiTahunIni).toBe(`${TAHUN_INI}-03-31`);
    // DIFFERENT CONVENTION FROM REPORT 19 ON PURPOSE: a statement of activity
    // compares like span with like span.
    expect(l.kolom.dariTahunLalu).toBe(`${TAHUN_LALU}-01-01`);
    expect(l.kolom.sampaiTahunLalu).toBe(`${TAHUN_LALU}-03-31`);
  });

  test("kalau kolom pembanding memakai setahun penuh, angkanya akan berbeda", async () => {
    // 2025 as a whole is 405 juta of revenue and 42 juta of expense; the first
    // quarter alone is 400 juta and nil. A report that quietly used the full
    // prior year would produce 363.000.000 here.
    const l = await aktivitas();
    expect(l.kenaikanAsetNetoTahunLalu.nilai).toBe(rp(400_000_000));
    expect(l.kenaikanAsetNetoTahunLalu.nilai).not.toBe(rp(363_000_000));
  });
});

describe("cakupan: hanya akun hasil, hanya cabang yang diminta", () => {
  test("akun neraca tidak muncul di laporan aktivitas", async () => {
    const l = await aktivitas();
    const semuaAkun = l.baris.flatMap((b) => b.akunKode);
    expect(semuaAkun).not.toContain(d.akun.kas.kode);
    expect(semuaAkun).not.toContain(d.akun.piutangPokok.kode);
    expect(semuaAkun).not.toContain(d.akun.asetNetoTidakTerikat.kode);
  });

  test("filter cabang: jurnal cabang B tidak masuk laporan cabang utama", async () => {
    const utama = await aktivitas();
    const semua = await d.engine.laporanAktivitas(
      { periodeId: d.periodeLaporan().id, cabangId: null },
      d.ctx.adminPusat,
    );
    expect(
      kurangUang(semua.kenaikanAsetNetoTahunIni.nilai, utama.kenaikanAsetNetoTahunIni.nilai),
    ).toBe(rp(50_000_000));
  });
});

describe("header dan format", () => {
  test("header spec 10 lengkap, dan setiap sel punya tampilan", async () => {
    const l = await aktivitas();
    headerSah(l.header as unknown as Record<string, unknown>, d, {
      namaLaporan: NAMA_LAPORAN.AKTIVITAS,
      cabangId: d.cabangId,
      sumberData: "LEDGER_LIVE",
    });
    expect(l.header.dariTanggal).toBe(`${TAHUN_INI}-01-01`);
    expect(l.header.sampaiTanggal).toBe(`${TAHUN_INI}-03-31`);
    expect(semuaAngkaSah(l, "aktivitas")).toBeGreaterThan(15);
  });
});
