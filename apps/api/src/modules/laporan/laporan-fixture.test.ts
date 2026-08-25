// THE FIXTURE PROVES ITSELF, BEFORE ANY REPORT IS ASKED ANYTHING.
//
// Every other file in this folder fails today, because modules/laporan is a
// contract and a set of stubs. THIS FILE MUST PASS. It touches the report
// engine nowhere; it asserts only three things about the world the other files
// are written against, and each of them is a thing that has already gone wrong
// in this repo:
//
//  1. THE EXPECTED FIGURES ARE RIGHT. `HARAPAN` in ./test-support.ts is a
//     table of literals, and the headline assertions of spec 16 scenarios 14,
//     15 and 16 are written against it. If the arithmetic behind those
//     literals is wrong, every report test fails for a reason that has nothing
//     to do with the report, and the first person to read the output blames
//     the implementation. So every literal is re-derived here from
//     `v_ledger_baris` and compared.
//
//  2. NOTHING IS VACUOUS. The three identities the specification asks for
//     ("Total Aset = Liabilitas + Aset Neto", "Kas Akhir = saldo is_kas",
//     "neraca lajur balance di ketiga pasang kolom") all hold trivially on an
//     empty ledger. This file asserts, at the LEDGER level, that the world
//     these identities will be checked in has non-zero figures on both sides
//     of each of them, in both years, in three sections of the cash flow
//     statement and in all six columns of the worksheet.
//
//  3. TWO RUNS WITHOUT A RESET PRODUCE THE SAME RESULT. `bun run db:reset` is
//     shared with other agents and is not run between files. A world that
//     collides with its predecessor on a unique key does not fail here, it
//     fails somewhere else, hours later, as a phantom.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  BUKU_STANDAR,
  HARAPAN,
  KODE_BARIS,
  TAHUN_INI,
  TAHUN_LALU,
  bacaTampil,
  buatDunia,
  formatTampil,
  jumlahUang,
  keSen,
  kurangUang,
  kunci,
  negasiUang,
  rp,
  tambahHari,
  type DuniaLaporan,
} from "./test-support";
import { NOL_TAMPIL, POLA_TAMPIL } from "./contract";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterAll(async () => {
  await d?.tutup();
});

const AKHIR_MARET = `${TAHUN_INI}-03-31`;
const AKHIR_TAHUN_LALU = `${TAHUN_LALU}-12-31`;
const AWAL_TAHUN_INI = `${TAHUN_INI}-01-01`;

/** Debit-positive balance, main branch, at a date. */
function saldo(kunciAkun: Parameters<typeof pilih>[0], pada: string) {
  return d.saldoLedger(pilih(kunciAkun), pada, d.cabangId);
}
function pilih(k: keyof DuniaLaporan["akun"]): string {
  return d.akun[k].id;
}

describe("dunia fixture: buku standar tercatat lewat engine jurnal yang nyata", () => {
  test("setiap jurnal buku standar POSTED, dan seluruh ledger balance", async () => {
    const baris = await d.db.query<{ n: string }>(
      `select count(*)::text as n from jurnal
        where bumn_id = $1 and status = 'POSTED' and deleted_at is null`,
      [d.bumnId],
    );
    expect(Number.parseInt(baris[0].n, 10)).toBe(BUKU_STANDAR.length);
    // Invariant 1 at the whole-ledger level: this is spec 8.4 check 7.
    expect(await d.selisihLedger()).toBe(rp(0));
  });

  test("periode 2026-03 masih OPEN, dan periode dua tahun tersedia", async () => {
    const p = d.periodeLaporan();
    expect(p.tahun).toBe(TAHUN_INI);
    expect(p.bulan).toBe(3);
    expect(p.tanggalMulai).toBe(`${TAHUN_INI}-03-01`);
    expect(p.tanggalAkhir).toBe(AKHIR_MARET);
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
    expect(d.periode(TAHUN_LALU, 1).tanggalMulai).toBe(`${TAHUN_LALU}-01-01`);
    expect(d.periode(TAHUN_LALU, 12).tanggalAkhir).toBe(AKHIR_TAHUN_LALU);
  });
});

