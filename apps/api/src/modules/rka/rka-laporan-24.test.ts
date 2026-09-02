// SPEC 10.3 REPORT 24, "Laporan RKA versus Realisasi", AND SPEC 16 SCENARIO 18.
//
//   Report 24: "Uraian, Anggaran, Realisasi, Selisih, persen Capaian. Per akun
//   untuk RKA Keuangan, per sektor untuk RKA PUMK, per bidang untuk RKA Non
//   PUMK. Ada versi bulanan dan kumulatif year to date."
//
//   Scenario 18: "Buka Laporan RKA versus Realisasi, konfirmasi angka realisasi
//   cocok dengan total di laporan penyaluran."
//
// HOW SCENARIO 18 IS TESTED HERE, AND WHY IT IS NOT AN EQUALITY WITH A LITERAL.
// The obvious test writes `expect(baris.realisasi).toBe(rp(7_350_000))`, having
// disbursed 7.350.000 three lines earlier. That asserts the fixture agrees with
// itself. It passes on an implementation that recomputes disbursements with its
// own predicate, which is exactly the implementation scenario 18 exists to rule
// out, because the divergence only appears later, on a reversal or a refund,
// in a client's data.
//
// So every realisation assertion below compares report 24 against a figure READ
// BACK from the source the DISBURSEMENT report reads:
//   PUMK      `pumk_pencairan`     (spec 10.1 report 2's source)
//   Non PUMK  `nonpumk_penyaluran` (spec 10.2 report 13's source), net of the
//                                   refunds the LPJ posted
//   Keuangan  the account's own period movement
// The literal amounts stay in the fixture, where they arrange the world, and
// never appear on the right-hand side of a realisation assertion.
//
// ONE THING SCENARIO 18 CANNOT SETTLE, FILED RATHER THAN DECIDED.
// Report 13's column is "Nilai" (what was disbursed). Report 24's column is
// "Realisasi" (what was spent). For a Non PUMK programme whose LPJ returned
// part of the money, those are DIFFERENT NUMBERS, and the difference is exactly
// the refund `verifikasiLpj` credited back to the bidang's expense account. The
// budget must be measured against the net figure, or a programme that returned
// half its money reads as fully delivered. The test below therefore asserts the
// decomposition explicitly (gross minus refunds), which is the only reading
// under which both reports can be right at once. Whether report 13 should show
// gross, net, or both is a client question.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { KODE_RKA } from "./contract";
import {
  BEBAN_OPERASIONAL_FEB,
  PENCAIRAN_SEKTOR_A,
  PENCAIRAN_SEKTOR_B,
  PENDAPATAN_GIRO_FEB,
  PENYALURAN_BIDANG_A,
  REALISASI_BIDANG_A,
  TAHUN_RKA,
  buatDunia,
  jumlahUang,
  kodeAda,
  kurangUang,
  persenCapaian,
  persenValid,
  rp,
  tolakDengan,
  uangValid,
  type DuniaRka,
} from "./test-support";

let d: DuniaRka;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

/** Creates a budget and approves it, so the report has a baseline to use. */
async function baseline(
  jenis: "PUMK" | "NON_PUMK" | "KEUANGAN",
  baris: Array<Record<string, unknown>>,
) {
  const rka = await d.engine.buatRka(
    {
      cabangId: d.cabangId,
      tahun: TAHUN_RKA,
      jenis,
      baris: baris as never,
    },
    d.ctx.adminPusat,
  );
  await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain);
  return rka;
}

