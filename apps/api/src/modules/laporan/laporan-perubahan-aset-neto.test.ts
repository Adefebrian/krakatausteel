// LAPORAN PERUBAHAN ASET NETO (spec 10.3 report 20): "Saldo awal, kenaikan
// atau penurunan, saldo akhir, per kategori aset neto".
//
// THE SCHEMA GAP THIS REPORT SITS ON TOP OF, stated plainly because it is a
// finding and not a design.
//
// `akun.klasifikasi_laporan` is SINGLE-VALUED and every account's one value is
// already spent: balance-sheet accounts point at POSISI_KEUANGAN lines, result
// accounts point at AKTIVITAS lines. No account can therefore point at a
// PERUBAHAN_ASET_NETO line, and `baris_laporan` ships no PERUBAHAN_ASET_NETO
// rows at all. Laporan Arus Kas has the same problem and the schema solves it
// with a parallel column (`akun.klasifikasi_arus_kas`); there is no equivalent
// column for net-asset categories.
//
// So this report is defined on the only mapping that exists:
//   - the CATEGORIES are the POSISI_KEUANGAN lines whose `seksi` is ASET_NETO;
//   - a movement from Laporan Aktivitas belongs to the category whose
//     `baris_laporan.kode` equals that AKTIVITAS line's `seksi`;
//   - an AKTIVITAS line whose `seksi` names no such category is a REFUSAL, not
//     a silent drop, because a dropped movement makes saldoAkhir stop equalling
//     saldoAwal + perubahan.
// ./contract.ts states it, ./laporan-struktur-data.test.ts proves the refusal,
// and the report is reported upward as needing a schema decision.
//
// NOTHING HERE ASSERTS WHICH CATEGORIES ARE CORRECT. docs/REGULASI.md finding
// 1 and docs/BUILD-PLAN.md: PSAK 45's "Tidak Terikat / Terikat Temporer"
// versus ISAK 335's "tanpa pembatasan / dengan pembatasan" is the client
// accounting team's decision, and two templates have to be able to coexist.
// The tests assert that whatever rows exist are the rows reported on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HARAPAN,
  KODE_BARIS,
  SEKSI,
  buatDunia,
  headerSah,
  jumlahUang,
  keSen,
  rp,
  semuaAngkaSah,
  type DuniaLaporan,
} from "./test-support";
import { NAMA_LAPORAN, NOL_TAMPIL, type LaporanPerubahanAsetNeto } from "./contract";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterAll(async () => {
  await d?.tutup();
});

function perubahan(cabangId: string | null = null): Promise<LaporanPerubahanAsetNeto> {
  return d.engine.laporanPerubahanAsetNeto(
    { periodeId: d.periodeLaporan().id, cabangId: cabangId ?? d.cabangId },
    d.ctx.adminPusat,
  );
}

describe("saldo awal + perubahan = saldo akhir, per kategori dan di total", () => {
  test("identitas berlaku per kategori, dengan angka yang bukan nol", async () => {
    const l = await perubahan();
    expect(l.baris.length).toBe(2);
    for (const b of l.baris) {
      expect(
        jumlahUang(b.saldoAwalTahunIni.nilai, b.perubahanTahunIni.nilai),
        `identitas ${b.kategoriKode}`,
      ).toBe(b.saldoAkhirTahunIni.nilai);
      expect(
        jumlahUang(b.saldoAwalTahunLalu.nilai, b.perubahanTahunLalu.nilai),
        `identitas tahun lalu ${b.kategoriKode}`,
      ).toBe(b.saldoAkhirTahunLalu.nilai);
      // NON-VACUOUS: every category actually moved.
      expect(keSen(b.perubahanTahunIni.nilai), `${b.kategoriKode} tidak bergerak`).not.toBe(0n);
    }
  });

  test("angka per kategori sesuai buku standar", async () => {
    const l = await perubahan();
    const tidakTerikat = l.baris.find((b) => b.kategoriKode === KODE_BARIS.asetNetoTidakTerikat)!;
    const terikat = l.baris.find((b) => b.kategoriKode === KODE_BARIS.asetNetoTerikat)!;

    expect(tidakTerikat.saldoAwalTahunIni.nilai).toBe(HARAPAN.asetNetoTidakTerikatAwal);
    expect(tidakTerikat.perubahanTahunIni.nilai).toBe(
      HARAPAN.kenaikanAsetNetoTidakTerikatTahunIni,
    );
    expect(tidakTerikat.saldoAkhirTahunIni.nilai).toBe(HARAPAN.asetNetoTidakTerikatAkhir);

    // A genuine zero opening balance. Spec 10: it prints, it is not blank.
    expect(terikat.saldoAwalTahunIni.nilai).toBe(HARAPAN.asetNetoTerikatAwal);
    expect(terikat.saldoAwalTahunIni.tampil).toBe(NOL_TAMPIL);
    expect(terikat.perubahanTahunIni.nilai).toBe(HARAPAN.kenaikanAsetNetoTerikatTahunIni);
    expect(terikat.saldoAkhirTahunIni.nilai).toBe(HARAPAN.asetNetoTerikatAkhir);
  });

  test("total menjumlah kategorinya dan identitasnya berlaku di total", async () => {
    const l = await perubahan();
    const jumlahKolom = (ambil: (b: (typeof l.baris)[number]) => string) =>
      l.baris.reduce((t, b) => jumlahUang(t, ambil(b)), rp(0));
    expect(jumlahKolom((b) => b.saldoAwalTahunIni.nilai)).toBe(l.totalSaldoAwalTahunIni.nilai);
    expect(jumlahKolom((b) => b.perubahanTahunIni.nilai)).toBe(l.totalPerubahanTahunIni.nilai);
    expect(jumlahKolom((b) => b.saldoAkhirTahunIni.nilai)).toBe(l.totalSaldoAkhirTahunIni.nilai);
    expect(
      jumlahUang(l.totalSaldoAwalTahunIni.nilai, l.totalPerubahanTahunIni.nilai),
    ).toBe(l.totalSaldoAkhirTahunIni.nilai);
    expect(keSen(l.totalSaldoAkhirTahunIni.nilai)).toBeGreaterThan(0n);
  });
});

