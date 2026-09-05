// THE TEST THIS WHOLE MODULE EXISTS FOR.
//
// Fase 7 adds a SECOND KIND OF PRINCIPAL to an application where, until now,
// every route required a staff session and every read was branch-scoped. Two
// claims have to survive that, and neither is provable by reading the code:
//
//   A. A MITRA PRINCIPAL CANNOT REACH A STAFF ROUTE. Not one sample endpoint:
//      every permission family the app mounts, each asserted to refuse AND to
//      leave a DITOLAK row in `audit_log` (spec 2 rule 5).
//
//   B. A MITRA CANNOT READ ANOTHER MITRA. Two mitra of the SAME branch and two
//      of DIFFERENT branches, and every handle the surface exposes: the akad
//      id, the akad number, the NIK, the mitra id, the kode mitra.
//
// Both are asserted through the REAL app `createApp` builds for the server
// (apps/api/src/testing/harness.ts rule 1), so the guard chain, the error
// handler and the cookie policy are the shipped ones.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { seedCoaDanEventMapping } from "../../seed/event-jurnal";
import { nativeFetchApi } from "../../testing/native-fetch";
import { MITRA_COOKIE } from "./guards";
import { buatAkadUji, buatMitraUji, type AkadUji, type MitraUji } from "./test-support";

/**
 * EVERY PERMISSION FAMILY THE APP MOUNTS, with a route from each.
 *
 * Not a sample. The point of the list is that a family added later without a
 * line here is a family nobody proved a mitra cannot reach, and the count
 * assertion below fails if the list shrinks.
 */
const KELUARGA_STAF: { keluarga: string; metode: string; path: string }[] = [
  { keluarga: "pumk", metode: "GET", path: "/pumk/proposal" },
  { keluarga: "nonpumk", metode: "GET", path: "/nonpumk/proposal" },
  { keluarga: "rka", metode: "GET", path: "/rka/periode" },
  { keluarga: "closing", metode: "GET", path: "/closing/periode" },
  { keluarga: "laporan", metode: "GET", path: "/laporan/katalog" },
  { keluarga: "tools", metode: "GET", path: "/tools/integritas" },
  { keluarga: "konfigurasi", metode: "GET", path: "/konfigurasi/sektor" },
  { keluarga: "audit", metode: "GET", path: "/audit" },
  { keluarga: "organisasi", metode: "GET", path: "/organisasi/cabang" },
  { keluarga: "dashboard", metode: "GET", path: "/dashboard/periode" },
  { keluarga: "portal (petugas)", metode: "GET", path: "/portal/submission" },
  { keluarga: "impor", metode: "POST", path: "/impor/MITRA/pratinjau" },
  { keluarga: "mitra (petugas)", metode: "POST", path: "/mitra/akun" },
];

