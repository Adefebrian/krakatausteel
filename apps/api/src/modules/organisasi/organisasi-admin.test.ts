// The administration API for the organisation: users, branches, employees.
//
// WHAT THESE TESTS ARE ABOUT, and it is not CRUD.
//
//   1. A ROLE GRANT IS A PRIVILEGE GRANT. Nobody may hand out authority they do
//      not hold themselves, and nobody may re-grant their own. Both are proved
//      here against the real guard chain over HTTP, not against the service.
//   2. A BRANCH ADMIN IS BOUND TO ITS BRANCH, including when it invents an id.
//      Spec 2 rule 3 and spec 16 scenario 24, applied to the screen that
//      creates the accounts everyone else logs in with.
//   3. A PASSWORD IS HANDED OVER ONCE. It is shown once, hashed at rest, absent
//      from `audit_log`, and the account it opens can do nothing but replace
//      it. Same scheme as `modules/mitra`; deliberately not a second one.
//   4. EVERY CHANGE IS EVIDENCE. These rows decide what the rest of the system
//      means, so `audit_log` carries the before and the after.
import { afterAll, describe, expect, test } from "bun:test";
import { createFixture, extractSessionCookie, tutupSemuaFixture, TEST_PASSWORD } from "../../testing/harness";

afterAll(tutupSemuaFixture);

const SANDI_BARU = "GantiSandi#2026x";

