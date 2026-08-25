// Konfigurasi service tests. Two themes:
//
//   1. IT NEVER GUESSES. A missing row or a malformed value throws instead of
//      defaulting, because a silent default inside a financial calculation
//      produces plausible wrong numbers for months before anyone notices.
//   2. A CHANGE TAKES EFFECT WITHOUT A DEPLOY (spec rule 3), which in practice
//      means the Redis cache is invalidated on write and the next read sees the
//      new value.
import { describe, expect, test } from "bun:test";
import { createMemoryKeyValueStore } from "../../core/adapters/keyvalue";
import { createFixture } from "../../testing/harness";
import {
  KATALOG,
  entriPerluKonfirmasiKlien,
  entriTambahan,
  katalogKey,
  periksaNilai,
  compareDesimal,
  tipeDataUntuk,
} from "./katalog";

/** A fixture plus a konfigurasi service sharing its db, kv and audit. */
async function setup(options: Parameters<typeof createFixture>[0] = {}) {
  const f = await createFixture(options);
  return { f, konfigurasi: f.ctx.konfigurasi };
}

describe("katalog validation (pure)", () => {
  test("rejects the shapes that turn into NaN or a wrong number", () => {
    const rate = KATALOG["jasa_adm.jasa_adm_rate_default"]!;
    expect(periksaNilai(rate, "0.030000")).toEqual([]);
    // parseFloat would read each of these as a number and carry on.
    expect(periksaNilai(rate, "3%")).not.toEqual([]);
    expect(periksaNilai(rate, "0,03")).not.toEqual([]);
    expect(periksaNilai(rate, "")).not.toEqual([]);
    expect(periksaNilai(rate, null)).not.toEqual([]);
    expect(periksaNilai(rate, "abc")).not.toEqual([]);
    // Out of range: a rate above 1 means 100 percent plus.
    expect(periksaNilai(rate, "1.5")).not.toEqual([]);
  });

  test("enforces enum membership so a typo cannot reach an engine", () => {
    const metode = KATALOG["jasa_adm.jasa_adm_metode_default"]!;
    expect(periksaNilai(metode, "FLAT")).toEqual([]);
    expect(periksaNilai(metode, "flat")).not.toEqual([]);
    expect(periksaNilai(metode, "MENURUN")).not.toEqual([]);
  });

  test("enforces integer bounds", () => {
    const tenor = KATALOG["batasan.tenor_max_bulan"]!;
    expect(periksaNilai(tenor, "36")).toEqual([]);
    expect(periksaNilai(tenor, "0")).not.toEqual([]);
    expect(periksaNilai(tenor, "36.5")).not.toEqual([]);
    expect(periksaNilai(tenor, "999")).not.toEqual([]);
  });

  test("enforces JSON array membership", () => {
    const akrual = KATALOG["akuntansi.akrual_hanya_untuk_kolektibilitas"]!;
    expect(periksaNilai(akrual, '["LANCAR"]')).toEqual([]);
    expect(periksaNilai(akrual, '["LANCAR","MACET"]')).toEqual([]);
    expect(periksaNilai(akrual, '["TIDAK_ADA"]')).not.toEqual([]);
    expect(periksaNilai(akrual, "LANCAR")).not.toEqual([]);
    expect(periksaNilai(akrual, "[1,2]")).not.toEqual([]);
  });

  test("compareDesimal does not go through a float", () => {
    // 0.1 + 0.2 !== 0.3 is why money is never a JS number here.
    expect(compareDesimal("0.03", "0.030000")).toBe(0);
    expect(compareDesimal("250000000.00", "250000000.01")).toBe(-1);
    expect(compareDesimal("9007199254740993.00", "9007199254740992.00")).toBe(1);
  });

  test("tipe_data maps onto the values the konfigurasi CHECK constraint allows", () => {
    const allowed = new Set(["STRING", "NUMBER", "BOOLEAN", "JSON", "ENUM", "DATE"]);
    for (const entri of Object.values(KATALOG)) {
      expect(allowed.has(tipeDataUntuk(entri.bentuk))).toBe(true);
    }
  });

  test("every spec 5 parameter and every BUILD-PLAN capability key is in the catalogue", () => {
    // Spec 5 groups.
    for (const kunci of [
      "jasa_adm.jasa_adm_rate_default",
      "jasa_adm.jasa_adm_metode_default",
      "jasa_adm.jasa_adm_basis_hari",
      "angsuran.pembulatan_angsuran",
      "angsuran.urutan_alokasi_setoran_preset",
      "batasan.plafon_min_pumk",
      "batasan.plafon_max_pumk",
      "batasan.tenor_min_bulan",
      "batasan.tenor_max_bulan",
      "batasan.grace_period_max_bulan",
      "batasan.wajib_jaminan_di_atas_plafon",
      "batasan.maks_pinjaman_aktif_per_mitra",
      "batasan.skor_survey_minimum_lolos",
      "akuntansi.metode_pengakuan_jasa_adm",
      "akuntansi.akrual_hanya_untuk_kolektibilitas",
      "akuntansi.tahun_buku_mulai_bulan",
      "akuntansi.izinkan_reopen_periode",
      "akuntansi.dasar_perhitungan_penyisihan",
    ]) {
      expect(KATALOG[kunci]).toBeDefined();
    }
    // docs/BUILD-PLAN.md "Dampak temuan regulasi ke kemampuan engine": the
    // two-mode capabilities must be selectable from config, not from a deploy.
    for (const kunci of [
      "jasa_adm.turunkan_flat_dari_efektif",
      "jasa_adm.rate_efektif_acuan",
      "akuntansi.mode_penyisihan",
      "akuntansi.penyisihan_min_bulan_histori",
      "akuntansi.pisahkan_penghapustagihan",
      "akuntansi.kekurangan_penyisihan_hapus_buku",
      "laporan.template_laporan_aktif",
      "batasan.izinkan_topup_jangka_pendek",
      "batasan.plafon_topup_jangka_pendek",
    ]) {
      expect(KATALOG[kunci]).toBeDefined();
    }
    expect(KATALOG["akuntansi.mode_penyisihan"]!.pilihan).toEqual(["RATE_TABLE", "KOLEKTIF_HISTORIS"]);
    expect(KATALOG["laporan.template_laporan_aktif"]!.pilihan).toEqual(["PSAK45", "ISAK335"]);
  });

  test("every capability key the seed owns is marked as not coming from a migration", () => {
    const tambahan = entriTambahan().map((e) => `${e.grup}.${e.kunci}`);
    expect(tambahan).toContain("akuntansi.mode_penyisihan");
    expect(tambahan).not.toContain("batasan.tenor_max_bulan");
  });
});

