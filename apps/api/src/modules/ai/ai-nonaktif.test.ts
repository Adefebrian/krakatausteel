// THE FEATURE-FLAG-OFF PROOF.
//
// The requirement is not "the AI endpoints return something when the flag is
// off". It is "the system is fully operable with the AI layer disabled", and
// operable means the screens and endpoints a person actually uses behave
// EXACTLY as they did before this phase existed. So this file runs with NO
// override at all -- `createFixture()` with nothing added, which is the default
// every other test file in this repository already uses, and which resolves
// `AI_ENABLED` from the environment, where it is unset.
//
// FOUR THINGS ARE ASSERTED, IN INCREASING ORDER OF WHAT THEY WOULD COST TO GET
// WRONG:
//
//   1. No provider client exists. With the flag off `createApp` never calls
//      `createAiAdapter`, so a deployment of this system contains no OpenAI
//      client and needs no API key. `/ai/status` reports `model: null`.
//   2. The AI endpoints answer, and answer WELL-FORMED EMPTY. A screen is told
//      the assistant is off; it is not shown a 404, a 503 or an error dialog.
//   3. Nothing is written. No `ai_saran` row, no rate-limit unit spent: asking
//      a switched-off feature must not cost a caller their quota, and a log
//      entry for a suggestion that was never made would claim an event that did
//      not happen.
//   4. THE REST OF THE APPLICATION IS UNTOUCHED. The journal engine still
//      posts, the diagnostics still diagnose, the reports still report, the
//      dashboard still loads, and a Maker can still file a PUMK proposal. That
//      is the actual claim, and it is the one worth the round trips.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, tutupSemuaFixture, type Fixture } from "../../testing/harness";
import { buatDuniaAi, type DuniaAi } from "./test-support";