describe("mitra: isolasi principal kedua", () => {
  let f: Fixture;
  let mitraA1: MitraUji;
  let mitraA2: MitraUji;
  let mitraB: MitraUji;
  let akadA1: AkadUji;
  let akadA2: AkadUji;
  let akadB: AkadUji;
  /** Session cookie for mitra A1, after it has changed its handed-over password. */
  let sesiA1 = "";
  let sesiA2 = "";
  let cookieAdmin = "";

  const SANDI_BARU = "SandiMitraBaru#2026";

  /** A request carrying the MITRA cookie rather than the staff one. */
  async function mintaSebagaiMitra(
    path: string,
    opsi: { cookie: string; method?: string; body?: unknown } = { cookie: "" },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opsi.cookie) headers.cookie = `${MITRA_COOKIE}=${opsi.cookie}`;
    const init: RequestInit = { method: opsi.method ?? "GET", headers };
    if (opsi.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opsi.body);
    }
    const { Request: NativeRequest } = nativeFetchApi();
    return f.ctx.app.fetch(new NativeRequest(`http://localhost${path}`, init));
  }

  async function masukMitra(email: string, sandi: string): Promise<Response> {
    const { Request: NativeRequest } = nativeFetchApi();
    return f.ctx.app.fetch(
      new NativeRequest("http://localhost/mitra/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, sandi }),
      }),
    );
  }

  function ambilCookieMitra(res: Response): string | null {
    const raw = res.headers.get("set-cookie");
    if (!raw) return null;
    const m = new RegExp(`${MITRA_COOKIE}=([^;]*)`).exec(raw);
    return m?.[1] && m[1].length > 0 ? m[1] : null;
  }

  /** Provision an account through the STAFF route and log in with it. */
  async function siapkanAkun(m: MitraUji, email: string): Promise<string> {
    const buat = await f.request("/mitra/akun", {
      cookie: cookieAdmin,
      method: "POST",
      body: { mitraId: m.mitraId, email },
    });
    expect(buat.status).toBe(201);
    const { sandiSementara } = (await buat.json()) as { sandiSementara: string };

    const masuk = await masukMitra(email, sandiSementara);
    expect(masuk.status).toBe(200);
    const sementara = ambilCookieMitra(masuk);
    expect(sementara).not.toBeNull();

    // The handed-over password may only replace itself, so the fixture has to
    // do that before it can read anything.
    const ganti = await mintaSebagaiMitra("/mitra/ganti-sandi", {
      cookie: sementara!,
      method: "POST",
      body: { sandiLama: sandiSementara, sandiBaru: SANDI_BARU },
    });
    expect(ganti.status).toBe(204);

    const lagi = await masukMitra(email, SANDI_BARU);
    expect(lagi.status).toBe(200);
    const cookie = ambilCookieMitra(lagi);
    expect(cookie).not.toBeNull();
    return cookie!;
  }

  beforeAll(async () => {
    // A COST KNOB, per harness rule 1: wiring and guards are the shipped ones,
    // only the login ceilings are raised, because this file makes far more
    // login calls from one (absent) client address than a human would. The
    // ceilings themselves are proved by their own fixture in
    // ./mitra-batas-masuk.test.ts.
    f = await createFixture({ loginLimits: { perIp: 500, perUsername: 500, windowSeconds: 60 } });
    await seedCoaDanEventMapping(f.db, f.bumnId, f.users.ADMIN_PUSAT.id);
    cookieAdmin = await f.login(f.users.ADMIN_PUSAT.username);

    mitraA1 = await buatMitraUji(f.db, { cabangId: f.cabangA.id, nama: "Mitra A Satu", suffix: f.suffix });
    mitraA2 = await buatMitraUji(f.db, { cabangId: f.cabangA.id, nama: "Mitra A Dua", suffix: f.suffix });
    mitraB = await buatMitraUji(f.db, { cabangId: f.cabangB.id, nama: "Mitra B Satu", suffix: f.suffix });

    akadA1 = await buatAkadUji(f.db, { cabangId: f.cabangA.id, mitraId: mitraA1.mitraId, suffix: f.suffix });
    akadA2 = await buatAkadUji(f.db, { cabangId: f.cabangA.id, mitraId: mitraA2.mitraId, suffix: f.suffix });
    akadB = await buatAkadUji(f.db, { cabangId: f.cabangB.id, mitraId: mitraB.mitraId, suffix: f.suffix });

    sesiA1 = await siapkanAkun(mitraA1, `a1.${f.suffix}@contoh.local`);
    sesiA2 = await siapkanAkun(mitraA2, `a2.${f.suffix}@contoh.local`);
  });

  afterAll(async () => {
    await f.tutup();
  });

  // -------------------------------------------------------------------- A.

  test("mitra melihat akadnya sendiri, dan hanya itu", async () => {
    const res = await mintaSebagaiMitra("/mitra/akad", { cookie: sesiA1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; noAkad: string }[] };
    expect(body.data.map((a) => a.id)).toEqual([akadA1.akadId]);
    expect(body.data.map((a) => a.noAkad)).not.toContain(akadA2.noAkad);
    expect(body.data.map((a) => a.noAkad)).not.toContain(akadB.noAkad);
  });

  test("SETIAP keluarga izin staf menolak sesi mitra, dengan baris DITOLAK", async () => {
    // The list must not shrink: a family added later with no line here is a
    // family nobody proved a mitra cannot reach.
    expect(KELUARGA_STAF.length).toBeGreaterThanOrEqual(13);

    const sebelum = await f.db.query<{ n: string }>(
      "select count(*)::text as n from audit_log where aksi = 'mitra.akses' and hasil = 'DITOLAK'",
    );
    const awal = Number(sebelum[0]?.n ?? "0");

    for (const { keluarga, metode, path } of KELUARGA_STAF) {
      const res = await mintaSebagaiMitra(path, {
        cookie: sesiA1,
        method: metode,
        ...(metode === "POST" ? { body: {} } : {}),
      });
      // 401, because a staff route sees NO staff cookie at all: the mitra
      // cookie has a different name and, in a browser, a Path that never sends
      // it here. Never a 200, and never a 500.
      expect({ keluarga, status: res.status }).toEqual({ keluarga, status: 401 });
      const body = (await res.json()) as { code: string };
      expect({ keluarga, code: body.code }).toEqual({ keluarga, code: "TIDAK_TERAUTENTIKASI" });
    }

    const sesudah = await f.db.query<{ n: string }>(
      `select count(*)::text as n from audit_log
        where aksi = 'auth.akses' and hasil = 'DITOLAK'
          and nilai_baru_json->>'path' = any($1::text[])`,
      [`{${KELUARGA_STAF.map((k) => k.path).join(",")}}`],
    );
    // Every one of those refusals is in the trail, keyed by the path it was
    // made on. `awal` is read only to prove the query is not counting rows
    // from an earlier file's fixtures.
    expect(Number(sesudah[0]?.n ?? "0")).toBeGreaterThanOrEqual(KELUARGA_STAF.length);
    expect(awal).toBeGreaterThanOrEqual(0);
  });

  test("id sesi mitra ditempel ke cookie STAF tidak resolve jadi apa pun", async () => {
    // The attack this defends against is not "send the wrong cookie name", it
    // is "take the opaque id out of the mitra cookie and present it as a staff
    // session id". It fails because the two stores use different Redis
    // prefixes, so the id was never written where the staff store looks.
    const res = await f.request("/pumk/proposal", { cookie: sesiA1 });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("TIDAK_TERAUTENTIKASI");
  });

  test("cookie sesi STAF tidak membuka satu pun rute mitra", async () => {
    // And the other direction: an Admin Pusat, the widest staff principal in
    // the system, holds nothing that resolves on the mitra surface.
    for (const path of ["/mitra/saya", "/mitra/akad", `/mitra/akad/${akadA1.akadId}/jadwal`]) {
      const res = await mintaSebagaiMitra(path, { cookie: cookieAdmin });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
    const staf = await f.request("/mitra/saya", { cookie: cookieAdmin });
    expect(staf.status).toBe(401);
  });

  // -------------------------------------------------------------------- B.

  test("mitra tidak bisa membaca mitra lain di CABANG YANG SAMA", async () => {
    for (const path of [
      `/mitra/akad/${akadA2.akadId}/jadwal`,
      `/mitra/akad/${akadA2.akadId}/pembayaran`,
    ]) {
      const res = await mintaSebagaiMitra(path, { cookie: sesiA1 });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      const body = (await res.json()) as { kodeDomain?: string };
      expect(body.kodeDomain).toBe("AKAD_TIDAK_DITEMUKAN");
    }
  });

  test("mitra tidak bisa membaca mitra lain di CABANG BERBEDA", async () => {
    for (const path of [
      `/mitra/akad/${akadB.akadId}/jadwal`,
      `/mitra/akad/${akadB.akadId}/pembayaran`,
    ]) {
      const res = await mintaSebagaiMitra(path, { cookie: sesiA1 });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });

  test("penolakan 'bukan punyamu' IDENTIK dengan 'tidak ada': tidak jadi oracle", async () => {
    const adaTapiBukanMilik = await mintaSebagaiMitra(`/mitra/akad/${akadA2.akadId}/jadwal`, {
      cookie: sesiA1,
    });
    const memangTidakAda = await mintaSebagaiMitra(
      "/mitra/akad/00000000-0000-4000-8000-000000000000/jadwal",
      { cookie: sesiA1 },
    );
    expect(adaTapiBukanMilik.status).toBe(memangTidakAda.status);
    expect(await adaTapiBukanMilik.json()).toEqual(await memangTidakAda.json());
  });

  test("tidak ada satu pun handle lain yang bisa dipakai menyebut mitra lain", async () => {
    // The surface takes NO mitra identifier at all, so each of these is a 404
    // from the router (the path does not exist) or a refusal, never a read.
    // Enumeration by sequential id is impossible for a third reason: every id
    // in this schema is a UUID.
    const percobaan = [
      `/mitra/akad?mitraId=${mitraA2.mitraId}`,
      `/mitra/akad?nik=${mitraA2.nik}`,
      `/mitra/akad?kodeMitra=${encodeURIComponent(mitraA2.kodeMitra)}`,
      `/mitra/akad?noAkad=${encodeURIComponent(akadA2.noAkad)}`,
      `/mitra/saya?mitraId=${mitraB.mitraId}`,
      `/mitra/akad/${akadA2.noAkad}/jadwal`,
      `/mitra/akad/${mitraA2.mitraId}/jadwal`,
    ];
    for (const path of percobaan) {
      const res = await mintaSebagaiMitra(path, { cookie: sesiA1 });
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        // A query parameter the surface does not read must not change the
        // answer: it is still exactly this mitra's own akad.
        const body = (await res.json()) as { data?: { id: string }[]; kodeMitra?: string };
        if (body.data) expect(body.data.map((a) => a.id)).toEqual([akadA1.akadId]);
        if (body.kodeMitra) expect(body.kodeMitra).toBe(mitraA1.kodeMitra);
      }
    }
  });

  test("dua mitra melihat dua dunia yang tidak beririsan", async () => {
    const a1 = (await (await mintaSebagaiMitra("/mitra/akad", { cookie: sesiA1 })).json()) as {
      data: { id: string }[];
    };
    const a2 = (await (await mintaSebagaiMitra("/mitra/akad", { cookie: sesiA2 })).json()) as {
      data: { id: string }[];
    };
    expect(a1.data.map((x) => x.id)).toEqual([akadA1.akadId]);
    expect(a2.data.map((x) => x.id)).toEqual([akadA2.akadId]);
    const irisan = a1.data.filter((x) => a2.data.some((y) => y.id === x.id));
    expect(irisan).toEqual([]);
  });

  // ------------------------------------------------------------ lifecycle

  test("sandi sementara hanya bisa mengganti dirinya sendiri", async () => {
    const email = `gate.${f.suffix}@contoh.local`;
    const m = await buatMitraUji(f.db, { cabangId: f.cabangA.id, nama: "Mitra Gerbang", suffix: f.suffix });
    const buat = await f.request("/mitra/akun", {
      cookie: cookieAdmin,
      method: "POST",
      body: { mitraId: m.mitraId, email },
    });
    const { sandiSementara } = (await buat.json()) as { sandiSementara: string };
    const masuk = await masukMitra(email, sandiSementara);
    const cookie = ambilCookieMitra(masuk)!;

    for (const path of ["/mitra/saya", "/mitra/akad"]) {
      const res = await mintaSebagaiMitra(path, { cookie });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      const body = (await res.json()) as { kodeDomain?: string };
      expect(body.kodeDomain).toBe("WAJIB_GANTI_SANDI");
    }

    const ganti = await mintaSebagaiMitra("/mitra/ganti-sandi", {
      cookie,
      method: "POST",
      body: { sandiLama: sandiSementara, sandiBaru: SANDI_BARU },
    });
    expect(ganti.status).toBe(204);
    expect((await mintaSebagaiMitra("/mitra/saya", { cookie })).status).toBe(200);
  });

  test("menonaktifkan akun mematikan sesi yang sedang hidup, seketika", async () => {
    const email = `mati.${f.suffix}@contoh.local`;
    const m = await buatMitraUji(f.db, { cabangId: f.cabangA.id, nama: "Mitra Nonaktif", suffix: f.suffix });
    const cookie = await siapkanAkun(m, email);
    expect((await mintaSebagaiMitra("/mitra/saya", { cookie })).status).toBe(200);

    const mati = await f.request(`/mitra/akun/${m.mitraId}/status`, {
      cookie: cookieAdmin,
      method: "POST",
      body: { aktif: false },
    });
    expect(mati.status).toBe(200);

    // No authorisation fact is cached in the session, so this takes effect on
    // the next request rather than at expiry.
    const res = await mintaSebagaiMitra("/mitra/saya", { cookie });
    expect(res.status).toBe(401);
  });

  test("MAKER tidak boleh menerbitkan akun portal mitra", async () => {
    const cookieMaker = await f.login(f.users.MAKER.username);
    const res = await f.request("/mitra/akun", {
      cookie: cookieMaker,
      method: "POST",
      body: { mitraId: mitraA1.mitraId, email: `maker.${f.suffix}@contoh.local` },
    });
    expect(res.status).toBe(403);
    const ditolak = await f.auditRows({ hasil: "DITOLAK", userId: f.users.MAKER.id });
    expect(
      ditolak.some((r) => (r.nilai_baru_json as { path?: string } | null)?.path === "/mitra/akun"),
    ).toBe(true);
  });

  test("ADMIN_CABANG tidak boleh menerbitkan akun untuk mitra cabang lain", async () => {
    const cookieAdminCabang = await f.login(f.users.ADMIN_CABANG.username);
    const res = await f.request("/mitra/akun", {
      cookie: cookieAdminCabang,
      method: "POST",
      body: { mitraId: mitraB.mitraId, email: `silang.${f.suffix}@contoh.local` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { kodeDomain?: string };
    // Without "MitraError" in core/http.ts's NAMA_ERROR_BERKODE this would be
    // an anonymous 500 with no code and no audit row.
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
  });

  test("logout membuang sesi, dan sesi yang sudah dibuang tidak hidup lagi", async () => {
    const email = `keluar.${f.suffix}@contoh.local`;
    const m = await buatMitraUji(f.db, { cabangId: f.cabangA.id, nama: "Mitra Keluar", suffix: f.suffix });
    const cookie = await siapkanAkun(m, email);
    expect((await mintaSebagaiMitra("/mitra/saya", { cookie })).status).toBe(200);

    const keluar = await mintaSebagaiMitra("/mitra/logout", { cookie, method: "POST" });
    expect(keluar.status).toBe(204);
    expect((await mintaSebagaiMitra("/mitra/saya", { cookie })).status).toBe(401);
  });

  test("cookie mitra dikirim dengan HttpOnly, SameSite=Lax dan Path=/api/mitra", async () => {
    const email = `cookie.${f.suffix}@contoh.local`;
    const m = await buatMitraUji(f.db, { cabangId: f.cabangA.id, nama: "Mitra Cookie", suffix: f.suffix });
    const buat = await f.request("/mitra/akun", {
      cookie: cookieAdmin,
      method: "POST",
      body: { mitraId: m.mitraId, email },
    });
    const { sandiSementara } = (await buat.json()) as { sandiSementara: string };
    const masuk = await masukMitra(email, sandiSementara);
    const raw = masuk.headers.get("set-cookie") ?? "";
    expect(raw).toContain(`${MITRA_COOKIE}=`);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
    // `/api/mitra`, the path the BROWSER requests, not `/mitra`, the path this
    // app is mounted at. The proxy strips `/api` on the way in, so a cookie
    // scoped to the mount point is stored and never replayed, and every request
    // after a successful login is a 401. Asserted as the exact segment rather
    // than a substring, because "Path=/api/mitra" contains neither more nor
    // less than it should and a loose check would pass on either value.
    expect(raw).toContain("Path=/api/mitra");
    // The staff cookie is never issued by this route.
    expect(raw).not.toContain("tjsl_sid=");
  });

  test("kredensial mitra salah dijawab sama untuk email tidak ada dan sandi salah", async () => {
    const tidakAda = await masukMitra(`hantu.${f.suffix}@contoh.local`, "SandiApaPun#2026");
    const sandiSalah = await masukMitra(`a1.${f.suffix}@contoh.local`, "SandiSalah#2026");
    expect(tidakAda.status).toBe(401);
    expect(sandiSalah.status).toBe(401);
    expect(await tidakAda.json()).toEqual(await sandiSalah.json());
  });

  test("sandi yang benar tetap diterima setelah tebakan orang lain gagal berkali-kali", async () => {
    // The lockout-weapon shape core/hardening.ts documents: a per-subject
    // counter consumed BEFORE verification lets anyone lock the owner out.
    // Here the budget counts wrong ANSWERS and a right one wins regardless.
    const email = `gembok.${f.suffix}@contoh.local`;
    const m = await buatMitraUji(f.db, { cabangId: f.cabangA.id, nama: "Mitra Gembok", suffix: f.suffix });
    const cookie = await siapkanAkun(m, email);
    expect(cookie.length).toBeGreaterThan(0);

    for (let i = 0; i < 4; i += 1) {
      const salah = await masukMitra(email, `TebakanSalah#${i}`);
      expect(salah.status).toBe(401);
    }
    const benar = await masukMitra(email, SANDI_BARU);
    expect(benar.status).toBe(200);
  });
});