describe("laporan 24: kolom, bentuk dan aritmetika", () => {
  test("setiap baris membawa uraian, anggaran, realisasi, selisih dan persen capaian", async () => {
    d.setelJam("2026-04-15");
    await d.buatPenyaluranNonPumk({
      tanggal: "2026-02-20",
      bidangId: d.bidang.a.id,
      jumlah: rp(5_000_000),
    });
    await baseline("NON_PUMK", [
      {
        bidangId: d.bidang.a.id,
        uraian: "Anggaran Pendidikan Februari",
        bulan: 2,
        jumlahAnggaran: rp(6_000_000),
      },
      {
        bidangId: d.bidang.b.id,
        uraian: "Anggaran Kesehatan Februari",
        bulan: 2,
        jumlahAnggaran: rp(4_000_000),
      },
    ]);

    const laporan = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );

    expect(laporan.dimensi).toBe("BIDANG");
    expect(laporan.mode).toBe("BULANAN");
    expect(laporan.dariBulan).toBe(2);
    expect(laporan.sampaiBulan).toBe(2);
    expect(laporan.baris).toHaveLength(2);

    for (const b of laporan.baris) {
      // The five columns spec 10.3 names, present and well-formed on EVERY
      // row, including the one with no realisation at all. That row is the
      // common case in a budget report and it is exactly where a
      // `coalesce(sum(...), 0)` leaks a bare '0'.
      expect(b.uraian.length).toBeGreaterThan(0);
      expect(b.dimensiKode.length).toBeGreaterThan(0);
      expect(b.dimensiNama.length).toBeGreaterThan(0);
      uangValid(b.anggaran, "anggaran");
      uangValid(b.realisasi, "realisasi");
      uangValid(b.selisih, "selisih");
      persenValid(b.persenCapaian, "persenCapaian");
      // Selisih is derived, never stored: anggaran - realisasi.
      expect(b.selisih).toBe(kurangUang(b.anggaran, b.realisasi));
      expect(b.persenCapaian).toBe(persenCapaian(b.realisasi, b.anggaran));
    }

    // The untouched bidang: budgeted, nothing spent, and the report says so
    // with a two-decimal zero rather than a bare '0'.
    const kesehatan = laporan.baris.find((b) => b.dimensiId === d.bidang.b.id)!;
    expect(kesehatan.realisasi).toBe("0.00");
    expect(kesehatan.selisih).toBe(rp(4_000_000));
    expect(kesehatan.persenCapaian).toBe("0.00");
  });

  test("total laporan adalah jumlah barisnya, dengan persen capaian dihitung dari total", async () => {
    d.setelJam("2026-04-15");
    await d.buatPenyaluranNonPumk({
      tanggal: "2026-02-20",
      bidangId: d.bidang.a.id,
      jumlah: rp(5_000_000),
    });
    await baseline("NON_PUMK", [
      { bidangId: d.bidang.a.id, uraian: "Pendidikan", bulan: 2, jumlahAnggaran: rp(6_000_000) },
      { bidangId: d.bidang.b.id, uraian: "Kesehatan", bulan: 2, jumlahAnggaran: rp(4_000_000) },
    ]);

    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(l.total.anggaran).toBe(jumlahUang(...l.baris.map((b) => b.anggaran)));
    expect(l.total.realisasi).toBe(jumlahUang(...l.baris.map((b) => b.realisasi)));
    expect(l.total.selisih).toBe(kurangUang(l.total.anggaran, l.total.realisasi));
    // NOT the average of the rows' percentages, which is a different and
    // wrong number whenever the budgets differ in size.
    expect(l.total.persenCapaian).toBe(persenCapaian(l.total.realisasi, l.total.anggaran));
  });

  test("realisasi tanpa anggaran tetap muncul sebagai baris, dengan persen capaian kosong", async () => {
    // The line that is easiest to lose: money spent on a bidang nobody
    // budgeted. An inner join onto `rka_detail` drops it, the report totals
    // then understate spending, and the omission is invisible because the
    // report has no independent total to disagree with.
    d.setelJam("2026-04-15");
    await d.buatPenyaluranNonPumk({
      tanggal: "2026-02-20",
      bidangId: d.bidang.b.id,
      jumlah: rp(2_500_000),
    });
    await baseline("NON_PUMK", [
      { bidangId: d.bidang.a.id, uraian: "Pendidikan", bulan: 2, jumlahAnggaran: rp(6_000_000) },
    ]);

    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    const takDianggarkan = l.baris.find((b) => b.dimensiId === d.bidang.b.id);
    expect(takDianggarkan).toBeDefined();
    expect(takDianggarkan!.anggaran).toBe("0.00");
    expect(takDianggarkan!.realisasi).toBe(rp(2_500_000));
    // Spending against a zero budget is not "0 percent" and not infinity.
    expect(takDianggarkan!.persenCapaian).toBeNull();
    // Over budget is a NEGATIVE selisih, not an absolute difference.
    expect(takDianggarkan!.selisih).toBe(kurangUang("0.00", rp(2_500_000)));
  });
});

