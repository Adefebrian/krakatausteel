// apps/api/src/modules/laporan/laporan-nonpumk.test.ts
//
// THE FOUR NON PUMK REPORTS OF SPEC 10.2 (12 to 15), AGAINST REAL POSTGRES.
//
// THE GRAIN IS THE WHOLE TEST. A Non PUMK disbursement is multi-termin (spec
// 9.2), so report 12 prints one row per TERMIN while reports 13 and 14 count
// PROGRAMMES and report 15 has one row per PROPOSAL. NP1 is deliberately paid
// in two instalments, so an implementation that confused the two grains would
// report two programmes where there is one, or 240 beneficiaries where there
// are 120, and the cross-report identities below are exactly what catches it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KODE_LAPORAN, type LaporanContext } from "./contract";
import { NAMA_LAPORAN_OPERASIONAL, SDG_TIDAK_DIPETAKAN } from "./kontrak-operasional";
import {
  buatDuniaOperasional,
  NILAI,
  TANGGAL,
  type DuniaOperasional,
} from "./test-support-operasional";
import { headerSah, jumlahUang, kodeAda, semuaAngkaSah, tolakDengan, rp } from "./test-support";

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

const bulanan = () => ({ periodeId: w.periodeLaporan.id, cabangId: w.d.cabangId });
const ytd = () => ({
  periodeId: w.periodeLaporan.id,
  cabangId: w.d.cabangId,
  mode: "KUMULATIF_YTD" as const,
});
const semuaCabang = () => ({ periodeId: w.periodeLaporan.id, cabangId: null });

// ---------------------------------------------------------------------------
// 12. Laporan Penyaluran Non PUMK
// ---------------------------------------------------------------------------

describe("Laporan 12: penyaluran Non PUMK", () => {
  test("satu baris per TERMIN, kolom proposal berulang seperti di cetakan", async () => {
    const l = await w.engine.penyaluranNonPumk(bulanan(), pusat);
    headerSah(l.header as unknown as { [k: string]: unknown }, w.d, {
      namaLaporan: NAMA_LAPORAN_OPERASIONAL.PENYALURAN_NON_PUMK,
      cabangId: w.d.cabangId,
      sumberData: "LEDGER_LIVE",
    });
    expect(l.header.tanggalCetak).toBe(TANGGAL.cetak);
    semuaAngkaSah(l);

    // Ordered (tanggal_penyaluran, no_proposal, termin), so NP1's second
    // instalment lands AFTER NP2's first.
    expect(l.baris.map((b) => [b.termin, b.tanggalPenyaluran])).toEqual([
      [1, "2026-03-05"],
      [1, "2026-03-10"],
      [2, "2026-03-20"],
    ]);
    expect(l.baris.map((b) => b.proposalId)).toEqual([
      w.nonpumk.np1,
      w.nonpumk.np2,
      w.nonpumk.np1,
    ]);
    expect(l.baris.map((b) => b.nilaiDisalurkan.nilai)).toEqual([
      NILAI.np1Termin1,
      NILAI.np2Termin1,
      NILAI.np1Termin2,
    ]);
    // The proposal-level columns repeat on every termin.
    expect(l.baris[0].nilaiDisetujui.nilai).toBe(NILAI.np1Disetujui);
    expect(l.baris[2].nilaiDisetujui.nilai).toBe(NILAI.np1Disetujui);
  });

  test("SDG per program dalam urutan nomor, dan status LPJ tanpa baris LPJ = BELUM", async () => {
    const l = await w.engine.penyaluranNonPumk(bulanan(), pusat);
    const np1 = l.baris.filter((b) => b.proposalId === w.nonpumk.np1);
    expect(np1[0].sdg.map((s) => s.nomor)).toEqual([4, 10]);
    expect(np1[0].statusLpj).toBe("DIVERIFIKASI");
    const np2 = l.baris.find((b) => b.proposalId === w.nonpumk.np2);
    expect(np2?.sdg.map((s) => s.nomor)).toEqual([13]);
    // `nonpumk_lpj` has no row at all for NP2, and spec 10.2 report 15's own
    // vocabulary calls that BELUM rather than leaving the column empty.
    expect(np2?.statusLpj).toBe("BELUM");
  });

  test("PENERIMA MANFAAT DIHITUNG SEKALI PER PROGRAM, bukan sekali per termin", async () => {
    const l = await w.engine.penyaluranNonPumk(bulanan(), pusat);
    expect(l.total.jumlahPenyaluran).toBe(3);
    expect(l.total.jumlahProposal).toBe(2);
    expect(l.total.nilaiDisalurkan.nilai).toBe(NILAI.nonPumkMaretCabangA);
    // NP1 reaches 120 people and was paid in two termin; summing the rows would
    // say 290 instead of 170.
    expect(l.total.penerimaManfaat).toBe(170);
    const jumlahBaris = l.baris.reduce((t, b) => t + (b.penerimaManfaat ?? 0), 0);
    expect(jumlahBaris).toBe(290);
  });

  test("nilai LPJ AKTUAL mengalahkan estimasi, dan jendela serta cabang memfilter", async () => {
    const l = await w.engine.penyaluranNonPumk(bulanan(), pusat);
    // NP1's verified LPJ reports 120 against an estimate of 100.
    expect(l.baris.find((b) => b.proposalId === w.nonpumk.np1)?.penerimaManfaat).toBe(120);

    const kumulatif = await w.engine.penyaluranNonPumk(ytd(), pusat);
    expect(kumulatif.total.jumlahPenyaluran).toBe(4);
    expect(kumulatif.total.nilaiDisalurkan.nilai).toBe(
      jumlahUang(NILAI.nonPumkMaretCabangA, NILAI.np3Termin1),
    );

    const lain = await w.engine.penyaluranNonPumk(
      { periodeId: w.periodeLaporan.id, cabangId: w.d.cabangLainId },
      pusat,
    );
    expect(lain.total.jumlahPenyaluran).toBe(1);
    expect(lain.total.nilaiDisalurkan.nilai).toBe(NILAI.np4Termin1);

    const semua = await w.engine.penyaluranNonPumk(semuaCabang(), pusat);
    expect(semua.total.nilaiDisalurkan.nilai).toBe(
      jumlahUang(NILAI.nonPumkMaretCabangA, NILAI.np4Termin1),
    );
    await tolakDengan(
      () => w.engine.penyaluranNonPumk(semuaCabang(), cabang),
      kodeAda(KODE_LAPORAN.CABANG_DILUAR_SCOPE),
    );
  });
});