describe("laporan 17, 19 dan 20 adalah satu angka dilihat dari tiga sisi", () => {
  test("total saldo akhir sama dengan Total Aset Neto di Posisi Keuangan", async () => {
    const p = d.periodeLaporan();
    const l = await perubahan();
    const posisi = await d.engine.laporanPosisiKeuangan(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(keSen(l.totalSaldoAkhirTahunIni.nilai)).toBeGreaterThan(0n);
    expect(l.totalSaldoAkhirTahunIni.nilai).toBe(posisi.totalAsetNetoTahunIni.nilai);
    expect(l.totalSaldoAwalTahunIni.nilai).toBe(posisi.totalAsetNetoTahunLalu.nilai);
  });

  test("total perubahan sama dengan kenaikan aset neto di Laporan Aktivitas", async () => {
    const p = d.periodeLaporan();
    const l = await perubahan();
    const aktivitas = await d.engine.laporanAktivitas(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(l.totalPerubahanTahunIni.nilai).toBe(aktivitas.kenaikanAsetNetoTahunIni.nilai);
    // And per category, which is the part that catches a report that got the
    // total right by putting everything in one bucket.
    for (const s of aktivitas.seksi) {
      const kategori = l.baris.find((b) => b.kategoriKode === s.kode);
      expect(kategori, `kategori untuk seksi ${s.kode} tidak ada`).toBeDefined();
      expect(kategori!.perubahanTahunIni.nilai).toBe(s.kenaikanAsetNetoTahunIni.nilai);
    }
  });
});

describe("kategori berasal dari baris_laporan, bukan dari kode", () => {
  test("kategori adalah baris POSISI_KEUANGAN berseksi ASET_NETO, dalam urutannya", async () => {
    const l = await perubahan();
    const tabel = (await d.bacaBarisLaporan("POSISI_KEUANGAN")).filter(
      (b) => b.seksi === SEKSI.asetNeto && b.aktif && b.tipe_baris === "DETAIL",
    );
    // A category is a DETAIL row: the section CAPTION (`tipe_baris = HEADER`)
    // is not a category and must not print as a third, permanently empty one.
    expect(tabel.map((b) => b.kode)).not.toContain(KODE_BARIS.asetNeto);
    expect(l.baris.map((b) => b.kategoriKode)).toEqual(tabel.map((b) => b.kode));
    for (const b of l.baris) {
      const row = tabel.find((t) => t.kode === b.kategoriKode)!;
      expect(b.nama).toBe(row.nama);
      expect(b.urutan).toBe(row.urutan);
    }
  });

  test("nama kategori adalah nama di tabel, bukan istilah yang dipilih kode", async () => {
    // The wording is contested (PSAK 45 versus ISAK 335). This asserts only
    // that the printed name IS the stored name, so renaming the row renames
    // the report and no code has an opinion.
    const l = await perubahan();
    const tabel = await d.bacaBarisLaporan("POSISI_KEUANGAN");
    for (const b of l.baris) {
      expect(b.nama).toBe(tabel.find((t) => t.kode === b.kategoriKode)!.nama);
    }
  });
});

describe("header dan format", () => {
  test("header spec 10 lengkap, dan setiap sel punya tampilan", async () => {
    const l = await perubahan();
    headerSah(l.header as unknown as Record<string, unknown>, d, {
      namaLaporan: NAMA_LAPORAN.PERUBAHAN_ASET_NETO,
      cabangId: d.cabangId,
      sumberData: "LEDGER_LIVE",
    });
    expect(semuaAngkaSah(l, "perubahanAsetNeto")).toBeGreaterThan(15);
  });
});
