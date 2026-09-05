// The administration API for master data: the chart of accounts and the
// reference lists every operational form picks from.
//
// THE THEME, and it is the same one in every test below: A MASTER ROW IS
// REFERENCED BY POSTED HISTORY. Nothing here deletes. The question each test
// asks is which changes rewrite the meaning of the past and must be refused,
// which merely stop future use and are therefore allowed, and whether an
// operator hears the rule in a sentence or hears a constraint name.
import { afterAll, describe, expect, test } from "bun:test";
import { createFixture, tutupSemuaFixture } from "../../testing/harness";
import { seedCoaInti } from "../../seed/coa-inti";
import { seedEventJurnalMapping } from "../../seed/event-jurnal";

afterAll(tutupSemuaFixture);

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A fixture whose entity has the core chart of accounts and event mapping. */
async function setupCoa() {
  const f = await createFixture();
  const akunIdByKode = await seedCoaInti(f.db, f.bumnId, f.users.ADMIN_PUSAT.id);
  await seedEventJurnalMapping(f.db, f.bumnId, { akunIdByKode, userId: f.users.ADMIN_PUSAT.id });
  const cookie = await f.login(f.users.ADMIN_PUSAT.username);
  return { f, cookie, akunIdByKode };
}

describe("GET /konfigurasi/coa", () => {
  test("answers the whole chart with the facts a screen needs to decide what is editable", async () => {
    const { f, cookie } = await setupCoa();
    const res = await f.request("/konfigurasi/coa", { cookie });
    expect(res.status).toBe(200);
    const { data } = await json<{
      data: {
        kode: string;
        isPostable: boolean;
        punyaAnak: boolean;
        dipakaiMapping: boolean;
        dipakaiJurnal: boolean;
      }[];
    }>(res);

    const kas = data.find((a) => a.kode === "1.1.01");
    expect(kas).toBeDefined();
    expect(kas!.isPostable).toBe(true);
    // 1.1.01 is the credit leg of PENCAIRAN_PUMK, so the mapping holds it.
    expect(kas!.dipakaiMapping).toBe(true);

    const header = data.find((a) => a.kode === "1");
    expect(header).toBeDefined();
    expect(header!.isPostable).toBe(false);
    expect(header!.punyaAnak).toBe(true);
  });

  test("is behind konfigurasi.coa, which a branch admin does not hold", async () => {
    const { f } = await setupCoa();
    const cabang = await f.login(f.users.ADMIN_CABANG.username);
    expect((await f.request("/konfigurasi/coa", { cookie: cabang })).status).toBe(403);
  });
});

