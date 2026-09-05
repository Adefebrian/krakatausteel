// Spec 2 rule 4, on the journal routes: call every endpoint with the wrong
// role and with the wrong branch, and check it is REFUSED rather than merely
// unlinked from a menu.
//
// This matters more here than on any other router. The ledger is the one place
// where "who may do this" is not a preference: the Maker who files an entry
// must not be able to verify it, the Checker who verifies it must not be able
// to post it, and the right to reverse a POSTED journal is a code of its own
// precisely so that posting does not silently include it. Every one of those is
// asserted below through a real session, not through a hand-built context.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buatDuniaRuteJurnal,
  rp,
  tutupSemuaFixture,
  type DuniaRuteJurnal,
  type JurnalHttp,
} from "./rute-test-support";

let d: DuniaRuteJurnal;
let tanggal = "";
/** A DRAFT in branch A, remade per test that consumes it. */
async function draftBaru(): Promise<JurnalHttp> {
  return d.ok<JurnalHttp>("MAKER", "/jurnal", {
    body: d.bodyUmum(tanggal, rp(90_000), "Draft untuk uji otorisasi"),
  });
}
async function postedBaru(): Promise<JurnalHttp> {
  const draft = await draftBaru();
  await d.ok("CHECKER", `/jurnal/${draft.id}/verifikasi`, { body: {} });
  return d.ok<JurnalHttp>("APPROVER", `/jurnal/${draft.id}/posting`, { body: {} });
}

beforeAll(async () => {
  d = await buatDuniaRuteJurnal();
  tanggal = "2026-04-10";
});

afterAll(async () => {
  await tutupSemuaFixture();
});

describe("izin per rute, spec 2 rule 4", () => {
  test("membuat jurnal: hanya peran yang memegang jurnal.create", async () => {
    for (const role of ["CHECKER", "APPROVER"]) {
      const ditolak = await d.tolak(role, "/jurnal", { body: d.bodyUmum(tanggal, rp(10_000)) });
      expect([role, ditolak.status]).toEqual([role, 403]);
    }
    expect((await d.panggil("MAKER", "/jurnal", { body: d.bodyUmum(tanggal, rp(10_000)) })).status)
      .toBe(201);
  });

  test("verifikasi hanya Checker, dan pembuatnya sendiri tetap ditolak meski peran lain memegangnya", async () => {
    const a = await draftBaru();
    expect((await d.tolak("APPROVER", `/jurnal/${a.id}/verifikasi`, { body: {} })).status).toBe(403);
    // The Maker HOLDS no `jurnal.verify` either, so this is the permission
    // refusing first. The segregation refusal on top of it, for a user who does
    // hold the code, is asserted in ./jurnal-rute-alur.test.ts.
    expect((await d.tolak("MAKER", `/jurnal/${a.id}/verifikasi`, { body: {} })).status).toBe(403);
    expect((await d.panggil("CHECKER", `/jurnal/${a.id}/verifikasi`, { body: {} })).status).toBe(200);
  });

  test("posting hanya Approver: Maker dan Checker ditolak dan jurnalnya tetap DRAFT", async () => {
    const a = await draftBaru();
    for (const role of ["MAKER", "CHECKER"]) {
      const ditolak = await d.tolak(role, `/jurnal/${a.id}/posting`, { body: {} });
      expect([role, ditolak.status]).toEqual([role, 403]);
    }
    expect(await d.statusJurnal(a.id)).toBe("DRAFT");
    expect((await d.panggil("APPROVER", `/jurnal/${a.id}/posting`, { body: {} })).status).toBe(200);
  });

  /**
   * `jurnal.reversal` IS ITS OWN RIGHT. The Approver holds both codes in the
   * shipped RBAC, so this cannot be shown by a role that lacks one; it is shown
   * by REVOKING `jurnal.reversal` from the role and watching the same session
   * keep posting and lose reversing. That is the whole reason the code exists:
   * the two can be separated tomorrow.
   */
  test("membalik jurnal adalah hak tersendiri, bukan efek samping dari hak posting", async () => {
    const asli = await postedBaru();
    const db = d.f.db;
    await db.query(
      `DELETE FROM role_permission
        WHERE role_id = (SELECT id FROM app_role WHERE kode = 'APPROVER' AND deleted_at IS NULL)
          AND permission_id = (SELECT id FROM permission WHERE kode = 'jurnal.reversal')`,
    );
    try {
      // No re-login: permissions are resolved per request, never cached in the
      // session (modules/auth/auth.test.ts pins that), so the SAME cookie now
      // carries one code fewer.
      const res = await d.tolak("APPROVER", `/jurnal/${asli.id}/pembalik`, {
        body: { alasan: "Percobaan membalik tanpa hak pembalik" },
      });
      expect(res.status).toBe(403);
      // And posting, which the same session still holds, is unaffected.
      const lain = await draftBaru();
      await d.ok("CHECKER", `/jurnal/${lain.id}/verifikasi`, { body: {} });
      expect((await d.panggil("APPROVER", `/jurnal/${lain.id}/posting`, { body: {} })).status)
        .toBe(200);
      expect(await d.statusJurnal(asli.id)).toBe("POSTED");
    } finally {
      // Restored, or every later file that expects an Approver to hold the code
      // fails for a reason that has nothing to do with it.
      await db.query(
        `INSERT INTO role_permission (role_id, permission_id)
         SELECT r.id, p.id FROM app_role r, permission p
          WHERE r.kode = 'APPROVER' AND r.deleted_at IS NULL AND p.kode = 'jurnal.reversal'
         ON CONFLICT DO NOTHING`,
      );
    }
  });
});

