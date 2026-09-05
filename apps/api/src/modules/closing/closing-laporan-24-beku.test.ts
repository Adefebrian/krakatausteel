// THE REASON THE FREEZE EXISTS, ASKED OF THE REPORT ITSELF.
//
// `closing-saldo-dimensi.test.ts` specifies the rows this module writes. This
// file asks the only question those rows exist to answer: does report 24, spec
// 10.3's "RKA vs Realisasi", give the SAME figures over a CLOSED period as it
// gave over the same window while that period was still OPEN.
//
// WHY IT IS HERE AND NOT IN modules/rka. The claim spans two modules and one
// transaction: modules/closing decides what is frozen, modules/rka decides what
// is read, and the property is that the second cannot tell which happened. A
// test inside modules/rka would have to freeze the rows itself, which would
// prove that a fixture's SQL agrees with a report's SQL; a test inside
// modules/closing that re-implemented the report would prove that two copies of
// a query agree. So this drives BOTH real engines, modules/rka reached through
// its index.ts like any other cross-module call (`d.rka`).
//
// WHAT WAS BLOCKED UNTIL NOW. `laporanRkaVsRealisasi` refused jenis PUMK and
// NON_PUMK the moment its window touched a CLOSED period, with
// `SKEMA_BELUM_LENGKAP`, because `saldo_akun_periode` carries no sektor and no
// bidang and nothing had ever written the child table migrations/0027 added to
// hold them (ADR 0016). Report 24 was the last of the specification's 31
// reports that could not be produced.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buatDunia,
  rp,
  TAHUN_AWAL,
  type DuniaClosing,
  type PeriodeFixture,
} from "./test-support";
import type { BarisRkaInput, JenisRka, RkaContext } from "../rka/index";

let d: DuniaClosing;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

/**
 * TWO ADMIN PUSAT CONTEXTS OVER TWO REAL USERS.
 *
 * `setujuiRka` refuses an approver who drafted the version
 * (KONFLIK_MAKER_APPROVER) while `rka.pemisahan_tugas_persetujuan` is on, which
 * it ships as. Only ADMIN_PUSAT holds `admin.rka` and `admin.rka.approve` on
 * the shipped matrix and this world has one such user, so the second context
 * borrows another real user id with the same rights. Segregation of duties is
 * modules/rka's own suite's subject; here it is scaffolding, and a fixture that
 * disabled the configuration key instead would be turning a control off to make
 * a test about arithmetic run.
 */
function ctxRka(dunia: DuniaClosing): { penyusun: RkaContext; pemberiPersetujuan: RkaContext } {
  const penyusun = dunia.ctx.adminPusat as RkaContext;
  return {
    penyusun,
    pemberiPersetujuan: { ...penyusun, userId: dunia.ctx.approver.userId },
  };
}

async function baselineRka(jenis: JenisRka, baris: readonly BarisRkaInput[]): Promise<void> {
  const { penyusun, pemberiPersetujuan } = ctxRka(d);
  const rka = await d.rka.buatRka(
    { cabangId: d.cabangId, tahun: TAHUN_AWAL, jenis, baris },
    penyusun,
  );
  await d.rka.setujuiRka({ rkaId: rka.id }, pemberiPersetujuan);
}

/** Report 24 for January, as `dimensiKode -> "realisasi / unit"`. */
async function laporan24(jenis: JenisRka): Promise<{
  baris: Record<string, string>;
  total: string;
  sumber: string;
}> {
  const l = await d.rka.laporanRkaVsRealisasi(
    { tahun: TAHUN_AWAL, jenis, cabangId: d.cabangId, mode: "BULANAN", bulan: 1 },
    d.ctx.adminPusat as RkaContext,
  );
  const baris: Record<string, string> = {};
  for (const b of l.baris) baris[b.dimensiKode] = `${b.realisasi} / ${b.unitRealisasi}`;
  return {
    baris,
    total: l.total.realisasi,
    sumber: l.sumberPerPeriode.map((s) => `${s.bulan}=${s.sumber}`).join(","),
  };
}

