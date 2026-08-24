// Spec 7.4 "Simulasi Angsuran": a standalone calculator that stores nothing,
// posts nothing, and MUST use the same engine as the real generator.
//
// The last part is the whole point, and it is spec 7.5 item 11. A simulation
// that duplicates the formulas will agree with the generator on round numbers
// and disagree by a sen on the ones that matter, and the disagreement surfaces
// as a mitra binaan being quoted one instalment on the form and billed another
// on the schedule. So the identity test below compares the ENTIRE table, and
// the config-sensitivity test proves the simulation reads the same
// configuration rather than carrying its own defaults.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createAngsuranEngine,
  KODE_ANGSURAN,
  type AngsuranEngine,
  type SimulasiInput,
  type Uang,
} from "./contract";
import {
  buatDunia,
  keSen,
  periksaTotalPokok,
  porterJurnalUji,
  rp,
  sen,
  tolakDengan,
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

beforeEach(() => {
  porter.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

const DASAR: SimulasiInput = {
  pokok: rp(12_000_000),
  rate: "0.030000",
  metode: "FLAT",
  tenorBulan: 12,
  gracePeriodBulan: 0,
  tanggalMulaiAngsuran: "2026-03-10",
};

async function hitungBaris(): Promise<{ jadwal: number; versi: number; akad: number; angsuran: number }> {
  const r = await d.db.query<{ jadwal: string; versi: string; akad: string; angsuran: string }>(
    `select (select count(*) from pumk_jadwal_angsuran)::text as jadwal,
            (select count(*) from pumk_jadwal_versi)::text as versi,
            (select count(*) from pumk_akad)::text as akad,
            (select count(*) from pumk_angsuran)::text as angsuran`,
  );
  return {
    jadwal: Number(r[0].jadwal),
    versi: Number(r[0].versi),
    akad: Number(r[0].akad),
    angsuran: Number(r[0].angsuran),
  };
}

function totalJasa(baris: ReadonlyArray<{ jasaAdm: Uang }>): Uang {
  return sen(baris.reduce((acc, b) => acc + keSen(b.jasaAdm), 0n));
}

describe("spec 7.4 simulasi berdiri sendiri", () => {
  test("spec 7.4: simulasi tidak menyimpan data apa pun", async () => {
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
    await d.setelKonfigurasi("akuntansi", "jasa_grace_period", "TIDAK_DIHITUNG");
    const sebelum = await hitungBaris();

    const tabel = await engine.simulasiJadwal(DASAR, d.ctx.maker);

    expect(tabel.baris.length).toBe(12);
    // Counted across the WHOLE test database, not just this world: a
    // "simulation" that quietly writes a schedule version somewhere is the
    // failure this is watching for.
    expect(await hitungBaris()).toEqual(sebelum);
  });

  test("spec 7.4: simulasi tidak membuat jurnal", async () => {
    const tabel = await engine.simulasiJadwal(DASAR, d.ctx.maker);
    expect(tabel.baris.length).toBe(12);
    expect(porter.panggilan).toEqual([]);
  });

  test("spec 7.4: bisa dipanggil tanpa proposal dan tanpa akad, dengan ringkasan lengkap", async () => {
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
    // No akad id anywhere in the input: the calculator is reachable from the
    // public-facing form as well as from a proposal.
    const tabel = await engine.simulasiJadwal(DASAR, d.ctx.maker);

    periksaTotalPokok(tabel.baris, rp(12_000_000));
    expect(totalJasa(tabel.baris)).toBe(rp(360_000));
    expect(tabel.ringkasan).toEqual({
      totalPokok: rp(12_000_000),
      totalJasa: rp(360_000),
      totalBayar: rp(12_360_000),
      angsuranPerBulan: rp(1_030_000),
      jumlahBaris: 12,
    });
  });

  test("spec 7.4: simulasi memakai konfigurasi yang sama, bukan default sendiri", async () => {
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "1000");
    const tabel = await engine.simulasiJadwal(
      { ...DASAR, pokok: rp(10_000_000), rate: "0.037000", tenorBulan: 7 },
      d.ctx.maker,
    );
    // Same fixture as the FLAT rounding test in angsuran-jadwal.test.ts. If the
    // simulation carried its own rounding default, this table would come back
    // unrounded and this is where it would show.
    expect(tabel.baris.map((b) => [b.pokok, b.jasaAdm, b.saldoPokokSetelah])).toEqual([
      ["1428000.00", "30000.00", "8572000.00"],
      ["1428000.00", "30000.00", "7144000.00"],
      ["1428000.00", "30000.00", "5716000.00"],
      ["1428000.00", "30000.00", "4288000.00"],
      ["1428000.00", "30000.00", "2860000.00"],
      ["1428000.00", "30000.00", "1432000.00"],
      ["1432000.00", "35833.33", "0.00"],
    ]);
    expect(tabel.parameterTerpakai.pembulatan).toBe(1000);
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
  });

  test("spec 7.4: grace period ikut disimulasikan", async () => {
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
    await d.setelKonfigurasi("akuntansi", "jasa_grace_period", "TIDAK_DIHITUNG");
    const tabel = await engine.simulasiJadwal({ ...DASAR, gracePeriodBulan: 3 }, d.ctx.maker);
    expect(tabel.baris.length).toBe(15);
    expect(tabel.baris.filter((b) => b.pokok === "0.00").length).toBe(3);
    periksaTotalPokok(tabel.baris, rp(12_000_000));
  });

  test("spec 7.4: input tidak valid ditolak dengan error domain, bukan tabel kosong", async () => {
    // A calculator that answers a nonsense question with an empty table is how
    // a nonsense akad gets created from its output.
    await tolakDengan(
      engine.simulasiJadwal({ ...DASAR, tenorBulan: 0 }, d.ctx.maker),
      KODE_ANGSURAN.TENOR_TIDAK_VALID,
    );
    await tolakDengan(
      engine.simulasiJadwal({ ...DASAR, pokok: "0.00" }, d.ctx.maker),
      KODE_ANGSURAN.POKOK_TIDAK_VALID,
    );
    await tolakDengan(
      engine.simulasiJadwal({ ...DASAR, pokok: "12000000" }, d.ctx.maker),
      KODE_ANGSURAN.NILAI_BUKAN_DESIMAL,
    );
  });
});

describe("spec 7.5.11 simulasi dan jadwal riil harus identik", () => {
  // One case per method, plus a rounded case and a grace case, because
  // "identical" is easy on 12.000.000 over 12 months and only interesting where
  // the rounding remainder and the grace policy get involved.
  const kasus: Array<{ nama: string; pembulatan: "0" | "1000"; input: SimulasiInput }> = [
    { nama: "FLAT tanpa pembulatan", pembulatan: "0", input: DASAR },
    {
      nama: "FLAT dengan pembulatan 1000 dan tenor ganjil",
      pembulatan: "1000",
      input: { ...DASAR, pokok: rp(10_000_000), rate: "0.037000", tenorBulan: 7 },
    },
    { nama: "EFEKTIF", pembulatan: "0", input: { ...DASAR, metode: "EFEKTIF" } },
    { nama: "ANUITAS", pembulatan: "0", input: { ...DASAR, metode: "ANUITAS" } },
    {
      nama: "EFEKTIF dengan pembulatan 1000",
      pembulatan: "1000",
      input: { ...DASAR, pokok: rp(10_000_000), metode: "EFEKTIF" },
    },
    { nama: "FLAT dengan grace 3 bulan", pembulatan: "0", input: { ...DASAR, gracePeriodBulan: 3 } },
  ];

  for (const k of kasus) {
    test(`spec 7.5.11: ${k.nama} menghasilkan tabel identik di simulasi dan jadwal riil`, async () => {
      await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", k.pembulatan);
      await d.setelKonfigurasi("akuntansi", "jasa_grace_period", "TIDAK_DIHITUNG");

      const akad = await d.buatAkad({
        pokok: k.input.pokok,
        rate: k.input.rate,
        metode: k.input.metode,
        tenorBulan: k.input.tenorBulan,
        gracePeriodBulan: k.input.gracePeriodBulan,
        tanggalMulaiAngsuran: k.input.tanggalMulaiAngsuran,
      });

      const riil = await engine.generateJadwal({ akadId: akad.id }, d.ctx.maker);
      const simulasi = await engine.simulasiJadwal(k.input, d.ctx.maker);

      // Deep equality on the whole table, dates included. `TabelJadwal` exists
      // precisely so this comparison cannot be weakened by an id or a
      // timestamp: akadId, versi and isActiveVersion live on `Jadwal`, which
      // extends it.
      expect(simulasi.baris).toEqual(riil.baris);
      expect(simulasi.ringkasan).toEqual(riil.ringkasan);
      expect(simulasi.parameterTerpakai).toEqual(riil.parameterTerpakai);
    });
  }
});