describe("typed reads", () => {
  test("returns the spec 5 defaults with the right TypeScript shapes", async () => {
    const { f, konfigurasi } = await setup();
    const jasa = await konfigurasi.jasaAdm(f.bumnId);
    // A rate is a decimal STRING, never a float.
    expect(typeof jasa.rateDefault).toBe("string");
    expect(jasa.rateDefault).toBe("0.030000");
    expect(jasa.metodeDefault).toBe("FLAT");
    expect(jasa.basisHari).toBe(360);
    expect(jasa.turunkanFlatDariEfektif).toBe(false);

    const batasan = await konfigurasi.batasan(f.bumnId);
    expect(typeof batasan.plafonMax).toBe("string");
    expect(batasan.plafonMax).toBe("250000000.00");
    // Countable values are numbers.
    expect(batasan.tenorMaxBulan).toBe(36);
    expect(batasan.maksPinjamanAktifPerMitra).toBe(1);
    expect(batasan.izinkanTopupJangkaPendek).toBe(false);

    const akuntansi = await konfigurasi.akuntansi(f.bumnId);
    expect(akuntansi.metodePengakuanJasaAdm).toBe("ACCRUAL");
    expect(akuntansi.akrualHanyaUntukKolektibilitas).toEqual(["LANCAR"]);
    expect(akuntansi.izinkanReopenPeriode).toBe(true);
    expect(akuntansi.modePenyisihan).toBe("RATE_TABLE");
    expect(akuntansi.templateLaporanAktif).toBe("PSAK45");
  });

  test("resolves the payment-allocation waterfall from its preset rows (spec 5.4)", async () => {
    const { f, konfigurasi } = await setup();
    const angsuran = await konfigurasi.angsuran(f.bumnId);
    expect(angsuran.presetAlokasi).toBe("DEFAULT");
    expect(angsuran.urutanAlokasi).toEqual([
      "TUNGGAKAN_JASA",
      "TUNGGAKAN_POKOK",
      "JASA_BERJALAN",
      "POKOK_BERJALAN",
      "KELEBIHAN",
    ]);
  });

  test("kolektibilitas ranges come back as an ordered, continuous ladder (spec 5.1)", async () => {
    const { f, konfigurasi } = await setup();
    const ranges = await konfigurasi.kolektibilitasRanges(f.bumnId, "2026-08-23");
    expect(ranges.map((r) => r.kelas_kode)).toEqual(["LANCAR", "KURANG_LANCAR", "DIRAGUKAN", "MACET"]);
    expect(ranges[0]).toMatchObject({ hari_min: 0, hari_max: 30 });
    expect(ranges[3]).toMatchObject({ hari_min: 271, hari_max: null });
  });

  test("penyisihan rates come back as decimal strings (spec 5.2)", async () => {
    const { f, konfigurasi } = await setup();
    const rates = await konfigurasi.penyisihanRates(f.bumnId, "2026-08-23");
    const byClass = Object.fromEntries(rates.map((r) => [r.kelas_kode, r.rate]));
    expect(byClass.LANCAR).toBe("0.000000");
    expect(byClass.KURANG_LANCAR).toBe("0.250000");
    expect(byClass.DIRAGUKAN).toBe("0.750000");
    expect(byClass.MACET).toBe("1.000000");
    expect(typeof byClass.MACET).toBe("string");
  });
});