describe("POST /konfigurasi/coa checks the hierarchy rules ahead of the trigger", () => {
  test("creates a leaf under a header and it becomes postable", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const parentId = akunIdByKode.get("1")!;
    const res = await f.request("/konfigurasi/coa", {
      method: "POST",
      cookie,
      body: {
        kode: "1.1.99",
        nama: "Kas Uji Coba",
        parentId,
        level: 2,
        tipe: "ASET",
        saldoNormal: "D",
        isPostable: true,
        isKas: true,
        klasifikasiAkun: "ASET",
      },
    });
    expect(res.status).toBe(201);
    const dibuat = await json<{ id: string; isPostable: boolean }>(res);
    expect(dibuat.isPostable).toBe(true);

    // Immediately offerable to a form that picks a cash account.
    const kas = (
      await json<{ data: { id: string }[] }>(await f.request("/konfigurasi/akun?kas=true", { cookie }))
    ).data;
    expect(kas.some((a) => a.id === dibuat.id)).toBe(true);
  });

  test("a parent that is postable is refused in a sentence, not as TJSL-COA-004", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request("/konfigurasi/coa", {
      method: "POST",
      cookie,
      body: {
        kode: "1.1.01.01",
        nama: "Anak Dari Akun Postable",
        parentId: akunIdByKode.get("1.1.01")!,
        level: 4,
        tipe: "ASET",
        saldoNormal: "D",
        klasifikasiAkun: "ASET",
      },
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: string }>(res);
    expect(body.error).not.toContain("TJSL-COA");
    expect(body.error).toMatch(/postable|anak/i);
  });

  test("a level that is not exactly one below the parent is refused with both levels named", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request("/konfigurasi/coa", {
      method: "POST",
      cookie,
      body: {
        kode: "1.1.98",
        nama: "Level Salah",
        parentId: akunIdByKode.get("1")!,
        level: 5,
        tipe: "ASET",
        saldoNormal: "D",
        klasifikasiAkun: "ASET",
      },
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/level/i);
  });

  test("a type that differs from the parent is refused: no Beban hanging under Aset", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request("/konfigurasi/coa", {
      method: "POST",
      cookie,
      body: {
        kode: "1.1.97",
        nama: "Beban Di Bawah Aset",
        parentId: akunIdByKode.get("1")!,
        level: 2,
        tipe: "BEBAN",
        saldoNormal: "D",
        klasifikasiAkun: "BEBAN",
      },
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/tipe/i);
  });

  test("a parent from another entity behaves like an id that does not exist", async () => {
    const { f, cookie } = await setupCoa();
    const lain = await createFixture();
    const akunLain = await seedCoaInti(lain.db, lain.bumnId, lain.users.ADMIN_PUSAT.id);
    const res = await f.request("/konfigurasi/coa", {
      method: "POST",
      cookie,
      body: {
        kode: "1.1.96",
        nama: "Parent Milik Entitas Lain",
        parentId: akunLain.get("1")!,
        level: 2,
        tipe: "ASET",
        saldoNormal: "D",
        klasifikasiAkun: "ASET",
      },
    });
    expect(res.status).toBe(404);
  });

  test("a level 1 account with a parent, and a deeper account without one, are both refused", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const tanpaParent = await f.request("/konfigurasi/coa", {
      method: "POST",
      cookie,
      body: {
        kode: "1.1.95",
        nama: "Tanpa Parent",
        level: 2,
        tipe: "ASET",
        saldoNormal: "D",
        klasifikasiAkun: "ASET",
      },
    });
    expect(tanpaParent.status).toBe(400);

    const akarBerparent = await f.request("/konfigurasi/coa", {
      method: "POST",
      cookie,
      body: {
        kode: "9",
        nama: "Akar Berparent",
        parentId: akunIdByKode.get("1")!,
        level: 1,
        tipe: "ASET",
        saldoNormal: "D",
        klasifikasiAkun: "ASET",
      },
    });
    expect(akarBerparent.status).toBe(400);
  });

  test("cash is only ever an asset", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request("/konfigurasi/coa", {
      method: "POST",
      cookie,
      body: {
        kode: "5.1.99",
        nama: "Beban Yang Mengaku Kas",
        parentId: akunIdByKode.get("5")!,
        level: 2,
        tipe: "BEBAN",
        saldoNormal: "D",
        isPostable: true,
        isKas: true,
        klasifikasiAkun: "BEBAN",
      },
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/kas/i);
  });
});

