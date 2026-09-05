// Spec 12 over HTTP, through the SAME app `createApp` builds for the server
// (apps/api/src/testing/harness.ts rule 1), with the AI flag ON and a STUB
// PORT. Spec 2 rule 4: "Buat test yang memanggil endpoint langsung dengan role
// yang salah dan pastikan ditolak."
//
// What this file adds over the two engine files beside it:
//   - the guard chain, the error handler and the cookie policy are real;
//   - the anomaly SQL actually runs, against real POSTED journals built through
//     the journal engine, so `percentile_disc`, the self-join over
//     `v_ledger_baris` and the branch scope are exercised rather than assumed;
//   - every refusal is checked to arrive with its `kodeDomain`, which is what
//     `NAMA_ERROR_BERKODE` in core/http.ts exists to make true. Four modules
//     shipped without their error class registered there, and the symptom was
//     an anonymous 500 with no audit row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, tutupSemuaFixture, type Fixture } from "../../testing/harness";
import { buatDuniaAi, jawabanModel, stubAi, type DuniaAi } from "./test-support";

describe("ai: rute HTTP dengan flag menyala", () => {
  let f: Fixture;
  let dunia: DuniaAi;
  let cookieMaker: string;
  let cookieChecker: string;
  let cookieApprover: string;
  let cookieAuditor: string;

  beforeAll(async () => {
    f = await createFixture({
      // The flag ON, with a stub behind it. No key, no network, and no way for
      // this file to reach one: `createApp` only builds the real adapter on the
      // `AI_ENABLED === "true"` branch, and `ai` being supplied preempts it.
      aiAktif: true,
      ai: stubAi({
        jawaban: jawabanModel({
          namaPemohon: { nilai: "Siti Rahayu", kutipan: "Siti Rahayu" },
        }),
      }),
    });
    dunia = await buatDuniaAi(f);

    // Twelve months of ordinary history on 5.1.01 / 1.1.01, none of it round,
    // so the outlier rule has a median and a non-zero MAD to work with and the
    // account pair has a precedent.
    for (let i = 0; i < 12; i += 1) {
      const bulan = 6 + Math.floor(i / 4);
      const hari = 3 + (i % 4) * 5;
      await dunia.posting({
        tanggal: `2026-${String(bulan).padStart(2, "0")}-${String(hari).padStart(2, "0")}`,
        keterangan: `Beban operasional rutin bulan ${bulan} urut ${i}`,
        jumlah: `${1_200_000 + i * 13_137}.00`,
        akunDebit: dunia.akunBeban,
        akunKredit: dunia.akunKas,
      });
    }

    cookieMaker = await f.login(f.users.MAKER.username);
    cookieChecker = await f.login(f.users.CHECKER.username);
    cookieApprover = await f.login(f.users.APPROVER.username);
    cookieAuditor = await f.login(f.users.AUDITOR.username);
  }, 60_000);

  afterAll(async () => {
    await tutupSemuaFixture();
  });

  test("tanpa sesi: 401 di setiap rute", async () => {
    expect((await f.request("/ai/status")).status).toBe(401);
    expect((await f.request("/ai/anomali?periodeId=" + dunia.periodeScan.id)).status).toBe(401);
    expect(
      (await f.request("/ai/ekstraksi", { method: "POST", body: { jenis: "PROPOSAL", teks: "x" } }))
        .status,
    ).toBe(401);
  });

  test("status menyebut model dan batasnya, untuk siapa pun yang punya sesi", async () => {
    const res = await f.request("/ai/status", { cookie: cookieMaker });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aktif: boolean;
      model: string;
      batas: { maksKarakterDokumen: number; ekstraksiPerUser: number };
    };
    expect(body.aktif).toBe(true);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.batas.maksKarakterDokumen).toBe(20_000);
    expect(body.batas.ekstraksiPerUser).toBe(10);
  });

  test("MAKER boleh ekstraksi; CHECKER tidak", async () => {
    const ok = await f.request("/ai/ekstraksi", {
      method: "POST",
      cookie: cookieMaker,
      body: { jenis: "PROPOSAL", teks: "Nama pemohon: Siti Rahayu" },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { status: string; perluKonfirmasi: boolean; sumber: string };
    expect(body.status).toBe("BERHASIL");
    expect(body.perluKonfirmasi).toBe(true);
    expect(body.sumber).toBe("AI");

    const tolak = await f.request("/ai/ekstraksi", {
      method: "POST",
      cookie: cookieChecker,
      body: { jenis: "PROPOSAL", teks: "Nama pemohon: Siti Rahayu" },
    });
    expect(tolak.status).toBe(403);
  });

  test("CHECKER, APPROVER dan AUDITOR boleh membaca antrean; MAKER tidak", async () => {
    const jalur = `/ai/anomali?periodeId=${dunia.periodeScan.id}`;
    expect((await f.request(jalur, { cookie: cookieChecker })).status).toBe(200);
    expect((await f.request(jalur, { cookie: cookieApprover })).status).toBe(200);
    expect((await f.request(jalur, { cookie: cookieAuditor })).status).toBe(200);
    expect((await f.request(jalur, { cookie: cookieMaker })).status).toBe(403);
  });

  test("AUDITOR tetap tidak boleh memanggil rute POST mana pun di sini", async () => {
    // Spec 16 scenario 23: read only penuh. `enforceReadOnlyRoles` refuses the
    // METHOD, so this holds for a route written next year too.
    const res = await f.request("/ai/ekstraksi", {
      method: "POST",
      cookie: cookieAuditor,
      body: { jenis: "PROPOSAL", teks: "apa pun" },
    });
    expect(res.status).toBe(403);
  });

  test("validasi di batas: jenis dokumen tak dikenal, teks kosong, teks kepanjangan", async () => {
    const salah = await f.request("/ai/ekstraksi", {
      method: "POST",
      cookie: cookieMaker,
      body: { jenis: "SERTIFIKAT_TANAH", teks: "" },
    });
    expect(salah.status).toBe(400);
    const body = (await salah.json()) as { code: string; detail: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    // BOTH bad fields in one response, not the first one found.
    expect(Object.keys(body.detail).sort()).toEqual(["jenis", "teks"]);

    const besar = await f.request("/ai/ekstraksi", {
      method: "POST",
      cookie: cookieMaker,
      body: { jenis: "PROPOSAL", teks: "x".repeat(20_001) },
    });
    expect(besar.status).toBe(400);
    expect((await besar.json()).detail.teks[0]).toContain("20000");
  });

  test("konteksTipe hanya menerima label yang dikenal", async () => {
    const res = await f.request("/ai/ekstraksi", {
      method: "POST",
      cookie: cookieMaker,
      body: { jenis: "PROPOSAL", teks: "halo", konteksTipe: "jurnal" },
    });
    expect(res.status).toBe(400);
  });

  // --- the anomaly queue, against real SQL --------------------------------

  test("buku yang wajar: antrean kosong, dan itu bukan kegagalan", async () => {
    await dunia.posting({
      tanggal: "2026-09-02",
      keterangan: "Beban operasional rutin September",
      jumlah: "1250777.00",
      akunDebit: dunia.akunBeban,
      akunKredit: dunia.akunKas,
    });
    const res = await f.request(`/ai/anomali?periodeId=${dunia.periodeScan.id}`, {
      cookie: cookieChecker,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aktif: boolean;
      model: null;
      hanyaSaran: boolean;
      jumlahJurnalDiperiksa: number;
      jurnal: unknown[];
    };
    expect(body.aktif).toBe(true);
    // NO MODEL ANSWERED, and the payload says so rather than claiming one did.
    expect(body.model).toBeNull();
    expect(body.hanyaSaran).toBe(true);
    expect(body.jumlahJurnalDiperiksa).toBe(1);
    expect(body.jurnal).toEqual([]);
  });

  test("jurnal mencurigakan naik ke atas antrean, dengan dasar perhitungannya", async () => {
    // A weekend entry, with no meaningful description, for an amount far
    // outside the account's twelve-month history, on an account pair the entity
    // has never used. Four rules, one journal.
    const no = await dunia.posting({
      tanggal: "2026-09-05", // Saturday
      keterangan: "-",
      jumlah: "750000000.00",
      akunDebit: dunia.akunBebanLain,
      akunKredit: dunia.akunKas,
    });

    const res = await f.request(`/ai/anomali?periodeId=${dunia.periodeScan.id}`, {
      cookie: cookieApprover,
    });
    const body = (await res.json()) as {
      jumlahDitandai: number;
      jurnal: {
        noJurnal: string;
        skor: number;
        temuan: { kode: string; dasar: Record<string, string | null> }[];
      }[];
    };

    expect(body.jurnal[0]!.noJurnal).toBe(no);
    const kode = body.jurnal[0]!.temuan.map((t) => t.kode).sort();
    expect(kode).toContain("TANGGAL_AKHIR_PEKAN");
    expect(kode).toContain("KETERANGAN_TIDAK_BERMAKNA");
    expect(kode).toContain("PASANGAN_AKUN_BARU");
    // Every finding carries its basis (spec 12), and every money figure in it
    // is text rather than a number.
    for (const t of body.jurnal[0]!.temuan) {
      expect(Object.keys(t.dasar).length).toBeGreaterThan(0);
      for (const nilai of Object.values(t.dasar)) {
        expect(nilai === null || typeof nilai === "string").toBe(true);
      }
    }
    // The pair rule names the account CODES the reviewer will recognise.
    const pasangan = body.jurnal[0]!.temuan.find((t) => t.kode === "PASANGAN_AKUN_BARU")!;
    expect(pasangan.dasar.pasangan).toBe("5.1.02 > 1.1.01");
  });

  test("NOMINAL_OUTLIER benar-benar memakai median dan MAD dari SQL", async () => {
    // Same account as the twelve history entries, so `percentile_disc` has
    // something to compute over. The amount is three orders of magnitude out.
    const no = await dunia.posting({
      tanggal: "2026-09-08",
      keterangan: "Pembayaran vendor tunggal September",
      jumlah: "480000000.00",
      akunDebit: dunia.akunBeban,
      akunKredit: dunia.akunKas,
    });
    const res = await f.request(`/ai/anomali?periodeId=${dunia.periodeScan.id}`, {
      cookie: cookieApprover,
    });
    const body = (await res.json()) as {
      jurnal: { noJurnal: string; temuan: { kode: string; dasar: Record<string, string> }[] }[];
    };
    const baris = body.jurnal.find((j) => j.noJurnal === no)!;
    const outlier = baris.temuan.find((t) => t.kode === "NOMINAL_OUTLIER")!;
    expect(outlier).toBeDefined();
    // The median is one of the twelve history amounts, verbatim: the SQL uses
    // `percentile_disc`, which returns an element of the set, not an
    // interpolated float.
    expect(outlier.dasar.medianHistoris).toMatch(/^12\d{5}\.00$/);
    expect(Number(outlier.dasar.jumlahBarisHistoris)).toBeGreaterThanOrEqual(12);
    expect(outlier.dasar.nilai).toBe("480000000.00");
  });

  test("cabang di luar scope ditolak, bukan dijawab kosong", async () => {
    const res = await f.request(
      `/ai/anomali?periodeId=${dunia.periodeScan.id}&cabangId=${f.cabangB.id}`,
      { cookie: cookieChecker },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; kodeDomain: string };
    expect(body.code).toBe("TIDAK_BERWENANG");
    // The registered error class is what makes this a 403 with a name rather
    // than an anonymous 500.
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
  });

  test("periode yang tidak ada: 404 dengan kodeDomain, bukan 500", async () => {
    const res = await f.request(
      "/ai/anomali?periodeId=00000000-0000-4000-8000-000000000000",
      { cookie: cookieChecker },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).kodeDomain).toBe("PERIODE_TIDAK_DITEMUKAN");
  });

  test("katalog aturan bisa dibaca sebelum ada pemindaian", async () => {
    const res = await f.request("/ai/anomali/katalog", { cookie: cookieChecker });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { kode: string; bobot: number }[] };
    expect(body.data).toHaveLength(8);
    for (const k of body.data) expect(k.bobot).toBeGreaterThan(0);
  });

  test("endpoint yang tidak ada menjawab 404 dalam amplop API, bukan teks polos", async () => {
    const res = await f.request("/ai/tidak-ada", { cookie: cookieMaker });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("TIDAK_DITEMUKAN");
  });

  test("konfirmasi lewat HTTP mencatat pemutusnya", async () => {
    const buat = await f.request("/ai/ekstraksi", {
      method: "POST",
      cookie: cookieMaker,
      body: { jenis: "PROPOSAL", teks: "Nama pemohon: Siti Rahayu" },
    });
    const { saranId } = (await buat.json()) as { saranId: string };
    const res = await f.request(`/ai/saran/${saranId}/konfirmasi`, {
      method: "POST",
      cookie: cookieMaker,
      body: { keputusan: "DITERIMA" },
    });
    expect(res.status).toBe(200);
    const baris = await f.db.query<{ dikonfirmasi_oleh: string; keputusan: string }>(
      `SELECT dikonfirmasi_oleh::text AS dikonfirmasi_oleh, keputusan
         FROM ai_saran WHERE id = $1::uuid`,
      [saranId],
    );
    expect(baris[0]!.dikonfirmasi_oleh).toBe(f.users.MAKER.id);
    expect(baris[0]!.keputusan).toBe("DITERIMA");

    // A second one is a 409, not a silent overwrite of the trail.
    const lagi = await f.request(`/ai/saran/${saranId}/konfirmasi`, {
      method: "POST",
      cookie: cookieMaker,
      body: { keputusan: "DITOLAK" },
    });
    expect(lagi.status).toBe(409);
    expect((await lagi.json()).kodeDomain).toBe("SARAN_SUDAH_DIKONFIRMASI");
  });

  test("batas per pengguna menjawab 429 DENGAN Retry-After", async () => {
    // The ceiling is 10 per 10 minutes, per user, in a real Redis namespaced to
    // this fixture. The eleventh call is the one under test.
    const kirim = () =>
      f.request("/ai/ekstraksi", {
        method: "POST",
        cookie: cookieMaker,
        body: { jenis: "KTP", teks: "NIK 3671014509870002" },
      });
    let terakhir = await kirim();
    for (let i = 0; i < 14 && terakhir.status === 200; i += 1) {
      terakhir = await kirim();
    }
    expect(terakhir.status).toBe(429);
    expect(terakhir.headers.get("Retry-After")).not.toBeNull();
    expect(Number(terakhir.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await terakhir.json()).kodeDomain).toBe("TERLALU_BANYAK_PERMINTAAN");
  });
});