describe("failing loudly", () => {
  test("a key that is not in the catalogue throws", async () => {
    const { f, konfigurasi } = await setup();
    await expect(konfigurasi.getDesimal(f.bumnId, "jasa_adm", "tidak_ada")).rejects.toThrow(
      /tidak ada di katalog/,
    );
  });

  test("a missing row throws instead of defaulting", async () => {
    const { f, konfigurasi } = await setup();
    // Soft-delete the row the way the config UI would, then read it.
    await f.db.query(
      `UPDATE konfigurasi SET deleted_at = now(), deleted_by = $1
        WHERE bumn_id IS NULL AND grup = 'akuntansi' AND kunci = 'mode_penyisihan'`,
      [f.users.ADMIN_PUSAT.id],
    );
    try {
      await konfigurasi.invalidate(f.bumnId);
      await expect(konfigurasi.getEnum(f.bumnId, "akuntansi", "mode_penyisihan")).rejects.toThrow(
        /tidak ada di tabel konfigurasi/,
      );
    } finally {
      await f.db.query(
        `UPDATE konfigurasi SET deleted_at = NULL, deleted_by = NULL
          WHERE bumn_id IS NULL AND grup = 'akuntansi' AND kunci = 'mode_penyisihan'`,
      );
      await konfigurasi.invalidate(f.bumnId);
    }
  });

  test("a malformed value throws rather than reaching a calculation as NaN", async () => {
    const { f, konfigurasi } = await setup();
    // Written straight to the table, bypassing the guarded write path: this is
    // what a psql session or a bad import looks like.
    await f.db.query(
      `INSERT INTO konfigurasi (bumn_id, grup, kunci, nilai, tipe_data)
       VALUES ($1, 'jasa_adm', 'jasa_adm_rate_default', '3%', 'NUMBER')`,
      [f.bumnId],
    );
    await konfigurasi.invalidate(f.bumnId);
    await expect(konfigurasi.getDesimal(f.bumnId, "jasa_adm", "jasa_adm_rate_default")).rejects.toThrow(
      /tidak valid/,
    );
  });

  test("an incoherent pair of limits is caught, not silently used", async () => {
    const { f, konfigurasi } = await setup();
    await f.db.query(
      `INSERT INTO konfigurasi (bumn_id, grup, kunci, nilai, tipe_data)
       VALUES ($1, 'batasan', 'plafon_min_pumk', '999000000.00', 'NUMBER')`,
      [f.bumnId],
    );
    await konfigurasi.invalidate(f.bumnId);
    // Each value is individually valid; together they describe a range no
    // proposal can satisfy.
    await expect(konfigurasi.batasan(f.bumnId)).rejects.toThrow(/lebih besar dari plafon_max_pumk/);
  });

  test("a broken kolektibilitas ladder is rejected, not used with a gap", async () => {
    const { f, konfigurasi } = await setup();
    await f.db.query(
      `INSERT INTO kolektibilitas_range (bumn_id, kelas_kode, hari_min, hari_max)
       VALUES ($1, 'LANCAR', 0, 10), ($1, 'KURANG_LANCAR', 40, 180),
              ($1, 'DIRAGUKAN', 181, 270), ($1, 'MACET', 271, NULL)`,
      [f.bumnId],
    );
    // Days 11..39 belong to no class: a mitra 20 days overdue would get no
    // classification at all, so the whole ladder is refused.
    await expect(konfigurasi.kolektibilitasRanges(f.bumnId, "2026-08-23")).rejects.toThrow(
      /tidak kontinu/,
    );
  });
});