describe("an account the engines depend on is protected harder than a sector name", () => {
  test("refuses to deactivate an account an active event mapping points at, and names the event", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request(`/konfigurasi/coa/${akunIdByKode.get("1.1.01")!}/status`, {
      method: "POST",
      cookie,
      body: { aktif: false },
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: string }>(res);
    expect(body.error).toMatch(/PENCAIRAN_PUMK|ALOKASI_DANA_BUMN_PEMBINA/);
  });

  test("refuses to make such an account non-postable: the mapping's FK target would vanish", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request(`/konfigurasi/coa/${akunIdByKode.get("1.1.01")!}`, {
      method: "PATCH",
      cookie,
      body: { isPostable: false },
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).not.toContain("akun_postable_id_uq");
  });

  test("refuses to deactivate a header that still has active children", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request(`/konfigurasi/coa/${akunIdByKode.get("1")!}/status`, {
      method: "POST",
      cookie,
      body: { aktif: false },
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: string }>(res)).error).toMatch(/anak|turunan/i);
  });

  test("allows renaming and reclassifying, because neither moves a posted number", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request(`/konfigurasi/coa/${akunIdByKode.get("1.1.01")!}`, {
      method: "PATCH",
      cookie,
      body: { nama: "Kas dan Setara Kas (dinamai ulang)", klasifikasiArusKas: "OPERASI" },
    });
    expect(res.status).toBe(200);
    expect((await json<{ nama: string }>(res)).nama).toContain("dinamai ulang");

    const jejak = await f.auditRows({ aksi: "konfigurasi.akun.ubah" });
    expect(jejak.length).toBeGreaterThan(0);
    expect(JSON.stringify(jejak[0]!.nilai_lama_json)).toContain("Kas");
  });

  test("refuses to renumber an account: the code is the contract every mapping and report uses", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request(`/konfigurasi/coa/${akunIdByKode.get("1.1.01")!}`, {
      method: "PATCH",
      cookie,
      body: { kode: "1.1.02" },
    });
    expect(res.status).toBe(400);
  });

  test("there is no DELETE for an account", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const res = await f.request(`/konfigurasi/coa/${akunIdByKode.get("1.1.01")!}`, {
      method: "DELETE",
      cookie,
    });
    expect(res.status).toBe(404);
  });

  test("deactivates a leaf nothing depends on", async () => {
    const { f, cookie, akunIdByKode } = await setupCoa();
    const dibuat = await json<{ id: string }>(
      await f.request("/konfigurasi/coa", {
        method: "POST",
        cookie,
        body: {
          kode: "1.1.94",
          nama: "Akun Tak Terpakai",
          parentId: akunIdByKode.get("1")!,
          level: 2,
          tipe: "ASET",
          saldoNormal: "D",
          isPostable: true,
          klasifikasiAkun: "ASET",
        },
      }),
    );
    const res = await f.request(`/konfigurasi/coa/${dibuat.id}/status`, {
      method: "POST",
      cookie,
      body: { aktif: false },
    });
    expect(res.status).toBe(200);
    expect((await json<{ aktif: boolean }>(res)).aktif).toBe(false);
  });
});