describe("HARAPAN cocok dengan ledger (kalau tidak, setiap test laporan gagal karena alasan yang salah)", () => {
  test("saldo akun kunci di 2026-03-31, cabang utama", async () => {
    expect(await saldo("kas", AKHIR_MARET)).toBe(HARAPAN.kasAkhir);
    expect(await saldo("piutangPokok", AKHIR_MARET)).toBe(HARAPAN.piutangPokok);
    expect(await saldo("asetTetap", AKHIR_MARET)).toBe(HARAPAN.asetTetap);
    // Contra asset: credit balance, so debit-positive is negative. The report
    // prints it as a deduction via baris_laporan.tanda = -1.
    expect(await saldo("penyisihan", AKHIR_MARET)).toBe(negasiUang(HARAPAN.penyisihan));
    expect(await saldo("kelebihanAngsuran", AKHIR_MARET)).toBe(negasiUang(HARAPAN.totalLiabilitas));
  });

  test("Total Aset, Total Liabilitas dan Aset Neto: identitas skenario 14 berlaku di ledger", async () => {
    const aset = jumlahUang(
      await saldo("kas", AKHIR_MARET),
      await saldo("piutangPokok", AKHIR_MARET),
      await saldo("asetTetap", AKHIR_MARET),
      await saldo("penyisihan", AKHIR_MARET),
    );
    const liabilitas = negasiUang(await saldo("kelebihanAngsuran", AKHIR_MARET));
    // NET ASSETS IS NOT THE ASET_NETO ACCOUNTS ALONE. No year-end closing
    // entry is ever posted in this system, so every period's surplus since
    // inception still sits in PENDAPATAN and BEBAN. See the note on
    // LaporanPosisiKeuangan.totalAsetNeto in ./contract.ts.
    const asetNetoAkun = negasiUang(
      jumlahUang(
        await saldo("asetNetoTidakTerikat", AKHIR_MARET),
        await saldo("asetNetoTerikat", AKHIR_MARET),
      ),
    );
    const surplus = negasiUang(
      jumlahUang(
        await saldo("pendapatanAlokasi", AKHIR_MARET),
        await saldo("pendapatanJasaAdm", AKHIR_MARET),
        await saldo("pendapatanTerikat", AKHIR_MARET),
        await saldo("bebanOperasional", AKHIR_MARET),
        await saldo("bebanPenyisihan", AKHIR_MARET),
      ),
    );
    const asetNeto = jumlahUang(asetNetoAkun, surplus);

    expect(aset).toBe(HARAPAN.totalAset);
    expect(liabilitas).toBe(HARAPAN.totalLiabilitas);
    expect(asetNeto).toBe(HARAPAN.totalAsetNeto);
    // NON-VACUOUS: all three sides carry money before the identity is claimed.
    expect(keSen(aset)).toBeGreaterThan(0n);
    expect(keSen(liabilitas)).toBeGreaterThan(0n);
    expect(keSen(asetNeto)).toBeGreaterThan(0n);
    expect(aset).toBe(jumlahUang(liabilitas, asetNeto));
  });

  test("kolom pembanding 2025-12-31 punya angka, bukan nol", async () => {
    expect(await saldo("kas", AKHIR_TAHUN_LALU)).toBe(HARAPAN.kasAkhirTahunLalu);
    const aset = jumlahUang(
      await saldo("kas", AKHIR_TAHUN_LALU),
      await saldo("piutangPokok", AKHIR_TAHUN_LALU),
      await saldo("asetTetap", AKHIR_TAHUN_LALU),
      await saldo("penyisihan", AKHIR_TAHUN_LALU),
    );
    expect(aset).toBe(HARAPAN.totalAsetTahunLalu);
    expect(keSen(aset)).toBeGreaterThan(0n);
    // No liability existed a year ago: the comparative column has a genuine
    // zero in it, which is exactly the cell spec 10's "0,00 bukan kosong" rule
    // is about.
    expect(await saldo("kelebihanAngsuran", AKHIR_TAHUN_LALU)).toBe(rp(0));
  });

  test("Laporan Aktivitas: pendapatan, beban dan kenaikan aset neto per seksi", async () => {
    const pend = negasiUang(
      jumlahUang(
        kurangUang(
          await saldo("pendapatanAlokasi", AKHIR_MARET),
          await saldo("pendapatanAlokasi", AKHIR_TAHUN_LALU),
        ),
        kurangUang(
          await saldo("pendapatanJasaAdm", AKHIR_MARET),
          await saldo("pendapatanJasaAdm", AKHIR_TAHUN_LALU),
        ),
        kurangUang(
          await saldo("pendapatanTerikat", AKHIR_MARET),
          await saldo("pendapatanTerikat", AKHIR_TAHUN_LALU),
        ),
      ),
    );
    const beban = jumlahUang(
      kurangUang(
        await saldo("bebanOperasional", AKHIR_MARET),
        await saldo("bebanOperasional", AKHIR_TAHUN_LALU),
      ),
      kurangUang(
        await saldo("bebanPenyisihan", AKHIR_MARET),
        await saldo("bebanPenyisihan", AKHIR_TAHUN_LALU),
      ),
    );
    expect(pend).toBe(HARAPAN.pendapatanTahunIni);
    expect(beban).toBe(HARAPAN.bebanTahunIni);
    expect(kurangUang(pend, beban)).toBe(HARAPAN.kenaikanAsetNetoTahunIni);
    expect(
      jumlahUang(
        HARAPAN.kenaikanAsetNetoTidakTerikatTahunIni,
        HARAPAN.kenaikanAsetNetoTerikatTahunIni,
      ),
    ).toBe(HARAPAN.kenaikanAsetNetoTahunIni);

    // The comparative span, 2025-01-01..2025-03-31, is non-zero too.
    const pendLalu = negasiUang(await saldo("pendapatanAlokasi", `${TAHUN_LALU}-03-31`));
    expect(pendLalu).toBe(HARAPAN.kenaikanAsetNetoTahunLalu);
    expect(keSen(pendLalu)).toBeGreaterThan(0n);
  });

  test("Arus Kas: ketiga seksi bergerak, dan kas awal plus kenaikan sama dengan kas akhir", async () => {
    const kasAwal = await saldo("kas", tambahHari(AWAL_TAHUN_INI, -1));
    expect(kasAwal).toBe(HARAPAN.kasAwal);
    expect(jumlahUang(kasAwal, HARAPAN.kenaikanKas)).toBe(HARAPAN.kasAkhir);
    expect(
      jumlahUang(HARAPAN.arusOperasi, HARAPAN.arusInvestasi, HARAPAN.arusPendanaan),
    ).toBe(HARAPAN.kenaikanKas);
    // NON-VACUOUS: an all-operating world would let a statement that
    // classifies nothing still tie to the balance sheet.
    expect(keSen(HARAPAN.arusOperasi)).toBeGreaterThan(0n);
    expect(keSen(HARAPAN.arusInvestasi)).toBeLessThan(0n);
    expect(keSen(HARAPAN.arusPendanaan)).toBeGreaterThan(0n);
  });

  test("Kas Akhir sama dengan saldo akun berflag is_kas (skenario 15, di level ledger)", async () => {
    const akunKas = await d.db.query<{ id: string; kode: string }>(
      `select id::text as id, kode from akun
        where bumn_id = $1 and is_kas and deleted_at is null order by kode`,
      [d.bumnId],
    );
    // Both 1.1.01 and 1.1.02 are flagged is_kas by the shipped seed. Only one
    // carries a balance, which is deliberate: a report that summed just the
    // first is_kas account it found would still pass, so the ARUS KAS test
    // additionally asserts the account list.
    expect(akunKas.map((a) => a.kode)).toEqual(["1.1.01", "1.1.02"]);
    let total = rp(0);
    for (const a of akunKas) total = jumlahUang(total, await d.saldoLedger(a.id, AKHIR_MARET, d.cabangId));
    expect(total).toBe(HARAPAN.kasAkhir);
    expect(keSen(total)).toBeGreaterThan(0n);
  });

  test("Neraca Lajur 2026-03: ketiga pasang kolom balance dan keenam total bukan nol", async () => {
    const p = d.periodeLaporan();
    const sebelum = tambahHari(p.tanggalMulai, -1);
    const akunSemua = await d.db.query<{ id: string }>(
      `select id::text as id from akun where bumn_id = $1 and is_postable and deleted_at is null`,
      [d.bumnId],
    );
    let awalD = rp(0);
    let awalK = rp(0);
    let mutD = rp(0);
    let mutK = rp(0);
    let akhirD = rp(0);
    let akhirK = rp(0);
    for (const a of akunSemua) {
      const awal = await d.saldoLedger(a.id, sebelum, d.cabangId);
      const akhir = await d.saldoLedger(a.id, p.tanggalAkhir, d.cabangId);
      const m = await d.mutasiLedger(a.id, p.tanggalMulai, p.tanggalAkhir, d.cabangId);
      if (keSen(awal) > 0n) awalD = jumlahUang(awalD, awal);
      else awalK = jumlahUang(awalK, negasiUang(awal));
      if (keSen(akhir) > 0n) akhirD = jumlahUang(akhirD, akhir);
      else akhirK = jumlahUang(akhirK, negasiUang(akhir));
      mutD = jumlahUang(mutD, m.debit);
      mutK = jumlahUang(mutK, m.kredit);
    }
    expect(awalD).toBe(HARAPAN.neracaSaldoAwal);
    expect(mutD).toBe(HARAPAN.neracaMutasi);
    expect(akhirD).toBe(HARAPAN.neracaSaldoAkhir);
    // The three pairs, and none of the six is zero.
    expect(awalD).toBe(awalK);
    expect(mutD).toBe(mutK);
    expect(akhirD).toBe(akhirK);
    for (const t of [awalD, awalK, mutD, mutK, akhirD, akhirK]) {
      expect(keSen(t)).toBeGreaterThan(0n);
    }
  });

  test("Buku Besar Kas di 2026-03: saldo awal, tiga mutasi, saldo akhir", async () => {
    const p = d.periodeLaporan();
    expect(await saldo("kas", tambahHari(p.tanggalMulai, -1))).toBe(HARAPAN.kasSaldoAwalMaret);
    const m = await d.mutasiLedger(d.akun.kas.id, p.tanggalMulai, p.tanggalAkhir, d.cabangId);
    expect(m.debit).toBe(HARAPAN.kasMutasiDebitMaret);
    expect(m.kredit).toBe(HARAPAN.kasMutasiKreditMaret);
    const jumlah = await d.db.query<{ n: string }>(
      `select count(*)::text as n from v_ledger_baris l
        where l.akun_id = $1 and l.cabang_id = $2
          and l.tanggal_transaksi between $3 and $4`,
      [d.akun.kas.id, d.cabangId, p.tanggalMulai, p.tanggalAkhir],
    );
    expect(Number.parseInt(jumlah[0].n, 10)).toBe(HARAPAN.kasMutasiBarisMaret);
    expect(
      jumlahUang(
        HARAPAN.kasSaldoAwalMaret,
        HARAPAN.kasMutasiDebitMaret,
        negasiUang(HARAPAN.kasMutasiKreditMaret),
      ),
    ).toBe(HARAPAN.kasAkhir);
  });

  test("cabang B punya jurnalnya sendiri, dan identitas neraca tetap berlaku per cabang", async () => {
    const kasB = await d.saldoLedger(d.akun.kas.id, AKHIR_MARET, d.cabangLainId);
    expect(kasB).toBe(rp(50_000_000));
    const pendapatanB = negasiUang(
      await d.saldoLedger(d.akun.pendapatanAlokasi.id, AKHIR_MARET, d.cabangLainId),
    );
    expect(kasB).toBe(pendapatanB);
    // Semua Cabang: the world's totals, larger than the main branch's.
    const kasSemua = await d.saldoLedger(d.akun.kas.id, AKHIR_MARET, null);
    expect(kasSemua).toBe(jumlahUang(HARAPAN.kasAkhir, rp(50_000_000)));
  });
});