describe("entity overrides", () => {
  test("an override wins over the shipped global default", async () => {
    const { f, konfigurasi } = await setup();
    expect(await konfigurasi.getInteger(f.bumnId, "batasan", "tenor_max_bulan")).toBe(36);
    await f.db.query(
      `INSERT INTO konfigurasi (bumn_id, grup, kunci, nilai, tipe_data)
       VALUES ($1, 'batasan', 'tenor_max_bulan', '24', 'NUMBER')`,
      [f.bumnId],
    );
    await konfigurasi.invalidate(f.bumnId);
    expect(await konfigurasi.getInteger(f.bumnId, "batasan", "tenor_max_bulan")).toBe(24);
    // The shipped default is untouched, so "what did we ship" stays answerable.
    const globals = await f.db.query<{ nilai: string }>(
      `SELECT nilai FROM konfigurasi
        WHERE bumn_id IS NULL AND grup = 'batasan' AND kunci = 'tenor_max_bulan' AND deleted_at IS NULL`,
    );
    expect(globals[0]!.nilai).toBe("36");
  });

  test("one entity's override does not leak into another", async () => {
    const { f, konfigurasi } = await setup();
    const other = await createFixture();
    await f.db.query(
      `INSERT INTO konfigurasi (bumn_id, grup, kunci, nilai, tipe_data)
       VALUES ($1, 'batasan', 'tenor_min_bulan', '3', 'NUMBER')`,
      [f.bumnId],
    );
    await konfigurasi.invalidate(f.bumnId);
    expect(await konfigurasi.getInteger(f.bumnId, "batasan", "tenor_min_bulan")).toBe(3);
    expect(await konfigurasi.getInteger(other.bumnId, "batasan", "tenor_min_bulan")).toBe(6);
  });
});

describe("cache and invalidation (spec rule 3: no deploy needed)", () => {
  test("a second read is served from the cache", async () => {
    const kv = createMemoryKeyValueStore();
    const { f, konfigurasi } = await setup({ kv });
    await konfigurasi.getInteger(f.bumnId, "batasan", "tenor_max_bulan");
    expect(await kv.get(`test:${f.suffix}:cfg:${f.bumnId}`)).not.toBeNull();
  });

  test("a write through the service invalidates the cache and the next read is fresh", async () => {
    const kv = createMemoryKeyValueStore();
    const { f, konfigurasi } = await setup({ kv });
    expect(await konfigurasi.getInteger(f.bumnId, "batasan", "tenor_max_bulan")).toBe(36);

    await konfigurasi.update({
      bumnId: f.bumnId,
      grup: "batasan",
      kunci: "tenor_max_bulan",
      nilai: "18",
      userId: f.users.ADMIN_PUSAT.id,
    });

    // No restart, no cache TTL wait: the very next read sees it.
    expect(await konfigurasi.getInteger(f.bumnId, "batasan", "tenor_max_bulan")).toBe(18);
  });

  test("a stale cache entry cannot survive a write, even if it was just repopulated", async () => {
    const kv = createMemoryKeyValueStore();
    const { f, konfigurasi } = await setup({ kv });
    await konfigurasi.getInteger(f.bumnId, "angsuran", "pembulatan_angsuran"); // warm
    await konfigurasi.update({
      bumnId: f.bumnId,
      grup: "angsuran",
      kunci: "pembulatan_angsuran",
      nilai: "1000",
      userId: f.users.ADMIN_PUSAT.id,
    });
    expect(await kv.get(`test:${f.suffix}:cfg:${f.bumnId}`)).toBeNull();
    expect(await konfigurasi.getInteger(f.bumnId, "angsuran", "pembulatan_angsuran")).toBe(1000);
  });

  test("a poisoned cache entry is ignored, not thrown on", async () => {
    const kv = createMemoryKeyValueStore();
    const { f, konfigurasi } = await setup({ kv });
    await kv.set(`test:${f.suffix}:cfg:${f.bumnId}`, "{not json", 60);
    expect(await konfigurasi.getInteger(f.bumnId, "batasan", "tenor_max_bulan")).toBe(36);
  });

  test("a cache read failure falls back to Postgres instead of failing the request", async () => {
    // Deliberate degradation, and only for READS: a journal must still post
    // when Redis is down.
    const broken = {
      get: async (): Promise<string | null> => {
        throw new Error("redis mati");
      },
      set: async (): Promise<void> => {
        throw new Error("redis mati");
      },
      del: async (): Promise<number> => {
        throw new Error("redis mati");
      },
      ttl: async (): Promise<number> => -2,
    };
    const { f, konfigurasi } = await setup({ kv: broken });
    expect(await konfigurasi.getInteger(f.bumnId, "batasan", "tenor_max_bulan")).toBe(36);
  });

  test("a cache DELETE failure surfaces as an error, it is not swallowed", async () => {
    // The inverse of the previous test: a silently skipped invalidation leaves
    // a stale rate in front of a financial calculation.
    const broken = {
      get: async (): Promise<string | null> => null,
      set: async (): Promise<void> => {},
      del: async (): Promise<number> => {
        throw new Error("redis mati");
      },
      ttl: async (): Promise<number> => -2,
    };
    const { f, konfigurasi } = await setup({ kv: broken });
    await expect(
      konfigurasi.update({
        bumnId: f.bumnId,
        grup: "batasan",
        kunci: "tenor_max_bulan",
        nilai: "12",
        userId: f.users.ADMIN_PUSAT.id,
      }),
    ).rejects.toThrow(/redis mati/);
  });
});

