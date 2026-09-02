// Spec 9.6 over HTTP, through the SAME app `createApp` builds for the server
// (apps/api/src/testing/harness.ts rule 1). Spec 2 rule 4: "Buat test yang
// memanggil endpoint langsung dengan role yang salah dan pastikan ditolak."
//
// What this file adds over the two engine files beside it:
//   - the guard chain, the error handler and the cookie policy are real;
//   - every refusal is checked to arrive with its `kodeDomain` AND to have
//     written a DITOLAK row to `audit_log` (spec 2 rule 5). Four modules
//     shipped without their error class registered in core/http.ts's
//     `NAMA_ERROR_BERKODE`, and the symptom was exactly this: an anonymous 500
//     and no audit row. This is the test that would have caught it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { PEMERIKSAAN_INTEGRITAS } from "./contract";

describe("tools: rute HTTP", () => {
  let f: Fixture;
  let cookieAdminPusat: string;
  let cookieAdminCabang: string;
  let cookieMaker: string;
  let cookieAuditor: string;

  beforeAll(async () => {
    f = await createFixture();
    // The reconciliation reads its receivable account from
    // `event_jurnal_mapping`; without the shipped mapping it would (correctly)
    // refuse, which is a different test.
    await seedCoaDanEventMapping(f.db, f.bumnId, f.users.ADMIN_PUSAT.id);
    cookieAdminPusat = await f.login(f.users.ADMIN_PUSAT.username);
    cookieAdminCabang = await f.login(f.users.ADMIN_CABANG.username);
    cookieMaker = await f.login(f.users.MAKER.username);
    cookieAuditor = await f.login(f.users.AUDITOR.username);
  });

  afterAll(async () => {
    await f.tutup();
  });

  test("tanpa sesi: 401 pada kedua halaman", async () => {
    expect((await f.request("/tools/integritas")).status).toBe(401);
    expect((await f.request("/tools/rekonsiliasi/piutang")).status).toBe(401);
  });

  test("ADMIN_PUSAT: health check menjawab sembilan pemeriksaan", async () => {
    const res = await f.request("/tools/integritas", { cookie: cookieAdminPusat });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sehat: boolean;
      hasil: { kode: string; lulus: boolean; sumber: string }[];
      cabangDiperiksa: string[];
    };
    expect(body.hasil).toHaveLength(9);
    expect(body.hasil.map((h) => h.kode)).toContain(
      PEMERIKSAAN_INTEGRITAS.SUB_LEDGER_PIUTANG_TIDAK_COCOK,
    );
    // A fresh entity with no akad and no journal is intact.
    expect(body.sehat).toBe(true);
    // Head office sees every branch of its own entity, and nothing else.
    expect(body.cabangDiperiksa.sort()).toEqual(
      [f.pusat.id, f.cabangA.id, f.cabangB.id].sort(),
    );
  });

  test("ADMIN_PUSAT: katalog terbaca sebelum pemeriksaan dijalankan", async () => {
    const res = await f.request("/tools/integritas/katalog", { cookie: cookieAdminPusat });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { kode: string; dijagaDatabase: boolean }[] };
    expect(body.data).toHaveLength(9);
    expect(body.data.filter((k) => k.dijagaDatabase)).toHaveLength(2);
  });

  test("satu pemeriksaan bisa dijalankan sendiri", async () => {
    const res = await f.request(
      `/tools/integritas/${PEMERIKSAAN_INTEGRITAS.NERACA_SALDO_TIDAK_SEIMBANG}`,
      { cookie: cookieAdminPusat },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kode: string; lulus: boolean; sumber: string };
    expect(body.kode).toBe(PEMERIKSAAN_INTEGRITAS.NERACA_SALDO_TIDAK_SEIMBANG);
    expect(body.sumber).toBe("v_ledger_baris");
    expect(body.lulus).toBe(true);
  });

  test("kode pemeriksaan yang tidak ada: 400 VALIDASI, bukan 200 hijau", async () => {
    const res = await f.request("/tools/integritas/TIDAK_ADA", { cookie: cookieAdminPusat });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    expect(body.detail.kode?.[0]).toContain("wajib salah satu dari");
  });

  test("filter cacat dikumpulkan jadi SATU 400 dengan setiap field disebut", async () => {
    const res = await f.request("/tools/integritas?cabangId=bukan-uuid&batasBaris=0", {
      cookie: cookieAdminPusat,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: Record<string, string[]> };
    expect(Object.keys(body.detail).sort()).toEqual(["batasBaris", "cabangId"]);
  });

  test("MAKER: 403 di kedua halaman, dan tiap penolakan menulis baris DITOLAK", async () => {
    const a = await f.request("/tools/integritas", { cookie: cookieMaker });
    expect(a.status).toBe(403);
    const b = await f.request("/tools/rekonsiliasi/piutang", { cookie: cookieMaker });
    expect(b.status).toBe(403);

    const ditolak = await f.auditRows({ hasil: "DITOLAK", userId: f.users.MAKER.id });
    const jalur = ditolak
      .map((r) => (r.nilai_baru_json as { path?: string } | null)?.path)
      .filter((p): p is string => typeof p === "string");
    expect(jalur).toContain("/tools/integritas");
    expect(jalur).toContain("/tools/rekonsiliasi/piutang");
  });

  /**
   * AUDITOR does NOT hold `tools.integritas` on the shipped grant matrix
   * (modules/auth/permissions.ts grants it to ADMIN_CABANG, and so to
   * ADMIN_PUSAT). Asserted as it SHIPS rather than quietly widened here:
   * whether the read-only evidence role should be able to open the health
   * check is a catalogue decision, and this module is not the place to make
   * it. Reported alongside this phase.
   */
  test("AUDITOR ditolak di health check, sesuai katalog izin yang dikirim", async () => {
    const res = await f.request("/tools/integritas", { cookie: cookieAuditor });
    expect(res.status).toBe(403);
  });

  test("ADMIN_CABANG: cabang lain di query DITOLAK 403 dengan kodeDomain", async () => {
    const res = await f.request(`/tools/integritas?cabangId=${f.cabangB.id}`, {
      cookie: cookieAdminCabang,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; kodeDomain?: string };
    expect(body.code).toBe("TIDAK_BERWENANG");
    // Without "ToolsError" in core/http.ts's NAMA_ERROR_BERKODE this would be
    // an anonymous 500 with no code and no audit row.
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");

    const ditolak = await f.auditRows({
      hasil: "DITOLAK",
      userId: f.users.ADMIN_CABANG.id,
    });
    expect(
      ditolak.some((r) => (r.keterangan ?? "").startsWith("CABANG_DILUAR_SCOPE")),
    ).toBe(true);
  });

  test("ADMIN_CABANG: tanpa filter, hanya cabangnya sendiri yang diperiksa", async () => {
    const res = await f.request("/tools/integritas", { cookie: cookieAdminCabang });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cabangDiperiksa: string[] };
    expect(body.cabangDiperiksa).toEqual([f.cabangA.id]);
  });

  test("rekonsiliasi menjawab dengan akun piutang dari event mapping", async () => {
    const res = await f.request("/tools/rekonsiliasi/piutang", {
      cookie: cookieAdminPusat,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      akunPiutangKode: string;
      cocok: boolean;
      jumlahAkadDiperiksa: number;
      baris: unknown[];
    };
    expect(body.akunPiutangKode).toBe("1.1.03");
    expect(body.cocok).toBe(true);
    expect(body.jumlahAkadDiperiksa).toBe(0);
    expect(body.baris).toEqual([]);
  });

  test("setiap rute tools menolak metode selain GET", async () => {
    for (const path of [
      "/tools/integritas",
      "/tools/rekonsiliasi/piutang",
      "/tools/integritas/katalog",
    ]) {
      const res = await f.request(path, { cookie: cookieAdminPusat, method: "POST" });
      // The catch-all `.all("/*")` answers a POST with the module's own 404:
      // there is no mutating route on this surface at all.
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("TIDAK_DITEMUKAN");
    }
  });

  test("path tools yang tidak ada: 404 dalam amplop API, bukan teks polos", async () => {
    const res = await f.request("/tools/tidak-ada", { cookie: cookieAdminPusat });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("TIDAK_DITEMUKAN");
  });
});