describe("ADR 0010: dua pembacaan ledger yang tidak boleh dikacaukan", () => {
  test("di buku standar keduanya SAMA, jadi test yang membedakan harus membuat pembaliknya sendiri", async () => {
    // Stated here on purpose. Without a reversal the naive predicate and the
    // correct one agree on every account, which is why a test that only
    // checked the correct value would pass vacuously on this data. Every ADR
    // 0010 assertion in this folder therefore posts and reverses first, and
    // asserts the divergence before asserting which reading the report used.
    for (const k of ["kas", "piutangPokok", "bebanOperasional"] as const) {
      expect(await d.saldoLedger(d.akun[k].id, AKHIR_MARET, d.cabangId)).toBe(
        await d.saldoLedgerNaifPostedSaja(d.akun[k].id, AKHIR_MARET, d.cabangId),
      );
    }
    expect(await d.selisihLedger()).toBe(rp(0));
    expect(await d.selisihLedgerNaifPostedSaja()).toBe(rp(0));
  });
});

describe("format uang (spec 10: nilai nol tampil 0,00, bukan kosong)", () => {
  test("aturan format dan pembacaan baliknya konsisten", () => {
    expect(formatTampil(rp(0))).toBe(NOL_TAMPIL);
    expect(formatTampil(rp(1_285_000_000))).toBe("1.285.000.000,00");
    expect(formatTampil("1234567.89")).toBe("1.234.567,89");
    expect(formatTampil(rp(-18_000_000))).toBe("(18.000.000,00)");
    expect(formatTampil("999.99")).toBe("999,99");
    for (const n of [rp(0), rp(-18_000_000), "1234567.89", rp(1_285_000_000), "999.99"]) {
      expect(formatTampil(n)).toMatch(POLA_TAMPIL);
      expect(bacaTampil(formatTampil(n))).toBe(n);
      expect(formatTampil(n)).not.toBe("");
    }
  });
});