describe("laporan 24 per sektor, untuk RKA PUMK (spec 16 skenario 18)", () => {
  test("realisasi per sektor COCOK dengan sumber laporan penyaluran, tidak dihitung ulang di sini", async () => {
    d.setelJam("2026-03-25");
    await d.buatPencairanPumk({
      tanggal: "2026-02-10",
      sektorId: d.sektor.a.id,
      jumlah: PENCAIRAN_SEKTOR_A,
    });
    await d.buatPencairanPumk({
      tanggal: "2026-02-18",
      sektorId: d.sektor.b.id,
      jumlah: PENCAIRAN_SEKTOR_B,
    });

    await baseline("PUMK", [
      {
        sektorId: d.sektor.a.id,
        uraian: "Target Perdagangan Februari",
        bulan: 2,
        jumlahAnggaran: rp(9_000_000),
        jumlahUnit: 2,
      },
      {
        sektorId: d.sektor.b.id,
        uraian: "Target Industri Februari",
        bulan: 2,
        jumlahAnggaran: rp(5_000_000),
        jumlahUnit: 1,
      },
    ]);

    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(l.dimensi).toBe("SEKTOR");

    // THE SCENARIO 18 ASSERTION. The right-hand side is read from
    // `pumk_pencairan`, which is what Laporan Realisasi Penyaluran berdasarkan
    // Sektor reads. Neither side restates a literal.
    const jendela = { dari: "2026-02-01", sampai: "2026-02-28", cabangId: d.cabangId };
    for (const sektorId of [d.sektor.a.id, d.sektor.b.id]) {
      const baris = l.baris.find((b) => b.dimensiId === sektorId)!;
      const dariLaporanPenyaluran = await d.totalPencairanPumk({ ...jendela, sektorId });
      expect(`${baris.dimensiKode}=${baris.realisasi}`).toBe(
        `${baris.dimensiKode}=${dariLaporanPenyaluran}`,
      );
    }
    // And in aggregate, which is the number a manager compares first.
    expect(l.total.realisasi).toBe(await d.totalPencairanPumk(jendela));
  });

  test("jumlah mitra target dibandingkan dengan jumlah mitra yang benar benar dicairkan", async () => {
    // Spec 9.3 names the partner count as part of the PUMK budget, so the
    // report has to show the achievement against it. Two disbursements to the
    // SAME partner is one partner, which is why the source counts DISTINCT
    // mitra rather than rows.
    d.setelJam("2026-03-25");
    await d.buatPencairanPumk({
      tanggal: "2026-02-10",
      sektorId: d.sektor.a.id,
      jumlah: rp(3_000_000),
    });
    await d.buatPencairanPumk({
      tanggal: "2026-02-14",
      sektorId: d.sektor.a.id,
      jumlah: rp(2_000_000),
    });

    await baseline("PUMK", [
      {
        sektorId: d.sektor.a.id,
        uraian: "Target Perdagangan Februari",
        bulan: 2,
        jumlahAnggaran: rp(9_000_000),
        jumlahUnit: 5,
      },
    ]);

    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    const baris = l.baris.find((b) => b.dimensiId === d.sektor.a.id)!;
    expect(baris.unitAnggaran).toBe(5);
    expect(baris.unitRealisasi).toBe(
      await d.jumlahMitraDicairkan({
        sektorId: d.sektor.a.id,
        dari: "2026-02-01",
        sampai: "2026-02-28",
        cabangId: d.cabangId,
      }),
    );
    expect(baris.unitRealisasi).toBe(2);
    expect(l.total.unitAnggaran).toBe(5);
  });

  test("jumlah unit null untuk jenis selain PUMK, bukan nol", async () => {
    // Zero would read as "a target of none was met", which is a claim. Null is
    // "not applicable", which is the truth for a Non PUMK budget.
    d.setelJam("2026-04-15");
    await baseline("NON_PUMK", [
      { bidangId: d.bidang.a.id, uraian: "Pendidikan", bulan: 2, jumlahAnggaran: rp(1_000_000) },
    ]);
    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(l.baris[0].unitAnggaran).toBeNull();
    expect(l.baris[0].unitRealisasi).toBeNull();
  });
});