/** Body of a response, typed loosely: these are HTTP contracts, not classes. */
async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("POST /organisasi/pengguna", () => {
  test("issues an account with a one-time password that is shown once and never stored in the clear", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);

    const res = await f.request("/organisasi/pengguna", {
      method: "POST",
      cookie,
      body: {
        username: `baru.${f.suffix}`,
        nama: "Pengguna Baru",
        email: `baru.${f.suffix}@uji.local`,
        nip: `N-${f.suffix}`,
        cabangId: f.cabangA.id,
        peran: [{ kode: "MAKER" }],
      },
    });
    expect(res.status).toBe(201);
    const body = await json<{ id: string; username: string; sandiSementara: string; harusGantiSandi: boolean }>(res);
    expect(body.harusGantiSandi).toBe(true);
    expect(typeof body.sandiSementara).toBe("string");
    expect(body.sandiSementara.length).toBeGreaterThanOrEqual(16);

    // Never at rest in the clear.
    const rows = await f.db.query<{ password_hash: string; harus_ganti_sandi: boolean }>(
      "SELECT password_hash, harus_ganti_sandi FROM app_user WHERE id = $1",
      [body.id],
    );
    expect(rows[0]!.password_hash).not.toContain(body.sandiSementara);
    expect(rows[0]!.password_hash.startsWith("$argon2id$")).toBe(true);
    expect(rows[0]!.harus_ganti_sandi).toBe(true);

    // Never in the audit trail: audit_log is readable by every holder of
    // `audit.view`, and this is a live credential for the length of a handover.
    const audit = await f.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_log WHERE nilai_baru_json::text LIKE $1",
      [`%${body.sandiSementara}%`],
    );
    expect(audit[0]!.n).toBe("0");

    // But the creation itself IS recorded, with what was granted.
    const jejak = await f.auditRows({ aksi: "organisasi.pengguna.buat" });
    expect(jejak.length).toBeGreaterThan(0);
    expect(JSON.stringify(jejak[0]!.nilai_baru_json)).toContain("MAKER");
  });

  test("the issued account may only change its own password until it does", async () => {
    const f = await createFixture();
    const admin = await f.login(f.users.ADMIN_PUSAT.username);
    const username = `wajib.${f.suffix}`;

    const dibuat = await json<{ sandiSementara: string }>(
      await f.request("/organisasi/pengguna", {
        method: "POST",
        cookie: admin,
        body: {
          username,
          nama: "Wajib Ganti",
          email: `${username}@uji.local`,
          cabangId: f.cabangA.id,
          peran: [{ kode: "MAKER" }],
        },
      }),
    );

    const masuk = await f.tryLogin(username, dibuat.sandiSementara);
    expect(masuk.status).toBe(200);
    const payload = await json<{ harusGantiSandi: boolean }>(masuk);
    expect(payload.harusGantiSandi).toBe(true);
    const sesi = extractSessionCookie(masuk)!;

    // Everything else is closed, including a plain read.
    const ditolak = await f.request("/pumk/proposal", { cookie: sesi });
    expect(ditolak.status).toBe(403);

    // AND A WRITE, which takes a different code path: the global
    // `enforceReadOnlyRoles` resolves the session for every mutating request,
    // so `requireSession` reaches its "already resolved" branch and the forced
    // change has to be checked there too. Checking only after a fresh resolve
    // would have left exactly the writes open.
    const tulisDitolak = await f.request("/pumk/proposal", {
      method: "POST",
      cookie: sesi,
      body: { nama: "apa saja" },
    });
    expect(tulisDitolak.status).toBe(403);

    // Its own identity stays readable, or the SPA cannot render the screen
    // that gets it out of this state.
    expect((await f.request("/auth/session", { cookie: sesi })).status).toBe(200);

    const ganti = await f.request("/auth/ganti-sandi", {
      method: "POST",
      cookie: sesi,
      body: { sandiLama: dibuat.sandiSementara, sandiBaru: SANDI_BARU },
    });
    expect(ganti.status).toBe(200);

    // Now the account works, and the old password does not.
    const sesiBaru = await f.login(username, SANDI_BARU);
    expect((await f.request("/pumk/proposal", { cookie: sesiBaru })).status).toBe(200);
    expect((await f.tryLogin(username, dibuat.sandiSementara)).status).toBe(401);
  });

  test("refuses a duplicate username or email with a 409, not a 500 from the index", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const body = {
      username: f.users.MAKER.username.toUpperCase(),
      nama: "Kembar",
      email: `kembar.${f.suffix}@uji.local`,
      cabangId: f.cabangA.id,
      peran: [{ kode: "MAKER" }],
    };
    const res = await f.request("/organisasi/pengguna", { method: "POST", cookie, body });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("KONFLIK");
  });

  test("refuses an account with no role at all", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request("/organisasi/pengguna", {
      method: "POST",
      cookie,
      body: {
        username: `tanpa.${f.suffix}`,
        nama: "Tanpa Peran",
        email: `tanpa.${f.suffix}@uji.local`,
        cabangId: f.cabangA.id,
        peran: [],
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("a role grant is a privilege grant", () => {
  test("a branch admin may grant a role whose authority it already holds", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_CABANG.username);
    const res = await f.request("/organisasi/pengguna", {
      method: "POST",
      cookie,
      body: {
        username: `maker2.${f.suffix}`,
        nama: "Maker Kedua",
        email: `maker2.${f.suffix}@uji.local`,
        cabangId: f.cabangA.id,
        peran: [{ kode: "MAKER" }],
      },
    });
    expect(res.status).toBe(201);
  });

  test("a branch admin may NOT grant Admin Pusat, and the refusal is audited", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_CABANG.username);
    const res = await f.request("/organisasi/pengguna", {
      method: "POST",
      cookie,
      body: {
        username: `naik.${f.suffix}`,
        nama: "Eskalasi",
        email: `naik.${f.suffix}@uji.local`,
        cabangId: f.cabangA.id,
        peran: [{ kode: "ADMIN_PUSAT" }],
      },
    });
    expect(res.status).toBe(403);
    const ditolak = await f.auditRows({ hasil: "DITOLAK", userId: f.users.ADMIN_CABANG.id });
    expect(ditolak.length).toBeGreaterThan(0);
  });

  test("a branch admin may NOT grant Auditor: it is a cross-branch role", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_CABANG.username);
    const res = await f.request("/organisasi/pengguna", {
      method: "POST",
      cookie,
      body: {
        username: `audit2.${f.suffix}`,
        nama: "Auditor Baru",
        email: `audit2.${f.suffix}@uji.local`,
        cabangId: f.cabangA.id,
        peran: [{ kode: "AUDITOR" }],
      },
    });
    expect(res.status).toBe(403);
  });

  test("nobody edits their own roles, not even Admin Pusat", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request(`/organisasi/pengguna/${f.users.ADMIN_PUSAT.id}/peran`, {
      method: "PUT",
      cookie,
      body: { peran: [{ kode: "ADMIN_PUSAT" }, { kode: "MAKER" }] },
    });
    expect(res.status).toBe(403);
  });

  test("nobody deactivates their own account", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request(`/organisasi/pengguna/${f.users.ADMIN_PUSAT.id}/status`, {
      method: "POST",
      cookie,
      body: { aktif: false },
    });
    expect(res.status).toBe(403);
  });

  test("GET /organisasi/peran tells the caller what it may actually grant", async () => {
    const f = await createFixture();
    const pusat = await f.login(f.users.ADMIN_PUSAT.username);
    const cabang = await f.login(f.users.ADMIN_CABANG.username);

    const bolehPusat = (
      await json<{ data: { kode: string; dapatDiberikan: boolean }[] }>(
        await f.request("/organisasi/peran", { cookie: pusat }),
      )
    ).data;
    expect(bolehPusat.every((r) => r.dapatDiberikan)).toBe(true);

    const bolehCabang = (
      await json<{ data: { kode: string; dapatDiberikan: boolean }[] }>(
        await f.request("/organisasi/peran", { cookie: cabang }),
      )
    ).data;
    const peta = new Map(bolehCabang.map((r) => [r.kode, r.dapatDiberikan]));
    expect(peta.get("MAKER")).toBe(true);
    expect(peta.get("CHECKER")).toBe(true);
    expect(peta.get("APPROVER")).toBe(true);
    expect(peta.get("ADMIN_PUSAT")).toBe(false);
    expect(peta.get("AUDITOR")).toBe(false);
  });
});