describe("master reference data", () => {
  test("creates, edits and deactivates a sektor, and the operational picker follows", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);

    const dibuat = await json<{ id: string; kode: string }>(
      await f.request("/konfigurasi/master/sektor", {
        method: "POST",
        cookie,
        body: { kode: "UJI", nama: "Sektor Uji", urutan: 90 },
      }),
    );
    expect(dibuat.kode).toBe("UJI");

    const terlihat = (
      await json<{ data: { id: string }[] }>(await f.request("/konfigurasi/sektor", { cookie }))
    ).data;
    expect(terlihat.some((s) => s.id === dibuat.id)).toBe(true);

    const diubah = await f.request(`/konfigurasi/master/sektor/${dibuat.id}`, {
      method: "PATCH",
      cookie,
      body: { nama: "Sektor Uji Diubah" },
    });
    expect(diubah.status).toBe(200);

    const nonaktif = await f.request(`/konfigurasi/master/sektor/${dibuat.id}/status`, {
      method: "POST",
      cookie,
      body: { aktif: false },
    });
    expect(nonaktif.status).toBe(200);

    const sesudah = (
      await json<{ data: { id: string }[] }>(await f.request("/konfigurasi/sektor", { cookie }))
    ).data;
    expect(sesudah.some((s) => s.id === dibuat.id)).toBe(false);

    // Deactivated, never deleted: the row is still in the administration list.
    const admin = (
      await json<{ data: { id: string; aktif: boolean }[] }>(
        await f.request("/konfigurasi/master/sektor", { cookie }),
      )
    ).data;
    expect(admin.find((s) => s.id === dibuat.id)?.aktif).toBe(false);
  });

  test("a duplicate code inside one entity is a 409", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const body = { kode: "DUP", nama: "Sektor Kembar" };
    expect((await f.request("/konfigurasi/master/sektor", { method: "POST", cookie, body })).status).toBe(201);
    expect((await f.request("/konfigurasi/master/sektor", { method: "POST", cookie, body })).status).toBe(409);
  });

  test("a row from another entity is not addressable by id", async () => {
    const f = await createFixture();
    const lain = await createFixture();
    const cookieLain = await lain.login(lain.users.ADMIN_PUSAT.username);
    const asing = await json<{ id: string }>(
      await lain.request("/konfigurasi/master/sektor", {
        method: "POST",
        cookie: cookieLain,
        body: { kode: "ASG", nama: "Sektor Entitas Lain" },
      }),
    );

    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const res = await f.request(`/konfigurasi/master/sektor/${asing.id}`, {
      method: "PATCH",
      cookie,
      body: { nama: "Diambil Alih" },
    });
    expect(res.status).toBe(404);
  });

  test("bidang, provinsi, kota and SDG are the same surface with the same rules", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const unik = f.suffix.slice(0, 4).toUpperCase();

    const bidang = await f.request("/konfigurasi/master/bidang", {
      method: "POST",
      cookie,
      body: { kode: `B${unik}`, nama: "Bidang Uji" },
    });
    expect(bidang.status).toBe(201);

    const provinsi = await json<{ id: string }>(
      await f.request("/konfigurasi/master/provinsi", {
        method: "POST",
        cookie,
        body: { kodeBps: `9${unik}`, nama: "Provinsi Uji" },
      }),
    );

    const kota = await f.request("/konfigurasi/master/kota", {
      method: "POST",
      cookie,
      body: { kodeBps: `9${unik}01`, nama: "Kota Uji", provinsiId: provinsi.id, tipe: "KOTA" },
    });
    expect(kota.status).toBe(201);

    const kotaSalah = await f.request("/konfigurasi/master/kota", {
      method: "POST",
      cookie,
      body: { kodeBps: `9${unik}02`, nama: "Kota Salah", provinsiId: provinsi.id, tipe: "DESA" },
    });
    expect(kotaSalah.status).toBe(400);

    const sdgSalah = await f.request("/konfigurasi/master/sdg", {
      method: "POST",
      cookie,
      body: { nomor: 18, nama: "SDG Ke Delapan Belas" },
    });
    expect(sdgSalah.status).toBe(400);
  });

  test("an unknown master kind is a 404, not a silent empty list", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    expect((await f.request("/konfigurasi/master/entah", { cookie })).status).toBe(404);
  });

  test("the master path is not swallowed by the parameter route above it", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    // GET /konfigurasi/:grup/:kunci would answer "master/sektor" as a
    // parameter lookup and 404 with the wrong reason. Prove it resolves as the
    // master list instead.
    const res = await f.request("/konfigurasi/master/sektor", { cookie });
    expect(res.status).toBe(200);
    expect(Array.isArray((await json<{ data: unknown[] }>(res)).data)).toBe(true);
  });

  test("master writes need konfigurasi.master, which a branch admin does not hold", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_CABANG.username);
    const res = await f.request("/konfigurasi/master/sektor", {
      method: "POST",
      cookie,
      body: { kode: "NOP", nama: "Tidak Boleh" },
    });
    expect(res.status).toBe(403);
  });

  test("every master write lands in the audit trail with its before and after", async () => {
    const f = await createFixture();
    const cookie = await f.login(f.users.ADMIN_PUSAT.username);
    const dibuat = await json<{ id: string }>(
      await f.request("/konfigurasi/master/sektor", {
        method: "POST",
        cookie,
        body: { kode: "AUD", nama: "Sebelum" },
      }),
    );
    await f.request(`/konfigurasi/master/sektor/${dibuat.id}`, {
      method: "PATCH",
      cookie,
      body: { nama: "Sesudah" },
    });
    const jejak = await f.auditRows({ aksi: "konfigurasi.master.ubah" });
    expect(jejak.length).toBeGreaterThan(0);
    expect(JSON.stringify(jejak[0]!.nilai_lama_json)).toContain("Sebelum");
    expect(JSON.stringify(jejak[0]!.nilai_baru_json)).toContain("Sesudah");
  });
});