describe("laporan 24 per bidang, untuk RKA Non PUMK (spec 16 skenario 18)", () => {
  test("realisasi per bidang adalah penyaluran DIKURANGI pengembalian sisa LPJ", async () => {
    // The gross/net question this file's header describes, as one experiment.
    d.setelJam("2026-05-15");
    const salur = await d.buatPenyaluranNonPumk({
      tanggal: "2026-02-20",
      bidangId: d.bidang.a.id,
      jumlah: PENYALURAN_BIDANG_A,
      realisasiLpj: REALISASI_BIDANG_A,
      // The refund lands in a LATER month, which is the normal case and the
      // reason a monthly report and a cumulative one disagree here.
      tanggalLpj: "2026-03-05",
    });
    expect(salur.pengembalian).toBe(kurangUang(PENYALURAN_BIDANG_A, REALISASI_BIDANG_A));

    await baseline("NON_PUMK", [
      { bidangId: d.bidang.a.id, uraian: "Pendidikan Februari", bulan: 2, jumlahAnggaran: rp(7_000_000) },
      { bidangId: d.bidang.a.id, uraian: "Pendidikan Maret", bulan: 3, jumlahAnggaran: rp(1_000_000) },
    ]);

    const jendelaFeb = { dari: "2026-02-01", sampai: "2026-02-28", cabangId: d.cabangId };
    const jendelaYtd = { dari: "2026-01-01", sampai: "2026-03-31", cabangId: d.cabangId };
    const bidangId = d.bidang.a.id;

    // February on its own: the money went out, nothing has come back.
    const feb = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    const barisFeb = feb.baris.find((b) => b.dimensiId === bidangId)!;
    expect(barisFeb.realisasi).toBe(
      kurangUang(
        await d.totalPenyaluranNonPumk({ ...jendelaFeb, bidangId }),
        await d.totalPengembalianNonPumk({ ...jendelaFeb, bidangId }),
      ),
    );
    expect(barisFeb.realisasi).toBe(PENYALURAN_BIDANG_A);

    // Year to date through March: the refund is inside the window, so the
    // budget is measured against what was actually spent.
    const ytd = await d.engine.laporanRkaVsRealisasi(
      {
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        cabangId: d.cabangId,
        mode: "KUMULATIF_YTD",
        bulan: 3,
      },
      d.ctx.adminPusat,
    );
    const barisYtd = ytd.baris.find((b) => b.dimensiId === bidangId)!;
    expect(barisYtd.realisasi).toBe(
      kurangUang(
        await d.totalPenyaluranNonPumk({ ...jendelaYtd, bidangId }),
        await d.totalPengembalianNonPumk({ ...jendelaYtd, bidangId }),
      ),
    );
    expect(barisYtd.realisasi).toBe(REALISASI_BIDANG_A);

    // The two windows DISAGREE, which is the whole reason the gross figure
    // cannot be the budget's yardstick. Without this line the test would pass
    // on an implementation that ignored refunds entirely.
    expect(barisYtd.realisasi).not.toBe(barisFeb.realisasi);
  });
});

