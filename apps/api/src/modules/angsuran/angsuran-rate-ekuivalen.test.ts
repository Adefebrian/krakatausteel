// The flat-equivalent-to-effective conversion, required by
// docs/BUILD-PLAN.md ("Tambahan: fungsi konversi 'flat yang ekuivalen dengan
// rate efektif' supaya rate flat bisa diturunkan dari 3 persen efektif, bukan
// diketik manual").
//
// WHY THIS FILE ASSERTS A MECHANIC AND NEVER A TARIFF.
// docs/REGULASI.md finding 1 reads PER-1/MBU/03/2023 pasal 22(2) as setting
// 3 percent EFEKTIF per year, or a FLAT rate equivalent to it, with tenor
// capped at 3 years, and finding 3 says the spec's "3 percent FLAT" is
// therefore not compliant as written: a flat 3 percent bills a mitra binaan
// close to twice what the regulation intends. Finding 5 adds that WHICH
// definition of "effective" applies (declining balance, annuity IRR, XIRR) is
// the client accounting team's decision and is still open.
//
// So the tests below assert three things only:
//   1. the DEFINITIONAL property: a FLAT schedule at the derived rate charges
//      exactly the same total jasa as the EFEKTIF schedule it was derived from;
//   2. the DIRECTIONAL properties that make the regulation's point arithmetic
//      rather than rhetorical (the equivalent flat rate is strictly below the
//      effective rate for any tenor beyond one month, and falls as tenor
//      lengthens);
//   3. that an undecided basis FAILS CLOSED instead of guessing.
// No test here claims that any particular rate is the correct rate.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAngsuranEngine, KODE_ANGSURAN, POLA_RATE, type AngsuranEngine, type Uang } from "./contract";
import {
  buatDunia,
  keMikro,
  keSen,
  porterJurnalUji,
  rp,
  sen,
  tolakDengan,
  tolakDenganSinkron,
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

function totalJasa(baris: ReadonlyArray<{ jasaAdm: Uang }>): Uang {
  return sen(baris.reduce((acc, b) => acc + keSen(b.jasaAdm), 0n));
}

describe("konversi rate flat ekuivalen, sifat definisi", () => {
  test("BUILD-PLAN: FLAT pada rate turunan menagih total jasa yang sama persis dengan EFEKTIF", async () => {
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
    await d.setelKonfigurasi("jasa_adm", "jasa_adm_basis_hari", "360");

    const rateEfektif = "0.030000";
    const rateFlat = engine.rateFlatEkuivalen({ rateEfektif, tenorBulan: 12 });

    // This is the definition, not a coincidence: for equal-principal declining
    // balance the total jasa is rate x pokok x (n+1) / 24, and a flat schedule
    // charges rate_flat x pokok x n / 12, so rate_flat = rate x (n+1) / (2n).
    // At n = 12 that is 3% x 13 / 24 = 1,625%, which also lands inside the
    // "1,6 to 1,7 percent" range docs/REGULASI.md computed independently.
    expect(rateFlat).toMatch(POLA_RATE);
    expect(rateFlat).toBe("0.016250");

    const efektif = await engine.simulasiJadwal(
      {
        pokok: rp(12_000_000),
        rate: rateEfektif,
        metode: "EFEKTIF",
        tenorBulan: 12,
        gracePeriodBulan: 0,
        tanggalMulaiAngsuran: "2026-03-10",
      },
      d.ctx.maker,
    );
    const flat = await engine.simulasiJadwal(
      {
        pokok: rp(12_000_000),
        rate: rateFlat,
        metode: "FLAT",
        tenorBulan: 12,
        gracePeriodBulan: 0,
        tanggalMulaiAngsuran: "2026-03-10",
      },
      d.ctx.maker,
    );

    // The property that makes the conversion worth having: identical total
    // jasa, different monthly shape. 195.000,00 either way.
    expect(totalJasa(flat.baris)).toBe(totalJasa(efektif.baris));
    expect(totalJasa(flat.baris)).toBe(rp(195_000));
    expect(flat.baris[0].jasaAdm).not.toBe(efektif.baris[0].jasaAdm);
  });

  test("konversi: rate flat ekuivalen selalu di bawah rate efektif untuk tenor lebih dari 1 bulan", () => {
    // The substantive finding of docs/REGULASI.md, expressed as arithmetic: a
    // flat rate numerically equal to the effective rate overcharges, and the
    // gap widens with tenor. At tenor 1 the two schedules are the same single
    // instalment, so the rates coincide.
    const rateEfektif = "0.030000";
    expect(engine.rateFlatEkuivalen({ rateEfektif, tenorBulan: 1 })).toBe(rateEfektif);
    for (const tenorBulan of [2, 6, 12, 24, 36]) {
      const flat = engine.rateFlatEkuivalen({ rateEfektif, tenorBulan });
      expect(keMikro(flat) < keMikro(rateEfektif)).toBe(true);
    }
  });

  test("konversi: rate flat ekuivalen turun secara monoton saat tenor memanjang", () => {
    const rateEfektif = "0.030000";
    let sebelumnya = keMikro(engine.rateFlatEkuivalen({ rateEfektif, tenorBulan: 1 }));
    for (let tenorBulan = 2; tenorBulan <= 36; tenorBulan += 1) {
      const kini = keMikro(engine.rateFlatEkuivalen({ rateEfektif, tenorBulan }));
      // Strict, and it stays strict at six decimals for every tenor up to the
      // 36-month regulatory ceiling: the step is rate/2 x 1/(n(n+1)), which at
      // n = 36 is still about 11 micro units.
      expect(kini < sebelumnya).toBe(true);
      sebelumnya = kini;
    }
  });

  test("konversi: rate flat ekuivalen naik secara monoton saat rate efektif naik", () => {
    const tenorBulan = 12;
    const hasil = ["0.010000", "0.020000", "0.030000", "0.060000"].map((r) =>
      keMikro(engine.rateFlatEkuivalen({ rateEfektif: r, tenorBulan })),
    );
    for (let i = 1; i < hasil.length; i += 1) {
      expect(hasil[i] > hasil[i - 1]).toBe(true);
    }
    // 3% x 13/24 = 1,625% and 6% x 13/24 = 3,25%: linear in the rate, which is
    // what "equivalent" means here and what makes the helper auditable.
    expect(hasil[2] * 2n).toBe(hasil[3]);
  });

  test("konversi: rate efektif nol menghasilkan rate flat nol", () => {
    expect(engine.rateFlatEkuivalen({ rateEfektif: "0.000000", tenorBulan: 12 })).toBe("0.000000");
  });
});

describe("konversi rate flat ekuivalen, penjagaan", () => {
  test("REGULASI: basis IRR_ANUITAS belum diputuskan, jadi ditolak, bukan ditebak", () => {
    // docs/REGULASI.md finding 3: the definition of "efektif" that applies is
    // the client accounting team's decision, and the wrong guess changes what
    // every mitra binaan is billed. An engine that silently picks a formula for
    // an undecided policy is worse than one that refuses.
    tolakDenganSinkron(
      () => engine.rateFlatEkuivalen({ rateEfektif: "0.030000", tenorBulan: 12, basis: "IRR_ANUITAS" }),
      KODE_ANGSURAN.BASIS_EKUIVALENSI_BELUM_DIPUTUSKAN,
    );
  });

  test("konversi: tenor tidak valid ditolak", () => {
    tolakDenganSinkron(
      () => engine.rateFlatEkuivalen({ rateEfektif: "0.030000", tenorBulan: 0 }),
      KODE_ANGSURAN.TENOR_TIDAK_VALID,
    );
  });

  test("konversi: rate yang bukan desimal enam digit ditolak", () => {
    tolakDenganSinkron(
      () => engine.rateFlatEkuivalen({ rateEfektif: "0.03", tenorBulan: 12 }),
      KODE_ANGSURAN.NILAI_BUKAN_DESIMAL,
    );
  });
});

describe("konfigurasi turunkan_flat_dari_efektif", () => {
  test("BUILD-PLAN: saat switch aktif, jadwal FLAT memakai rate turunan, bukan rate yang diketik di akad", async () => {
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
    await d.setelKonfigurasi("jasa_adm", "turunkan_flat_dari_efektif", "true");
    await d.setelKonfigurasi("jasa_adm", "rate_efektif_acuan", "0.030000");

    // The akad still carries the typed 3 percent. That is the point: the whole
    // reason the switch exists is that a flat 3 percent typed into an akad is
    // the non-compliant reading, and the engine must be able to derive the
    // compliant flat rate instead of trusting the field.
    const akad = await d.buatAkad({
      pokok: rp(12_000_000),
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 12,
      tanggalMulaiAngsuran: "2026-03-10",
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    expect(jadwal.parameterTerpakai.rate).toBe("0.016250");
    expect((await d.bacaAkad(akad.id)).jasa_adm_rate).toBe("0.030000");
    // 12jt x 1,625% x 12/12 = 195.000, which is exactly the EFEKTIF total for
    // the same akad. Half of the 360.000 a flat 3 percent would have charged.
    expect(totalJasa(jadwal.baris)).toBe(rp(195_000));
    expect(jadwal.baris[0].jasaAdm).toBe(rp(16_250));

    await d.setelKonfigurasi("jasa_adm", "turunkan_flat_dari_efektif", "false");
  });

  test("BUILD-PLAN: saat switch mati, rate akad dipakai apa adanya", async () => {
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
    await d.setelKonfigurasi("jasa_adm", "turunkan_flat_dari_efektif", "false");
    const akad = await d.buatAkad({
      pokok: rp(12_000_000),
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 12,
      tanggalMulaiAngsuran: "2026-04-10",
    });
    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);
    // Asserting the MECHANIC of the switch, in both positions. Which position
    // is correct is the client's decision, and no test here takes it.
    expect(jadwal.parameterTerpakai.rate).toBe("0.030000");
    expect(totalJasa(jadwal.baris)).toBe(rp(360_000));
  });

  test("BUILD-PLAN: switch aktif tapi rate_efektif_acuan kosong ditolak, tidak jatuh ke rate akad", async () => {
    await d.setelKonfigurasi("jasa_adm", "turunkan_flat_dari_efektif", "true");
    await d.setelKonfigurasi("jasa_adm", "rate_efektif_acuan", "");
    const akad = await d.buatAkad({
      pokok: rp(12_000_000),
      metode: "FLAT",
      tenorBulan: 12,
      tanggalMulaiAngsuran: "2026-05-10",
    });
    // A blank config cell must stop the calculation, never default to the value
    // the switch exists to override (see the header of
    // modules/konfigurasi/katalog.ts on MISSING values).
    await tolakDengan(
      engine.generateJadwal({ akadId: akad.id }, d.ctx.maker),
      KODE_ANGSURAN.KONFIGURASI_TIDAK_VALID,
    );
    await d.setelKonfigurasi("jasa_adm", "rate_efektif_acuan", "0.030000");
    await d.setelKonfigurasi("jasa_adm", "turunkan_flat_dari_efektif", "false");
  });
});