async function tutup(p: PeriodeFixture): Promise<void> {
  d.setelJam(p.tanggalAkhir);
  await d.siapkanTutup(p);
  await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.adminPusat);
}

describe("laporan 24 atas periode CLOSED, sesudah closing membekukan penguraiannya", () => {
  test("PUMK dan NON PUMK menghasilkan angka yang sama persis dengan bacaan saat periode masih OPEN", async () => {
    const p = d.periode(TAHUN_AWAL, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-02", rp(100_000_000));

    // --- PUMK, two sectors, three partners -------------------------------
    // Two akads in sektor A so the sector's figure is a SUM and its partner
    // count is a COUNT, and the two cannot be confused with each other.
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(5_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(3_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-06",
    });
    await d.buatAkad({
      sektorId: d.sektorLainId,
      pokok: rp(6_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-07",
    });

    // --- Non PUMK, two bidang, one refund, one undimensioned expense -----
    await d.postingPenyaluranNonPumk("2026-01-12", rp(4_000_000), d.bidang.a.id);
    await d.postingPenyaluranNonPumk("2026-01-14", rp(2_000_000), d.bidang.b.id);
    // The refund credits the SAME expense account per bidang, so bidang A's
    // realisation is 3.500.000 and not 4.000.000. A freeze that stored one
    // netted figure, or that lost the credit, would still look plausible here
    // and would disagree with the open reading.
    await d.postingPengembalianSisaNonPumk("2026-01-20", rp(500_000), d.bidang.a.id);
    // Movement on the same account carrying NO bidang: the residual bucket.
    // It must appear in neither reading.
    await d.postingBebanOperasional("2026-01-22", rp(1_000_000));

    await baselineRka("PUMK", [
      {
        sektorId: d.sektorId,
        uraian: "Target sektor A Januari",
        bulan: 1,
        jumlahAnggaran: rp(10_000_000),
        jumlahUnit: 3,
      },
      {
        sektorId: d.sektorLainId,
        uraian: "Target sektor B Januari",
        bulan: 1,
        jumlahAnggaran: rp(6_000_000),
        jumlahUnit: 1,
      },
    ]);
    await baselineRka("NON_PUMK", [
      {
        bidangId: d.bidang.a.id,
        uraian: "Anggaran Pendidikan Januari",
        bulan: 1,
        jumlahAnggaran: rp(5_000_000),
      },
      {
        bidangId: d.bidang.b.id,
        uraian: "Anggaran Kesehatan Januari",
        bulan: 1,
        jumlahAnggaran: rp(2_000_000),
      },
    ]);

    // --- THE OPEN READING, taken first and kept ---------------------------
    const pumkTerbuka = await laporan24("PUMK");
    const nonPumkTerbuka = await laporan24("NON_PUMK");
    expect(pumkTerbuka.sumber).toBe("1=V_LEDGER_BARIS");
    expect(nonPumkTerbuka.sumber).toBe("1=V_LEDGER_BARIS");

    // Stated in full rather than only compared with the frozen reading: two
    // readings that agree on the wrong number agree.
    const kodeSektorA = Object.keys(pumkTerbuka.baris).find(
      (k) => pumkTerbuka.baris[k] === `${rp(8_000_000)} / 2`,
    );
    expect(kodeSektorA).toBeDefined();
    expect(Object.values(pumkTerbuka.baris).sort()).toEqual(
      [`${rp(8_000_000)} / 2`, `${rp(6_000_000)} / 1`].sort(),
    );
    expect(nonPumkTerbuka.baris).toEqual({
      [d.bidang.a.kode]: `${rp(3_500_000)} / null`,
      [d.bidang.b.kode]: `${rp(2_000_000)} / null`,
    });
    expect(pumkTerbuka.total).toBe(rp(14_000_000));
    expect(nonPumkTerbuka.total).toBe(rp(5_500_000));

    // --- THE CLOSE --------------------------------------------------------
    await tutup(p);
    expect(await d.dimensiDibekukanAt(p.id)).not.toBeNull();

    for (const jenis of ["PUMK", "NON_PUMK"] as const) {
      expect(
        `${jenis}=${await d.rka.metodeRealisasi({ periodeId: p.id, jenis }, d.ctx.adminPusat as RkaContext)}`,
      ).toBe(`${jenis}=SALDO_AKUN_PERIODE`);
    }

    // --- THE FROZEN READING ----------------------------------------------
    const pumkTertutup = await laporan24("PUMK");
    const nonPumkTertutup = await laporan24("NON_PUMK");

    // It really did switch source, so the equality below is not two live reads.
    expect(pumkTertutup.sumber).toBe("1=SALDO_AKUN_PERIODE");
    expect(nonPumkTertutup.sumber).toBe("1=SALDO_AKUN_PERIODE");

    expect(pumkTertutup).toEqual({ ...pumkTerbuka, sumber: "1=SALDO_AKUN_PERIODE" });
    expect(nonPumkTertutup).toEqual({ ...nonPumkTerbuka, sumber: "1=SALDO_AKUN_PERIODE" });
  });

  test("periode yang ditutup tanpa penguraian tetap DITOLAK, dan itu bukan nol", async () => {
    // The fail-closed half, and the reason migrations/0032 added a stamp rather
    // than letting the reader count rows. A period closed before this engine
    // existed HAD disbursements and has no frozen record of them; answering it
    // with zero would report a month of real lending as a month of none.
    const p = d.periode(TAHUN_AWAL, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-02", rp(50_000_000));
    await d.buatAkad({
      sektorId: d.sektorId,
      pokok: rp(5_000_000),
      hariTunggakan: null,
      padaTanggal: p.tanggalAkhir,
      tanggalPencairan: "2026-01-05",
    });
    await baselineRka("PUMK", [
      {
        sektorId: d.sektorId,
        uraian: "Target sektor A Januari",
        bulan: 1,
        jumlahAnggaran: rp(5_000_000),
        jumlahUnit: 1,
      },
    ]);

    // Closed the way every period closed before this feature was closed: the
    // status moves and nothing is decomposed.
    await d.tutupPeriodeLangsung(p);
    expect(await d.dimensiDibekukanAt(p.id)).toBeNull();

    expect(
      await d.rka.metodeRealisasi({ periodeId: p.id, jenis: "PUMK" }, d.ctx.adminPusat as RkaContext),
    ).toBe("TIDAK_TERSEDIA");

    let kode = "";
    try {
      await laporan24("PUMK");
    } catch (err) {
      kode = (err as { kode?: string }).kode ?? "";
    }
    expect(kode).toBe("SKEMA_BELUM_LENGKAP");
  });

  test("periode sepi tetap dijawab: diuraikan, hasilnya nol, dan itu bukan penolakan", async () => {
    // The other half of the same distinction. Nothing carried a sektor in this
    // month, so the decomposition is complete and empty, and a reader that
    // treated "no rows" as "never decomposed" would refuse a quiet January
    // forever.
    const p = d.periode(TAHUN_AWAL, 1);
    d.setelJam("2026-01-20");
    await d.postingAlokasiDana("2026-01-02", rp(50_000_000));
    await d.postingBebanOperasional("2026-01-22", rp(1_000_000));
    await baselineRka("PUMK", [
      {
        sektorId: d.sektorId,
        uraian: "Target sektor A Januari",
        bulan: 1,
        jumlahAnggaran: rp(5_000_000),
        jumlahUnit: 1,
      },
    ]);

    await tutup(p);
    expect(await d.bacaDimensiBeku(p.id)).toEqual([]);
    expect(await d.dimensiDibekukanAt(p.id)).not.toBeNull();

    const hasil = await laporan24("PUMK");
    expect(hasil.sumber).toBe("1=SALDO_AKUN_PERIODE");
    // The budget line still appears, with a realisation of zero: a target with
    // no spending is the report's whole point, not a missing row.
    expect(hasil.total).toBe("0.00");
  });
});