describe("laporan 24 per akun, untuk RKA Keuangan", () => {
  test("beban dan pendapatan sama sama positif terhadap anggarannya masing masing", async () => {
    // The sign question. The ledger moves an expense debit and a revenue
    // credit, so a debit-positive reading would report the revenue target as
    // minus its achievement and every revenue line would show a negative
    // percentage. Report 24 shows the account's NORMAL direction.
    d.setelJam("2026-03-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-02-05", BEBAN_OPERASIONAL_FEB);
    await d.postingPendapatanGiro("2026-02-07", PENDAPATAN_GIRO_FEB);

    await baseline("KEUANGAN", [
      {
        akunId: d.akun.bebanOperasional.id,
        uraian: "Beban operasional Februari",
        bulan: 2,
        jumlahAnggaran: rp(4_000_000),
      },
      {
        akunId: d.akun.pendapatanJasaGiro.id,
        uraian: "Target pendapatan jasa giro Februari",
        bulan: 2,
        jumlahAnggaran: rp(1_500_000),
      },
    ]);

    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "KEUANGAN", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(l.dimensi).toBe("AKUN");

    const jendela = { dari: "2026-02-01", sampai: "2026-02-28" };
    for (const akun of [d.akun.bebanOperasional, d.akun.pendapatanJasaGiro]) {
      const baris = l.baris.find((b) => b.dimensiId === akun.id)!;
      expect(baris.dimensiKode).toBe(akun.kode);
      // Read from the ledger in normal sign, not restated.
      expect(`${akun.kode}=${baris.realisasi}`).toBe(
        `${akun.kode}=${await d.mutasiNormal(akun.id, jendela.dari, jendela.sampai, d.cabangId)}`,
      );
    }
    // And both are positive, which is what makes the percentage readable.
    const pendapatan = l.baris.find((b) => b.dimensiId === d.akun.pendapatanJasaGiro.id)!;
    expect(pendapatan.realisasi).toBe(PENDAPATAN_GIRO_FEB);
    expect(pendapatan.persenCapaian).toBe(persenCapaian(PENDAPATAN_GIRO_FEB, rp(1_500_000)));
  });

  test("hanya akun yang dianggarkan atau bergerak yang muncul, bukan seluruh bagan akun", async () => {
    d.setelJam("2026-03-20");
    await d.postingAlokasiDana("2026-01-05", rp(90_000_000));
    await d.postingBebanOperasional("2026-02-05", BEBAN_OPERASIONAL_FEB);
    await baseline("KEUANGAN", [
      {
        akunId: d.akun.bebanPembinaan.id,
        uraian: "Beban pembinaan Februari",
        bulan: 2,
        jumlahAnggaran: rp(2_000_000),
      },
    ]);

    const l = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "KEUANGAN", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    const kode = l.baris.map((b) => b.dimensiKode).sort();
    // The budgeted account with no spending, and the spent account with no
    // budget. Nothing else: cash moved in February too, and cash is not a
    // budget line.
    expect(kode).toEqual([d.akun.bebanPembinaan.kode, d.akun.bebanOperasional.kode].sort());
    expect(kode).not.toContain(d.akun.kas.kode);
  });
});

