// Document-number generator tests.
//
// Spec 4.10: "Harus aman dari race condition (pakai row lock atau sequence per
// kombinasi)." The load test below is the point of this file: 40 concurrent
// allocations against one counter row must produce 40 distinct numbers with no
// gaps. A gap in an official document series is a question an auditor asks, so
// uniqueness alone is not enough.
import { afterAll, describe, expect, test } from "bun:test";
import { createDbAdapter } from "../../core/adapters/db";
import { createFixture, tutupSemuaFixture } from "../../testing/harness";
import { DEFAULT_FORMAT_TEMPLATE, bulanRomawi, formatNomor } from "./format";
import { createNomorService } from "./service";

// Fixture teardown, one call for the whole file. Every `createFixture` in here
// registers itself; this closes them all. Nothing else in this file changed.
// See the FIXTURE LEAK note in apps/api/src/testing/harness.ts.
afterAll(tutupSemuaFixture);

const db = createDbAdapter();
const nomor = createNomorService({ db });

const KONTEKS = {
  urutan: 7,
  tahun: 2026,
  bulan: 8,
  jenisDokumen: "PUMK",
  kodeCabang: "CLG",
  kodeBumn: "KRAS",
};

describe("formatNomor (pure)", () => {
  test("renders the default template the way Indonesian document numbers read", () => {
    expect(formatNomor(DEFAULT_FORMAT_TEMPLATE, KONTEKS)).toBe("0007/PUMK/CLG/VIII/2026");
  });

  test("supports padding, two-digit years, numeric months and both codes", () => {
    expect(formatNomor("{jenis}-{tahun2}{bulan}-{urutan:6}", KONTEKS)).toBe("PUMK-2608-000007");
    expect(formatNomor("{kode_bumn}/{kode_cabang}/{urutan}", KONTEKS)).toBe("KRAS/CLG/7");
    expect(formatNomor("{urutan:2}", { ...KONTEKS, urutan: 1234 })).toBe("1234");
  });

  test("roman months, all twelve", () => {
    expect([...Array(12).keys()].map((i) => bulanRomawi(i + 1))).toEqual([
      "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII",
    ]);
    expect(() => bulanRomawi(13)).toThrow();
  });

  test("collapses the empty branch slot of a pusat-level series", () => {
    expect(formatNomor(DEFAULT_FORMAT_TEMPLATE, { ...KONTEKS, kodeCabang: "" })).toBe("0007/PUMK/VIII/2026");
  });

  test("an unknown placeholder is an error, not an empty string", () => {
    // Otherwise a typo in a template an operator edited starts producing
    // document numbers with a hole where the sequence should be.
    expect(() => formatNomor("{urutann:4}/PUMK", KONTEKS)).toThrow(/tidak dikenal/);
  });

  test("a template with no sequence placeholder is an error", () => {
    // Every document would get the same number.
    expect(() => formatNomor("PUMK/{tahun}", KONTEKS)).toThrow(/tidak memuat \{urutan\}/);
    expect(() => formatNomor("", KONTEKS)).toThrow();
  });

  test("a month placeholder on a yearly series is an error, not a blank", () => {
    expect(() => formatNomor("{urutan:4}/{bulan}", { ...KONTEKS, bulan: null })).toThrow(/tidak punya bulan/);
    expect(() => formatNomor("{urutan:4}/{bulan_romawi}", { ...KONTEKS, bulan: null })).toThrow(
      /tidak punya bulan/,
    );
    // A yearly series with a yearly template is fine.
    expect(formatNomor("{urutan:4}/{jenis}/{tahun}", { ...KONTEKS, bulan: null })).toBe("0007/PUMK/2026");
  });
});