describe("guarded write path", () => {
  test("records the before and after value in audit_log, in the same transaction", async () => {
    const { f, konfigurasi } = await setup();
    await konfigurasi.update({
      bumnId: f.bumnId,
      grup: "batasan",
      kunci: "skor_survey_minimum_lolos",
      nilai: "80",
      userId: f.users.ADMIN_PUSAT.id,
      alasan: "keputusan komite",
    });

    const rows = await f.auditRows({ aksi: "konfigurasi.update", userId: f.users.ADMIN_PUSAT.id });
    const row = rows[0]!;
    expect(row.hasil).toBe("SUKSES");
    expect(row.entitas).toBe("konfigurasi");
    expect(JSON.stringify(row.nilai_lama_json)).toContain("70");
    expect(JSON.stringify(row.nilai_baru_json)).toContain("80");
    expect(row.keterangan).toBe("keputusan komite");
  });

  test("rejects an invalid value with field detail and changes nothing", async () => {
    const { f, konfigurasi } = await setup();
    await expect(
      konfigurasi.update({
        bumnId: f.bumnId,
        grup: "jasa_adm",
        kunci: "jasa_adm_metode_default",
        nilai: "MENURUN",
        userId: f.users.ADMIN_PUSAT.id,
      }),
    ).rejects.toThrow(/tidak valid/);
    expect(await konfigurasi.getEnum(f.bumnId, "jasa_adm", "jasa_adm_metode_default")).toBe("FLAT");
  });

  test("optimistic concurrency: a stale version is a 409, not a silent overwrite", async () => {
    const { f, konfigurasi } = await setup();
    const first = await konfigurasi.update({
      bumnId: f.bumnId,
      grup: "batasan",
      kunci: "grace_period_max_bulan",
      nilai: "3",
      userId: f.users.ADMIN_PUSAT.id,
    });
    await konfigurasi.update({
      bumnId: f.bumnId,
      grup: "batasan",
      kunci: "grace_period_max_bulan",
      nilai: "4",
      userId: f.users.ADMIN_PUSAT.id,
    });
    const err = await konfigurasi
      .update({
        bumnId: f.bumnId,
        grup: "batasan",
        kunci: "grace_period_max_bulan",
        nilai: "5",
        userId: f.users.ADMIN_PUSAT.id,
        version: first.version,
      })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err?.message).toMatch(/sudah diubah oleh pengguna lain/);
    expect(await konfigurasi.getInteger(f.bumnId, "batasan", "grace_period_max_bulan")).toBe(4);
  });
});

describe("HTTP surface", () => {
  test("PUT applies the change and GET reflects it immediately", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const put = await f.request("/konfigurasi/batasan/tenor_min_bulan", {
      method: "PUT",
      cookie,
      body: { nilai: "9", alasan: "uji" },
    });
    expect(put.status).toBe(200);
    const get = await f.request("/konfigurasi/batasan/tenor_min_bulan", { cookie });
    expect(((await get.json()) as { nilai: string }).nilai).toBe("9");
  });

  test("PUT with a non-string value is a 400 with field detail", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request("/konfigurasi/batasan/tenor_min_bulan", {
      method: "PUT",
      cookie,
      body: { nilai: 9 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    expect(body.detail.nilai).toBeDefined();
  });

  test("PUT of an unknown key is a 400, not a new row", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request("/konfigurasi/batasan/kunci_karangan", {
      method: "PUT",
      cookie,
      body: { nilai: "1" },
    });
    expect(res.status).toBe(400);
    const rows = await f.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM konfigurasi WHERE kunci = 'kunci_karangan'",
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  test("GET / lists resolved parameters and flags rows outside the catalogue", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request("/konfigurasi", { cookie });
    const body = (await res.json()) as { data: { grup: string; kunci: string; diLuarKatalog: boolean }[] };
    expect(body.data.length).toBeGreaterThanOrEqual(30);
    const tenor = body.data.find((row) => row.kunci === "tenor_max_bulan");
    expect(tenor).toBeDefined();
    expect(tenor!.diLuarKatalog).toBe(false);
  });

  test("GET of an unknown key is a 404", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request("/konfigurasi/batasan/tidak_ada", { cookie });
    expect(res.status).toBe(404);
  });
});