describe("a branch admin is bound to its branch", () => {
  test("cannot create a user in another branch", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_CABANG.username);
    const res = await f.request("/organisasi/pengguna", {
      method: "POST",
      cookie,
      body: {
        username: `lintas.${f.suffix}`,
        nama: "Lintas Cabang",
        email: `lintas.${f.suffix}@uji.local`,
        cabangId: f.cabangB.id,
        peran: [{ kode: "MAKER" }],
      },
    });
    expect(res.status).toBe(403);
  });

  test("cannot edit, deactivate or reset a user in another branch, by id", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_CABANG.username);
    const lain = f.users.MAKER_B.id;

    expect((await f.request(`/organisasi/pengguna/${lain}`, { cookie })).status).toBe(403);
    expect(
      (
        await f.request(`/organisasi/pengguna/${lain}`, {
          method: "PATCH",
          cookie,
          body: { nama: "Diambil Alih" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(`/organisasi/pengguna/${lain}/status`, {
          method: "POST",
          cookie,
          body: { aktif: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (await f.request(`/organisasi/pengguna/${lain}/sandi-sementara`, { method: "POST", cookie })).status,
    ).toBe(403);
  });

  test("cannot move a user of its own branch into another branch", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_CABANG.username);
    const res = await f.request(`/organisasi/pengguna/${f.users.MAKER.id}`, {
      method: "PATCH",
      cookie,
      body: { cabangId: f.cabangB.id },
    });
    expect(res.status).toBe(403);
  });

  test("the list only ever shows its own branch", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_CABANG.username);
    const data = (
      await json<{ data: { id: string; cabangId: string }[] }>(
        await f.request("/organisasi/pengguna", { cookie }),
      )
    ).data;
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((u) => u.cabangId === f.cabangA.id)).toBe(true);
  });
});