describe("allocation", () => {
  test("numbers a series 1, 2, 3 with the row's own template", async () => {
    const f = await createFixture();
    const key = {
      bumnId: f.bumnId,
      cabangId: f.cabangA.id,
      jenisDokumen: "PUMK",
      tahun: 2026,
      bulan: 8,
    };
    const first = await nomor.generate({ ...key, kodeCabang: f.cabangA.kode, kodeBumn: "T" });
    const second = await nomor.generate({ ...key, kodeCabang: f.cabangA.kode, kodeBumn: "T" });
    expect(first.urutan).toBe(1);
    expect(second.urutan).toBe(2);
    expect(first.nomor).toBe(`0001/PUMK/${f.cabangA.kode}/VIII/2026`);
    expect(second.nomor).toBe(`0002/PUMK/${f.cabangA.kode}/VIII/2026`);
  });

  test("each (cabang, jenis, tahun, bulan) combination is its own series", async () => {
    const f = await createFixture();
    const base = { bumnId: f.bumnId, jenisDokumen: "AKAD", tahun: 2026, bulan: 8 };
    const a1 = await nomor.generate({ ...base, cabangId: f.cabangA.id, kodeCabang: "01" });
    const b1 = await nomor.generate({ ...base, cabangId: f.cabangB.id, kodeCabang: "02" });
    const a2 = await nomor.generate({ ...base, cabangId: f.cabangA.id, kodeCabang: "01" });
    // Branch B starts at 1 of its own accord.
    expect([a1.urutan, a2.urutan]).toEqual([1, 2]);
    expect(b1.urutan).toBe(1);

    // A different month, a different jenis and a pusat-level series are all
    // separate counters too.
    expect((await nomor.generate({ ...base, bulan: 9, cabangId: f.cabangA.id, kodeCabang: "01" })).urutan).toBe(1);
    expect(
      (await nomor.generate({ ...base, jenisDokumen: "CAIR", cabangId: f.cabangA.id, kodeCabang: "01" })).urutan,
    ).toBe(1);
    expect((await nomor.generate({ ...base, cabangId: null })).urutan).toBe(1);
  });

  test("a yearly series (bulan null) does not reset monthly", async () => {
    const f = await createFixture();
    const key = {
      bumnId: f.bumnId,
      cabangId: f.cabangA.id,
      jenisDokumen: "SK",
      tahun: 2026,
      bulan: null,
      formatTemplate: "{urutan:3}/SK/{tahun}",
    };
    expect((await nomor.generate(key)).nomor).toBe("001/SK/2026");
    expect((await nomor.generate(key)).nomor).toBe("002/SK/2026");
  });

  test("validates the series key before touching the database", async () => {
    const f = await createFixture();
    const base = { bumnId: f.bumnId, cabangId: f.cabangA.id, tahun: 2026, bulan: 8 };
    await expect(nomor.generate({ ...base, jenisDokumen: "pumk lower" })).rejects.toThrow(/jenis_dokumen/);
    await expect(nomor.generate({ ...base, jenisDokumen: "PUMK", tahun: 1800 })).rejects.toThrow(/tahun/);
    await expect(nomor.generate({ ...base, jenisDokumen: "PUMK", bulan: 13 })).rejects.toThrow(/bulan/);
  });

  test("a bad template fails BEFORE a counter row is created or a number burned", async () => {
    const f = await createFixture();
    const key = {
      bumnId: f.bumnId,
      cabangId: f.cabangA.id,
      jenisDokumen: "BADTPL",
      tahun: 2026,
      bulan: 8,
      formatTemplate: "{tidakdikenal}/{urutan}",
    };
    await expect(nomor.generate(key)).rejects.toThrow(/tidak dikenal/);
    expect(await nomor.peek({ ...key })).toBeNull();
  });

  test("peek reports the counter without consuming a number", async () => {
    const f = await createFixture();
    const key = {
      bumnId: f.bumnId,
      cabangId: f.cabangA.id,
      jenisDokumen: "PEEK",
      tahun: 2026,
      bulan: 8,
    };
    expect(await nomor.peek(key)).toBeNull();
    await nomor.generate(key);
    expect(await nomor.peek(key)).toBe(1);
    expect(await nomor.peek(key)).toBe(1);
  });
});

describe("transaction behaviour", () => {
  test("joining the caller's transaction means a rolled-back document burns no number", async () => {
    const f = await createFixture();
    const key = {
      bumnId: f.bumnId,
      cabangId: f.cabangA.id,
      jenisDokumen: "ROLLBACK",
      tahun: 2026,
      bulan: 8,
    };
    await nomor.generate(key); // 1, committed

    await db
      .transaction(async (tx) => {
        const taken = await nomor.generate(key, { tx });
        expect(taken.urutan).toBe(2);
        throw new Error("dokumen gagal disimpan");
      })
      .catch(() => {});

    // The number went back with the document, so the next allocation reuses it.
    expect(await nomor.peek(key)).toBe(1);
    expect((await nomor.generate(key)).urutan).toBe(2);
  });
});

describe("concurrency (spec 4.10: aman dari race condition)", () => {
  test("40 parallel allocations produce zero duplicates and no gaps", async () => {
    const f = await createFixture();
    const key = {
      bumnId: f.bumnId,
      cabangId: f.cabangA.id,
      jenisDokumen: "PARALEL",
      tahun: 2026,
      bulan: 8,
      kodeCabang: f.cabangA.kode,
    };

    const COUNT = 40;
    const results = await Promise.all(
      Array.from({ length: COUNT }, () => nomor.generate(key)),
    );

    const urutan = results.map((r) => r.urutan).sort((a, b) => a - b);
    // Unique...
    expect(new Set(urutan).size).toBe(COUNT);
    // ...and contiguous 1..COUNT, which is the property a sequence would NOT
    // give (nextval is not rolled back, so gaps are guaranteed there).
    expect(urutan).toEqual(Array.from({ length: COUNT }, (_, i) => i + 1));

    const nomorUnik = new Set(results.map((r) => r.nomor));
    expect(nomorUnik.size).toBe(COUNT);
    expect(await nomor.peek(key)).toBe(COUNT);
  }, 20_000);

  test("parallel first-use of a series does not fail on a duplicate key", async () => {
    // Every caller tries to create the counter row; ON CONFLICT DO NOTHING
    // means exactly one wins and nobody errors.
    const f = await createFixture();
    const key = {
      bumnId: f.bumnId,
      cabangId: f.cabangB.id,
      jenisDokumen: "PERTAMA",
      tahun: 2026,
      bulan: 12,
      kodeCabang: f.cabangB.kode,
    };
    const results = await Promise.all(Array.from({ length: 12 }, () => nomor.generate(key)));
    expect(new Set(results.map((r) => r.urutan)).size).toBe(12);
    const rows = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM nomor_urut
        WHERE bumn_id = $1 AND jenis_dokumen = 'PERTAMA'`,
      [f.bumnId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  }, 20_000);

  test("parallel allocations across different series do not block each other", async () => {
    const f = await createFixture();
    const series = ["A1", "A2", "A3", "A4"];
    const results = await Promise.all(
      series.flatMap((jenis) =>
        Array.from({ length: 5 }, () =>
          nomor.generate({
            bumnId: f.bumnId,
            cabangId: f.cabangA.id,
            jenisDokumen: jenis,
            tahun: 2026,
            bulan: 8,
            kodeCabang: f.cabangA.kode,
          }),
        ),
      ),
    );
    expect(results).toHaveLength(20);
    for (const jenis of series) {
      const forSeries = results.filter((r) => r.nomor.includes(jenis)).map((r) => r.urutan).sort();
      expect(forSeries).toEqual([1, 2, 3, 4, 5]);
    }
  }, 20_000);
});