// ---------------------------------------------------------------------------
// 13. Rekap Penyaluran Non PUMK per Bidang
// ---------------------------------------------------------------------------

describe("Laporan 13: rekap per bidang", () => {
  test("setiap bidang master tercetak, termasuk yang tanpa program", async () => {
    const l = await w.engine.rekapBidang(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.baris.map((b) => b.kode)).toEqual(["B01", "B02", "B03"]);
    expect(l.baris.map((b) => b.nilai.nilai)).toEqual([
      // B01 is NP1's two termin added up, which is also its approved amount.
      jumlahUang(NILAI.np1Termin1, NILAI.np1Termin2),
      NILAI.np2Termin1,
      rp(0),
    ]);
    expect(l.baris.map((b) => b.jumlahProgram)).toEqual([1, 1, 0]);
    expect(l.baris[2].nilai.tampil).toBe("0,00");
    expect(l.baris.map((b) => b.persenDariTotal)).toEqual(["55.56", "44.44", "0.00"]);
    expect(l.total.nilai.nilai).toBe(NILAI.nonPumkMaretCabangA);
    expect(l.total.jumlahProgram).toBe(2);
  });

  test("kolom versus RKA per bidang, dengan aturan bulan-null yang sama", async () => {
    const bulan = await w.engine.rekapBidang(bulanan(), pusat);
    expect(bulan.rkaVersi).toBe(1);
    expect(bulan.baris.map((b) => b.anggaran?.nilai)).toEqual([
      NILAI.anggaranBidang1Maret,
      NILAI.anggaranBidang2Maret,
      rp(0),
    ]);
    expect(bulan.baris.map((b) => b.persenCapaian)).toEqual(["83.33", "133.33", null]);
    expect(bulan.baris[1].selisih?.nilai).toBe(rp(-10_000_000));
    expect(bulan.total.anggaran?.nilai).toBe(rp(90_000_000));
    expect(bulan.total.selisih?.nilai).toBe(rp(0));
    expect(bulan.total.persenCapaian).toBe("100.00");

    const kumulatif = await w.engine.rekapBidang(ytd(), pusat);
    const b3 = kumulatif.baris.find((b) => b.bidangId === w.bidang.b3.id);
    // A whole-year budget line lands in the year-to-date window only.
    expect(b3?.anggaran?.nilai).toBe(NILAI.anggaranBidang3Tahunan);
    expect(kumulatif.total.anggaran?.nilai).toBe(rp(190_000_000));
    expect(kumulatif.total.nilai.nilai).toBe(
      jumlahUang(NILAI.nonPumkMaretCabangA, NILAI.np3Termin1),
    );
    expect(kumulatif.total.jumlahProgram).toBe(3);
  });

  test("IDENTITAS: total laporan 13 = nilai disalurkan laporan 12", async () => {
    for (const filter of [bulanan(), ytd(), semuaCabang()]) {
      const [tigaBelas, duaBelas] = await Promise.all([
        w.engine.rekapBidang(filter, pusat),
        w.engine.penyaluranNonPumk(filter, pusat),
      ]);
      expect(tigaBelas.total.nilai.nilai).toBe(duaBelas.total.nilaiDisalurkan.nilai);
      expect(tigaBelas.total.jumlahProgram).toBe(duaBelas.total.jumlahProposal);
      // And the rows themselves foot to the same figure.
      expect(jumlahUang(...tigaBelas.baris.map((b) => b.nilai.nilai))).toBe(
        duaBelas.total.nilaiDisalurkan.nilai,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 14. Laporan Pemetaan SDGs
// ---------------------------------------------------------------------------

describe("Laporan 14: pemetaan SDGs", () => {
  test("tujuh belas tujuan plus keranjang belum dipetakan, tanpa kolom uang", async () => {
    const l = await w.engine.pemetaanSdg(bulanan(), pusat);
    expect(l.baris).toHaveLength(18);
    expect(l.baris.map((b) => b.nomor).slice(0, 17)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    expect(l.baris[17]).toMatchObject({ sdgId: null, nomor: null, nama: SDG_TIDAK_DIPETAKAN });
    // ADR 0016: an SDG mapping is many to many, so a rupiah figure split by it
    // would need an allocation rule the client has not supplied. There is
    // therefore NO `Angka` anywhere in this report except the header, and
    // `semuaAngkaSah` is asserted to find none.
    semuaAngkaSah(l, "$", { tanpaUang: true });
  });

  test("keranjang bertumpang: jumlahProgram menjumlah LEBIH dari program unik", async () => {
    const l = await w.engine.pemetaanSdg(bulanan(), pusat);
    const per = (nomor: number) => l.baris.find((b) => b.nomor === nomor)!;
    expect(per(4)).toMatchObject({ jumlahProgram: 1, penerimaManfaat: 120 });
    expect(per(10)).toMatchObject({ jumlahProgram: 1, penerimaManfaat: 120 });
    expect(per(13)).toMatchObject({ jumlahProgram: 1, penerimaManfaat: 50 });
    expect(per(1)).toMatchObject({ jumlahProgram: 0, penerimaManfaat: 0 });

    expect(l.totalProgramUnik).toBe(2);
    expect(l.totalPenerimaManfaatUnik).toBe(170);
    // NP1 serves goals 4 and 10, so the column sums to three programmes over
    // two. That overlap is correct and is the whole reason there is no money.
    expect(l.baris.reduce((t, b) => t + b.jumlahProgram, 0)).toBe(3);
    expect(l.baris.reduce((t, b) => t + b.jumlahProgram, 0)).toBeGreaterThan(
      l.totalProgramUnik,
    );
  });

  test("program tanpa SDG mendarat di keranjangnya, bukan hilang", async () => {
    const bulan = await w.engine.pemetaanSdg(bulanan(), pusat);
    expect(bulan.baris[17]).toMatchObject({ jumlahProgram: 0, penerimaManfaat: 0 });

    // NP3 is mapped to nothing and was disbursed in February.
    const kumulatif = await w.engine.pemetaanSdg(ytd(), pusat);
    expect(kumulatif.baris[17]).toMatchObject({ jumlahProgram: 1, penerimaManfaat: 30 });
    expect(kumulatif.totalProgramUnik).toBe(3);
    expect(kumulatif.totalPenerimaManfaatUnik).toBe(200);
  });

  test("IDENTITAS: program unik dan penerima manfaat = laporan 12", async () => {
    for (const filter of [bulanan(), ytd(), semuaCabang()]) {
      const [empatBelas, duaBelas] = await Promise.all([
        w.engine.pemetaanSdg(filter, pusat),
        w.engine.penyaluranNonPumk(filter, pusat),
      ]);
      expect(empatBelas.totalProgramUnik).toBe(duaBelas.total.jumlahProposal);
      expect(empatBelas.totalPenerimaManfaatUnik).toBe(duaBelas.total.penerimaManfaat);
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Laporan Monitoring LPJ
// ---------------------------------------------------------------------------

describe("Laporan 15: monitoring LPJ", () => {
  test("kewajiban tertua di atas, satu baris per proposal", async () => {
    const l = await w.engine.monitoringLpj(bulanan(), pusat);
    semuaAngkaSah(l);
    expect(l.baris.map((b) => b.proposalId)).toEqual([w.nonpumk.np2, w.nonpumk.np1]);
    expect(l.baris.map((b) => b.umurHari)).toEqual([21, 5]);
    expect(l.total.jumlahProposal).toBe(2);
  });

  test("UMUR dihitung ke tanggal LPJ kalau ada, ke hari cetak kalau belum", async () => {
    const l = await w.engine.monitoringLpj(bulanan(), pusat);
    const np1 = l.baris.find((b) => b.proposalId === w.nonpumk.np1)!;
    const np2 = l.baris.find((b) => b.proposalId === w.nonpumk.np2)!;
    // NP1 reported on 25 March against a last disbursement of 20 March: five
    // days, and it stays five days forever. Measuring to today would make a
    // programme that reported on time look worse every day afterwards.
    expect(np1.tanggalSalurTerakhir).toBe("2026-03-20");
    expect(np1.tanggalLpj).toBe("2026-03-25");
    expect(np1.umurHari).toBe(5);
    // NP2 has no LPJ, so the clock runs to the injected print date.
    expect(np2.tanggalLpj).toBeNull();
    expect(np2.umurHari).toBe(21);
  });

  test("selisih realisasi nol untuk LPJ terverifikasi, penuh untuk yang belum", async () => {
    const l = await w.engine.monitoringLpj(bulanan(), pusat);
    const np1 = l.baris.find((b) => b.proposalId === w.nonpumk.np1)!;
    // `tjsl_nonpumk_cek_lpj` makes realisasi + sisa = disalurkan for a verified
    // LPJ, so a non-zero difference here would be a database-level defect the
    // report SHOWS rather than refuses on.
    expect(np1.nilaiDisalurkan.nilai).toBe(NILAI.np1Disetujui);
    expect(np1.jumlahRealisasi.nilai).toBe(NILAI.np1Realisasi);
    expect(np1.jumlahSisaDikembalikan.nilai).toBe(NILAI.np1Sisa);
    expect(np1.selisihRealisasi.nilai).toBe(rp(0));
    expect(np1.penerimaManfaatAktual).toBe(120);

    const np2 = l.baris.find((b) => b.proposalId === w.nonpumk.np2)!;
    expect(np2.selisihRealisasi.nilai).toBe(NILAI.np2Termin1);
    expect(np2.penerimaManfaatAktual).toBeNull();
    expect(np2.penerimaManfaatEstimasi).toBe(50);

    expect(l.total.selisihRealisasi.nilai).toBe(NILAI.np2Termin1);
    expect(l.total.jumlahRealisasi.nilai).toBe(NILAI.np1Realisasi);
  });

  test("per status berkaki, keempat status dicetak", async () => {
    const l = await w.engine.monitoringLpj(bulanan(), pusat);
    expect(l.perStatus.map((s) => s.status)).toEqual([
      "BELUM",
      "DIAJUKAN",
      "DIVERIFIKASI",
      "DITOLAK",
    ]);
    expect(l.perStatus.map((s) => s.jumlah)).toEqual([1, 0, 1, 0]);
    expect(jumlahUang(...l.perStatus.map((s) => s.nilaiDisalurkan.nilai))).toBe(
      l.total.nilaiDisalurkan.nilai,
    );
    expect(l.perStatus.reduce((t, s) => t + s.jumlah, 0)).toBe(l.total.jumlahProposal);
  });

  test("IDENTITAS: nilai disalurkan laporan 15 = laporan 12 = laporan 13", async () => {
    for (const filter of [bulanan(), ytd(), semuaCabang()]) {
      const [limaBelas, duaBelas, tigaBelas] = await Promise.all([
        w.engine.monitoringLpj(filter, pusat),
        w.engine.penyaluranNonPumk(filter, pusat),
        w.engine.rekapBidang(filter, pusat),
      ]);
      expect(limaBelas.total.nilaiDisalurkan.nilai).toBe(
        duaBelas.total.nilaiDisalurkan.nilai,
      );
      expect(limaBelas.total.nilaiDisalurkan.nilai).toBe(tigaBelas.total.nilai.nilai);
      expect(limaBelas.total.jumlahProposal).toBe(duaBelas.total.jumlahProposal);
    }
  });
});
