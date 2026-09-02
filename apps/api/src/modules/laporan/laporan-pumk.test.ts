// apps/api/src/modules/laporan/laporan-pumk.test.ts
//
// THE ELEVEN PUMK REPORTS OF SPEC 10.1, AGAINST REAL POSTGRES.
//
// WHAT MAKES A REPORT "DONE" HERE, and it is not "it returned rows":
//
//   1. EVERY FIGURE IS AN EXPLICIT NUMERIC FIXTURE. `NILAI` in
//      ./test-support-operasional.ts holds every amount; no assertion below
//      recomputes a number from the report it is checking.
//
//   2. THE CROSS-REPORT IDENTITIES ARE ASSERTED, NOT ASSUMED. Reports 1, 2, 3
//      and 7 are four views of ONE ledger figure and their totals are compared
//      to each other; reports 8, 10, 11 and 28 are four views of ONE snapshot
//      and the same is done; report 9's own outstanding is compared to report
//      8's. Those equalities are what make the catalogue trustworthy, because
//      four implementations that agree on a non-trivial world are far more
//      likely right than four that each match their own expectation.
//
//   3. THE ADR 0010 READING IS MEASURED. A reversed disbursement must LEAVE the
//      sector it was booked in and leave 0,00 behind, not minus the amount. The
//      fixture computes what a POSTED-only query answers, and the tests assert
//      the report DISAGREES with it. Without that, an assertion of the right
//      value could pass on data where both readings coincide.
//
//   4. A REFUSAL IS TESTED AS A PRODUCT. Out-of-scope branch, a partner in
//      another branch, an inverted date window and a period with no
//      collectibility run each have their own code, and the codes are checked
//      against `KODE_LAPORAN` rather than typed as strings.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KODE_LAPORAN, type LaporanContext } from "./contract";
import {
  BUCKET_AGING,
  KELAS_BARU,
  NAMA_LAPORAN_OPERASIONAL,
  WILAYAH_TIDAK_DIKETAHUI,
} from "./kontrak-operasional";
import {
  buatDuniaOperasional,
  JATUH_TEMPO_HARI,
  NILAI,
  TANGGAL,
  type DuniaOperasional,
} from "./test-support-operasional";
import {
  headerSah,
  jumlahUang,
  kodeAda,
  semuaAngkaSah,
  tolakDengan,
  rp,
} from "./test-support";

let w: DuniaOperasional;
let pusat: LaporanContext;
let cabang: LaporanContext;

beforeAll(async () => {
  w = await buatDuniaOperasional();
  pusat = w.d.ctx.adminPusat;
  cabang = w.d.ctx.adminCabang;
});

afterAll(async () => {
  await w?.tutup();
});

/** BULANAN March 2026, one branch: the window most assertions below use. */
const bulanan = () => ({ periodeId: w.periodeLaporan.id, cabangId: w.d.cabangId });
const ytd = () => ({
  periodeId: w.periodeLaporan.id,
  cabangId: w.d.cabangId,
  mode: "KUMULATIF_YTD" as const,
});
const semuaCabang = () => ({ periodeId: w.periodeLaporan.id, cabangId: null });

// ---------------------------------------------------------------------------
// 1. Laporan Realisasi Penyaluran berdasarkan Provinsi, Kota, Kabupaten
// ---------------------------------------------------------------------------

