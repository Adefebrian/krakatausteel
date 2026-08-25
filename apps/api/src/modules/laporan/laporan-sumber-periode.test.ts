// THE TWO PATHS OF SPEC 10, AND THE ONE DEFECT THAT CANNOT BE CORRECTED
// LATER.
//
// Spec 10 "Aturan teknis laporan", verbatim:
//   "Laporan untuk periode CLOSED dibaca dari `saldo_akun_periode` dan
//    `kolektibilitas_snapshot`, bukan dihitung ulang."
//   "Laporan untuk periode OPEN dihitung realtime dari ledger."
// which is invariant 14 made operational: "Laporan periode lampau yang dibuka
// hari ini harus menghasilkan angka yang sama dengan saat periode itu ditutup."
//
// THREE THINGS ARE TESTED HERE, AND THE MIDDLE ONE IS THE POINT.
//
//  1. EACH PATH IS TAKEN WHEN IT SHOULD BE, and the report says which one it
//     took. A CLOSED period that answers LEDGER_LIVE has recomputed history.
//
//  2. THE TWO PATHS AGREE AT THE MOMENT OF CLOSING. Every one of the seven
//     reports is captured on the OPEN period, the period is frozen and closed,
//     and every report is captured again and compared field for field. THAT
//     AGREEMENT IS WHAT MAKES A CLOSED PERIOD TRUSTWORTHY: without it, closing
//     is a moment at which the numbers quietly change, and no report on either
//     side of it is wrong in a way anyone can see.
//
//  3. THE CLOSED PATH REALLY READS THE FROZEN ROWS. Proved by moving a frozen
//     figure away from the ledger figure and asserting the report follows the
//     frozen one. Without that, a report that recomputed would pass every test
//     in point 2 and fail invariant 14 the first time a back-dated correction
//     landed.
//
// AND ADR 0010, WHICH LIVES HERE BECAUSE IT IS A PROPERTY OF THE LIVE PATH.
// A live computation reads `v_ledger_baris` (`status IN ('POSTED','REVERSED')`),
// never `status = 'POSTED'` alone. A reversal ADDS two lines and REMOVES none;
// marking the original REVERSED drops its lines from a POSTED-only sum while
// the reversing journal keeps subtracting, so the correction is counted twice.
//
// THE ERROR IS INVISIBLE TO EVERY BALANCE CHECK THIS MODULE HAS. Both journals
// balance, so the naive trial balance still foots, the naive Posisi Keuangan
// still satisfies Aset = Liabilitas + Aset Neto, and the naive Arus Kas still
// ties to it. Only a per-account comparison against the ledger predicate
// catches it, and the tests below prove the two readings DIFFER before
// asserting which one the report used, so they cannot pass vacuously on data
// where the two happen to agree (which is most data: see
// ./laporan-fixture.test.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  HARAPAN,
  buatDunia,
  jumlahUang,
  keSen,
  kurangUang,
  negasiUang,
  rp,
  tolakDengan,
  type DuniaLaporan,
  type PeriodeFixture,
} from "./test-support";
import { KODE_LAPORAN } from "./contract";

let d: DuniaLaporan;

