// Spec 7.1 "Generate Jadwal": the three methods, the three non-negotiable
// rounding rules, grace period behaviour, and the due-date rule.
//
// EVERY EXPECTED NUMBER BELOW IS WRITTEN OUT IN FULL, to the sen.
// A schedule test that only asserts totals passes against a schedule with the
// right total and the wrong shape, and the shape is what a mitra binaan pays
// and what the kartu piutang shows. The arithmetic convention that produces
// these numbers (BigInt sen, truncation toward zero, floor to the rounding
// unit, whole remainder onto the last row) is pinned in the header of
// ./contract.ts; if the client's accounting team changes the convention, that
// block and these fixtures change together, on purpose.
//
// ON THE 3 PERCENT RATE. docs/REGULASI.md finding 1 records that
// PER-1/MBU/03/2023 pasal 22(2) sets 3 percent EFEKTIF, or a flat rate
// EQUIVALENT to it, and caps tenor at 3 years, so the spec's "3 percent FLAT"
// is not settled policy. Every test here therefore reads the rate from the
// akad and the method from the akad, and none of them asserts that any
// particular rate or method is CORRECT. The 3 percent figures in the fixtures
// are exercising arithmetic, not endorsing a tariff.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createAngsuranEngine,
  KODE_ANGSURAN,
  type AngsuranEngine,
  type TabelJadwal,
  type Uang,
} from "./contract";
import {
  buatDunia,
  keSen,
  periksaPembulatan,
  periksaTotalPokok,
  porterJurnalUji,
  rp,
  sen,
  tambahBulan,
  tolakDengan,
  type DuniaAngsuran,
} from "./test-support";

let d: DuniaAngsuran;
let engine: AngsuranEngine;

beforeAll(async () => {
  d = await buatDunia();
  engine = createAngsuranEngine({ db: d.db, jurnal: porterJurnalUji(d.db, d.jam), jam: d.jam });
});

afterAll(async () => {
  if (d) await d.tutup();
});

/** [pokok, jasa, total, saldo_pokok_setelah] per row. */
type Baris4 = readonly [Uang, Uang, Uang, Uang];

function angka(t: TabelJadwal): Baris4[] {
  return t.baris.map((b) => [b.pokok, b.jasaAdm, b.total, b.saldoPokokSetelah] as Baris4);
}

function tanggal(t: TabelJadwal): string[] {
  return t.baris.map((b) => b.tanggalJatuhTempo);
}

function totalJasa(t: TabelJadwal): Uang {
  return sen(t.baris.reduce((acc, b) => acc + keSen(b.jasaAdm), 0n));
}

/**
 * Every test sets the configuration it depends on, rather than trusting the
 * fixture default or the previous test's cleanup. Tests inside one file share
 * one world, so order-independence has to be built in, not hoped for.
 */
async function konfigurasi(opsi: {
  pembulatan?: "0" | "100" | "1000";
  jasaGrace?: "TIDAK_DIHITUNG" | "DIHITUNG_DITANGGUHKAN" | "DIHITUNG_DIBAYAR";
  hariTetap?: number;
  basisHari?: "360" | "365";
  turunkanFlat?: boolean;
  rateEfektifAcuan?: string;
  tenorMax?: number;
}): Promise<void> {
  await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", opsi.pembulatan ?? "0");
  await d.setelKonfigurasi("akuntansi", "jasa_grace_period", opsi.jasaGrace ?? "TIDAK_DIHITUNG");
  await d.setelKonfigurasi("angsuran", "hari_jatuh_tempo_tetap", String(opsi.hariTetap ?? 0));
  await d.setelKonfigurasi("jasa_adm", "jasa_adm_basis_hari", opsi.basisHari ?? "360");
  await d.setelKonfigurasi(
    "jasa_adm",
    "turunkan_flat_dari_efektif",
    opsi.turunkanFlat ? "true" : "false",
  );
  await d.setelKonfigurasi("jasa_adm", "rate_efektif_acuan", opsi.rateEfektifAcuan ?? "0.030000");
  await d.setelKonfigurasi("batasan", "tenor_max_bulan", String(opsi.tenorMax ?? 36));
}