describe("deactivation, reset and the audit trail", () => {
  test("deactivating a user ends their live session on the next request", async () => {
    const f = await createFixture();
    const admin = await f.login(f.users.ADMIN_PUSAT.username);
    const korban = await f.login(f.users.MAKER.username);
    expect((await f.request("/auth/session", { cookie: korban })).status).toBe(200);

    const res = await f.request(`/organisasi/pengguna/${f.users.MAKER.id}/status`, {
      method: "POST",
      cookie: admin,
      body: { aktif: false, alasan: "pindah unit" },
    });
    expect(res.status).toBe(200);
    expect((await f.request("/auth/session", { cookie: korban })).status).toBe(401);
    expect((await f.tryLogin(f.users.MAKER.username, TEST_PASSWORD)).status).toBe(401);
  });

  test("a password reset issues a new one-time password and re-arms the forced change", async () => {
    const f = await createFixture();
    const admin = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request(`/organisasi/pengguna/${f.users.CHECKER.id}/sandi-sementara`, {
      method: "POST",
      cookie: admin,
    });
    expect(res.status).toBe(200);
    const { sandiSementara } = await json<{ sandiSementara: string }>(res);

    const masuk = await f.tryLogin(f.users.CHECKER.username, sandiSementara);
    expect(masuk.status).toBe(200);
    expect((await json<{ harusGantiSandi: boolean }>(masuk)).harusGantiSandi).toBe(true);
    // The password it replaced is dead.
    expect((await f.tryLogin(f.users.CHECKER.username, TEST_PASSWORD)).status).toBe(401);
  });

  test("an edit records what changed, from what to what", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request(`/organisasi/pengguna/${f.users.APPROVER.id}`, {
      method: "PATCH",
      cookie,
      body: { nama: "Nama Yang Diperbaiki" },
    });
    expect(res.status).toBe(200);

    const jejak = await f.auditRows({ aksi: "organisasi.pengguna.ubah" });
    expect(jejak.length).toBeGreaterThan(0);
    const baris = jejak[0]!;
    expect(JSON.stringify(baris.nilai_lama_json)).toContain("Uji APPROVER");
    expect(JSON.stringify(baris.nilai_baru_json)).toContain("Nama Yang Diperbaiki");
  });

  test("a stale version is a 409, not a silent overwrite", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const path = `/organisasi/pengguna/${f.users.MAKER.id}`;
    const awal = await json<{ version: number }>(await f.request(path, { cookie }));

    expect(
      (await f.request(path, { method: "PATCH", cookie, body: { nama: "Sekali", version: awal.version } }))
        .status,
    ).toBe(200);
    const kedua = await f.request(path, {
      method: "PATCH",
      cookie,
      body: { nama: "Dua Kali", version: awal.version },
    });
    expect(kedua.status).toBe(409);
  });
});

describe("who may reach this surface at all", () => {
  test("a Maker has konfigurasi.user for nothing and is refused", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.MAKER.username);
    const res = await f.request("/organisasi/pengguna", { cookie });
    expect(res.status).toBe(403);
  });

  test("the Auditor is refused every write structurally, by method", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.AUDITOR.username);
    for (const [method, path] of [
      ["POST", "/organisasi/pengguna"],
      ["POST", "/organisasi/cabang"],
      ["POST", "/organisasi/karyawan"],
    ] as const) {
      const res = await f.request(path, { method, cookie, body: {} });
      expect(res.status).toBe(403);
    }
  });

  test("the Auditor may READ the user list, because the audit trail names actors by id alone", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.AUDITOR.username);
    const res = await f.request("/organisasi/pengguna", { cookie });
    expect(res.status).toBe(200);
    const { data } = await json<{ data: { id: string; username: string }[] }>(res);
    // Cross-branch: the Auditor is exempt from branch scoping (spec 2 rule 3),
    // and the trail it reads spans every branch.
    expect(data.some((u) => u.id === f.users.MAKER.id)).toBe(true);
    expect(data.some((u) => u.id === f.users.MAKER_B.id)).toBe(true);
    // And nothing about a credential travels with it.
    expect(JSON.stringify(data)).not.toContain("password");
  });

  test("a branch admin cannot touch branches or employees: that is konfigurasi.master", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_CABANG.username);
    const res = await f.request("/organisasi/cabang", {
      method: "POST",
      cookie,
      body: { kode: "99", nama: "Cabang Baru" },
    });
    expect(res.status).toBe(403);
  });
});