describe("laporan 24: bentuk bulanan dan kumulatif year to date", () => {
  test("bulanan hanya melihat bulannya sendiri, kumulatif menjumlah dari awal tahun buku", async () => {
    d.setelJam("2026-05-20");
    await d.buatPenyaluranNonPumk({
      tanggal: "2026-01-15",
      bidangId: d.bidang.a.id,
      jumlah: rp(2_000_000),
    });
    await d.buatPenyaluranNonPumk({
      tanggal: "2026-03-10",
      bidangId: d.bidang.a.id,
      jumlah: rp(3_000_000),
    });
    await baseline("NON_PUMK", [
      { bidangId: d.bidang.a.id, uraian: "Pendidikan Januari", bulan: 1, jumlahAnggaran: rp(2_500_000) },
      { bidangId: d.bidang.a.id, uraian: "Pendidikan Februari", bulan: 2, jumlahAnggaran: rp(2_500_000) },
      { bidangId: d.bidang.a.id, uraian: "Pendidikan Maret", bulan: 3, jumlahAnggaran: rp(2_500_000) },
    ]);

    const dasar = {
      tahun: TAHUN_RKA,
      jenis: "NON_PUMK" as const,
      cabangId: d.cabangId,
    };

    const maret = await d.engine.laporanRkaVsRealisasi(
      { ...dasar, mode: "BULANAN", bulan: 3 },
      d.ctx.adminPusat,
    );
    expect(maret.dariBulan).toBe(3);
    expect(maret.sampaiBulan).toBe(3);
    expect(maret.baris[0].anggaran).toBe(rp(2_500_000));
    expect(maret.baris[0].realisasi).toBe(rp(3_000_000));

    const ytd = await d.engine.laporanRkaVsRealisasi(
      { ...dasar, mode: "KUMULATIF_YTD", bulan: 3 },
      d.ctx.adminPusat,
    );
    expect(ytd.dariBulan).toBe(1);
    expect(ytd.sampaiBulan).toBe(3);
    // BOTH sides cumulate: the budget for January to March and the realisation
    // for January to March. A report that cumulated only one of them would be
    // comparing three months of spending with one month of budget, and would
    // look like a 300 percent overrun on well-behaved data.
    expect(ytd.baris[0].anggaran).toBe(rp(7_500_000));
    expect(ytd.baris[0].realisasi).toBe(rp(5_000_000));
    expect(ytd.baris[0].persenCapaian).toBe(persenCapaian(rp(5_000_000), rp(7_500_000)));
  });

  test("kumulatif dihitung dari bulan awal tahun buku di konfigurasi, bukan dari Januari", async () => {
    // THE MECHANIC, NOT THE POLICY. Nothing here asserts that the year starts
    // in January; it asserts that moving `akuntansi.tahun_buku_mulai_bulan`
    // moves the window. An engine with January hardcoded passes the previous
    // test and fails this one.
    d.setelJam("2026-07-20");
    await d.buatPenyaluranNonPumk({
      tanggal: "2026-02-15",
      bidangId: d.bidang.a.id,
      jumlah: rp(2_000_000),
    });
    await d.buatPenyaluranNonPumk({
      tanggal: "2026-05-10",
      bidangId: d.bidang.a.id,
      jumlah: rp(3_000_000),
    });
    await baseline("NON_PUMK", [
      { bidangId: d.bidang.a.id, uraian: "Pendidikan Februari", bulan: 2, jumlahAnggaran: rp(2_500_000) },
      { bidangId: d.bidang.a.id, uraian: "Pendidikan Mei", bulan: 5, jumlahAnggaran: rp(2_500_000) },
    ]);

    const dasar = {
      tahun: TAHUN_RKA,
      jenis: "NON_PUMK" as const,
      cabangId: d.cabangId,
      mode: "KUMULATIF_YTD" as const,
      bulan: 5,
    };

    const tahunKalender = await d.engine.laporanRkaVsRealisasi(dasar, d.ctx.adminPusat);
    expect(tahunKalender.dariBulan).toBe(1);
    expect(tahunKalender.baris[0].realisasi).toBe(rp(5_000_000));

    // A financial year starting in April: February is in the PREVIOUS year and
    // drops out of the cumulation entirely.
    await d.setelKonfigurasi("akuntansi", "tahun_buku_mulai_bulan", "4");
    const tahunBukuApril = await d.engine.laporanRkaVsRealisasi(dasar, d.ctx.adminPusat);
    expect(tahunBukuApril.dariBulan).toBe(4);
    expect(tahunBukuApril.sampaiBulan).toBe(5);
    expect(tahunBukuApril.baris[0].realisasi).toBe(rp(3_000_000));
    expect(tahunBukuApril.baris[0].anggaran).toBe(rp(2_500_000));
  });

  test("menghapus baris bumn saja TIDAK menghentikan laporan: default global yang menjawab", async () => {
    // THE RESOLUTION ORDER, ASSERTED RATHER THAN ASSUMED, and the half the
    // old version of the test below got wrong. `hapusKonfigurasi` removes
    // THIS WORLD'S row only; `akuntansi.tahun_buku_mulai_bulan` has a global
    // row from migrations/0004; resolution is bumn-scoped THEN global. So the
    // report proceeds on the shipped default, which is January.
    //
    // This is not a lesser assertion than the refusal below, it is the other
    // half of the same rule: a client who configures nothing gets the shipped
    // default, and a client who has no default anywhere gets a refusal.
    await d.hapusKonfigurasi("akuntansi", "tahun_buku_mulai_bulan");
    d.setelJam("2026-05-20");
    await baseline("NON_PUMK", [
      { bidangId: d.bidang.a.id, uraian: "Pendidikan", bulan: 2, jumlahAnggaran: rp(2_500_000) },
    ]);
    const laporan = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "KUMULATIF_YTD", bulan: 5 },
      d.ctx.adminPusat,
    );
    expect(laporan.dariBulan).toBe(1);
    expect(laporan.sampaiBulan).toBe(5);
  });

  test("konfigurasi tahun buku yang hilang menghentikan laporan, bukan diganti Januari", async () => {
    kodeAda(KODE_RKA.KONFIGURASI_TIDAK_ADA);
    // FIXED TEST, NOT A FIXED ENGINE. This used to call `hapusKonfigurasi`,
    // which removes this world's row only, and then demand a refusal that
    // bumn-then-global resolution can never produce; its own comment conceded
    // the resolution order and then asserted against it. The engine was right
    // and the test was wrong, and the same defect in modules/laporan's copy of
    // it pushed that module into resolving this one key branch-only, which is
    // one key with two resolution orders in one system.
    //
    // `tanpaKonfigurasi` removes BOTH levels for the duration of the call, so
    // "hilang" now means what the title always claimed. The refusal must name
    // the key, or an administrator has nothing to act on.
    d.setelJam("2026-05-20");
    await baseline("NON_PUMK", [
      { bidangId: d.bidang.a.id, uraian: "Pendidikan", bulan: 2, jumlahAnggaran: rp(2_500_000) },
    ]);
    const err = await d.tanpaKonfigurasi("akuntansi", "tahun_buku_mulai_bulan", () =>
      tolakDengan(
        () =>
          d.engine.laporanRkaVsRealisasi(
            {
              tahun: TAHUN_RKA,
              jenis: "NON_PUMK",
              cabangId: d.cabangId,
              mode: "KUMULATIF_YTD",
              bulan: 5,
            },
            d.ctx.adminPusat,
          ),
        KODE_RKA.KONFIGURASI_TIDAK_ADA,
      ),
    );
    expect(err.message).toContain("tahun_buku_mulai_bulan");
  });

  test("baris anggaran tahunan tanpa bulan ikut di kumulatif tapi tidak di satu bulan", async () => {
    // migrations/0012 allows `bulan IS NULL` for "an annual figure with no
    // monthly breakdown". A monthly report that silently included the whole
    // annual figure would show a twelvefold overrun every month; one that
    // dropped it from the cumulative would understate the budget for the year.
    d.setelJam("2026-05-20");
    await d.buatPenyaluranNonPumk({
      tanggal: "2026-02-15",
      bidangId: d.bidang.a.id,
      jumlah: rp(2_000_000),
    });
    await baseline("NON_PUMK", [
      {
        bidangId: d.bidang.a.id,
        uraian: "Anggaran tahunan Pendidikan",
        bulan: null,
        jumlahAnggaran: rp(12_000_000),
      },
    ]);
    const dasar = { tahun: TAHUN_RKA, jenis: "NON_PUMK" as const, cabangId: d.cabangId };

    const feb = await d.engine.laporanRkaVsRealisasi(
      { ...dasar, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(feb.baris.find((b) => b.dimensiId === d.bidang.a.id)?.anggaran).toBe("0.00");

    const ytd = await d.engine.laporanRkaVsRealisasi(
      { ...dasar, mode: "KUMULATIF_YTD", bulan: 12 },
      d.ctx.adminPusat,
    );
    expect(ytd.baris.find((b) => b.dimensiId === d.bidang.a.id)?.anggaran).toBe(rp(12_000_000));
  });

  test("bulan di luar 1 sampai 12 ditolak", async () => {
    kodeAda(KODE_RKA.BULAN_TIDAK_VALID);
    await baseline("NON_PUMK", [
      { bidangId: d.bidang.a.id, uraian: "Pendidikan", bulan: 2, jumlahAnggaran: rp(1_000_000) },
    ]);
    for (const bulan of [0, 13]) {
      await tolakDengan(
        () =>
          d.engine.laporanRkaVsRealisasi(
            { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan },
            d.ctx.adminPusat,
          ),
        KODE_RKA.BULAN_TIDAK_VALID,
      );
    }
  });
});