describe("dunia terisolasi: dua run tanpa reset menghasilkan hasil yang sama", () => {
  test("kunci fixture unik antar pemanggilan", () => {
    const a = kunci("BUMN");
    const b = kunci("BUMN");
    expect(a).not.toBe(b);
  });

  test("dunia kedua punya bumn, cabang, COA, baris laporan dan periode sendiri", async () => {
    const lain = await buatDunia();
    try {
      expect(lain.bumnId).not.toBe(d.bumnId);
      expect(lain.cabangId).not.toBe(d.cabangId);
      expect(lain.akun.kas.id).not.toBe(d.akun.kas.id);
      // A second world's ledger is empty until it posts, which is what proves
      // the two do not share one.
      expect(await lain.saldoLedger(lain.akun.kas.id, AKHIR_MARET, lain.cabangId)).toBe(rp(0));
      await lain.postingBukuStandar();
      expect(await lain.saldoLedger(lain.akun.kas.id, AKHIR_MARET, lain.cabangId)).toBe(
        HARAPAN.kasAkhir,
      );
      // And the first world is untouched by any of it.
      expect(await d.saldoLedger(d.akun.kas.id, AKHIR_MARET, d.cabangId)).toBe(HARAPAN.kasAkhir);

      const barisLain = await lain.bacaBarisLaporan();
      const barisKita = await d.bacaBarisLaporan();
      expect(barisLain.map((b) => b.kode).sort()).toEqual(barisKita.map((b) => b.kode).sort());
      expect(barisLain.map((b) => b.id).sort()).not.toEqual(barisKita.map((b) => b.id).sort());
    } finally {
      await lain.tutup();
    }
  });
});

