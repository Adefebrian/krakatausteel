// Spec 7.5 "Test wajib untuk engine angsuran", all twelve, one test each, in
// the order the spec lists them, named so a failing line names the spec item.
//
// These are the twelve the spec itself demands. The deeper behaviour of each
// engine surface lives in the sibling files (angsuran-jadwal, angsuran-alokasi,
// angsuran-reschedule, angsuran-simulasi, angsuran-rate-ekuivalen); this file
// is the checklist, kept literal so it can be read against the spec line by
// line without cross-referencing anything.
//
// ON ITEM 1 AND THE 3 PERCENT QUESTION. docs/REGULASI.md finding 1 records that
// PER-1/MBU/03/2023 pasal 22(2) sets 3 percent EFEKTIF per year, or a flat rate
// equivalent to it, so the spec's flat 3 percent is one reading and not settled
// policy. docs/BUILD-PLAN.md resolves the tension explicitly: "Test fixture
// spec 7.5 nomor 1 tetap dipakai sebagai test metode FLAT, bukan sebagai klaim
// kepatuhan." Item 1 below is therefore written exactly as the spec states it,
// as a test OF FLAT ARITHMETIC, with the rate and the method read from the
// akad. Nothing in this file asserts that flat 3 percent is the correct tariff.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createAngsuranEngine,
  type AngsuranEngine,
  type MetodePerhitungan,
  type Uang,
} from "./contract";
import {
  acak,
  buatDunia,
  jumlahUang,
  keSen,
  periksaTotalPokok,
  porterJurnalUji,
  rp,
  sen,
  tambahBulan,
  type AkadFixture,
  type DuniaAngsuran,
  type PorterUji,
} from "./test-support";

let d: DuniaAngsuran;
let engine: AngsuranEngine;
let porter: PorterUji;

beforeAll(async () => {
  d = await buatDunia();
  porter = porterJurnalUji(d.db, d.jam);
  engine = createAngsuranEngine({ db: d.db, jurnal: porter, jam: d.jam });
});

beforeEach(async () => {
  porter.reset();
  // Every test states the configuration it depends on, so no test can be
  // perturbed by the one before it.
  await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
  await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
  await d.setelKonfigurasi("angsuran", "hari_jatuh_tempo_tetap", "0");
  await d.setelKonfigurasi("akuntansi", "jasa_grace_period", "TIDAK_DIHITUNG");
  await d.setelKonfigurasi("jasa_adm", "turunkan_flat_dari_efektif", "false");
  await d.setelKonfigurasi("batasan", "plafon_min_pumk", "1000000.00");
  await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
});

afterAll(async () => {
  if (d) await d.tutup();
});

function totalJasa(baris: ReadonlyArray<{ jasaAdm: Uang }>): Uang {
  return sen(baris.reduce((acc, b) => acc + keSen(b.jasaAdm), 0n));
}

/** The 12 x (1.000.000 + 30.000) schedule used by items 6 to 10. */
const MULAI = "2026-03-10";
async function akadSiapAngsur(): Promise<AkadFixture> {
  const akad = await d.buatAkad({
    pokok: rp(12_000_000),
    rate: "0.030000",
    metode: "FLAT",
    tenorBulan: 12,
    tanggalMulaiAngsuran: MULAI,
  });
  await d.cairkan(akad.id, rp(12_000_000), rp(360_000));
  await d.pasangJadwal(
    akad.id,
    1,
    Array.from({ length: 12 }, (_, i) => ({
      angsuranKe: i + 1,
      tanggalJatuhTempo: tambahBulan(MULAI, i),
      pokok: rp(1_000_000),
      jasaAdm: rp(30_000),
      saldoPokokSetelah: rp(12_000_000 - 1_000_000 * (i + 1)),
    })),
  );
  return akad;
}