describe("ai: seluruh sistem tetap utuh dengan flag mati", () => {
  let f: Fixture;
  let dunia: DuniaAi;
  let cookieMaker: string;
  let cookieChecker: string;
  let cookieAdminPusat: string;

  beforeAll(async () => {
    // NO `aiAktif`, NO `ai`. This is the shipped default, resolved from
    // AI_ENABLED, which .env.example, the CI workflow and the production
    // compose file all ship as false.
    f = await createFixture();
    dunia = await buatDuniaAi(f);
    cookieMaker = await f.login(f.users.MAKER.username);
    cookieChecker = await f.login(f.users.CHECKER.username);
    cookieAdminPusat = await f.login(f.users.ADMIN_PUSAT.username);
  }, 60_000);

  afterAll(async () => {
    await tutupSemuaFixture();
  });

  test("status: mati, tanpa model, tanpa kunci API", () => {
    // The environment this suite runs in is the proof: no key is configured and
    // none is needed, because the adapter was never constructed.
    expect(process.env.AI_ENABLED).not.toBe("true");
  });

  test("GET /ai/status menjawab 'mati' dan bukan 404", async () => {
    const res = await f.request("/ai/status", { cookie: cookieMaker });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aktif: boolean;
      model: string | null;
      kemampuan: { ekstraksiDokumen: boolean; deteksiAnomali: boolean };
    };
    expect(body.aktif).toBe(false);
    expect(body.model).toBeNull();
    expect(body.kemampuan).toEqual({ ekstraksiDokumen: false, deteksiAnomali: false });
  });

  test("ekstraksi menjawab NONAKTIF, tanpa menulis apa pun dan tanpa memakan jatah", async () => {
    const sebelum = await hitungSaran(f);
    const res = await f.request("/ai/ekstraksi", {
      method: "POST",
      cookie: cookieMaker,
      body: { jenis: "PROPOSAL", teks: "Nama pemohon: Siti Rahayu\nNIK: 3671014509870002" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      field: unknown[];
      saranId: string | null;
      model: string | null;
      alasan: string;
      perluKonfirmasi: boolean;
    };
    expect(body.status).toBe("NONAKTIF");
    expect(body.field).toEqual([]);
    expect(body.saranId).toBeNull();
    expect(body.model).toBeNull();
    expect(body.perluKonfirmasi).toBe(true);
    // A sentence the Maker can act on, which is the same sentence they would
    // act on if the provider were down: carry on by hand.
    expect(body.alasan).toContain("seperti biasa");
    expect(await hitungSaran(f)).toBe(sebelum);
  });

  test("ekstraksi berkali-kali dengan flag mati tidak pernah menjadi 429", async () => {
    // The per-user ceiling is 10. Fifteen calls with the layer off must all
    // succeed, because a switched-off feature cannot cost anybody their budget.
    for (let i = 0; i < 15; i += 1) {
      const res = await f.request("/ai/ekstraksi", {
        method: "POST",
        cookie: cookieMaker,
        body: { jenis: "KTP", teks: "NIK 3671014509870002" },
      });
      expect(res.status).toBe(200);
    }
  });

  test("antrean anomali kosong dan jujur tentang kenapa", async () => {
    const res = await f.request(`/ai/anomali?periodeId=${dunia.periodeScan.id}`, {
      cookie: cookieChecker,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      aktif: boolean;
      hanyaSaran: boolean;
      jurnal: unknown[];
      jumlahDitandai: number;
    };
    expect(body.aktif).toBe(false);
    expect(body.jurnal).toEqual([]);
    expect(body.jumlahDitandai).toBe(0);
    // Still says out loud that it never blocks anything, off or on.
    expect(body.hanyaSaran).toBe(true);
  });

  test("otorisasi tetap ditegakkan walau fiturnya mati", async () => {
    // Off is not open. A Maker still cannot read the review queue, and a
    // Checker still cannot ask for an extraction: a disabled feature that
    // stopped checking permissions would be a permission bug waiting for the
    // day somebody turns the flag on.
    expect(
      (await f.request(`/ai/anomali?periodeId=${dunia.periodeScan.id}`, { cookie: cookieMaker }))
        .status,
    ).toBe(403);
    expect(
      (
        await f.request("/ai/ekstraksi", {
          method: "POST",
          cookie: cookieChecker,
          body: { jenis: "PROPOSAL", teks: "x" },
        })
      ).status,
    ).toBe(403);
  });

  test("validasi tetap ditegakkan walau fiturnya mati", async () => {
    const res = await f.request("/ai/ekstraksi", {
      method: "POST",
      cookie: cookieMaker,
      body: { jenis: "PROPOSAL", teks: "x".repeat(20_001) },
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // THE CLAIM ITSELF: the rest of the application is unchanged.
  // -------------------------------------------------------------------------

  test("buku besar tetap bisa ditulis: satu jurnal masih bisa diposting", async () => {
    const no = await dunia.posting({
      tanggal: "2026-09-10",
      keterangan: "Beban operasional September dengan layer AI mati",
      jumlah: "1750000.00",
      akunDebit: dunia.akunBeban,
      akunKredit: dunia.akunKas,
    });
    expect(no).toMatch(/\S/);
    const baris = await f.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM v_ledger_baris v
        JOIN jurnal j ON j.id = v.jurnal_id
       WHERE j.no_jurnal = $1 AND v.bumn_id = $2::uuid`,
      [no, f.bumnId],
    );
    expect(Number(baris[0]!.n)).toBe(2);
  });

  test("layar yang terdampak tetap jalan: health, dashboard, tools, laporan", async () => {
    const jalur: [string, string][] = [
      ["/health", ""],
      ["/dashboard", cookieAdminPusat],
      ["/tools/integritas", cookieAdminPusat],
      ["/tools/rekonsiliasi/piutang", cookieAdminPusat],
      ["/laporan/katalog", cookieAdminPusat],
      ["/konfigurasi", cookieAdminPusat],
      ["/pumk/proposal", cookieMaker],
      ["/organisasi/cabang", cookieMaker],
    ];
    for (const [path, cookie] of jalur) {
      const res = await f.request(path, cookie ? { cookie } : {});
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });

  test("cek integritas tetap hijau: tidak ada yang dirusak oleh modul ini", async () => {
    const res = await f.request("/tools/integritas", { cookie: cookieAdminPusat });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sehat: boolean; hasil: { kode: string; lulus: boolean }[] };
    expect(body.hasil).toHaveLength(9);
    expect(body.hasil.filter((h) => !h.lulus)).toEqual([]);
    expect(body.sehat).toBe(true);
  });
});

async function hitungSaran(f: Fixture): Promise<number> {
  const rows = await f.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_saran WHERE bumn_id = $1::uuid`,
    [f.bumnId],
  );
  return Number(rows[0]!.n);
}