describe("laporan 24: scope cabang ikut ke angka realisasi, bukan hanya ke anggaran", () => {
  test("realisasi cabang lain tidak bocor ke laporan cabang ini", async () => {
    // A budget filtered by branch whose realisation is not is the worst of both
    // worlds: the percentages are wrong in a direction that always flatters,
    // and every branch's report double counts head office.
    d.setelJam("2026-03-25");
    await d.buatPencairanPumk({
      tanggal: "2026-02-10",
      sektorId: d.sektor.a.id,
      cabangId: d.cabangId,
      jumlah: PENCAIRAN_SEKTOR_A,
    });
    await d.buatPencairanPumk({
      tanggal: "2026-02-12",
      sektorId: d.sektor.a.id,
      cabangId: d.cabangLainId,
      jumlah: PENCAIRAN_SEKTOR_B,
    });

    // TWO baselines, because they are two documents: `rka_versi_uq` is NULLS
    // NOT DISTINCT, so the branch budget and the consolidated one are separate
    // rows with separate approvals (see ./rka-jenis.test.ts). Asking for a
    // consolidated report against a branch baseline would be asking the wrong
    // question, so the fixture answers both.
    const barisTarget = [
      {
        sektorId: d.sektor.a.id,
        uraian: "Target Perdagangan Februari",
        bulan: 2,
        jumlahAnggaran: rp(20_000_000),
        jumlahUnit: 4,
      },
    ];
    await baseline("PUMK", barisTarget);
    const konsolidasi = await d.engine.buatRka(
      { cabangId: null, tahun: TAHUN_RKA, jenis: "PUMK", baris: barisTarget as never },
      d.ctx.adminPusat,
    );
    await d.engine.setujuiRka({ rkaId: konsolidasi.id }, d.ctx.adminPusatLain);

    const satuCabang = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(satuCabang.baris[0].realisasi).toBe(
      await d.totalPencairanPumk({
        sektorId: d.sektor.a.id,
        dari: "2026-02-01",
        sampai: "2026-02-28",
        cabangId: d.cabangId,
      }),
    );
    expect(satuCabang.baris[0].realisasi).toBe(PENCAIRAN_SEKTOR_A);

    // Consolidated: every branch in scope, which for Admin Pusat is both.
    const semua = await d.engine.laporanRkaVsRealisasi(
      { tahun: TAHUN_RKA, jenis: "PUMK", cabangId: null, mode: "BULANAN", bulan: 2 },
      d.ctx.adminPusat,
    );
    expect(semua.baris[0].realisasi).toBe(
      jumlahUang(PENCAIRAN_SEKTOR_A, PENCAIRAN_SEKTOR_B),
    );
  });
});
