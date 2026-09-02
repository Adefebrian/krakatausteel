// The OFFICER half of /portal over HTTP, through the SAME app `createApp`
// builds for the server. Spec 2 rule 4: "Buat test yang memanggil endpoint
// langsung dengan role yang salah dan pastikan ditolak."
//
// What this file adds over ./portal-publik.test.ts:
//   - the two permission codes are the ones that actually ship, asserted by
//     calling with roles that do and do not hold them;
//   - every refusal arrives with its `kodeDomain` AND leaves a DITOLAK row in
//     `audit_log` (spec 2 rule 5). Four modules shipped without their error
//     class registered in core/http.ts's `NAMA_ERROR_BERKODE`, and the symptom
//     was exactly this: an anonymous 500 and no audit row;
//   - a submission of ANOTHER reporting entity is not readable by id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { nativeFetchApi } from "../../testing/native-fetch";

describe("portal: rute petugas", () => {
  let f: Fixture;
  let kodeEntitas = "";
  let cookieAdminPusat = "";
  let cookieMaker = "";
  let cookieChecker = "";
  let cookieAuditor = "";
  let submissionId = "";
  let noTiket = "";

  async function ajukan(nik: string): Promise<{ noTiket: string; id: string }> {
    const { Request: NativeRequest } = nativeFetchApi();
    const res = await f.ctx.app.fetch(
      new NativeRequest("http://localhost/portal/pengajuan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kodeEntitas,
          jenis: "PUMK",
          emailKontak: "pemohon@contoh.local",
          nik,
          formulir: {
            nama_lengkap: "Pemohon Antrean",
            nama_usaha: "Usaha Antrean",
            alamat: "Jl. Antrean 7",
            jumlah_diajukan: "12000000.00",
            tenor_diajukan: 18,
            tujuan_penggunaan: "Modal kerja",
          },
        }),
      }),
    );
    if (res.status !== 201) throw new Error(`ajukan gagal: ${res.status} ${await res.text()}`);
    const { noTiket: tiket } = (await res.json()) as { noTiket: string };
    const rows = await f.db.query<{ id: string }>(
      "select id::text as id from portal_submission where no_tiket = $1",
      [tiket],
    );
    return { noTiket: tiket, id: rows[0]!.id };
  }

  beforeAll(async () => {
    f = await createFixture({
      portalLimits: { pengajuanPerIp: 200, pengajuanPerIpHarian: 200, rutePengajuan: 200 },
    });
    const rows = await f.db.query<{ kode: string }>("select kode from bumn where id = $1::uuid", [
      f.bumnId,
    ]);
    kodeEntitas = rows[0]!.kode;
    cookieAdminPusat = await f.login(f.users.ADMIN_PUSAT.username);
    cookieMaker = await f.login(f.users.MAKER.username);
    cookieChecker = await f.login(f.users.CHECKER.username);
    cookieAuditor = await f.login(f.users.AUDITOR.username);
    const dibuat = await ajukan("3204010101900101");
    submissionId = dibuat.id;
    noTiket = dibuat.noTiket;
  });

  afterAll(async () => {
    await f.tutup();
  });

  test("tanpa sesi: 401 di antrean dan di detail", async () => {
    expect((await f.request("/portal/submission")).status).toBe(401);
    expect((await f.request(`/portal/submission/${submissionId}`)).status).toBe(401);
  });

  test("pemegang portal.view melihat antrean, dengan nomor tiket dan nama pemohon", async () => {
    const res = await f.request("/portal/submission", { cookie: cookieAdminPusat });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { noTiket: string; namaPemohon: string | null; sudahDikonversi: boolean }[];
    };
    const baris = body.data.find((b) => b.noTiket === noTiket);
    expect(baris).toBeDefined();
    expect(baris!.namaPemohon).toBe("Pemohon Antrean");
    expect(baris!.sudahDikonversi).toBe(false);
  });

  test("AUDITOR (read only) boleh membaca antrean: portal.view ada di daftarnya", async () => {
    const res = await f.request("/portal/submission", { cookie: cookieAuditor });
    expect(res.status).toBe(200);
  });

  test("AUDITOR tidak boleh menindak: mutasi ditolak secara struktural", async () => {
    const res = await f.request(`/portal/submission/${submissionId}/tindak`, {
      cookie: cookieAuditor,
      method: "POST",
      body: { tindakan: "DIPROSES" },
    });
    expect(res.status).toBe(403);
    const ditolak = await f.auditRows({ hasil: "DITOLAK", userId: f.users.AUDITOR.id });
    expect(ditolak.length).toBeGreaterThan(0);
  });

  test("CHECKER tidak memegang portal.konversi: 403 dengan baris DITOLAK", async () => {
    const res = await f.request(`/portal/submission/${submissionId}/tindak`, {
      cookie: cookieChecker,
      method: "POST",
      body: { tindakan: "DITOLAK", catatan: "Berkas tidak lengkap" },
    });
    expect(res.status).toBe(403);
    const ditolak = await f.auditRows({ hasil: "DITOLAK", userId: f.users.CHECKER.id });
    expect(
      ditolak.some(
        (r) =>
          (r.nilai_baru_json as { path?: string } | null)?.path ===
          `/portal/submission/${submissionId}/tindak`,
      ),
    ).toBe(true);
  });

  test("MAKER memegang portal.konversi: bisa menandai DIPROSES lalu DITOLAK", async () => {
    const diproses = await f.request(`/portal/submission/${submissionId}/tindak`, {
      cookie: cookieMaker,
      method: "POST",
      body: { tindakan: "DIPROSES", catatan: "Sedang diverifikasi petugas cabang" },
    });
    expect(diproses.status).toBe(200);
    expect(((await diproses.json()) as { status: string }).status).toBe("DIPROSES");

    const ditolak = await f.request(`/portal/submission/${submissionId}/tindak`, {
      cookie: cookieMaker,
      method: "POST",
      body: { tindakan: "DITOLAK" },
    });
    expect(ditolak.status).toBe(200);
    const body = (await ditolak.json()) as { status: string; catatanPetugas: string | null };
    expect(body.status).toBe("DITOLAK");
    // The earlier note survives a later action with no note of its own.
    expect(body.catatanPetugas).toBe("Sedang diverifikasi petugas cabang");
  });

  test("catatan petugas TIDAK bocor ke jawaban publik", async () => {
    const { Request: NativeRequest } = nativeFetchApi();
    const res = await f.ctx.app.fetch(
      new NativeRequest("http://localhost/portal/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noTiket, nik: "3204010101900101" }),
      }),
    );
    expect(res.status).toBe(200);
    const teks = await res.text();
    expect(teks).not.toContain("Sedang diverifikasi petugas cabang");
    expect(teks).toContain("DITOLAK");
  });

  test("submission milik ENTITAS LAIN tidak terbaca lewat id", async () => {
    const lain = await createFixture();
    const rows = await lain.db.query<{ kode: string }>(
      "select kode from bumn where id = $1::uuid",
      [lain.bumnId],
    );
    const { Request: NativeRequest } = nativeFetchApi();
    const buat = await lain.ctx.app.fetch(
      new NativeRequest("http://localhost/portal/pengajuan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kodeEntitas: rows[0]!.kode,
          jenis: "PUMK",
          emailKontak: "lain@contoh.local",
          nik: "3204010101900777",
          formulir: {
            nama_lengkap: "Pemohon Entitas Lain",
            nama_usaha: "Usaha Lain",
            alamat: "Jl. Lain 9",
            jumlah_diajukan: "9000000.00",
            tenor_diajukan: 12,
            tujuan_penggunaan: "Modal kerja",
          },
        }),
      }),
    );
    expect(buat.status).toBe(201);
    const { noTiket: tiketLain } = (await buat.json()) as { noTiket: string };
    const idLain = (
      await lain.db.query<{ id: string }>(
        "select id::text as id from portal_submission where no_tiket = $1",
        [tiketLain],
      )
    )[0]!.id;

    // An ADMIN_PUSAT of this fixture's entity, the widest staff principal
    // there is, still gets a not-found: the scope is in the QUERY.
    const res = await f.request(`/portal/submission/${idLain}`, { cookie: cookieAdminPusat });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { kodeDomain?: string };
    expect(body.kodeDomain).toBe("SUBMISSION_TIDAK_DITEMUKAN");
    await lain.tutup();
  });

  test("filter antrean yang cacat dikumpulkan jadi SATU 400 dengan setiap field disebut", async () => {
    const res = await f.request("/portal/submission?jenis=SALAH&status=SALAH&batasBaris=0", {
      cookie: cookieAdminPusat,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: Record<string, string[]> };
    expect(Object.keys(body.detail).sort()).toEqual(["batasBaris", "jenis", "status"]);
  });

  test("id submission yang bukan UUID: 400 VALIDASI, bukan 500 dari driver", async () => {
    const res = await f.request("/portal/submission/bukan-uuid", { cookie: cookieAdminPusat });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("VALIDASI");
  });

  test("path portal petugas yang tidak ada: 404 dalam amplop API", async () => {
    const res = await f.request("/portal/tidak-ada", { cookie: cookieAdminPusat });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { code: string }).code).toBe("TIDAK_DITEMUKAN");
  });
});