describe("branches", () => {
  test("creates one, and it is immediately visible to the branch list every module reads", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request("/organisasi/cabang", {
      method: "POST",
      cookie,
      body: { kode: "07", nama: `Cabang Tujuh ${f.suffix}`, alamat: "Jalan Uji 7" },
    });
    expect(res.status).toBe(201);
    const dibuat = await json<{ id: string; kode: string; aktif: boolean }>(res);
    expect(dibuat.kode).toBe("07");
    expect(dibuat.aktif).toBe(true);

    const daftar = (
      await json<{ data: { id: string }[] }>(await f.request("/organisasi/cabang", { cookie }))
    ).data;
    expect(daftar.some((c) => c.id === dibuat.id)).toBe(true);
  });

  test("refuses a second head office", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request("/organisasi/cabang", {
      method: "POST",
      cookie,
      body: { kode: "08", nama: "Pusat Kedua", isPusat: true },
    });
    expect(res.status).toBe(409);
  });

  test("refuses to renumber a branch: the code is inside every document number it ever issued", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request(`/organisasi/cabang/${f.cabangA.id}`, {
      method: "PATCH",
      cookie,
      body: { kode: "77" },
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain("kode");
  });

  test("refuses to deactivate a branch that still has active users, and names the count", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request(`/organisasi/cabang/${f.cabangA.id}/status`, {
      method: "POST",
      cookie,
      body: { aktif: false },
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toMatch(/pengguna/i);
  });

  test("refuses to deactivate the head office at all", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request(`/organisasi/cabang/${f.pusat.id}/status`, {
      method: "POST",
      cookie,
      body: { aktif: false },
    });
    expect(res.status).toBe(409);
  });

  test("deactivates an empty branch, and it stops being offered while staying readable", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const dibuat = await json<{ id: string }>(
      await f.request("/organisasi/cabang", {
        method: "POST",
        cookie,
        body: { kode: "09", nama: `Cabang Sembilan ${f.suffix}` },
      }),
    );
    const res = await f.request(`/organisasi/cabang/${dibuat.id}/status`, {
      method: "POST",
      cookie,
      body: { aktif: false },
    });
    expect(res.status).toBe(200);
    expect((await json<{ aktif: boolean }>(res)).aktif).toBe(false);
    // Still readable: a branch that carried history never disappears.
    expect((await f.request(`/organisasi/cabang/${dibuat.id}`, { cookie })).status).toBe(200);
  });

  test("there is no DELETE for a branch", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request(`/organisasi/cabang/${f.cabangB.id}`, { method: "DELETE", cookie });
    expect(res.status).toBe(404);
  });
});

describe("employees", () => {
  test("creates, edits and deactivates one inside a branch", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const dibuat = await json<{ id: string; nama: string }>(
      await f.request("/organisasi/karyawan", {
        method: "POST",
        cookie,
        body: {
          cabangId: f.cabangA.id,
          nama: "Petugas Baru",
          nip: `NP-${f.suffix}`,
          jabatan: "Staf",
          unit: "TJSL",
        },
      }),
    );
    expect(dibuat.nama).toBe("Petugas Baru");

    const diubah = await f.request(`/organisasi/karyawan/${dibuat.id}`, {
      method: "PATCH",
      cookie,
      body: { jabatan: "Koordinator" },
    });
    expect(diubah.status).toBe(200);
    expect((await json<{ jabatan: string }>(diubah)).jabatan).toBe("Koordinator");

    const nonaktif = await f.request(`/organisasi/karyawan/${dibuat.id}/status`, {
      method: "POST",
      cookie,
      body: { aktif: false },
    });
    expect(nonaktif.status).toBe(200);
    expect((await json<{ aktif: boolean }>(nonaktif)).aktif).toBe(false);
  });

  test("refuses a duplicate NIP with a 409", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const nip = `NPX-${f.suffix}`;
    const body = { cabangId: f.cabangA.id, nama: "Kembar Satu", nip };
    expect((await f.request("/organisasi/karyawan", { method: "POST", cookie, body })).status).toBe(201);
    const res = await f.request("/organisasi/karyawan", {
      method: "POST",
      cookie,
      body: { ...body, nama: "Kembar Dua" },
    });
    expect(res.status).toBe(409);
  });
});