describe("spec 7.1 generate jadwal, metode FLAT", () => {
  test("spec 7.1 FLAT: pokok rata, jasa pokok*rate*tenor/12, sisa pembulatan di baris terakhir", async () => {
    await konfigurasi({ pembulatan: "0" });
    const akad = await d.buatAkad({
      pokok: rp(10_000_000),
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 12,
      tanggalMulaiAngsuran: "2026-03-10",
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    // 10.000.000 / 12 = 833.333,3333... truncated to 833.333,33 for rows 1..11;
    // 11 x 833.333,33 = 9.166.666,63, so the last row carries 833.333,37.
    // Jasa: 10.000.000 x 3% x 12/12 = 300.000,00 exactly, 25.000,00 per row.
    const harapan: Baris4[] = [
      ["833333.33", "25000.00", "858333.33", "9166666.67"],
      ["833333.33", "25000.00", "858333.33", "8333333.34"],
      ["833333.33", "25000.00", "858333.33", "7500000.01"],
      ["833333.33", "25000.00", "858333.33", "6666666.68"],
      ["833333.33", "25000.00", "858333.33", "5833333.35"],
      ["833333.33", "25000.00", "858333.33", "5000000.02"],
      ["833333.33", "25000.00", "858333.33", "4166666.69"],
      ["833333.33", "25000.00", "858333.33", "3333333.36"],
      ["833333.33", "25000.00", "858333.33", "2500000.03"],
      ["833333.33", "25000.00", "858333.33", "1666666.70"],
      ["833333.33", "25000.00", "858333.33", "833333.37"],
      ["833333.37", "25000.00", "858333.37", "0.00"],
    ];
    expect(angka(jadwal)).toEqual(harapan);
    periksaTotalPokok(jadwal.baris, rp(10_000_000));
    expect(totalJasa(jadwal)).toBe(rp(300_000));
    expect(jadwal.ringkasan).toEqual({
      totalPokok: rp(10_000_000),
      totalJasa: rp(300_000),
      totalBayar: rp(10_300_000),
      angsuranPerBulan: "858333.33",
      jumlahBaris: 12,
    });
    expect(jadwal.versi).toBe(1);
    expect(jadwal.isActiveVersion).toBe(true);
    expect(jadwal.parameterTerpakai.rate).toBe("0.030000");
    expect(jadwal.parameterTerpakai.metode).toBe("FLAT");
    expect(jadwal.parameterTerpakai.pembulatan).toBe(0);
  });

  test("spec 7.1 FLAT: jadwal yang dikembalikan sama persis dengan baris yang tersimpan di database", async () => {
    await konfigurasi({ pembulatan: "0" });
    const akad = await d.buatAkad({
      pokok: rp(10_000_000),
      metode: "FLAT",
      tenorBulan: 12,
      tanggalMulaiAngsuran: "2026-04-10",
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    // The return value is not the assertion; the rows are. A schedule that is
    // correct in the response and wrong in the table is the worst outcome,
    // because the wrong one is what every later report reads.
    const tersimpan = await d.bacaJadwal(akad.id, 1);
    expect(tersimpan.map((b) => [b.pokok, b.jasa_adm, b.total, b.saldo_pokok_setelah])).toEqual(
      angka(jadwal).map((x) => [...x]),
    );
    const versi = await d.bacaVersi(akad.id);
    expect(versi).toEqual([
      { versi: 1, is_active_version: true, status: "ACTIVE", reschedule_id: null },
    ]);
  });

  test("spec 7.1 FLAT pembulatan 1000: setiap baris kelipatan 1000, selisih pokok DAN jasa penuh di baris terakhir", async () => {
    await konfigurasi({ pembulatan: "1000" });
    const akad = await d.buatAkad({
      pokok: rp(10_000_000),
      rate: "0.037000",
      metode: "FLAT",
      tenorBulan: 7,
      tanggalMulaiAngsuran: "2026-05-10",
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    // pokok/bulan = 1.428.571,42 -> floored to 1.428.000,00; 6 rows leave
    // 1.432.000,00 for the last. Target jasa = 10.000.000 x 3,7% x 7/12 =
    // 215.833,33; per row 30.833,33 -> floored to 30.000,00; 6 rows leave
    // 35.833,33, which is deliberately NOT a multiple of 1000: the rounding
    // remainder lands whole on the last row instead of being spread.
    const harapan: Baris4[] = [
      ["1428000.00", "30000.00", "1458000.00", "8572000.00"],
      ["1428000.00", "30000.00", "1458000.00", "7144000.00"],
      ["1428000.00", "30000.00", "1458000.00", "5716000.00"],
      ["1428000.00", "30000.00", "1458000.00", "4288000.00"],
      ["1428000.00", "30000.00", "1458000.00", "2860000.00"],
      ["1428000.00", "30000.00", "1458000.00", "1432000.00"],
      ["1432000.00", "35833.33", "1467833.33", "0.00"],
    ];
    expect(angka(jadwal)).toEqual(harapan);
    periksaPembulatan(jadwal.baris, 100_000n);
    periksaTotalPokok(jadwal.baris, rp(10_000_000));
    expect(totalJasa(jadwal)).toBe("215833.33");
    // Separately for pokok and for jasa: both remainders are on the last row,
    // and neither leaked into row 6.
    expect(jadwal.baris[6].pokok).not.toBe(jadwal.baris[5].pokok);
    expect(jadwal.baris[6].jasaAdm).not.toBe(jadwal.baris[5].jasaAdm);
  });
});

describe("spec 7.1 generate jadwal, metode EFEKTIF", () => {
  test("spec 7.1 EFEKTIF: jasa dihitung atas saldo pokok berjalan, angsuran pokok tetap", async () => {
    await konfigurasi({ pembulatan: "0", basisHari: "360" });
    const akad = await d.buatAkad({
      pokok: rp(12_000_000),
      rate: "0.030000",
      metode: "EFEKTIF",
      tenorBulan: 12,
      tanggalMulaiAngsuran: "2026-03-10",
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    // Monthly jasa = saldo awal x 3% x 30/360 = saldo x 0,0025. Pokok is flat
    // at 1.000.000,00 and the jasa steps down by 2.500,00 a month, which is
    // what "jasa atas saldo berjalan" means and what a FLAT schedule can never
    // produce.
    const harapan: Baris4[] = [
      ["1000000.00", "30000.00", "1030000.00", "11000000.00"],
      ["1000000.00", "27500.00", "1027500.00", "10000000.00"],
      ["1000000.00", "25000.00", "1025000.00", "9000000.00"],
      ["1000000.00", "22500.00", "1022500.00", "8000000.00"],
      ["1000000.00", "20000.00", "1020000.00", "7000000.00"],
      ["1000000.00", "17500.00", "1017500.00", "6000000.00"],
      ["1000000.00", "15000.00", "1015000.00", "5000000.00"],
      ["1000000.00", "12500.00", "1012500.00", "4000000.00"],
      ["1000000.00", "10000.00", "1010000.00", "3000000.00"],
      ["1000000.00", "7500.00", "1007500.00", "2000000.00"],
      ["1000000.00", "5000.00", "1005000.00", "1000000.00"],
      ["1000000.00", "2500.00", "1002500.00", "0.00"],
    ];
    expect(angka(jadwal)).toEqual(harapan);
    periksaTotalPokok(jadwal.baris, rp(12_000_000));
    expect(totalJasa(jadwal)).toBe(rp(195_000));
  });

  test("spec 7.1 EFEKTIF pembulatan 1000: jasa per baris dibulatkan, akumulasi selisih penuh di baris terakhir", async () => {
    await konfigurasi({ pembulatan: "1000", basisHari: "360" });
    const akad = await d.buatAkad({
      pokok: rp(10_000_000),
      rate: "0.030000",
      metode: "EFEKTIF",
      tenorBulan: 12,
      tanggalMulaiAngsuran: "2026-06-10",
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    // Jasa of row k is computed on the ROUNDED balance (saldo_pokok_setelah of
    // row k-1), so there is no shadow unrounded balance anywhere. The target
    // total is the sum of the twelve unrounded values, 162.555,00; rows 1..11
    // floored to the thousand contribute 155.000,00, so the last row carries
    // 7.555,00.
    const harapan: Baris4[] = [
      ["833000.00", "25000.00", "858000.00", "9167000.00"],
      ["833000.00", "22000.00", "855000.00", "8334000.00"],
      ["833000.00", "20000.00", "853000.00", "7501000.00"],
      ["833000.00", "18000.00", "851000.00", "6668000.00"],
      ["833000.00", "16000.00", "849000.00", "5835000.00"],
      ["833000.00", "14000.00", "847000.00", "5002000.00"],
      ["833000.00", "12000.00", "845000.00", "4169000.00"],
      ["833000.00", "10000.00", "843000.00", "3336000.00"],
      ["833000.00", "8000.00", "841000.00", "2503000.00"],
      ["833000.00", "6000.00", "839000.00", "1670000.00"],
      ["833000.00", "4000.00", "837000.00", "837000.00"],
      ["837000.00", "7555.00", "844555.00", "0.00"],
    ];
    expect(angka(jadwal)).toEqual(harapan);
    periksaPembulatan(jadwal.baris, 100_000n);
    periksaTotalPokok(jadwal.baris, rp(10_000_000));
    expect(totalJasa(jadwal)).toBe("162555.00");
  });
});

describe("spec 7.1 generate jadwal, metode ANUITAS", () => {
  test("spec 7.1 ANUITAS: total angsuran tetap, komposisi pokok naik dan jasa turun", async () => {
    await konfigurasi({ pembulatan: "0", basisHari: "360" });
    const akad = await d.buatAkad({
      pokok: rp(12_000_000),
      rate: "0.030000",
      metode: "ANUITAS",
      tenorBulan: 12,
      tanggalMulaiAngsuran: "2026-03-10",
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    // A = pokok x i / (1 - (1+i)^-n) with i = 3%/12 = 0,0025, evaluated on
    // BigInt fixed point at scale 1e12 and truncated to the sen:
    // A = 1.016.324,38. Rows 1..11 total exactly A. The last row is the
    // documented exception: its pokok is the remaining balance and its jasa is
    // the leftover of the target, so its total is 1.016.324,36, two sen under A.
    const harapan: Baris4[] = [
      ["986324.38", "30000.00", "1016324.38", "11013675.62"],
      ["988790.20", "27534.18", "1016324.38", "10024885.42"],
      ["991262.17", "25062.21", "1016324.38", "9033623.25"],
      ["993740.33", "22584.05", "1016324.38", "8039882.92"],
      ["996224.68", "20099.70", "1016324.38", "7043658.24"],
      ["998715.24", "17609.14", "1016324.38", "6044943.00"],
      ["1001212.03", "15112.35", "1016324.38", "5043730.97"],
      ["1003715.06", "12609.32", "1016324.38", "4040015.91"],
      ["1006224.35", "10100.03", "1016324.38", "3033791.56"],
      ["1008739.91", "7584.47", "1016324.38", "2025051.65"],
      ["1011261.76", "5062.62", "1016324.38", "1013789.89"],
      ["1013789.89", "2534.47", "1016324.36", "0.00"],
    ];
    expect(angka(jadwal)).toEqual(harapan);
    periksaTotalPokok(jadwal.baris, rp(12_000_000));
    expect(totalJasa(jadwal)).toBe("195892.54");

    // The method-defining properties, asserted independently of the literals
    // above so that a wrong-but-self-consistent annuity cannot pass: constant
    // instalment on rows 1..n-1, pokok strictly up, jasa strictly down.
    for (let i = 1; i < jadwal.baris.length - 1; i += 1) {
      expect(jadwal.baris[i].total).toBe(jadwal.baris[0].total);
      expect(keSen(jadwal.baris[i].pokok) > keSen(jadwal.baris[i - 1].pokok)).toBe(true);
      expect(keSen(jadwal.baris[i].jasaAdm) < keSen(jadwal.baris[i - 1].jasaAdm)).toBe(true);
    }
  });

  test("spec 7.1: untuk pokok, rate dan tenor yang sama, total jasa FLAT > ANUITAS > EFEKTIF", async () => {
    await konfigurasi({ pembulatan: "0", basisHari: "360" });
    const total: Record<string, Uang> = {};
    for (const metode of ["FLAT", "EFEKTIF", "ANUITAS"] as const) {
      const akad = await d.buatAkad({
        pokok: rp(12_000_000),
        rate: "0.030000",
        metode,
        tenorBulan: 12,
        tanggalMulaiAngsuran: "2026-07-10",
      });
      total[metode] = totalJasa(await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker));
    }
    // Not a policy claim, an arithmetic one, and the cheapest possible guard
    // against the three methods being wired to the same formula: FLAT charges
    // on the original principal for the whole tenor, ANUITAS repays principal
    // more slowly than equal instalments, EFEKTIF repays it fastest.
    expect(keSen(total.FLAT) > keSen(total.ANUITAS)).toBe(true);
    expect(keSen(total.ANUITAS) > keSen(total.EFEKTIF)).toBe(true);
  });
});

describe("spec 7.1 aturan pembulatan yang tidak bisa dinegosiasi", () => {
  test("spec 7.1: SUM(pokok) sama persis dengan pokok pinjaman untuk 3 metode x 3 pembulatan", async () => {
    // Nine combinations of the two knobs that can break the totals, all
    // asserted on the same awkward principal (10.000.001, prime-ish and not
    // divisible by 7 or by any rounding unit).
    for (const pembulatan of ["0", "100", "1000"] as const) {
      for (const metode of ["FLAT", "EFEKTIF", "ANUITAS"] as const) {
        await konfigurasi({ pembulatan });
        const akad = await d.buatAkad({
          pokok: "10000001.00",
          rate: "0.030000",
          metode,
          tenorBulan: 7,
          tanggalMulaiAngsuran: "2026-08-10",
        });
        const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);
        periksaTotalPokok(jadwal.baris, "10000001.00");
        periksaPembulatan(jadwal.baris, pembulatan === "0" ? 1n : pembulatan === "100" ? 10_000n : 100_000n);
        expect(jadwal.parameterTerpakai.pembulatan).toBe(Number(pembulatan));
      }
    }
  });

  test("spec 7.1: nilai pembulatan_angsuran di luar 0/100/1000 ditolak, bukan dipakai apa adanya", async () => {
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "250");
    const akad = await d.buatAkad({
      pokok: rp(10_000_000),
      metode: "FLAT",
      tenorBulan: 12,
      tanggalMulaiAngsuran: "2026-09-10",
    });
    // A config row an operator can type into must never silently become a
    // rounding unit nobody specified (see the header of
    // modules/konfigurasi/katalog.ts on MALFORMED values).
    await tolakDengan(
      engine.generateJadwal({ akadId: akad.id }, d.ctx.maker),
      KODE_ANGSURAN.PEMBULATAN_TIDAK_VALID,
    );
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
  });
});

describe("spec 7.1 grace period", () => {
  // DOCUMENTED CHOICE, required by spec 7.5 item 5 ("total baris 15 atau 12
  // sesuai konfigurasi, didokumentasikan mana yang dipilih"):
  // rows = grace + tenor, so grace 3 with tenor 12 gives FIFTEEN rows and
  // `tenor_bulan` keeps meaning "months of principal repayment". The two are
  // separate columns on pumk_akad, and if grace ate into tenor a 36-month akad
  // with grace would repay its principal in 33 months, which is not what a
  // 36-month akad says. The consequence, asserted below, is that grace + tenor
  // is what gets compared against `batasan.tenor_max_bulan`.
  const AKAD = {
    pokok: rp(12_000_000),
    rate: "0.030000" as const,
    metode: "FLAT" as const,
    tenorBulan: 12,
    gracePeriodBulan: 3,
  };

  test("spec 7.1 grace, jasa TIDAK_DIHITUNG: 15 baris, 3 baris pokok 0 dan jasa 0", async () => {
    await konfigurasi({ pembulatan: "0", jasaGrace: "TIDAK_DIHITUNG" });
    const akad = await d.buatAkad({ ...AKAD, tanggalMulaiAngsuran: "2026-03-10" });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    expect(jadwal.baris.length).toBe(15);
    expect(angka(jadwal).slice(0, 3)).toEqual([
      ["0.00", "0.00", "0.00", "12000000.00"],
      ["0.00", "0.00", "0.00", "12000000.00"],
      ["0.00", "0.00", "0.00", "12000000.00"],
    ]);
    // Target jasa uses the 12 tenor months only: 12jt x 3% x 12/12 = 360.000.
    expect(angka(jadwal)[3]).toEqual(["1000000.00", "30000.00", "1030000.00", "11000000.00"]);
    expect(angka(jadwal)[14]).toEqual(["1000000.00", "30000.00", "1030000.00", "0.00"]);
    periksaTotalPokok(jadwal.baris, rp(12_000_000));
    expect(totalJasa(jadwal)).toBe(rp(360_000));
    expect(jadwal.parameterTerpakai.jasaGrace).toBe("TIDAK_DIHITUNG");
  });

  test("spec 7.1 grace, jasa DIHITUNG_DIBAYAR: 3 baris pokok 0 tapi jasa tetap ditagih", async () => {
    await konfigurasi({ pembulatan: "0", jasaGrace: "DIHITUNG_DIBAYAR" });
    const akad = await d.buatAkad({ ...AKAD, tanggalMulaiAngsuran: "2026-04-10" });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    expect(jadwal.baris.length).toBe(15);
    // Target jasa now uses all 15 months: 12jt x 3% x 15/12 = 450.000, spread
    // over 15 rows at 30.000. The grace rows bill jasa and no pokok.
    expect(angka(jadwal).slice(0, 3)).toEqual([
      ["0.00", "30000.00", "30000.00", "12000000.00"],
      ["0.00", "30000.00", "30000.00", "12000000.00"],
      ["0.00", "30000.00", "30000.00", "12000000.00"],
    ]);
    expect(angka(jadwal)[3]).toEqual(["1000000.00", "30000.00", "1030000.00", "11000000.00"]);
    periksaTotalPokok(jadwal.baris, rp(12_000_000));
    expect(totalJasa(jadwal)).toBe(rp(450_000));
  });

  test("spec 7.1 grace, jasa DIHITUNG_DITANGGUHKAN: jasa masa grace ditambahkan ke baris setelah grace", async () => {
    await konfigurasi({ pembulatan: "0", jasaGrace: "DIHITUNG_DITANGGUHKAN" });
    const akad = await d.buatAkad({ ...AKAD, tanggalMulaiAngsuran: "2026-05-10" });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    expect(jadwal.baris.length).toBe(15);
    // Same 450.000 target as DIHITUNG_DIBAYAR (jasa accrues during grace), but
    // carried entirely by the 12 post-grace rows: 450.000 / 12 = 37.500.
    expect(angka(jadwal).slice(0, 3)).toEqual([
      ["0.00", "0.00", "0.00", "12000000.00"],
      ["0.00", "0.00", "0.00", "12000000.00"],
      ["0.00", "0.00", "0.00", "12000000.00"],
    ]);
    expect(angka(jadwal)[3]).toEqual(["1000000.00", "37500.00", "1037500.00", "11000000.00"]);
    expect(angka(jadwal)[14]).toEqual(["1000000.00", "37500.00", "1037500.00", "0.00"]);
    periksaTotalPokok(jadwal.baris, rp(12_000_000));
    expect(totalJasa(jadwal)).toBe(rp(450_000));
  });

  test("spec 7.1 + BUILD-PLAN: grace + tenor di atas batasan.tenor_max_bulan ditolak", async () => {
    // docs/BUILD-PLAN.md: 36 months is the regulatory ceiling of
    // PER-1/MBU/03/2023 pasal 22(2), not a preference, so it is rejected
    // server-side. The BOUND still comes from konfigurasi, which is what this
    // asserts: 30 + 6 fits under 36 and passes, the same akad fails once the
    // configured ceiling drops to 30.
    await konfigurasi({ pembulatan: "0", tenorMax: 30 });
    const akad = await d.buatAkad({
      pokok: rp(12_000_000),
      metode: "FLAT",
      tenorBulan: 30,
      gracePeriodBulan: 6,
      tanggalMulaiAngsuran: "2026-06-10",
    });
    await tolakDengan(
      engine.generateJadwal({ akadId: akad.id }, d.ctx.maker),
      KODE_ANGSURAN.TENOR_DILUAR_BATAS,
    );
    await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
  });
});

describe("spec 7.1 tanggal jatuh tempo", () => {
  test("spec 7.1: default tanggal yang sama setiap bulan", async () => {
    await konfigurasi({ pembulatan: "0", hariTetap: 0 });
    const akad = await d.buatAkad({
      pokok: rp(4_000_000),
      metode: "FLAT",
      tenorBulan: 4,
      tanggalMulaiAngsuran: "2026-11-15",
    });
    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);
    // Crosses a year boundary, which is where naive month arithmetic breaks.
    expect(tanggal(jadwal)).toEqual(["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15"]);
  });

  test("spec 7.1: tanggal 31 yang tidak ada di bulan pendek jatuh ke hari terakhir, lalu KEMBALI ke 31", async () => {
    await konfigurasi({ pembulatan: "0", hariTetap: 0 });
    const akad = await d.buatAkad({
      pokok: rp(4_000_000),
      metode: "FLAT",
      tenorBulan: 4,
      tanggalMulaiAngsuran: "2027-01-31",
    });
    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);
    // THE BUG THIS EXISTS TO CATCH: anchoring each due date on the PREVIOUS
    // row's date instead of on the akad's day-of-month. That implementation
    // gives 31 Jan, 28 Feb, 28 Mar, 28 Apr, and every later instalment of the
    // loan is on the wrong day. The anchor is the day-of-month, always.
    expect(tanggal(jadwal)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  });

  test("spec 7.1: tahun kabisat, 31 Januari 2028 jatuh ke 29 Februari 2028", async () => {
    await konfigurasi({ pembulatan: "0", hariTetap: 0 });
    const akad = await d.buatAkad({
      pokok: rp(3_000_000),
      metode: "FLAT",
      tenorBulan: 3,
      tanggalMulaiAngsuran: "2028-01-31",
      tanggalAkad: "2027-12-20",
    });
    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);
    expect(tanggal(jadwal)).toEqual(["2028-01-31", "2028-02-29", "2028-03-31"]);
  });

  test("spec 7.1: opsi hari jatuh tempo tetap menggeser semua tanggal ke hari itu", async () => {
    await konfigurasi({ pembulatan: "0", hariTetap: 25 });
    const akad = await d.buatAkad({
      pokok: rp(3_000_000),
      metode: "FLAT",
      tenorBulan: 3,
      tanggalMulaiAngsuran: "2027-01-10",
    });
    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);
    expect(tanggal(jadwal)).toEqual(["2027-01-25", "2027-02-25", "2027-03-25"]);
    expect(jadwal.parameterTerpakai.hariJatuhTempoTetap).toBe(25);
  });

  test("spec 7.1: hari jatuh tempo tetap 31 tetap tunduk pada aturan hari terakhir bulan", async () => {
    await konfigurasi({ pembulatan: "0", hariTetap: 31 });
    const akad = await d.buatAkad({
      pokok: rp(3_000_000),
      metode: "FLAT",
      tenorBulan: 3,
      tanggalMulaiAngsuran: "2027-01-10",
    });
    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);
    // The two rules compose; the fixed day does not get to bypass the clamp.
    expect(tanggal(jadwal)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
    await d.setelKonfigurasi("angsuran", "hari_jatuh_tempo_tetap", "0");
  });
});

describe("spec 7.1 penjagaan generate jadwal", () => {
  test("spec 7.1 + invarian 8: generate kedua untuk akad yang sudah punya jadwal ditolak", async () => {
    await konfigurasi({ pembulatan: "0" });
    const akad = await d.buatAkad({
      pokok: rp(6_000_000),
      metode: "FLAT",
      tenorBulan: 6,
      tanggalMulaiAngsuran: "2026-10-10",
    });
    // A hand-built version 1 stands in for "already generated", so this test
    // does not depend on generateJadwal succeeding first.
    await d.pasangJadwal(
      akad.id,
      1,
      Array.from({ length: 6 }, (_, i) => ({
        angsuranKe: i + 1,
        tanggalJatuhTempo: tambahBulan("2026-10-10", i),
        pokok: rp(1_000_000),
        jasaAdm: rp(15_000),
        saldoPokokSetelah: rp(6_000_000 - 1_000_000 * (i + 1)),
      })),
    );
    // Invariant 8: a generated schedule is immutable, so the only legal way to
    // a different schedule is a reschedule that creates a new version.
    await tolakDengan(
      engine.generateJadwal({ akadId: akad.id }, d.ctx.maker),
      KODE_ANGSURAN.JADWAL_SUDAH_ADA,
    );
  });

  test("spec 7.1: akad yang tidak ada ditolak dengan error domain, bukan crash driver", async () => {
    await tolakDengan(
      engine.generateJadwal({ akadId: "00000000-0000-0000-0000-000000000000" }, d.ctx.maker),
      KODE_ANGSURAN.AKAD_TIDAK_DITEMUKAN,
    );
  });

  test("spec 2: user tanpa permission pumk.akad tidak boleh generate jadwal", async () => {
    await konfigurasi({ pembulatan: "0" });
    const akad = await d.buatAkad({
      pokok: rp(6_000_000),
      metode: "FLAT",
      tenorBulan: 6,
      tanggalMulaiAngsuran: "2026-12-10",
    });
    // Spec 2: "Sistem harus menolak, bukan hanya menyembunyikan tombol."
    await tolakDengan(
      engine.generateJadwal({ akadId: akad.id }, d.ctx.auditor),
      KODE_ANGSURAN.TIDAK_BERWENANG,
    );
  });
});