beforeEach(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterEach(async () => {
  await d?.tutup();
});

/** Every report of this pass, for one period and one branch scope. */
async function semuaLaporan(p: PeriodeFixture, cabangId: string | null) {
  const f = { periodeId: p.id, cabangId };
  return {
    aktivitas: await d.engine.laporanAktivitas(f, d.ctx.adminPusat),
    arusKas: await d.engine.laporanArusKas(f, d.ctx.adminPusat),
    posisiKeuangan: await d.engine.laporanPosisiKeuangan(f, d.ctx.adminPusat),
    perubahanAsetNeto: await d.engine.laporanPerubahanAsetNeto(f, d.ctx.adminPusat),
    neracaLajur: await d.engine.neracaLajur(f, d.ctx.adminPusat),
    bukuBesarKas: await d.engine.bukuBesar({ ...f, akunId: d.akun.kas.id }, d.ctx.adminPusat),
    bukuBesarPiutang: await d.engine.bukuBesar(
      { ...f, akunId: d.akun.piutangPokok.id },
      d.ctx.adminPusat,
    ),
  };
}

/**
 * Strips the header from every report in a bundle. The header is the ONE part
 * that is SUPPOSED to differ across a close: `statusPeriode` moves OPEN ->
 * CLOSED and `sumberData` moves LEDGER_LIVE -> SNAPSHOT_PERIODE. Everything
 * else, every figure and every line, must be identical.
 */
function tanpaHeader(bundel: Record<string, unknown>): Record<string, unknown> {
  const keluar: Record<string, unknown> = {};
  for (const [nama, laporan] of Object.entries(bundel)) {
    const { header: _abaikan, ...sisa } = laporan as Record<string, unknown>;
    keluar[nama] = sisa;
  }
  return keluar;
}

describe("jalur dipilih menurut status periode, dan laporan menyatakan jalurnya", () => {
  test("periode OPEN dihitung dari ledger", async () => {
    const p = d.periodeLaporan();
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
    const l = await semuaLaporan(p, d.cabangId);
    for (const [nama, laporan] of Object.entries(l)) {
      expect((laporan as { header: { sumberData: string } }).header.sumberData, nama).toBe(
        "LEDGER_LIVE",
      );
      expect((laporan as { header: { statusPeriode: string } }).header.statusPeriode).toBe("OPEN");
    }
  });

  test("periode CLOSED dibaca dari saldo_akun_periode", async () => {
    const p = d.periodeLaporan();
    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);
    expect((await d.bacaPeriode(p.id)).status).toBe("CLOSED");
    expect((await d.bacaSaldoBeku(p.id)).length).toBeGreaterThan(0);

    const l = await semuaLaporan(p, d.cabangId);
    for (const [nama, laporan] of Object.entries(l)) {
      expect((laporan as { header: { sumberData: string } }).header.sumberData, nama).toBe(
        "SNAPSHOT_PERIODE",
      );
      expect((laporan as { header: { statusPeriode: string } }).header.statusPeriode).toBe(
        "CLOSED",
      );
    }
  });

  test("periode CLOSED tanpa saldo beku ditolak, bukan dihitung ulang diam diam", async () => {
    // The state spec 10 has no answer for. Recomputing would produce a
    // plausible page that violates invariant 14 and that nothing downstream
    // could detect, so the report refuses and says which period.
    const p = d.periodeLaporan();
    await d.bekukanDanTutupSampai(p);
    await d.tutupTanpaMembekukan(p);
    expect(await d.bacaSaldoBeku(p.id)).toHaveLength(0);

    for (const panggil of [
      () => d.engine.laporanPosisiKeuangan({ periodeId: p.id, cabangId: d.cabangId }, d.ctx.adminPusat),
      () => d.engine.neracaLajur({ periodeId: p.id, cabangId: d.cabangId }, d.ctx.adminPusat),
      () => d.engine.laporanArusKas({ periodeId: p.id, cabangId: d.cabangId }, d.ctx.adminPusat),
    ]) {
      await tolakDengan(panggil, KODE_LAPORAN.SALDO_PERIODE_BELUM_DIBEKUKAN);
    }
  });

  test("periode CLOSED yang memang tidak punya transaksi TIDAK ditolak", async () => {
    // 2025-01 has one journal, so the first genuinely empty month is a later
    // one; a period whose ledger is empty freezes nothing, and refusing on
    // that would make the opening months of any go-live unreportable.
    const kosong = d.periode(2025, 2);
    await d.bekukanDanTutupSampai(kosong);
    await d.bekukanDanTutup(kosong);
    const neraca = await d.engine.neracaLajur(
      { periodeId: kosong.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(neraca.header.sumberData).toBe("SNAPSHOT_PERIODE");
    // February 2025 has no movement but DOES carry January's opening balance,
    // so it freezes rows and still balances.
    expect(neraca.total.mutasiDebit.nilai).toBe(rp(0));
    expect(neraca.total.saldoAwalDebit.nilai).toBe(neraca.total.saldoAwalKredit.nilai);
  });
});

describe("kedua jalur SEPAKAT pada saat periode ditutup", () => {
  test("ketujuh laporan identik sebelum dan sesudah closing, angka demi angka", async () => {
    const p = d.periodeLaporan();
    const sebelum = await semuaLaporan(p, d.cabangId);

    // NON-VACUOUS: the "before" capture has to contain real figures, or the
    // comparison below is a comparison of two empty objects.
    expect(keSen(sebelum.posisiKeuangan.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
    expect(keSen(sebelum.neracaLajur.total.mutasiDebit.nilai)).toBeGreaterThan(0n);
    expect(sebelum.bukuBesarKas.mutasi.length).toBeGreaterThan(0);
    expect(sebelum.posisiKeuangan.header.sumberData).toBe("LEDGER_LIVE");

    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);

    const sesudah = await semuaLaporan(p, d.cabangId);
    expect(sesudah.posisiKeuangan.header.sumberData).toBe("SNAPSHOT_PERIODE");
    // The header is the only thing allowed to move.
    expect(tanpaHeader(sesudah)).toEqual(tanpaHeader(sebelum));
  });

  test("juga sepakat untuk Semua Cabang", async () => {
    const p = d.periodeLaporan();
    const sebelum = await semuaLaporan(p, null);
    expect(keSen(sebelum.posisiKeuangan.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);
    expect(tanpaHeader(await semuaLaporan(p, null))).toEqual(tanpaHeader(sebelum));
  });

  test("kolom tahun lalu ikut sepakat, meski diambil dari periode yang berbeda", async () => {
    // The comparative cut-offs sit in 2025, which closes in the same sweep.
    // A report that reconstructed the comparative from a different set of
    // frozen rows would diverge exactly here and nowhere else.
    const p = d.periodeLaporan();
    const sebelum = await d.engine.laporanPosisiKeuangan(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(keSen(sebelum.totalAsetTahunLalu.nilai)).toBeGreaterThan(0n);
    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);
    const sesudah = await d.engine.laporanPosisiKeuangan(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(sesudah.totalAsetTahunLalu.nilai).toBe(sebelum.totalAsetTahunLalu.nilai);
    expect(sesudah.kasDanSetaraKasTahunLalu.nilai).toBe(sebelum.kasDanSetaraKasTahunLalu.nilai);
  });
});

describe("periode CLOSED benar benar membaca saldo beku, bukan menghitung ulang", () => {
  test("saldo beku yang digeser dari ledger: laporan mengikuti yang beku", async () => {
    const p = d.periodeLaporan();
    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);

    // Two opposite moves, so the frozen trial balance still balances and the
    // report has no excuse to refuse. The ledger is untouched: after this the
    // frozen figure and the live figure disagree, and for a CLOSED period
    // there is exactly one right answer.
    const geser = rp(7_000_000);
    await d.rusakSaldoBeku(p.id, d.akun.kas.id, geser);
    await d.rusakSaldoBeku(p.id, d.akun.piutangPokok.id, negasiUang(geser));

    const ledger = await d.saldoLedger(d.akun.kas.id, p.tanggalAkhir, d.cabangId);
    const beku = (await d.bacaSaldoBeku(p.id)).find(
      (b) => b.akun_kode === d.akun.kas.kode && b.cabang_id === d.cabangId,
    )!;
    // PROVE THEY DIVERGE FIRST.
    expect(beku.saldo_akhir).not.toBe(ledger);
    expect(beku.saldo_akhir).toBe(jumlahUang(ledger, geser));

    const neraca = await d.engine.neracaLajur(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    const kas = neraca.baris.find((b) => b.akunId === d.akun.kas.id)!;
    expect(kas.saldoAkhirDebit.nilai).toBe(beku.saldo_akhir);
    expect(kas.saldoAkhirDebit.nilai).not.toBe(ledger);

    const buku = await d.engine.bukuBesar(
      { periodeId: p.id, cabangId: d.cabangId, akunId: d.akun.kas.id },
      d.ctx.adminPusat,
    );
    expect(buku.saldoAkhir.nilai).toBe(beku.saldo_akhir);

    // And the balance sheet still balances, because the sabotage was
    // symmetric: the point is which SOURCE was read, not whether it foots.
    const posisi = await d.engine.laporanPosisiKeuangan(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(posisi.totalAsetTahunIni.nilai).toBe(
      jumlahUang(posisi.totalLiabilitasTahunIni.nilai, posisi.totalAsetNetoTahunIni.nilai),
    );
    expect(posisi.kasDanSetaraKasTahunIni.nilai).toBe(beku.saldo_akhir);
  });

  test("saldo beku yang tidak balance ditolak, bukan dicetak", async () => {
    // A balance sheet that does not balance is never printed. This is the one
    // corruption that survives every other check: `saldo_akun_periode`'s own
    // CHECK constraint only validates a row against itself.
    const p = d.periodeLaporan();
    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);
    await d.rusakSaldoBeku(p.id, d.akun.kas.id, rp(7_000_000));

    const err = await tolakDengan(
      () =>
        d.engine.laporanPosisiKeuangan({ periodeId: p.id, cabangId: d.cabangId }, d.ctx.adminPusat),
      KODE_LAPORAN.LAPORAN_TIDAK_BALANCE,
    );
    expect(JSON.stringify(err.detail ?? "")).toContain("7000000");
    await tolakDengan(
      () => d.engine.neracaLajur({ periodeId: p.id, cabangId: d.cabangId }, d.ctx.adminPusat),
      KODE_LAPORAN.LAPORAN_TIDAK_BALANCE,
    );
  });
});

describe("ADR 0010: perhitungan live membaca v_ledger_baris, bukan status POSTED saja", () => {
  /** Posts a journal and reverses it, both inside the reporting period. */
  async function postingLaluBalik(nilai: string): Promise<void> {
    const p = d.periodeLaporan();
    d.setelJam("2026-03-20");
    const asli = await d.postingJurnal({
      tanggal: "2026-03-15",
      jenis: "KAS_BANK",
      keterangan: "Penerimaan lain lain, kemudian dikoreksi (fixture laporan)",
      baris: [
        { akun: "kas", debit: nilai },
        { akun: "pendapatanLain", kredit: nilai },
      ],
    });
    await d.reversalJurnal(asli.id, "Salah akun, dikoreksi dengan jurnal pembalik (fixture)");
    expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
  }

  test("kedua pembacaan BERBEDA setelah pembalikan, dan laporan memakai yang benar", async () => {
    const p = d.periodeLaporan();
    const nilai = rp(7_500_000);
    await postingLaluBalik(nilai);

    // PROVE THE DIVERGENCE FIRST, or the assertions below could pass on data
    // where both readings agree.
    const benar = await d.saldoLedger(d.akun.kas.id, p.tanggalAkhir, d.cabangId);
    const naif = await d.saldoLedgerNaifPostedSaja(d.akun.kas.id, p.tanggalAkhir, d.cabangId);
    expect(benar).toBe(HARAPAN.kasAkhir);
    expect(naif).toBe(kurangUang(HARAPAN.kasAkhir, nilai));
    expect(benar).not.toBe(naif);

    const posisi = await d.engine.laporanPosisiKeuangan(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(posisi.kasDanSetaraKasTahunIni.nilai).toBe(benar);
    expect(posisi.kasDanSetaraKasTahunIni.nilai).not.toBe(naif);

    const arus = await d.engine.laporanArusKas(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(arus.kasAkhirTahunIni.nilai).toBe(benar);
    expect(arus.kasAkhirTahunIni.nilai).not.toBe(naif);

    const neraca = await d.engine.neracaLajur(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    const kas = neraca.baris.find((b) => b.akunId === d.akun.kas.id)!;
    expect(kas.saldoAkhirDebit.nilai).toBe(benar);
    expect(kas.saldoAkhirDebit.nilai).not.toBe(naif);
  });

  test("pembacaan naif TETAP balance, jadi tidak ada total yang bisa mendeteksinya", async () => {
    // The reason this test exists at all. If the defect showed up as an
    // out-of-balance report, the balance checks in the other files would catch
    // it and this file would be redundant. It does not.
    await postingLaluBalik(rp(7_500_000));
    expect(await d.selisihLedger()).toBe(rp(0));
    expect(await d.selisihLedgerNaifPostedSaja()).toBe(rp(0));

    const p = d.periodeLaporan();
    const neraca = await d.engine.neracaLajur(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(neraca.total.saldoAkhirDebit.nilai).toBe(neraca.total.saldoAkhirKredit.nilai);
    const posisi = await d.engine.laporanPosisiKeuangan(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    expect(posisi.totalAsetTahunIni.nilai).toBe(
      jumlahUang(posisi.totalLiabilitasTahunIni.nilai, posisi.totalAsetNetoTahunIni.nilai),
    );
  });

  test("buku besar mencetak kedua sisi koreksi, bukan hanya pembaliknya", async () => {
    // The report where the double count becomes visible to a human: an entry
    // and its reversal are two lines that cancel, and a POSTED-only page shows
    // only the second, i.e. a subtraction with nothing to subtract it from.
    const p = d.periodeLaporan();
    await postingLaluBalik(rp(7_500_000));
    const buku = await d.engine.bukuBesar(
      { periodeId: p.id, cabangId: d.cabangId, akunId: d.akun.kas.id },
      d.ctx.adminPusat,
    );
    expect(buku.mutasi.length).toBe(HARAPAN.kasMutasiBarisMaret + 2);
    const dibalik = buku.mutasi.filter((m) => keSen(m.debit.nilai) === keSen(rp(7_500_000)));
    const pembalik = buku.mutasi.filter((m) => keSen(m.kredit.nilai) === keSen(rp(7_500_000)));
    expect(dibalik).toHaveLength(1);
    expect(pembalik).toHaveLength(1);
    expect(buku.saldoAkhir.nilai).toBe(HARAPAN.kasAkhir);
  });

  test("periode CLOSED mewarisi predikat yang sama lewat saldo beku", async () => {
    // The frozen table is written from `v_ledger_baris` too (ADR 0010,
    // migrations/0018 names modules/closing by name). If it were not, the
    // error would be permanent rather than a query away from being fixed.
    const p = d.periodeLaporan();
    await postingLaluBalik(rp(7_500_000));
    await d.bekukanDanTutupSampai(p);
    await d.bekukanDanTutup(p);
    const neraca = await d.engine.neracaLajur(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    const kas = neraca.baris.find((b) => b.akunId === d.akun.kas.id)!;
    expect(kas.saldoAkhirDebit.nilai).toBe(HARAPAN.kasAkhir);
    expect(kas.saldoAkhirDebit.nilai).not.toBe(
      kurangUang(HARAPAN.kasAkhir, rp(7_500_000)),
    );
  });
});