describe("Auditor: read only penuh, spec 16 skenario 23", () => {
  test("membaca daftar dan detail, dan setiap rute tulis ditolak", async () => {
    const asli = await postedBaru();

    const daftar = await d.ok<{ data: unknown[] }>("AUDITOR", "/jurnal");
    expect(Array.isArray(daftar.data)).toBe(true);
    expect((await d.panggil("AUDITOR", `/jurnal/${asli.id}`)).status).toBe(200);

    const tulis: Array<[string, string, unknown]> = [
      ["POST", "/jurnal", d.bodyUmum(tanggal, rp(1_000))],
      ["PUT", `/jurnal/${asli.id}`, d.bodyUmum(tanggal, rp(1_000))],
      ["POST", `/jurnal/${asli.id}/batal`, {}],
      ["POST", `/jurnal/${asli.id}/verifikasi`, {}],
      ["POST", `/jurnal/${asli.id}/posting`, {}],
      ["POST", "/jurnal/posting-batch", { ids: [asli.id] }],
      ["POST", `/jurnal/${asli.id}/pembalik`, { alasan: "Auditor tidak boleh membalik apa pun" }],
    ];
    for (const [method, path, body] of tulis) {
      const res = await d.panggil("AUDITOR", path, { method, body });
      expect([`${method} ${path}`, res.status]).toEqual([`${method} ${path}`, 403]);
    }
    // Nothing moved.
    expect(await d.statusJurnal(asli.id)).toBe("POSTED");
  });
});

describe("lingkup cabang, spec 2 rule 3 dan spec 16 skenario 24", () => {
  test("jurnal cabang lain: 404 pada pembacaan, bukan 403 yang membocorkan keberadaannya", async () => {
    const asli = await postedBaru();
    // MAKER_B lives in branch B and holds every Maker code; the only thing it
    // lacks is this row's branch. A 403 here would confirm that the id names a
    // real document somewhere, which is the enumeration branch scope exists to
    // prevent.
    const dibaca = await d.tolak("MAKER_B", `/jurnal/${asli.id}`);
    expect([dibaca.status, dibaca.kodeDomain]).toEqual([404, "JURNAL_TIDAK_DITEMUKAN"]);
    // And it is absent from the list, rather than the list being empty.
    const daftar = await d.ok<{ data: Array<{ id: string }> }>("MAKER_B", "/jurnal");
    expect(daftar.data.map((j) => j.id)).not.toContain(asli.id);
  });

  test("menulis jurnal ke cabang lain ditolak, meski izinnya lengkap", async () => {
    const ditolak = await d.tolak("MAKER_B", "/jurnal", {
      body: d.bodyUmum(tanggal, rp(20_000)),
    });
    // `cabangId` in the body is the journal's HEADER branch and the engine
    // checks it against the session's scope (validation 6.2.7). It is never
    // authority.
    expect([ditolak.status, ditolak.kodeDomain]).toEqual([403, "CABANG_DILUAR_SCOPE"]);
  });

  test("membatalkan dan membalik dokumen cabang lain ditolak", async () => {
    const draft = await draftBaru();
    const posted = await postedBaru();
    expect((await d.tolak("MAKER_B", `/jurnal/${draft.id}/batal`, { body: {} })).status).toBe(403);
    expect(await d.statusJurnal(draft.id)).toBe("DRAFT");
    // MAKER_B holds no `jurnal.reversal`, so this is refused twice over; what
    // is asserted is that it is refused and that nothing was written.
    expect(
      (await d.tolak("MAKER_B", `/jurnal/${posted.id}/pembalik`, { body: { alasan: "Tidak boleh" } }))
        .status,
    ).toBe(403);
    expect(await d.statusJurnal(posted.id)).toBe("POSTED");
  });

  test("cabangId pada daftar adalah penyempit, bukan wewenang", async () => {
    const asli = await postedBaru();
    const dipersempit = await d.ok<{ data: Array<{ id: string }> }>(
      "MAKER_B",
      `/jurnal?cabangId=${d.f.cabangA.id}`,
    );
    // Asking for another branch by name does not widen the answer; it narrows
    // an already-scoped list to nothing.
    expect(dipersempit.data.map((j) => j.id)).not.toContain(asli.id);
    // Admin Pusat is cross-branch, so the same filter really does narrow.
    const pusat = await d.ok<{ data: Array<{ id: string }> }>(
      "ADMIN_PUSAT",
      `/jurnal?cabangId=${d.f.cabangA.id}`,
    );
    expect(pusat.data.map((j) => j.id)).toContain(asli.id);
  });
});

describe("tanpa sesi", () => {
  test("setiap rute jurnal menolak 401 sebelum menyentuh apa pun", async () => {
    for (const [method, path] of [
      ["GET", "/jurnal"],
      ["GET", `/jurnal/${crypto.randomUUID()}`],
      ["POST", "/jurnal"],
      ["POST", `/jurnal/${crypto.randomUUID()}/posting`],
      ["POST", `/jurnal/${crypto.randomUUID()}/pembalik`],
    ] as const) {
      const res = await d.f.request(path, { method, ...(method === "POST" ? { body: {} } : {}) });
      expect([`${method} ${path}`, res.status]).toEqual([`${method} ${path}`, 401]);
    }
  });
});