describe("spec 7.5 test wajib engine angsuran", () => {
  test("spec 7.5.1 pokok 10.000.000 rate 3 persen tenor 12 FLAT: total pokok 10.000.000 persis, jasa total 300.000", async () => {
    const akad = await d.buatAkad({
      pokok: rp(10_000_000),
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 12,
      tanggalMulaiAngsuran: MULAI,
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    // Invariant 9 and spec 7.1: exact, no tolerance.
    periksaTotalPokok(jadwal.baris, rp(10_000_000));
    expect(totalJasa(jadwal.baris)).toBe(rp(300_000));
    expect(jadwal.baris.length).toBe(12);
    // The rate and method came from the akad row, which is what makes this a
    // test of FLAT arithmetic rather than of a tariff (see the file header).
    expect(jadwal.parameterTerpakai.rate).toBe("0.030000");
    expect(jadwal.parameterTerpakai.metode).toBe("FLAT");
  });

  test("spec 7.5.2 pokok 10.000.000 tenor 7 (pembulatan tidak rata): total pokok tetap 10.000.000 persis", async () => {
    const akad = await d.buatAkad({
      pokok: rp(10_000_000),
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 7,
      tanggalMulaiAngsuran: MULAI,
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    // 10.000.000 / 7 = 1.428.571,428..., so six rows of 1.428.571,42 and a last
    // row of 1.428.571,48. The remainder of 6 sen is on the last row and
    // nowhere else.
    periksaTotalPokok(jadwal.baris, rp(10_000_000));
    expect(jadwal.baris.slice(0, 6).every((b) => b.pokok === "1428571.42")).toBe(true);
    expect(jadwal.baris[6].pokok).toBe("1428571.48");
  });

  test("spec 7.5.3 pokok 1 rupiah tenor 12: tidak crash, total tetap 1", async () => {
    // The plafon floor is lowered for this test only. Spec 7.5 item 3 is an
    // arithmetic edge case (does the engine survive an amount smaller than its
    // own rounding remainders), not a claim that a 1 rupiah loan is allowed.
    await d.setelKonfigurasi("batasan", "plafon_min_pumk", "1.00");
    const akad = await d.buatAkad({
      pokok: "1.00",
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 12,
      tanggalMulaiAngsuran: MULAI,
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    // 100 sen over 12 rows: 8 sen each for rows 1..11 (truncated from 8,33),
    // leaving 12 sen on the last. Jasa is 3 sen in total, 3/12 = 0,25 sen per
    // row which truncates to nothing, so the whole 3 sen lands on the last row
    // too. Every row is still a legal NUMERIC(20,2) and no row is negative.
    expect(jadwal.baris.length).toBe(12);
    expect(jadwal.baris.slice(0, 11).map((b) => [b.pokok, b.jasaAdm, b.total])).toEqual(
      Array.from({ length: 11 }, () => ["0.08", "0.00", "0.08"]),
    );
    expect([
      jadwal.baris[11].pokok,
      jadwal.baris[11].jasaAdm,
      jadwal.baris[11].total,
      jadwal.baris[11].saldoPokokSetelah,
    ]).toEqual(["0.12", "0.03", "0.15", "0.00"]);
    periksaTotalPokok(jadwal.baris, "1.00");
    expect(totalJasa(jadwal.baris)).toBe("0.03");
    // A schedule of twelve zero rows plus one 1,00 row would also sum to 1,00.
    // It is not what truncation gives, and asserting the table rules it out.
    expect(jadwal.baris.filter((b) => b.pokok === "0.00").length).toBe(0);
  });

  test("spec 7.5.4 saldo_pokok_setelah baris terakhir selalu 0 untuk 500 kombinasi random pokok dan tenor (seed 20260823)", async () => {
    // Deterministic PRNG, seed in the test name: a failure reproduces exactly,
    // and the thrown message carries the offending combination so it can be
    // pasted straight into a focused test.
    const SEED = 20260823;
    const rnd = acak(SEED);
    const metodeSet: MetodePerhitungan[] = ["FLAT", "EFEKTIF", "ANUITAS"];
    // Run through simulasiJadwal, not generateJadwal: spec 7.5 item 11 makes
    // the two tables identical by construction, and 500 persisted schedules
    // would mean 500 akad rows and 500 mitra for no extra coverage.
    const pembagian: Array<["0" | "100" | "1000", number]> = [
      ["0", 167],
      ["100", 167],
      ["1000", 166],
    ];
    let dijalankan = 0;
    for (const [pembulatan, banyak] of pembagian) {
      await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", pembulatan);
      for (let i = 0; i < banyak; i += 1) {
        // 1.000,00 up to 250.000.000,00, in sen, so principals that are not a
        // whole rupiah are in scope too.
        const pokok = sen(BigInt(Math.floor(rnd() * 25_000_000_000) + 100_000));
        const tenorBulan = Math.floor(rnd() * 36) + 1;
        const metode = metodeSet[Math.floor(rnd() * 3)];
        const tabel = await engine.simulasiJadwal(
          { pokok, rate: "0.030000", metode, tenorBulan, gracePeriodBulan: 0, tanggalMulaiAngsuran: MULAI },
          d.ctx.maker,
        );
        dijalankan += 1;
        const jumlah = sen(tabel.baris.reduce((acc, b) => acc + keSen(b.pokok), 0n));
        const terakhir = tabel.baris[tabel.baris.length - 1];
        const adaNegatif = tabel.baris.some(
          (b) => keSen(b.pokok) < 0n || keSen(b.jasaAdm) < 0n || keSen(b.saldoPokokSetelah) < 0n,
        );
        if (
          tabel.baris.length !== tenorBulan ||
          jumlah !== pokok ||
          terakhir.saldoPokokSetelah !== "0.00" ||
          adaNegatif
        ) {
          throw new Error(
            `spec 7.5.4 gagal pada iterasi ${i} (seed ${SEED}): pokok=${pokok} tenor=${tenorBulan} ` +
              `metode=${metode} pembulatan=${pembulatan} baris=${tabel.baris.length} ` +
              `sumPokok=${jumlah} saldoTerakhir=${terakhir.saldoPokokSetelah} adaNegatif=${adaNegatif}`,
          );
        }
      }
    }
    expect(dijalankan).toBe(500);
  });

  test("spec 7.5.5 grace 3 bulan tenor 12: ada 3 baris pokok 0, total baris 15 (pilihan yang didokumentasikan)", async () => {
    // DOCUMENTED CHOICE: rows = grace + tenor = 15, not 12. `tenor_bulan` keeps
    // meaning "months of principal repayment", which is what makes
    // grace + tenor the quantity compared against batasan.tenor_max_bulan (the
    // 36-month regulatory ceiling in docs/BUILD-PLAN.md). Same choice is
    // stated at angsuran-jadwal.test.ts and in ./contract.ts.
    const akad = await d.buatAkad({
      pokok: rp(12_000_000),
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 12,
      gracePeriodBulan: 3,
      tanggalMulaiAngsuran: MULAI,
    });

    const jadwal = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);

    expect(jadwal.baris.length).toBe(15);
    expect(jadwal.baris.filter((b) => b.pokok === "0.00").length).toBe(3);
    expect(jadwal.baris.slice(0, 3).every((b) => b.pokok === "0.00")).toBe(true);
    expect(jadwal.baris[3].pokok).toBe(rp(1_000_000));
    periksaTotalPokok(jadwal.baris, rp(12_000_000));
    // Jasa during grace follows konfigurasi akuntansi.jasa_grace_period, whose
    // default is contested (spec 7.1 says "jasa dibayar", ASSUMPTIONS.md A-05
    // and migrations/0004 say TIDAK_DIHITUNG). This test SETS the policy in its
    // beforeEach and asserts the consequence; it does not assert a default.
    expect(jadwal.parameterTerpakai.jasaGrace).toBe("TIDAK_DIHITUNG");
    expect(jadwal.baris.slice(0, 3).every((b) => b.jasaAdm === "0.00")).toBe(true);
  });

  test("spec 7.5.6 setoran tepat sebesar satu angsuran melunasi tepat satu baris", async () => {
    const akad = await akadSiapAngsur();

    await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: rp(1_030_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    const baris = await d.bacaJadwal(akad.id, 1);
    expect(baris.filter((b) => b.status === "LUNAS").length).toBe(1);
    expect(baris[0].status).toBe("LUNAS");
    expect(baris[0].pokok_terbayar).toBe(rp(1_000_000));
    expect(baris[0].jasa_terbayar).toBe(rp(30_000));
    expect(baris[1].pokok_terbayar).toBe("0.00");
  });

  test("spec 7.5.7 setoran lebih besar dari total kewajiban menghasilkan Kelebihan Pembayaran, bukan piutang negatif", async () => {
    const akad = await akadSiapAngsur();

    // Obligation is 12.360.000,00; the deposit is 12.500.000,00.
    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2027-02-10", jumlah: rp(12_500_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiKelebihan).toBe(rp(140_000));
    const kelebihan = await d.bacaKelebihan(akad.id);
    expect(kelebihan.length).toBe(1);
    expect(kelebihan[0].jumlah).toBe(rp(140_000));
    // Invariant 10, stated as the spec states it: the receivable stops at zero.
    const akadDb = await d.bacaAkad(akad.id);
    expect(akadDb.outstanding_pokok).toBe("0.00");
    expect(akadDb.outstanding_jasa).toBe("0.00");
    expect(keSen(akadDb.outstanding_pokok) >= 0n).toBe(true);
  });

  test("spec 7.5.8 setoran sebagian membuat baris berstatus SEBAGIAN dengan angka terbayar yang benar", async () => {
    const akad = await akadSiapAngsur();

    await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: rp(500_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    // DEFAULT preset: 30.000 of jasa, then 470.000 of pokok, all on row 1.
    const baris = await d.bacaJadwal(akad.id, 1);
    expect(baris[0].status).toBe("SEBAGIAN");
    expect(baris[0].jasa_terbayar).toBe(rp(30_000));
    expect(baris[0].pokok_terbayar).toBe(rp(470_000));
    expect(baris[0].tanggal_lunas).toBeNull();
    expect(jumlahUang(baris[0].pokok_terbayar, baris[0].jasa_terbayar)).toBe(rp(500_000));
  });

  test("spec 7.5.9 setelah semua baris lunas, akad otomatis LUNAS", async () => {
    const akad = await akadSiapAngsur();

    // Twelve instalments paid on their due dates, one call each, which is how
    // this actually happens in production.
    for (let i = 0; i < 12; i += 1) {
      const tanggal = tambahBulan(MULAI, i);
      const hasil = await engine.alokasikanSetoran(
        { akadId: akad.id, tanggal, jumlah: rp(1_030_000), akunKasId: d.akun.kas.id },
        d.ctx.maker,
      );
      // The flip happens on the LAST one and not before: an akad that goes
      // LUNAS early stops appearing in the receivables list while it is still
      // owed money.
      expect(hasil.akadSetelah.status).toBe(i === 11 ? "LUNAS" : "AKTIF");
    }

    const akadDb = await d.bacaAkad(akad.id);
    expect(akadDb.status).toBe("LUNAS");
    expect(akadDb.outstanding_pokok).toBe("0.00");
    expect(akadDb.outstanding_jasa).toBe("0.00");
    expect(akadDb.tanggal_lunas).toBe("2027-02-10");
    const baris = await d.bacaJadwal(akad.id, 1);
    expect(baris.every((b) => b.status === "LUNAS")).toBe(true);
    expect(await d.bacaKelebihan(akad.id)).toEqual([]);
  });

  test("spec 7.5.10 reschedule di tengah tenor: total pokok terbayar historis + outstanding baru = pokok asli", async () => {
    const akad = await akadSiapAngsur();
    // Three instalments paid, then a reschedule to 18 months.
    for (let i = 0; i < 3; i += 1) {
      await engine.alokasikanSetoran(
        { akadId: akad.id, tanggal: tambahBulan(MULAI, i), jumlah: rp(1_030_000), akunKasId: d.akun.kas.id },
        d.ctx.maker,
      );
    }
    const reschedule = await engine.ajukanReschedule(
      {
        akadId: akad.id,
        tanggalPengajuan: "2026-06-20",
        alasan: "Omzet usaha mitra turun",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: 18,
      },
      d.ctx.maker,
    );

    const hasil = await engine.setujuiReschedule(reschedule.id, d.ctx.approver);

    expect(hasil.pokokTerbayarHistoris).toBe(rp(3_000_000));
    expect(hasil.outstandingBaru).toBe(rp(9_000_000));
    expect(jumlahUang(hasil.pokokTerbayarHistoris, hasil.outstandingBaru)).toBe(rp(12_000_000));
    // And the new version's principal really is that outstanding, not the
    // original loan restarted.
    expect(hasil.jadwalBaru.ringkasan.totalPokok).toBe(rp(9_000_000));
    periksaTotalPokok(hasil.jadwalBaru.baris, rp(9_000_000));
  });

  test("spec 7.5.11 simulasi dan jadwal riil dengan input identik menghasilkan tabel identik", async () => {
    const parameter = {
      pokok: rp(10_000_000),
      rate: "0.030000",
      metode: "FLAT" as const,
      tenorBulan: 7,
      gracePeriodBulan: 0,
      tanggalMulaiAngsuran: MULAI,
    };
    const akad = await d.buatAkad(parameter);

    const riil = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);
    const simulasi = await engine.simulasiJadwal(parameter, d.ctx.maker);

    // Tenor 7 on purpose: the rounding remainder is where a duplicated formula
    // and the real one part company.
    expect(simulasi.baris).toEqual(riil.baris);
    expect(simulasi.ringkasan).toEqual(riil.ringkasan);
    expect(simulasi.parameterTerpakai).toEqual(riil.parameterTerpakai);
  });

  test("spec 7.5.12 jatuh tempo tanggal 31 di bulan Februari jatuh ke 28 atau 29 dengan benar", async () => {
    // Non-leap: February 2027 has 28 days. Note row 3 goes back to the 31st;
    // the day-of-month anchor is the akad's, never the previous row's.
    const biasa = await d.buatAkad({
      pokok: rp(4_000_000),
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 4,
      tanggalMulaiAngsuran: "2027-01-31",
    });
    const jadwalBiasa = await engine.generateJadwal({ akadId: biasa.id }, d.ctx.maker);
    expect(jadwalBiasa.baris.map((b) => b.tanggalJatuhTempo)).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);

    // Leap: February 2028 has 29.
    const kabisat = await d.buatAkad({
      pokok: rp(3_000_000),
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 3,
      tanggalMulaiAngsuran: "2028-01-31",
      tanggalAkad: "2027-12-20",
    });
    const jadwalKabisat = await engine.generateJadwal({ akadId: kabisat.id }, d.ctx.maker);
    expect(jadwalKabisat.baris.map((b) => b.tanggalJatuhTempo)).toEqual([
      "2028-01-31",
      "2028-02-29",
      "2028-03-31",
    ]);
  });
});