// ---------------------------------------------------------------------------
// The sweep. A parameter that is shipped but not catalogued is invisible to the
// Konfigurasi screen and un-PUT-able, which is spec rule 3 broken for that
// parameter: it can only be changed with psql, i.e. by a deploy-equivalent.
// This is DB-driven on purpose. A hand-written list of "keys we shipped" is a
// second copy of the migrations and drifts from them exactly the way the
// thirteen keys below did: four Non PUMK (0022), the fixed due day (0019) and
// eleven integration switches (0016) were all live rows that this catalogue had
// never heard of, and nothing failed until someone opened the screen.
// ---------------------------------------------------------------------------
describe("catalogue and database agree about which parameters exist", () => {
  test("every global row shipped by a migration or the seed has a catalogue entry", async () => {
    const f = await createFixture();
    const rows = await f.db.query<{ grup: string; kunci: string }>(
      `SELECT grup, kunci FROM konfigurasi
        WHERE bumn_id IS NULL AND deleted_at IS NULL ORDER BY grup, kunci`,
    );
    expect(rows.length).toBeGreaterThan(30);
    const asing = rows
      .map((r) => katalogKey(r.grup, r.kunci))
      .filter((key) => KATALOG[key] === undefined);
    // Named in the failure, so the fix is obvious: add the entry, do not delete
    // the row.
    expect(asing).toEqual([]);
  });

  test("every entry that claims to come from a migration really has a global row", async () => {
    // The other direction: an entry marked `dariMigrasi: true` that no
    // migration ships is a parameter the seed will never create either
    // (`entriTambahan` skips it), so the first read of it fails in production.
    const f = await createFixture();
    const rows = await f.db.query<{ grup: string; kunci: string }>(
      `SELECT grup, kunci FROM konfigurasi WHERE bumn_id IS NULL AND deleted_at IS NULL`,
    );
    const ada = new Set(rows.map((r) => katalogKey(r.grup, r.kunci)));
    const hilang = Object.entries(KATALOG)
      .filter(([key, entri]) => entri.dariMigrasi && !ada.has(key))
      .map(([key]) => key);
    expect(hilang).toEqual([]);
  });

  test("the thirteen keys the sweep found are catalogued, with shapes and bounds", () => {
    for (const key of [
      // migrations/0019, spec 7.1's fixed due day
      "angsuran.hari_jatuh_tempo_tetap",
      // migrations/0022, the invented Non PUMK limits
      "batasan.nilai_min_non_pumk",
      "batasan.nilai_max_non_pumk",
      "batasan.skor_penilaian_minimum_lolos_non_pumk",
      "batasan.batas_hari_lpj_non_pumk",
      // migrations/0016, the integration switches
      "integrasi.integrasi_akuntansi_aktif",
      "integrasi.sistem_akuntansi_target",
      "integrasi.pemegang_buku_resmi",
      "integrasi.adapter_ekspor",
      "integrasi.granularitas_push",
      "integrasi.maks_baris_per_dokumen",
      "integrasi.maks_percobaan_kirim",
      "integrasi.batas_menit_anggap_ambigu",
      "integrasi.wajib_pemetaan_lengkap_sebelum_push",
      "integrasi.wajib_pihak_valid_sebelum_push",
      "integrasi.verifikasi_remote_setiap_hari",
      "integrasi.kirim_dimensi_program",
    ]) {
      const entri = KATALOG[key];
      expect(`${key}:${entri !== undefined}`).toBe(`${key}:true`);
      // Every numeric key carries at least a floor, or an out-of-range value
      // would validate and then disable the check it configures.
      if (entri!.bentuk === "INTEGER" || entri!.bentuk === "DESIMAL") {
        expect(`${key}:${entri!.min !== undefined}`).toBe(`${key}:true`);
      }
      if (entri!.bentuk === "ENUM") {
        expect((entri!.pilihan ?? []).length).toBeGreaterThan(1);
      }
    }
  });

  test("the fixed due day matches the ENGINE's range, not the migration comment's", () => {
    // migrations/0019 says values above 28 are refused; nothing enforces that,
    // modules/angsuran/service.ts refuses only above 31, and
    // angsuran-jadwal.test.ts pins hariTetap = 31 producing 31 Jan / 28 Feb /
    // 31 Mar. A catalogue stricter than the engine would make the screen refuse
    // a supported, tested setting.
    const entri = KATALOG["angsuran.hari_jatuh_tempo_tetap"]!;
    expect(periksaNilai(entri, "31")).toEqual([]);
    expect(periksaNilai(entri, "0")).toEqual([]);
    expect(periksaNilai(entri, "32")).not.toEqual([]);
    expect(periksaNilai(entri, "-1")).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The four invented Non PUMK parameters (migrations/0022, ASSUMPTIONS A-41..44)
// ---------------------------------------------------------------------------
describe("parameter Non PUMK yang nilainya dikarang", () => {
  test("provenance says ASUMSI, so a screen cannot present them as settled policy", () => {
    const dikarang = entriPerluKonfirmasiKlien().map((e) => katalogKey(e.grup, e.kunci));
    for (const key of [
      "batasan.nilai_min_non_pumk",
      "batasan.nilai_max_non_pumk",
      "batasan.skor_penilaian_minimum_lolos_non_pumk",
      "batasan.batas_hari_lpj_non_pumk",
    ]) {
      expect(dikarang).toContain(key);
      expect(KATALOG[key]!.asalNilaiDefault).toBe("ASUMSI");
    }
    // And a value the spec actually states is NOT marked as invented, or the
    // marking would mean nothing.
    expect(KATALOG["batasan.plafon_max_pumk"]!.asalNilaiDefault).toBe("SPEC");
  });

  test("the shipped rows carry perlu_konfirmasi and the API hands it to the screen", async () => {
    const f = await createFixture();
    const rows = await f.db.query<{ kunci: string; perlu_konfirmasi: boolean }>(
      `SELECT kunci, perlu_konfirmasi FROM konfigurasi
        WHERE bumn_id IS NULL AND deleted_at IS NULL AND kunci LIKE '%non_pumk%'`,
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(`${row.kunci}:${row.perlu_konfirmasi}`).toBe(`${row.kunci}:true`);

    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request("/konfigurasi/batasan/batas_hari_lpj_non_pumk", { cookie });
    const body = (await res.json()) as {
      nilai: string;
      perluKonfirmasi: boolean;
      asalNilaiDefault: string | null;
      override: boolean;
    };
    expect(body).toMatchObject({
      nilai: "60",
      perluKonfirmasi: true,
      asalNilaiDefault: "ASUMSI",
      override: false,
    });
  });

  test("bounds refuse what would silently disable the check the engine believes it does", () => {
    const hari = KATALOG["batasan.batas_hari_lpj_non_pumk"]!;
    expect(periksaNilai(hari, "60")).toEqual([]);
    // 0 would make every LPJ late on the day the money moves.
    expect(periksaNilai(hari, "0")).not.toEqual([]);
    // "60 hari" is the shape that becomes NaN and then compares false against
    // everything, i.e. a deadline nobody ever misses.
    expect(periksaNilai(hari, "60 hari")).not.toEqual([]);
    expect(periksaNilai(hari, "")).not.toEqual([]);

    const skor = KATALOG["batasan.skor_penilaian_minimum_lolos_non_pumk"]!;
    expect(periksaNilai(skor, "70")).toEqual([]);
    // skor_total is a 0..100 weighted average, so 101 is a pass mark no
    // proposal can reach and -1 is no pass mark at all.
    expect(periksaNilai(skor, "101")).not.toEqual([]);
    expect(periksaNilai(skor, "-1")).not.toEqual([]);

    const maks = KATALOG["batasan.nilai_max_non_pumk"]!;
    expect(periksaNilai(maks, "500000000.00")).toEqual([]);
    // A ceiling of zero rejects every proposal ever filed.
    expect(periksaNilai(maks, "0")).not.toEqual([]);
    // Rupiah with a thousands separator, the classic import artefact.
    expect(periksaNilai(maks, "500.000.000")).not.toEqual([]);
    expect(periksaNilai(maks, "500,000,000.00")).not.toEqual([]);
  });

  test("no third fallback: with the override AND the global row gone, the read fails closed", async () => {
    // The condition attached to shipping these defaults at all. The engine's
    // KONFIGURASI_TIDAK_ADA path must stay reachable, so nothing in the
    // catalogue may quietly answer from `nilaiDefault`: that field is what the
    // SEED writes for keys with no migration, never a read-time default.
    const { f, konfigurasi } = await setup();
    await f.db.query(
      `UPDATE konfigurasi SET deleted_at = now(), deleted_by = $1
        WHERE bumn_id IS NULL AND grup = 'batasan' AND kunci = 'batas_hari_lpj_non_pumk'`,
      [f.users.ADMIN_PUSAT.id],
    );
    try {
      await konfigurasi.invalidate(f.bumnId);
      await expect(
        konfigurasi.getInteger(f.bumnId, "batasan", "batas_hari_lpj_non_pumk"),
      ).rejects.toThrow(/tidak ada di tabel konfigurasi/);
    } finally {
      await f.db.query(
        `UPDATE konfigurasi SET deleted_at = NULL, deleted_by = NULL
          WHERE bumn_id IS NULL AND grup = 'batasan' AND kunci = 'batas_hari_lpj_non_pumk'`,
      );
      await konfigurasi.invalidate(f.bumnId);
    }
  });
});

// ---------------------------------------------------------------------------
// "It is in the catalogue" and "an operator can change it" are different
// claims, and spec rule 3 is about the second one.
// ---------------------------------------------------------------------------
describe("round trip lewat PUT /konfigurasi/:grup/:kunci (spec rule 3)", () => {
  test("an Admin Pusat changes an invented Non PUMK limit end to end, no deploy", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const jalur = "/konfigurasi/batasan/batas_hari_lpj_non_pumk";

    const sebelum = (await (await f.request(jalur, { cookie })).json()) as {
      nilai: string;
      override: boolean;
      perluKonfirmasi: boolean;
    };
    expect(sebelum).toMatchObject({ nilai: "60", override: false, perluKonfirmasi: true });

    const put = await f.request(jalur, {
      method: "PUT",
      cookie,
      body: { nilai: "45", alasan: "hasil rapat unit TJSL" },
    });
    expect(put.status).toBe(200);
    const hasil = (await put.json()) as {
      nilai: string;
      override: boolean;
      perluKonfirmasi: boolean;
      asalNilaiDefault: string;
    };
    // The override IS the confirmation of the value, so the row stops asking
    // for one; the PROVENANCE of the shipped default does not change, because
    // it is a fact about where the number came from.
    expect(hasil).toMatchObject({
      nilai: "45",
      override: true,
      perluKonfirmasi: false,
      asalNilaiDefault: "ASUMSI",
    });

    const sesudah = (await (await f.request(jalur, { cookie })).json()) as { nilai: string };
    expect(sesudah.nilai).toBe("45");
    // And the ENGINE-side read agrees, which is the half that matters: the
    // cache was invalidated, so the next calculation uses the new number
    // without a restart.
    expect(await f.ctx.konfigurasi.getInteger(f.bumnId, "batasan", "batas_hari_lpj_non_pumk")).toBe(45);

    // The shipped default is untouched, so "what did we ship, and what did this
    // entity decide" stays answerable.
    const global = await f.db.query<{ nilai: string }>(
      `SELECT nilai FROM konfigurasi
        WHERE bumn_id IS NULL AND grup = 'batasan' AND kunci = 'batas_hari_lpj_non_pumk'
          AND deleted_at IS NULL`,
    );
    expect(global[0]!.nilai).toBe("60");

    // The change is in the audit trail with the reason, because a parameter is
    // evidence for how a number was calculated.
    // Scoped to THIS fixture's user: audit_log is append-only and shared by
    // every run against this database, so an unscoped count would grow by one
    // per run and pass only the first time.
    const audit = await f.db.query<{ nilai_baru_json: { nilai: string }; keterangan: string }>(
      `SELECT nilai_baru_json, keterangan FROM audit_log
        WHERE aksi = 'konfigurasi.update' AND user_id = $1 ORDER BY waktu DESC`,
      [f.users.ADMIN_PUSAT.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.keterangan).toBe("hasil rapat unit TJSL");
    expect(audit[0]!.nilai_baru_json.nilai).toBe("45");
  });

  test("a value outside the catalogue bounds is a 400 and changes nothing", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const jalur = "/konfigurasi/batasan/skor_penilaian_minimum_lolos_non_pumk";

    for (const nilai of ["101", "-1", "70 persen", "70.5"]) {
      const res = await f.request(jalur, { method: "PUT", cookie, body: { nilai } });
      expect(`${nilai}:${res.status}`).toBe(`${nilai}:400`);
      const body = (await res.json()) as { code: string; detail: Record<string, string[]> };
      expect(body.code).toBe("VALIDASI");
      expect(body.detail.nilai).toBeDefined();
    }
    const get = (await (await f.request(jalur, { cookie })).json()) as { nilai: string };
    expect(get.nilai).toBe("70");
  });

  test("an integration switch shipped by 0016 is now editable too, not only visible", async () => {
    // It was `diLuarKatalog` until this change, so PUT answered 400: the master
    // switch for the whole integration layer could only be turned on with psql.
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const jalur = "/konfigurasi/integrasi/integrasi_akuntansi_aktif";
    const put = await f.request(jalur, { method: "PUT", cookie, body: { nilai: "true" } });
    expect(put.status).toBe(200);
    expect(await f.ctx.konfigurasi.getBoolean(f.bumnId, "integrasi", "integrasi_akuntansi_aktif")).toBe(
      true,
    );
    const daftar = (await (await f.request("/konfigurasi", { cookie })).json()) as {
      data: { kunci: string; diLuarKatalog: boolean }[];
    };
    const baris = daftar.data.find((row) => row.kunci === "integrasi_akuntansi_aktif");
    expect(baris).toBeDefined();
    expect(baris!.diLuarKatalog).toBe(false);
  });
});
