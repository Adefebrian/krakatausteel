// Spec 11 over HTTP, through the SAME app `createApp` builds for the server
// (apps/api/src/testing/harness.ts rule 1). Spec 2 rule 4: "Buat test yang
// memanggil endpoint langsung dengan role yang salah dan pastikan ditolak."
//
// What this file adds over the engine files beside it:
//   - the guard chain, the error handler and the cookie policy are real;
//   - the three engine PORTS are the ones `createApp` wires, so "the RKA
//     baseline, the LPJ deadline and the closing checklist come from their
//     owning modules" is proven on the shipped composition rather than on a
//     fixture's wiring;
//   - every refusal is checked to arrive with its `kodeDomain` AND, where it is
//     an authorisation refusal, to have written a DITOLAK row to `audit_log`
//     (spec 2 rule 5). Four modules shipped without their error class
//     registered in core/http.ts's `NAMA_ERROR_BERKODE`, and the symptom was
//     exactly this: an anonymous 500 and no audit row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";

const TAHUN = 2028;

describe("dashboard: rute HTTP", () => {
  let f: Fixture;
  let periodeId: string;
  let cookieAdminPusat: string;
  let cookieAdminCabang: string;
  let cookieMaker: string;
  let cookieAuditor: string;

  beforeAll(async () => {
    f = await createFixture();
    // The PUMK disbursement figure reads its receivable account from
    // `event_jurnal_mapping`; without the shipped mapping the metric would
    // (correctly) report `PEMETAAN_AKUN_BELUM_ADA`, which is a different test.
    await seedCoaDanEventMapping(f.db, f.bumnId, f.users.ADMIN_PUSAT.id);
    const baris = await f.db.query<{ id: string }>(
      // `$2::int` everywhere, then narrowed for the column: passing the same
      // parameter to `make_date` (integer) and to `tahun` (smallint) makes the
      // driver deduce two types for one placeholder and fail 42P08.
      `insert into periode (bumn_id, tahun, bulan, tanggal_mulai, tanggal_akhir, status)
       values ($1, $2::int::smallint, 1, make_date($2::int, 1, 1),
               (make_date($2::int, 1, 1) + interval '1 month' - interval '1 day')::date,
               'OPEN')
       returning id::text as id`,
      [f.bumnId, TAHUN],
    );
    periodeId = baris[0]!.id;

    cookieAdminPusat = await f.login(f.users.ADMIN_PUSAT.username);
    cookieAdminCabang = await f.login(f.users.ADMIN_CABANG.username);
    cookieMaker = await f.login(f.users.MAKER.username);
    cookieAuditor = await f.login(f.users.AUDITOR.username);
  });

  afterAll(async () => {
    await f.tutup();
  });

  test("tanpa sesi: 401 di ketiga rute", async () => {
    expect((await f.request("/dashboard")).status).toBe(401);
    expect((await f.request("/dashboard/periode")).status).toBe(401);
    expect(
      (await f.request("/dashboard/rincian?kunci=metrik:DANA_TERSEDIA")).status,
    ).toBe(401);
  });

  test("ADMIN_PUSAT: halaman utuh dalam satu panggilan", async () => {
    const res = await f.request("/dashboard", { cookie: cookieAdminPusat });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sumberPeriode: string;
      periode: { status: string; tahun: number };
      metrik: { kunci: string; nilai: string | null; sumber: string | null }[];
      antrian: { tahap: string; milikSaya: boolean }[];
      closing: { prasyarat: { hasil: unknown[] } | null };
      cabangDilaporkan: { id: string }[];
    };
    expect(body.periode.tahun).toBe(TAHUN);
    expect(body.periode.status).toBe("OPEN");
    expect(body.sumberPeriode).toBe("V_LEDGER_BARIS");
    expect(body.metrik).toHaveLength(11);
    expect(body.antrian).toHaveLength(10);
    // Head office sees every branch of its own entity, and nothing else.
    expect(body.cabangDilaporkan.map((c) => c.id).sort()).toEqual(
      [f.pusat.id, f.cabangA.id, f.cabangB.id].sort(),
    );
    // The closing checklist arrives through the port the composition root
    // wired, which is modules/closing's own engine.
    expect(body.closing.prasyarat?.hasil).toHaveLength(10);
  });

  test("periode picker terbaca tanpa menghitung satu metrik pun", async () => {
    const res = await f.request("/dashboard/periode", { cookie: cookieAdminPusat });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; bulan: number }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(periodeId);
  });

  test("rincian menjawab dengan barisnya", async () => {
    const res = await f.request(
      `/dashboard/rincian?kunci=metrik:DANA_TERSEDIA&periodeId=${periodeId}`,
      { cookie: cookieAdminPusat },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kunci: string; sumber: string; baris: unknown[] };
    expect(body.kunci).toBe("metrik:DANA_TERSEDIA");
    expect(body.sumber).toBe("V_LEDGER_BARIS");
    expect(Array.isArray(body.baris)).toBe(true);
  });

  test("kunci rincian yang tidak dikenal: 400 dengan kodeDomain, bukan daftar kosong", async () => {
    const res = await f.request("/dashboard/rincian?kunci=metrik:TIDAK_ADA", {
      cookie: cookieAdminPusat,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; kodeDomain?: string };
    // Registered in NAMA_ERROR_BERKODE, so the code survives the handler
    // instead of becoming an anonymous 500.
    expect(body.kodeDomain).toBe("RINCIAN_TIDAK_DIKENAL");
  });

  test("kunci wajib ada", async () => {
    const res = await f.request("/dashboard/rincian", { cookie: cookieAdminPusat });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    expect(body.detail.kunci?.[0]).toContain("wajib");
  });

  test("filter cacat dikumpulkan jadi SATU 400 dengan setiap field disebut", async () => {
    const res = await f.request(
      "/dashboard?cabangId=bukan-uuid&bulan=13&tahun=1800&hanyaMilikSaya=mungkin",
      { cookie: cookieAdminPusat },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: Record<string, string[]> };
    expect(Object.keys(body.detail).sort()).toEqual(
      ["bulan", "cabangId", "hanyaMilikSaya", "tahun"].sort(),
    );
  });

  test("periode yang tidak ada: 404, bukan bulan yang dikarang", async () => {
    const res = await f.request(`/dashboard?tahun=${TAHUN}&bulan=7`, {
      cookie: cookieAdminPusat,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { kodeDomain?: string };
    expect(body.kodeDomain).toBe("PERIODE_TIDAK_ADA");
  });

  test("cabang di luar scope: 403 dan sebuah baris DITOLAK", async () => {
    const res = await f.request(`/dashboard?cabangId=${f.cabangB.id}`, {
      cookie: cookieAdminCabang,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; kodeDomain?: string };
    expect(body.code).toBe("TIDAK_BERWENANG");
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");

    const ditolak = await f.auditRows({
      hasil: "DITOLAK",
      userId: f.users.ADMIN_CABANG.id,
    });
    const jalur = ditolak
      .map((r) => (r.nilai_baru_json as { path?: string } | null)?.path)
      .filter((p): p is string => typeof p === "string");
    expect(jalur).toContain("/dashboard");
  });

  test("MAKER boleh membuka halaman, tapi dua angka tetap absen", async () => {
    const res = await f.request("/dashboard", { cookie: cookieMaker });
    // NOT a 403. Gating the page on the two evidence codes would hide the nine
    // metrics a Maker may see in order to protect the two it may not.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrik: { kunci: string; nilai: string | null; alasanKosong: string | null }[];
      closing: { prasyarat: unknown; alasanKosong: string | null };
    };
    const anggaran = body.metrik.find((m) => m.kunci === "ANGGARAN_NON_PUMK")!;
    expect(anggaran.nilai).toBeNull();
    expect(anggaran.alasanKosong).toBe("IZIN_TIDAK_DIMILIKI");
    expect(body.closing.prasyarat).toBeNull();
    expect(body.closing.alasanKosong).toBe("IZIN_TIDAK_DIMILIKI");
  });

  test("AUDITOR: membaca semuanya, mengubah tidak satu pun (spec 16 skenario 23)", async () => {
    expect((await f.request("/dashboard", { cookie: cookieAuditor })).status).toBe(200);
    expect(
      (await f.request("/dashboard/periode", { cookie: cookieAuditor })).status,
    ).toBe(200);
    // There is no write route at all on this module, so the read-only guard has
    // nothing to refuse here: the property holds structurally.
    const post = await f.request("/dashboard", {
      method: "POST",
      cookie: cookieAuditor,
    });
    expect(post.status).toBeGreaterThanOrEqual(400);
  });

  test("subpath yang tidak ada: 404 dalam amplop API, bukan teks polos Hono", async () => {
    const res = await f.request("/dashboard/tidak-ada", { cookie: cookieAdminPusat });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("TIDAK_DITEMUKAN");
  });
});