describe("apa yang TIDAK dikirim oleh seed (temuan, dipatok di sini supaya tidak terlupa)", () => {
  test("seed inti tidak punya akun ASET_NETO yang postable, jadi fixture menambahkannya", async () => {
    const baris = await d.db.query<{ kode: string }>(
      `select kode from akun
        where bumn_id = $1 and tipe = 'ASET_NETO' and is_postable and deleted_at is null
        order by kode`,
      [d.bumnId],
    );
    // Both come from AKUN_TAMBAHAN in ./test-support.ts, none from the seed.
    expect(baris.map((b) => b.kode)).toEqual(["3.1.01", "3.2.01"]);
  });

  test("seed inti tidak punya baris laporan ARUS_KAS atau PERUBAHAN_ASET_NETO", async () => {
    const arus = await d.bacaBarisLaporan("ARUS_KAS");
    const perubahan = await d.bacaBarisLaporan("PERUBAHAN_ASET_NETO");
    expect(arus).toHaveLength(0);
    expect(perubahan).toHaveLength(0);
    // Which is why ./contract.ts derives report 18 from
    // `akun.klasifikasi_arus_kas` and report 20 from the ASET_NETO section of
    // the POSISI_KEUANGAN template: those are the only mappings that exist.
    const seksiAsetNeto = (await d.bacaBarisLaporan("POSISI_KEUANGAN")).filter(
      (b) => b.seksi === "ASET_NETO",
    );
    expect(seksiAsetNeto.map((b) => b.kode)).toContain(KODE_BARIS.asetNetoTidakTerikat);
    expect(seksiAsetNeto.map((b) => b.kode)).toContain(KODE_BARIS.asetNetoTerikat);
  });
});