describe("Laporan 1: realisasi penyaluran per wilayah", () => {
  test("provinsi lalu kotanya, dengan total yang sama dengan angka fixture", async () => {
    const l = await w.engine.realisasiWilayah(bulanan(), pusat);

    headerSah(l.header as unknown as { [k: string]: unknown }, w.d, {
      namaLaporan: NAMA_LAPORAN_OPERASIONAL.REALISASI_WILAYAH,
      cabangId: w.d.cabangId,
      // These reports read the ledger and the operational tables, never
      // `saldo_akun_periode`, so they say LEDGER_LIVE whatever the period's
      // status is. See ./dasar-operasional.ts's header note.
      sumberData: "LEDGER_LIVE",
    });
    expect(l.header.dicetakOleh).toBe(w.d.namaUser.adminPusat);
    expect(l.header.tanggalCetak).toBe(TANGGAL.cetak);
    // No `baris_laporan` layout is involved, so the page says so rather than
    // naming a template it did not print from.
    expect(l.header.sumberTemplate).toBe("TANPA_TEMPLATE");
    expect(l.mode).toBe("BULANAN");
    // ADR 0016 is undecided about which address a geography report uses; this
    // module TOOK the decision and the page says which one it took.
    expect(l.dasarWilayah).toBe("ALAMAT_MITRA_SAAT_INI");
    semuaAngkaSah(l);

    // Provinces by name, each immediately followed by its cities, unknown last.
    expect(l.baris.map((b) => [b.tipeBaris, b.provinsiNama, b.kotaNama])).toEqual([
      ["PROVINSI", w.wilayah.banten.provinsiNama, null],
      ["KOTA", w.wilayah.banten.provinsiNama, w.wilayah.banten.kotaNama],
      ["PROVINSI", w.wilayah.jabar.provinsiNama, null],
      ["KOTA", w.wilayah.jabar.provinsiNama, w.wilayah.jabar.kotaNama],
      ["PROVINSI", WILAYAH_TIDAK_DIKETAHUI, null],
      ["KOTA", WILAYAH_TIDAK_DIKETAHUI, WILAYAH_TIDAK_DIKETAHUI],
    ]);

    const prov = l.baris.filter((b) => b.tipeBaris === "PROVINSI");
    expect(prov.map((b) => b.jumlahPenyaluran.nilai)).toEqual([
      NILAI.pencairanA4, // Banten: A4 only, in March
      NILAI.pencairanA2, // Jawa Barat: A2, plus A6 reversed to nothing
      NILAI.pencairanA3, // no address at all
    ]);
    // Jawa Barat holds TWO partners: A2's, and A6's whose disbursement was
    // reversed. The reversal leaves the partner in the count and takes the
    // money out, which is what the ledger actually says happened.
    expect(prov.map((b) => b.jumlahMitra)).toEqual([1, 2, 1]);
    expect(l.total.jumlahPenyaluran.nilai).toBe(NILAI.penyaluranMaretCabangA);
    expect(l.total.jumlahMitra).toBe(4);
  });

  test("A PARTNER WITH NO KOTA IS A ROW, NOT A GAP: the total still ties", async () => {
    const l = await w.engine.realisasiWilayah(bulanan(), pusat);
    const kosong = l.baris.find((b) => b.tipeBaris === "PROVINSI" && b.provinsiId === null);
    expect(kosong?.jumlahPenyaluran.nilai).toBe(NILAI.pencairanA3);
    // The province rows must add up to the footing. If the unknown row were
    // dropped the two would differ by exactly A3, silently.
    const jumlahProvinsi = jumlahUang(
      ...l.baris.filter((b) => b.tipeBaris === "PROVINSI").map((b) => b.jumlahPenyaluran.nilai),
    );
    expect(jumlahProvinsi).toBe(l.total.jumlahPenyaluran.nilai);
  });

  test("persen dari total menjumlah 100,00 dan null hanya kalau totalnya nol", async () => {
    const l = await w.engine.realisasiWilayah(bulanan(), pusat);
    const persen = l.baris
      .filter((b) => b.tipeBaris === "PROVINSI")
      .map((b) => Number(b.persenDariTotal));
    expect(persen.reduce((t, n) => t + n, 0)).toBeCloseTo(100, 2);

    // February in the OTHER branch has no disbursement at all, so the share of
    // nothing must be null rather than a plausible "0,00".
    const kosong = await w.engine.realisasiWilayah(
      { periodeId: w.periodeSebelum.id, cabangId: w.d.cabangLainId },
      pusat,
    );
    expect(kosong.total.jumlahPenyaluran.nilai).toBe(rp(0));
    expect(kosong.baris).toHaveLength(0);
  });

  test("KUMULATIF_YTD menjangkau Februari, BULANAN tidak", async () => {
    const bulan = await w.engine.realisasiWilayah(bulanan(), pusat);
    const kumulatif = await w.engine.realisasiWilayah(ytd(), pusat);
    expect(bulan.total.jumlahPenyaluran.nilai).toBe(NILAI.penyaluranMaretCabangA);
    expect(kumulatif.total.jumlahPenyaluran.nilai).toBe(NILAI.penyaluranYtdCabangA);
    // February adds M001, who took no March loan, so the cumulative partner
    // count grows by exactly one.
    expect(bulan.total.jumlahMitra).toBe(4);
    expect(kumulatif.total.jumlahMitra).toBe(5);
  });

  test("Semua Cabang menambahkan cabang lain; cabang di luar scope DITOLAK", async () => {
    const semua = await w.engine.realisasiWilayah(semuaCabang(), pusat);
    expect(semua.total.jumlahPenyaluran.nilai).toBe(NILAI.penyaluranMaretSemuaCabang);
    expect(semua.total.jumlahMitra).toBe(5);

    // Spec 16 scenario 24: a refusal, never a narrowed WHERE clause. An empty
    // page would read as "that branch did nothing".
    await tolakDengan(
      () => w.engine.realisasiWilayah(semuaCabang(), cabang),
      kodeAda(KODE_LAPORAN.CABANG_DILUAR_SCOPE),
    );
    await tolakDengan(
      () =>
        w.engine.realisasiWilayah(
          { periodeId: w.periodeLaporan.id, cabangId: w.d.cabangLainId },
          cabang,
        ),
      kodeAda(KODE_LAPORAN.CABANG_DILUAR_SCOPE),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Laporan Realisasi Penyaluran berdasarkan Sektor
// ---------------------------------------------------------------------------

describe("Laporan 2: realisasi penyaluran per sektor", () => {
  test("setiap sektor master tercetak, termasuk yang nol", async () => {
    const l = await w.engine.realisasiSektor(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.baris.map((b) => b.kode)).toEqual(["S01", "S02", "S03"]);
    expect(l.baris.map((b) => b.jumlahPenyaluran.nilai)).toEqual([
      jumlahUang(NILAI.pencairanA3, NILAI.pencairanA4), // S01: A3 + A4
      NILAI.pencairanA2, // S02: A2
      rp(0), // S03: A6 only, and A6 was reversed
    ]);
    expect(l.baris.map((b) => b.jumlahMitra)).toEqual([2, 1, 1]);
    expect(l.total.jumlahPenyaluran.nilai).toBe(NILAI.penyaluranMaretCabangA);
  });

  test("PENCAIRAN YANG DIREVERSAL MENINGGALKAN 0,00, BUKAN MINUS (ADR 0010)", async () => {
    const l = await w.engine.realisasiSektor(bulanan(), pusat);
    const s3 = l.baris.find((b) => b.sektorId === w.sektor.s3.id);
    expect(s3?.jumlahPenyaluran.nilai).toBe(rp(0));
    expect(s3?.jumlahPenyaluran.tampil).toBe("0,00");

    // WHAT THE BUG WOULD HAVE ANSWERED. `status = 'POSTED'` alone drops the
    // reversed original and keeps its reversal, so the sector goes NEGATIVE.
    // Asserting the two DIFFER is what stops this test passing vacuously.
    const naif = await w.penyaluranNaifPostedSaja(
      w.sektor.s3.id,
      w.periodeLaporan.tanggalMulai,
      w.periodeLaporan.tanggalAkhir,
      [w.d.cabangId],
    );
    expect(naif).toBe(`-${NILAI.pencairanA6}`);
    expect(naif).not.toBe(s3?.jumlahPenyaluran.nilai);
  });

  test("kolom versus RKA memakai baseline DISETUJUI, dan menyebut versinya", async () => {
    const l = await w.engine.realisasiSektor(bulanan(), pusat);
    expect(l.rkaId).not.toBeNull();
    expect(l.rkaVersi).toBe(1);
    expect(l.baris.map((b) => b.anggaran?.nilai)).toEqual([
      NILAI.anggaranSektor1Maret,
      NILAI.anggaranSektor2Maret,
      NILAI.anggaranSektor3Maret,
    ]);
    // `anggaran - realisasi`: negative means over budget.
    expect(l.baris[0].selisih?.nilai).toBe(rp(20_000_000));
    expect(l.baris[1].selisih?.nilai).toBe(rp(-50_000_000));
    expect(l.baris.map((b) => b.persenCapaian)).toEqual(["80.00", "133.33", "0.00"]);
    expect(l.total.anggaran?.nilai).toBe(rp(270_000_000));
    expect(l.total.persenCapaian).toBe("103.70");
  });

  test("baris anggaran TANPA BULAN masuk di YTD dan tidak di bulanan", async () => {
    const bulan = await w.engine.realisasiSektor(bulanan(), pusat);
    const kumulatif = await w.engine.realisasiSektor(ytd(), pusat);
    const s3Bulan = bulan.baris.find((b) => b.sektorId === w.sektor.s3.id);
    const s3Ytd = kumulatif.baris.find((b) => b.sektorId === w.sektor.s3.id);
    expect(s3Bulan?.anggaran?.nilai).toBe(NILAI.anggaranSektor3Maret);
    expect(s3Ytd?.anggaran?.nilai).toBe(
      jumlahUang(NILAI.anggaranSektor3Maret, NILAI.anggaranSektor3Tahunan),
    );
  });

  test("IDENTITAS: total laporan 2 = total laporan 1 = total laporan 3", async () => {
    for (const filter of [bulanan(), ytd(), semuaCabang()]) {
      const [satu, dua, tiga] = await Promise.all([
        w.engine.realisasiWilayah(filter, pusat),
        w.engine.realisasiSektor(filter, pusat),
        w.engine.penyaluranNasional(filter, pusat),
      ]);
      expect(dua.total.jumlahPenyaluran.nilai).toBe(satu.total.jumlahPenyaluran.nilai);
      expect(tiga.totalKeseluruhan.nilai.nilai).toBe(satu.total.jumlahPenyaluran.nilai);
      expect(dua.total.jumlahMitra).toBe(satu.total.jumlahMitra);
      expect(tiga.totalKeseluruhan.jumlahMitra).toBe(satu.total.jumlahMitra);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Laporan Penyaluran Nasional
// ---------------------------------------------------------------------------

describe("Laporan 3: matriks provinsi x sektor", () => {
  test("matriksnya PADAT: setiap baris punya sel untuk setiap kolom", async () => {
    const l = await w.engine.penyaluranNasional(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.kolom.map((k) => k.kode)).toEqual(["S01", "S02", "S03"]);
    expect(l.baris.map((b) => b.provinsiNama)).toEqual([
      w.wilayah.banten.provinsiNama,
      w.wilayah.jabar.provinsiNama,
      WILAYAH_TIDAK_DIKETAHUI,
    ]);
    for (const b of l.baris) expect(b.sel).toHaveLength(l.kolom.length);
    expect(l.totalKolom).toHaveLength(l.kolom.length);
    // Spec 10's zero rule: a hole is not a zero, so every empty cell prints.
    for (const b of l.baris) for (const s of b.sel) expect(s.nilai.tampil).toMatch(/\d/);
  });

  test("setiap sel ada di tempatnya, dan baris/kolom keduanya berkaki", async () => {
    const l = await w.engine.penyaluranNasional(bulanan(), pusat);
    const sel = (provinsi: string, sektor: string) => {
      const i = l.baris.findIndex((b) => b.provinsiId === provinsi);
      const j = l.kolom.findIndex((k) => k.sektorId === sektor);
      return l.baris[i].sel[j].nilai.nilai;
    };
    expect(sel(w.wilayah.banten.provinsiId, w.sektor.s1.id)).toBe(NILAI.pencairanA4);
    expect(sel(w.wilayah.banten.provinsiId, w.sektor.s2.id)).toBe(rp(0));
    expect(sel(w.wilayah.jabar.provinsiId, w.sektor.s2.id)).toBe(NILAI.pencairanA2);
    expect(sel(w.wilayah.jabar.provinsiId, w.sektor.s3.id)).toBe(rp(0));

    for (const b of l.baris) {
      expect(b.total.nilai.nilai).toBe(jumlahUang(...b.sel.map((s) => s.nilai.nilai)));
    }
    for (let j = 0; j < l.kolom.length; j += 1) {
      expect(l.totalKolom[j].nilai.nilai).toBe(
        jumlahUang(...l.baris.map((b) => b.sel[j].nilai.nilai)),
      );
    }
    expect(l.totalKeseluruhan.nilai.nilai).toBe(NILAI.penyaluranMaretCabangA);
  });

  test("cacah mitra dihitung di levelnya sendiri, tidak dijumlahkan", async () => {
    const l = await w.engine.penyaluranNasional(ytd(), pusat);
    const jumlahSel = l.baris.reduce(
      (t, b) => t + b.sel.reduce((u, s) => u + s.jumlahMitra, 0),
      0,
    );
    // Five partners were funded in the year to date. Every province row's own
    // total is a DISTINCT count too, so it can be smaller than its cells.
    expect(l.totalKeseluruhan.jumlahMitra).toBe(5);
    expect(jumlahSel).toBeGreaterThanOrEqual(l.totalKeseluruhan.jumlahMitra);
    for (const b of l.baris) {
      expect(b.total.jumlahMitra).toBeLessThanOrEqual(
        b.sel.reduce((t, s) => t + s.jumlahMitra, 0),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Laporan Penerimaan Angsuran
// ---------------------------------------------------------------------------

describe("Laporan 4: penerimaan angsuran", () => {
  test("tiga komponen alokasi, dan Total yang benar-benar berkaki", async () => {
    const l = await w.engine.penerimaanAngsuran(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.baris.map((b) => b.tanggalTerima)).toEqual(["2026-03-08", "2026-03-18"]);
    expect(l.baris.map((b) => b.total.nilai)).toEqual([
      NILAI.setoran1Total,
      NILAI.setoran2Total,
    ]);
    // spec 16 scenario 6: the overpayment. Printing only Pokok and Jasa next to
    // Total would produce a row that visibly does not add up.
    expect(l.baris[1].kelebihan.nilai).toBe(NILAI.setoran2Kelebihan);
    for (const b of l.baris) {
      expect(b.total.nilai).toBe(jumlahUang(b.pokok.nilai, b.jasaAdm.nilai, b.kelebihan.nilai));
    }
    expect(l.total).toMatchObject({ jumlahSetoran: 2 });
    expect(l.total.pokok.nilai).toBe(NILAI.setoranMaretPokok);
    expect(l.total.jasaAdm.nilai).toBe(NILAI.setoranMaretJasa);
    expect(l.total.kelebihan.nilai).toBe(NILAI.setoranMaretKelebihan);
    expect(l.total.total.nilai).toBe(NILAI.setoranMaretTotal);
  });

  test("jendela dan cabang benar-benar memfilter", async () => {
    const kumulatif = await w.engine.penerimaanAngsuran(ytd(), pusat);
    expect(kumulatif.total.jumlahSetoran).toBe(3);
    // February's receipt was a PREPAYMENT: it moves `kelebihan`, not `pokok`.
    expect(kumulatif.total.pokok.nilai).toBe(NILAI.setoranMaretPokok);
    expect(kumulatif.total.kelebihan.nilai).toBe(
      jumlahUang(NILAI.setoranMaretKelebihan, rp(3_000_000)),
    );
    expect(kumulatif.total.total.nilai).toBe(
      jumlahUang(NILAI.setoranMaretTotal, rp(3_000_000)),
    );

    const semua = await w.engine.penerimaanAngsuran(semuaCabang(), pusat);
    expect(semua.total.jumlahSetoran).toBe(3);
    const lain = await w.engine.penerimaanAngsuran(
      { periodeId: w.periodeLaporan.id, cabangId: w.d.cabangLainId },
      pusat,
    );
    expect(lain.total.jumlahSetoran).toBe(1);
    expect(lain.total.pokok.nilai).toBe(rp(1_000_000));
  });
});

// ---------------------------------------------------------------------------
// 5. Laporan Jatuh Tempo
// ---------------------------------------------------------------------------

describe("Laporan 5: jatuh tempo ke depan", () => {
  test("HANYA VERSI JADWAL AKTIF, jadi akad yang direschedule tidak dobel", async () => {
    const l = await w.engine.jatuhTempo(
      {
        dariTanggal: TANGGAL.jatuhTempoDari,
        sampaiTanggal: TANGGAL.jatuhTempoSampai,
        cabangId: w.d.cabangId,
      },
      pusat,
    );
    semuaAngkaSah(l);
    expect(l.tanggalAcuan).toBe(TANGGAL.cetak);
    expect(l.baris.map((b) => [b.noAkad, b.angsuranKe, b.tanggalJatuhTempo])).toEqual([
      [w.akad.a1.noAkad, 2, "2026-04-01"],
      [w.akad.a4.noAkad, 1, "2026-04-15"],
      [w.akad.a1.noAkad, 3, "2026-05-01"],
      [w.akad.a1.noAkad, 4, "2026-06-01"],
      // A2's version 2. Its SUPERSEDED version 1 falls due on 15 April and 15
      // May, inside the window, and must not appear.
      [w.akad.a2.noAkad, 1, "2026-06-15"],
    ]);
    expect(l.baris.some((b) => b.total.nilai === rp(120_000_000))).toBe(false);
  });

  test("yang tercetak adalah SISA angsuran, bukan angsuran aslinya", async () => {
    const l = await w.engine.jatuhTempo(
      {
        dariTanggal: TANGGAL.jatuhTempoDari,
        sampaiTanggal: TANGGAL.jatuhTempoSampai,
        cabangId: w.d.cabangId,
      },
      pusat,
    );
    // Instalment 2 is SEBAGIAN: 10.000.000 due, 5.000.000 paid, so 5.000.000
    // is collectable, not 10.000.000.
    expect(l.baris[0].status).toBe("SEBAGIAN");
    expect(l.baris[0].pokok.nilai).toBe(rp(5_000_000));
    expect(l.baris[0].jasaAdm.nilai).toBe(rp(1_000_000));
    expect(l.baris[0].total.nilai).toBe(rp(6_000_000));
    expect(l.total.jumlahAngsuran).toBe(5);
    expect(l.total.pokok.nilai).toBe(rp(155_000_000));
    expect(l.total.jasaAdm.nilai).toBe(rp(9_600_000));
    expect(l.total.total.nilai).toBe(rp(164_600_000));
  });

  test("hari sampai jatuh tempo dihitung dari jam yang disuntikkan", async () => {
    const l = await w.engine.jatuhTempo(
      {
        dariTanggal: TANGGAL.jatuhTempoDari,
        sampaiTanggal: TANGGAL.jatuhTempoSampai,
        cabangId: w.d.cabangId,
      },
      pusat,
    );
    expect(l.baris.map((b) => b.hariSampaiJatuhTempo)).toEqual([
      JATUH_TEMPO_HARI.a1Ke2,
      JATUH_TEMPO_HARI.a4Ke1,
      JATUH_TEMPO_HARI.a1Ke3,
      JATUH_TEMPO_HARI.a1Ke4,
      JATUH_TEMPO_HARI.a2V2Ke1,
    ]);
  });

  test("jendela terbalik DITOLAK, bukan dijawab dengan halaman kosong", async () => {
    await tolakDengan(
      () =>
        w.engine.jatuhTempo(
          { dariTanggal: "2026-06-30", sampaiTanggal: "2026-04-01", cabangId: w.d.cabangId },
          pusat,
        ),
      kodeAda(KODE_LAPORAN.TANGGAL_TIDAK_VALID),
    );
    await tolakDengan(
      () =>
        w.engine.jatuhTempo(
          { dariTanggal: "bukan tanggal", sampaiTanggal: "2026-04-01", cabangId: w.d.cabangId },
          pusat,
        ),
      kodeAda(KODE_LAPORAN.TANGGAL_TIDAK_VALID),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Rekap Permohonan PUMK
// ---------------------------------------------------------------------------

describe("Laporan 6: rekap permohonan", () => {
  test("DUA PENGELOMPOKAN, SATU POPULASI: keduanya berkaki ke total yang sama", async () => {
    const l = await w.engine.rekapPermohonanPumk(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.total.jumlahProposal).toBe(5);
    expect(l.total.nilaiDiajukan.nilai).toBe(NILAI.diajukanMaretCabangA);
    expect(l.total.nilaiDisetujui.nilai).toBe(NILAI.disetujuiMaretCabangA);
    expect(l.total.rasioPersetujuan).toBe("80.00");

    for (const kelompok of [l.perStatus, l.perSektor]) {
      expect(kelompok.reduce((t, b) => t + b.jumlahProposal, 0)).toBe(l.total.jumlahProposal);
      expect(jumlahUang(...kelompok.map((b) => b.nilaiDiajukan.nilai))).toBe(
        l.total.nilaiDiajukan.nilai,
      );
      expect(jumlahUang(...kelompok.map((b) => b.nilaiDisetujui.nilai))).toBe(
        l.total.nilaiDisetujui.nilai,
      );
    }
  });

  test("nilai disetujui adalah baris PERSETUJUAN TERAKHIR, bukan yang pertama", async () => {
    const l = await w.engine.rekapPermohonanPumk(bulanan(), pusat);
    const s2 = l.perSektor.find((b) => b.kunci === w.sektor.s2.id);
    // P2 has two SETUJU rows, 180.000.000 then 200.000.000. Spec 16 scenario 3
    // lets an approver change the plafond, so the later one is the decision.
    expect(s2?.nilaiDisetujui.nilai).toBe(rp(200_000_000));
    expect(s2?.nilaiDiajukan.nilai).toBe(rp(250_000_000));
  });

  test("proposal DITOLAK dihitung sebagai permohonan tapi bukan sebagai persetujuan", async () => {
    const l = await w.engine.rekapPermohonanPumk(bulanan(), pusat);
    const ditolak = l.perStatus.find((b) => b.kunci === "DITOLAK");
    expect(ditolak?.jumlahProposal).toBe(1);
    expect(ditolak?.jumlahDisetujui).toBe(0);
    expect(ditolak?.nilaiDisetujui.nilai).toBe(rp(0));
    // A ratio of nothing approved against something applied for is 0,00, which
    // is a real answer; it is null only when nothing was applied for at all.
    expect(ditolak?.rasioPersetujuan).toBe("0.00");
    expect(l.total.jumlahDisetujui).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 7. Rekap Realisasi PUMK
// ---------------------------------------------------------------------------

describe("Laporan 7: rekap realisasi per bulan", () => {
  test("selalu tahun buku sampai bulan laporan, bulan tanpa aktivitas tetap tercetak", async () => {
    // `mode` is FORCED: a table whose first column is "Bulan" and which holds
    // one month is not the report spec 10.1 describes.
    const l = await w.engine.rekapRealisasiPumk(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.baris.map((b) => [b.tahun, b.bulan])).toEqual([
      [2026, 1],
      [2026, 2],
      [2026, 3],
    ]);
    expect(l.baris[0].jumlahAkad).toBe(0);
    expect(l.baris[0].nilaiAkad.tampil).toBe("0,00");
  });

  test("nilai akad dan nilai dicairkan adalah dua angka berbeda", async () => {
    const l = await w.engine.rekapRealisasiPumk(bulanan(), pusat);
    const maret = l.baris[2];
    // Four akads signed in March in this branch (A2, A3, A4, A6) at contract
    // value, but A6's disbursement was reversed, so the money is 40.000.000
    // less than the contracts.
    expect(maret.jumlahAkad).toBe(4);
    expect(maret.nilaiAkad.nilai).toBe(rp(320_000_000));
    expect(maret.nilaiDicairkan.nilai).toBe(NILAI.penyaluranMaretCabangA);
    expect(l.total.nilaiAkad.nilai).toBe(rp(420_000_000));
    expect(l.total.nilaiDicairkan.nilai).toBe(NILAI.penyaluranYtdCabangA);
  });

  test("mitra baru versus lama DIHITUNG dari akad pertama, bukan dibaca dari flag", async () => {
    const l = await w.engine.rekapRealisasiPumk(bulanan(), pusat);
    const [, februari, maret] = l.baris;
    // M002 settled a 2025 loan, so its March contract makes it LAMA; every
    // other March borrower is taking their first ever akad and counts BARU.
    expect([februari.mitraBaru, februari.mitraLama]).toEqual([1, 0]);
    expect([maret.mitraBaru, maret.mitraLama]).toEqual([3, 1]);
    // DISTINCT over the window, not the sum of the columns.
    expect(l.total.mitraBaru).toBe(4);
    expect(l.total.mitraLama).toBe(1);
    for (const b of l.baris) {
      expect(b.mitraBaru + b.mitraLama).toBeLessThanOrEqual(b.jumlahAkad);
    }
  });

  test("IDENTITAS: kaki laporan 7 = laporan 1, 2 dan 3 dalam KUMULATIF_YTD", async () => {
    const tujuh = await w.engine.rekapRealisasiPumk(bulanan(), pusat);
    const [satu, dua, tiga] = await Promise.all([
      w.engine.realisasiWilayah(ytd(), pusat),
      w.engine.realisasiSektor(ytd(), pusat),
      w.engine.penyaluranNasional(ytd(), pusat),
    ]);
    expect(tujuh.total.nilaiDicairkan.nilai).toBe(satu.total.jumlahPenyaluran.nilai);
    expect(tujuh.total.nilaiDicairkan.nilai).toBe(dua.total.jumlahPenyaluran.nilai);
    expect(tujuh.total.nilaiDicairkan.nilai).toBe(tiga.totalKeseluruhan.nilai.nilai);
  });
});

// ---------------------------------------------------------------------------
// 8. Laporan Aging Piutang
// ---------------------------------------------------------------------------

describe("Laporan 8: aging piutang", () => {
  test("lima bucket spesifikasi, dalam urutannya, yang kosong pun tercetak", async () => {
    const l = await w.engine.agingPiutang(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.header.sumberData).toBe("SNAPSHOT_PERIODE");
    expect(l.perBucket.map((b) => b.kode)).toEqual(BUCKET_AGING.map((b) => b.kode));
    expect(l.perBucket.map((b) => b.outstanding.nilai)).toEqual([
      NILAI.outstandingA1, // 15 hari
      NILAI.outstandingA2, // 45 hari
      rp(0), // 91-180: kosong, dan tetap tercetak
      NILAI.outstandingA3, // 200 hari
      NILAI.outstandingA4, // 300 hari
    ]);
    expect(l.perBucket[2].outstanding.tampil).toBe("0,00");
  });

  test("satu baris per mitra, dan setiap akad mendarat di tepat satu bucket", async () => {
    const l = await w.engine.agingPiutang(bulanan(), pusat);
    expect(l.baris.map((b) => b.kodeMitra)).toEqual([
      w.mitra.m1.kode,
      w.mitra.m2.kode,
      w.mitra.m3.kode,
      w.mitra.m5.kode,
    ]);
    const m1 = l.baris.find((b) => b.mitraId === w.mitra.m1.id);
    expect(m1?.outstanding.nilai).toBe(NILAI.outstandingA1);
    expect(m1?.bucket.B_0_30.nilai).toBe(NILAI.outstandingA1);
    // Every other band on that partner's row is zero, and prints as 0,00.
    expect(m1?.bucket.B_270_PLUS.tampil).toBe("0,00");
    const m5 = l.baris.find((b) => b.mitraId === w.mitra.m5.id);
    expect(m5?.bucket.B_270_PLUS.nilai).toBe(NILAI.outstandingA4);
    // `pumk_akad_satu_aktif_per_mitra_uq` allows one live loan per partner, so
    // one partner in two bands is unreachable on valid data. Each row therefore
    // has exactly one non-zero band, and the fixture does not fake otherwise.
    for (const b of l.baris) {
      const isi = BUCKET_AGING.filter((x) => b.bucket[x.kode].nilai !== rp(0));
      expect(isi).toHaveLength(1);
    }
    expect(l.total.jumlahMitra).toBe(4);
    expect(l.total.outstanding.nilai).toBe(NILAI.outstandingCabangA);
  });

  test("ketiga pengelompokan berkaki ke satu outstanding", async () => {
    const l = await w.engine.agingPiutang(bulanan(), pusat);
    expect(jumlahUang(...l.baris.map((b) => b.outstanding.nilai))).toBe(
      l.total.outstanding.nilai,
    );
    expect(jumlahUang(...l.perBucket.map((b) => b.outstanding.nilai))).toBe(
      l.total.outstanding.nilai,
    );
    expect(jumlahUang(...l.perCabang.map((b) => b.outstanding.nilai))).toBe(
      l.total.outstanding.nilai,
    );
    expect(
      l.perBucket.map((b) => Number(b.persenDariTotal)).reduce((t, n) => t + n, 0),
    ).toBeCloseTo(100, 2);
  });

  test("Semua Cabang memunculkan dua baris per cabang", async () => {
    const l = await w.engine.agingPiutang(semuaCabang(), pusat);
    expect(l.perCabang).toHaveLength(2);
    expect(l.total.outstanding.nilai).toBe(
      jumlahUang(NILAI.outstandingCabangA, NILAI.outstandingA5),
    );
  });

  test("periode tanpa Closing Kolektibilitas DITOLAK, bukan dihitung ulang", async () => {
    // Reading C in ./kontrak-operasional.ts: recomputing at print time would be
    // a second implementation of the provisioning engine, and it would make
    // spec 16 scenario 17's reconciliation unfalsifiable.
    await tolakDengan(
      () =>
        w.engine.agingPiutang(
          { periodeId: w.periodeSebelum.id, cabangId: w.d.cabangId },
          pusat,
        ),
      kodeAda(KODE_LAPORAN.SNAPSHOT_KOLEKTIBILITAS_BELUM_ADA),
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Kartu Piutang Mitra Binaan
// ---------------------------------------------------------------------------

describe("Laporan 9: kartu piutang", () => {
  test("jadwal, setoran dan saldo berjalan konsisten (spec 16 skenario 7)", async () => {
    const l = await w.engine.kartuPiutang(
      { periodeId: w.periodeLaporan.id, cabangId: w.d.cabangId, mitraId: w.mitra.m1.id },
      pusat,
    );
    semuaAngkaSah(l);
    expect(l.kodeMitra).toBe(w.mitra.m1.kode);
    expect(l.akad.map((a) => a.noAkad)).toEqual([w.akad.a1.noAkad]);

    const a1 = l.akad[0];
    expect(a1.pokokDicairkan.nilai).toBe(NILAI.pencairanA1);
    // THE WHOLE PLAN, not the part that has fallen due: an instalment dated
    // after the period end is still owed.
    expect(a1.jadwal).toHaveLength(10);
    // THE CARD IS CUMULATIVE to the period end, so February's prepayment is on
    // it even though report 4's March page is not.
    expect(a1.setoran.map((s) => s.tanggalTerima)).toEqual([
      "2026-02-20",
      "2026-03-08",
      "2026-03-18",
    ]);
    // The running balance falls by the PRINCIPAL allocation of each receipt,
    // starting from what was actually disbursed. The prepayment allocates none,
    // so it leaves the balance where it was.
    expect(a1.setoran.map((s) => s.saldoPokokBerjalan.nilai)).toEqual([
      NILAI.pencairanA1,
      rp(90_000_000),
      NILAI.outstandingA1,
    ]);
    expect(a1.totalPokokDibayar.nilai).toBe(NILAI.setoranMaretPokok);
    expect(a1.totalKelebihan.nilai).toBe(
      jumlahUang(NILAI.setoran2Kelebihan, rp(3_000_000)),
    );
    // THE CONSISTENCY CLAIM IS A FIELD: the akad's own outstanding against the
    // card's own arithmetic, and zero on healthy data.
    expect(a1.outstandingPokokKartu.nilai).toBe(NILAI.outstandingA1);
    expect(a1.selisihOutstandingPokok.nilai).toBe(rp(0));
    expect(l.total.selisihOutstandingPokok.nilai).toBe(rp(0));
  });

  test("kartu memuat akad yang sudah lunas di atas akad yang berjalan", async () => {
    const l = await w.engine.kartuPiutang(
      { periodeId: w.periodeLaporan.id, cabangId: w.d.cabangId, mitraId: w.mitra.m2.id },
      pusat,
    );
    // Newest contract last: the 2025 loan M002 settled, then the live one.
    expect(l.akad.map((a) => a.noAkad)).toEqual([w.akad.a0.noAkad, w.akad.a2.noAkad]);
    const [a0, a2] = l.akad;
    expect(a0.status).toBe("LUNAS");
    expect(a0.pokokDicairkan.nilai).toBe(rp(20_000_000));
    expect(a0.totalPokokDibayar.nilai).toBe(rp(20_000_000));
    expect(a0.outstandingPokokKartu.nilai).toBe(rp(0));
    expect(a0.selisihOutstandingPokok.nilai).toBe(rp(0));
    // A2 is disbursed and unrepaid, so the card runs down from the disbursement
    // and lands exactly on the akad's own figure.
    expect(a2.setoran).toHaveLength(0);
    expect(a2.outstandingPokokKartu.nilai).toBe(NILAI.outstandingA2);
    expect(l.total.pokokDicairkan.nilai).toBe(
      jumlahUang(rp(20_000_000), NILAI.pencairanA2),
    );
    expect(l.total.selisihOutstandingPokok.nilai).toBe(rp(0));
  });

  test("akad yang belum dicairkan berjalan dari nol, bukan dari nilai kontrak", async () => {
    const l = await w.engine.kartuPiutang(
      { periodeId: w.periodeLaporan.id, cabangId: w.d.cabangId, mitraId: w.mitra.m6.id },
      pusat,
    );
    const a6 = l.akad.find((a) => a.noAkad === w.akad.a6.noAkad);
    // A6's disbursement journal was reversed, so no `pumk_pencairan` row
    // exists: the card must show nothing paid out rather than a debt.
    expect(a6?.pokokPinjaman.nilai).toBe(NILAI.pencairanA6);
    expect(a6?.pokokDicairkan.nilai).toBe(rp(0));
    expect(a6?.outstandingPokokKartu.nilai).toBe(rp(0));
  });

  test("IDENTITAS: outstanding kartu = baris mitra itu di laporan 8", async () => {
    const aging = await w.engine.agingPiutang(bulanan(), pusat);
    for (const m of [w.mitra.m1, w.mitra.m2, w.mitra.m3, w.mitra.m5]) {
      const kartu = await w.engine.kartuPiutang(
        { periodeId: w.periodeLaporan.id, cabangId: w.d.cabangId, mitraId: m.id },
        pusat,
      );
      const barisAging = aging.baris.find((b) => b.mitraId === m.id);
      expect(barisAging, m.kode).toBeDefined();
      expect(kartu.total.outstandingPokokAkad.nilai, m.kode).toBe(barisAging!.outstanding.nilai);
    }
  });

  test("mitra di cabang lain DITOLAK, bukan dijawab kartu kosong", async () => {
    // Spec 16 scenario 24's "manipulasi ID di URL": an empty card would read as
    // a partner who never borrowed.
    await tolakDengan(
      () =>
        w.engine.kartuPiutang(
          { periodeId: w.periodeLaporan.id, cabangId: w.d.cabangId, mitraId: w.mitra.m4.id },
          pusat,
        ),
      kodeAda(KODE_LAPORAN.CABANG_DILUAR_SCOPE),
    );
    await tolakDengan(
      () =>
        w.engine.kartuPiutang(
          {
            periodeId: w.periodeLaporan.id,
            cabangId: w.d.cabangId,
            mitraId: "00000000-0000-4000-8000-000000000000",
          },
          pusat,
        ),
      kodeAda(KODE_LAPORAN.MITRA_TIDAK_DITEMUKAN),
    );
  });
});

// ---------------------------------------------------------------------------
// 10 and 11. Kolektibilitas and its movement matrix
// ---------------------------------------------------------------------------

describe("Laporan 10: kolektibilitas", () => {
  test("tangga kelas dari data, setiap kelas tercetak termasuk yang kosong", async () => {
    const l = await w.engine.kolektibilitas(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.baris.map((b) => b.klasifikasi)).toEqual([
      "LANCAR",
      "KURANG_LANCAR",
      "DIRAGUKAN",
      "MACET",
    ]);
    expect(l.baris.map((b) => b.urutan)).toEqual([1, 2, 3, 4]);
    expect(l.baris.map((b) => b.outstandingPokok.nilai)).toEqual([
      NILAI.outstandingA1,
      NILAI.outstandingA2,
      NILAI.outstandingA3,
      NILAI.outstandingA4,
    ]);
    expect(l.baris.map((b) => b.nilaiPenyisihan.nilai)).toEqual([
      NILAI.penyisihanA1,
      NILAI.penyisihanA2,
      NILAI.penyisihanA3,
      NILAI.penyisihanA4,
    ]);
    expect(l.total.jumlahAkad).toBe(4);
    expect(l.total.jumlahMitra).toBe(4);
    expect(l.total.outstandingPokok.nilai).toBe(NILAI.outstandingCabangA);
    expect(l.total.nilaiPenyisihan.nilai).toBe(NILAI.penyisihanCabangA);
  });

  test("per sektor berkaki, dan setiap sel per klasifikasi sejajar indeksnya", async () => {
    const l = await w.engine.kolektibilitas(bulanan(), pusat);
    expect(jumlahUang(...l.perSektor.map((s) => s.outstandingPokok.nilai))).toBe(
      l.total.outstandingPokok.nilai,
    );
    for (const s of l.perSektor) {
      expect(s.perKlasifikasi).toHaveLength(l.baris.length);
      expect(jumlahUang(...s.perKlasifikasi.map((a) => a.nilai))).toBe(
        s.outstandingPokok.nilai,
      );
    }
    // Column footings across sectors equal the class rows.
    for (let i = 0; i < l.baris.length; i += 1) {
      expect(jumlahUang(...l.perSektor.map((s) => s.perKlasifikasi[i].nilai))).toBe(
        l.baris[i].outstandingPokok.nilai,
      );
    }
  });

  test("IDENTITAS: outstanding laporan 10 = outstanding laporan 8", async () => {
    for (const filter of [bulanan(), semuaCabang()]) {
      const [sepuluh, delapan] = await Promise.all([
        w.engine.kolektibilitas(filter, pusat),
        w.engine.agingPiutang(filter, pusat),
      ]);
      expect(sepuluh.total.outstandingPokok.nilai).toBe(delapan.total.outstanding.nilai);
      expect(sepuluh.total.jumlahMitra).toBe(delapan.total.jumlahMitra);
      expect(sepuluh.total.outstandingJasa.nilai).toBe(delapan.total.outstandingJasa.nilai);
    }
  });
});

describe("Laporan 11: perpindahan kolektibilitas", () => {
  test("matriks kelas lalu versus kelas ini, dengan baris BARU untuk akad baru", async () => {
    const l = await w.engine.perpindahanKolektibilitas(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.kolom.map((k) => k.kode)).toEqual([
      "LANCAR",
      "KURANG_LANCAR",
      "DIRAGUKAN",
      "MACET",
    ]);
    expect(l.baris[0].kode).toBe(KELAS_BARU);
    expect(l.baris.map((b) => b.kode)).toEqual([
      KELAS_BARU,
      "LANCAR",
      "KURANG_LANCAR",
      "DIRAGUKAN",
      "MACET",
    ]);

    const sel = (dari: string, ke: string) => {
      const i = l.baris.findIndex((b) => b.kode === dari);
      const j = l.kolom.findIndex((k) => k.kode === ke);
      return l.baris[i].sel[j];
    };
    // A1 is new this period; A2, A3 and A4 each moved down one rung.
    expect(sel(KELAS_BARU, "LANCAR").outstandingPokok.nilai).toBe(NILAI.outstandingA1);
    expect(sel("LANCAR", "KURANG_LANCAR").outstandingPokok.nilai).toBe(NILAI.outstandingA2);
    expect(sel("KURANG_LANCAR", "DIRAGUKAN").outstandingPokok.nilai).toBe(NILAI.outstandingA3);
    expect(sel("DIRAGUKAN", "MACET").outstandingPokok.nilai).toBe(NILAI.outstandingA4);
    expect(sel("LANCAR", "LANCAR").jumlahAkad).toBe(0);
  });

  test("IDENTITAS: kaki kolom laporan 11 = baris kelas laporan 10", async () => {
    const [sebelas, sepuluh] = await Promise.all([
      w.engine.perpindahanKolektibilitas(bulanan(), pusat),
      w.engine.kolektibilitas(bulanan(), pusat),
    ]);
    expect(sebelas.totalKeseluruhan.jumlahAkad).toBe(sepuluh.total.jumlahAkad);
    expect(sebelas.totalKeseluruhan.outstandingPokok.nilai).toBe(
      sepuluh.total.outstandingPokok.nilai,
    );
    for (let j = 0; j < sebelas.kolom.length; j += 1) {
      expect(sebelas.kolom[j].kode).toBe(sepuluh.baris[j].klasifikasi);
      expect(sebelas.totalKolom[j].outstandingPokok.nilai).toBe(
        sepuluh.baris[j].outstandingPokok.nilai,
      );
      expect(sebelas.totalKolom[j].jumlahAkad).toBe(sepuluh.baris[j].jumlahAkad);
    }
    // And the whole matrix foots, row-wise as well as column-wise.
    expect(jumlahUang(...sebelas.baris.map((b) => b.total.outstandingPokok.nilai))).toBe(
      sebelas.totalKeseluruhan.outstandingPokok.nilai,
    );
  });
});

// ---------------------------------------------------------------------------
// 28. Laporan Perhitungan Penyisihan
// ---------------------------------------------------------------------------

describe("Laporan 28: perhitungan penyisihan", () => {
  test("per akad dengan rate dan provenansinya, dan total per klasifikasi", async () => {
    const l = await w.engine.perhitunganPenyisihan(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.baris).toHaveLength(4);
    const a2 = l.baris.find((b) => b.akadId === w.akad.a2.id);
    // The snapshot stores the rate as a FRACTION; the report prints a percent.
    expect(a2?.ratePenyisihan).toBe("10.00");
    expect(a2?.hariTunggakan).toBe(45);
    expect(a2?.klasifikasi).toBe("KURANG_LANCAR");
    expect(a2?.dasarPerhitungan).toBe("OUTSTANDING_POKOK");
    // ADR 0014: which rate produced this figure must still be answerable after
    // somebody edits the rate table.
    expect(a2?.sumberRate).toBe("TABEL_KONFIGURASI");
    expect(a2?.rateHistoriDari).toBeNull();
    expect(a2?.nilaiPenyisihan.nilai).toBe(NILAI.penyisihanA2);

    expect(l.perKlasifikasi.map((k) => k.jumlahAkad)).toEqual([1, 1, 1, 1]);
    expect(jumlahUang(...l.perKlasifikasi.map((k) => k.nilaiPenyisihan.nilai))).toBe(
      l.total.nilaiPenyisihan.nilai,
    );
    expect(l.total.nilaiPenyisihan.nilai).toBe(NILAI.penyisihanCabangA);
  });

  test("SPEC 16 SKENARIO 17: totalnya merekonstruksi angka run penyisihan", async () => {
    const l = await w.engine.perhitunganPenyisihan(bulanan(), pusat);
    expect(l.penyisihanDibutuhkanRun?.nilai).toBe(NILAI.penyisihanCabangA);
    expect(l.selisihTerhadapRun?.nilai).toBe(rp(0));
  });

  test("IDENTITAS: total laporan 28 = penyisihanDibutuhkan laporan 29", async () => {
    for (const filter of [bulanan(), semuaCabang()]) {
      const [duapuluhdelapan, duapuluhsembilan] = await Promise.all([
        w.engine.perhitunganPenyisihan(filter, pusat),
        w.engine.bebanPenyisihan(filter, pusat),
      ]);
      const dibutuhkan = jumlahUang(
        ...duapuluhsembilan.baris.map((b) => b.penyisihanDibutuhkan.nilai),
      );
      expect(duapuluhdelapan.total.nilaiPenyisihan.nilai).toBe(dibutuhkan);
      expect(duapuluhdelapan.selisihTerhadapRun?.nilai).toBe(rp(0));
    }
  });

  test("IDENTITAS: outstanding laporan 28 = laporan 10 = laporan 8", async () => {
    const [a, b, c] = await Promise.all([
      w.engine.perhitunganPenyisihan(bulanan(), pusat),
      w.engine.kolektibilitas(bulanan(), pusat),
      w.engine.agingPiutang(bulanan(), pusat),
    ]);
    expect(a.total.outstandingPokok.nilai).toBe(b.total.outstandingPokok.nilai);
    expect(a.total.outstandingPokok.nilai).toBe(c.total.outstanding.nilai);
    expect(a.total.nilaiPenyisihan.nilai).toBe(b.total.nilaiPenyisihan.nilai);
  });
});
