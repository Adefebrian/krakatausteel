// THE FIRST UNAUTHENTICATED SURFACE IN THIS APPLICATION, tested as such.
//
// Everything here is called with NO cookie of any kind, through the REAL app
// `createApp` builds for the server (apps/api/src/testing/harness.ts rule 1),
// so the hardening stack, the guard chain and the error handler are the
// shipped ones.
//
// FOUR CLAIMS, and each has a section below:
//
//   1. The form is an ALLOWLIST. An unknown key is a refusal, not something
//      quietly stored in a schemaless JSONB column.
//   2. A submission creates NOTHING operational. One `portal_submission` row,
//      and not a mitra, a proposal, an akad or a journal.
//   3. The status check is NOT AN ORACLE. Unknown ticket and wrong verifier
//      are byte-for-byte the same answer, and a ticket is unguessable anyway.
//   4. The verifier is NEVER STORED IN CLEARTEXT.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFixture, type Fixture } from "../../testing/harness";
import { nativeFetchApi } from "../../testing/native-fetch";
import { POLA_TIKET } from "./contract";

const NIK = "3204010101900001";

function formulirPumk(): Record<string, unknown> {
  return {
    nama_lengkap: "Siti Rohmah",
    nama_usaha: "Warung Siti",
    sektor: "PERDAGANGAN",
    alamat: "Kp. Ciwaduk RT 03/RW 02",
    jumlah_diajukan: "15000000.00",
    tenor_diajukan: 12,
    tujuan_penggunaan: "Tambahan modal kerja",
  };
}

describe("portal: permukaan publik", () => {
  let f: Fixture;
  let kodeEntitas = "";

  /** A request with NO cookie at all. That is the whole point of this file. */
  async function publik(path: string, body: unknown, method = "POST"): Promise<Response> {
    const { Request: NativeRequest } = nativeFetchApi();
    return f.ctx.app.fetch(
      new NativeRequest(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async function ajukan(ubah: Record<string, unknown> = {}): Promise<Response> {
    return publik("/portal/pengajuan", {
      kodeEntitas,
      jenis: "PUMK",
      emailKontak: "siti@contoh.local",
      nik: NIK,
      formulir: formulirPumk(),
      dokumen: [{ jenis: "KTP", namaFile: "ktp.jpg" }],
      ...ubah,
    });
  }

  beforeAll(async () => {
    // COST KNOBS ONLY, per harness rule 1: the wiring, the guards and the
    // error handler are the shipped ones, and only the anti-spam ceilings are
    // raised, because this file submits far more forms from one (absent)
    // client address than a member of the public would. The ceilings
    // themselves are proved against a fixture that does NOT raise them, in
    // ./portal-batas.test.ts.
    f = await createFixture({
      portalLimits: {
        pengajuanPerIp: 500,
        pengajuanPerIpHarian: 500,
        cekPerIp: 500,
        rutePengajuan: 500,
        ruteCek: 500,
        jendelaPengajuanDetik: 60,
        jendelaCekDetik: 60,
      },
    });
    const rows = await f.db.query<{ kode: string }>(
      "select kode from bumn where id = $1::uuid",
      [f.bumnId],
    );
    kodeEntitas = rows[0]!.kode;
  });

  afterAll(async () => {
    await f.tutup();
  });

  // ------------------------------------------------------------------ 1.

  test("pengajuan yang sah diterima tanpa sesi apa pun, dan menjawab nomor tiket", async () => {
    const res = await ajukan();
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("BARU");
    expect(POLA_TIKET.test(body.noTiket as string)).toBe(true);
    // The answer carries NOTHING that could be used to reach the row again.
    expect(Object.keys(body).sort()).toEqual(["jenis", "noTiket", "pesan", "status", "tanggalSubmit"]);
  });

  test("field yang tidak ada di allowlist DITOLAK, bukan disimpan diam-diam", async () => {
    const res = await ajukan({
      formulir: { ...formulirPumk(), catatan_petugas: "SUDAH DISETUJUI", status: "DIKONVERSI" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { kodeDomain?: string; error: string };
    expect(body.kodeDomain).toBe("FORMULIR_TIDAK_VALID");
  });

  test("jumlah wajib string desimal: angka JS dan notasi lain ditolak", async () => {
    for (const jumlah of [15000000, "15000000", "1.5e7", "15000000.000", "-15000000.00", "0.00"]) {
      const res = await ajukan({ formulir: { ...formulirPumk(), jumlah_diajukan: jumlah } });
      expect({ jumlah, status: res.status }).toEqual({ jumlah, status: 400 });
    }
  });

  test("teks berlebihan, karakter kendali dan tenor di luar batas ditolak", async () => {
    const terlaluPanjang = "x".repeat(600);
    const kendali = "Warung\u0007Siti";
    const kasus: Record<string, unknown>[] = [
      { ...formulirPumk(), tujuan_penggunaan: terlaluPanjang },
      { ...formulirPumk(), nama_usaha: kendali },
      { ...formulirPumk(), tenor_diajukan: 999 },
      { ...formulirPumk(), tenor_diajukan: "12" },
    ];
    for (const formulir of kasus) {
      expect((await ajukan({ formulir })).status).toBe(400);
    }
  });

  test("nama berkas dokumen tidak boleh memuat pemisah path", async () => {
    const res = await ajukan({
      dokumen: [{ jenis: "KTP", namaFile: "../../etc/passwd" }],
    });
    expect(res.status).toBe(400);
  });

  test("markup yang diketik pemohon disimpan sebagai TEKS, bukan diproses", async () => {
    const jahat = "<script>alert(1)</script> & 'quote' \"dq\"";
    const res = await ajukan({ formulir: { ...formulirPumk(), nama_usaha: jahat } });
    expect(res.status).toBe(201);
    const { noTiket } = (await res.json()) as { noTiket: string };
    const rows = await f.db.query<{ nilai: string }>(
      "select data_json->>'nama_usaha' as nilai from portal_submission where no_tiket = $1",
      [noTiket],
    );
    // Stored verbatim: it is data. Escaping belongs to whatever renders it,
    // and mangling it here would corrupt a legitimate business name.
    expect(rows[0]?.nilai).toBe(jahat);
  });

  test("tepat satu pemeriksa: tidak boleh nol, tidak boleh dua", async () => {
    expect((await ajukan({ nik: null, tanggalLahir: null })).status).toBe(400);
    expect((await ajukan({ nik: NIK, tanggalLahir: "1990-01-01" })).status).toBe(400);
    expect((await ajukan({ nik: "123" })).status).toBe(400);
    expect((await ajukan({ nik: null, tanggalLahir: "1990-02-30" })).status).toBe(400);
  });

  test("entitas tujuan yang tidak dikenal ditolak", async () => {
    const res = await ajukan({ kodeEntitas: "TIDAK-ADA" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { kodeDomain?: string };
    expect(body.kodeDomain).toBe("ENTITAS_TIDAK_DITEMUKAN");
  });

  test("badan permintaan publik dibatasi jauh di bawah batas global 1 MB", async () => {
    const { Request: NativeRequest } = nativeFetchApi();
    const besar = JSON.stringify({ kodeEntitas, jenis: "PUMK", isi: "x".repeat(64 * 1024) });

    // Declared oversize: refused before a byte is read.
    const menyatakan = await f.ctx.app.fetch(
      new NativeRequest("http://localhost/portal/pengajuan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(besar.length),
        },
        body: besar,
      }),
    );
    expect(menyatakan.status).toBe(413);

    // Undeclared: measured after reading, refused 400. Either way the public
    // body is capped at 32 KB, far below the global 1 MB.
    const diam = await f.ctx.app.fetch(
      new NativeRequest("http://localhost/portal/pengajuan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: besar,
      }),
    );
    expect(diam.status).toBe(400);
  });

  // ------------------------------------------------------------------ 2.

  test("pengajuan TIDAK membuat mitra, proposal, akad atau jurnal", async () => {
    const hitung = async (): Promise<Record<string, number>> => {
      const q = async (sql: string): Promise<number> => {
        const r = await f.db.query<{ n: string }>(sql, [f.bumnId]);
        return Number(r[0]?.n ?? "0");
      };
      return {
        mitra: await q(
          `select count(*)::text as n from mitra m join cabang c on c.id = m.cabang_id
            where c.bumn_id = $1::uuid`,
        ),
        proposal: await q(
          `select count(*)::text as n from pumk_proposal p join cabang c on c.id = p.cabang_id
            where c.bumn_id = $1::uuid`,
        ),
        akad: await q(
          `select count(*)::text as n from pumk_akad a join cabang c on c.id = a.cabang_id
            where c.bumn_id = $1::uuid`,
        ),
        jurnal: await q(`select count(*)::text as n from jurnal where bumn_id = $1::uuid`),
      };
    };
    const sebelum = await hitung();
    expect((await ajukan()).status).toBe(201);
    expect(await hitung()).toEqual(sebelum);
  });

  test("status DIKONVERSI tidak bisa dicapai lewat rute portal mana pun", async () => {
    const cookieAdmin = await f.login(f.users.ADMIN_PUSAT.username);
    const buat = await ajukan();
    const { noTiket } = (await buat.json()) as { noTiket: string };
    const rows = await f.db.query<{ id: string }>(
      "select id::text as id from portal_submission where no_tiket = $1",
      [noTiket],
    );
    const id = rows[0]!.id;

    const res = await f.request(`/portal/submission/${id}/tindak`, {
      cookie: cookieAdmin,
      method: "POST",
      body: { tindakan: "DIKONVERSI" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: Record<string, string[]> };
    expect(body.detail?.tindakan?.[0]).toContain("DIPROSES, DITOLAK");
  });

  // ------------------------------------------------------------------ 3.

  test("cek status yang benar menjawab status dan TIDAK membocorkan apa pun lain", async () => {
    const buat = await ajukan();
    const { noTiket } = (await buat.json()) as { noTiket: string };
    const res = await publik("/portal/status", { noTiket, nik: NIK });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["jenis", "noTiket", "pesan", "status", "tanggalSubmit"]);
    // Explicitly NOT present: the row id, the converted proposal id, the
    // officer's internal note, the form data, the contact details.
    for (const bocor of ["id", "convertedProposalId", "catatanPetugas", "formulir", "emailKontak"]) {
      expect(body[bocor]).toBeUndefined();
    }
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  test("TIDAK JADI ORACLE: tiket tak dikenal dan pemeriksa salah dijawab identik", async () => {
    const buat = await ajukan();
    const { noTiket } = (await buat.json()) as { noTiket: string };

    const pemeriksaSalah = await publik("/portal/status", {
      noTiket,
      nik: "3204010101900099",
    });
    const tiketTakAda = await publik("/portal/status", {
      noTiket: "TKT-202601-ZZZZZZZZZZ",
      nik: NIK,
    });

    expect(pemeriksaSalah.status).toBe(404);
    expect(tiketTakAda.status).toBe(404);
    expect(await pemeriksaSalah.json()).toEqual(await tiketTakAda.json());
  });

  test("bentuk tiket yang cacat dijawab sama pula, bukan 400 yang bisa dibedakan", async () => {
    const acak = await publik("/portal/status", { noTiket: "bukan-tiket", nik: NIK });
    const takAda = await publik("/portal/status", { noTiket: "TKT-202601-ZZZZZZZZZZ", nik: NIK });
    expect(acak.status).toBe(takAda.status);
    expect(await acak.json()).toEqual(await takAda.json());
  });

  test("nomor tiket tidak bisa ditebak: acak, tidak berurutan", async () => {
    const tiket: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await ajukan();
      expect(res.status).toBe(201);
      tiket.push(((await res.json()) as { noTiket: string }).noTiket);
    }
    expect(new Set(tiket).size).toBe(tiket.length);
    // Every tail differs; a counter would produce a shared prefix and a
    // predictable next value.
    const ekor = tiket.map((t) => t.split("-")[2]!);
    expect(new Set(ekor).size).toBe(ekor.length);
    for (const e of ekor) expect(e).toHaveLength(10);
  });

  test("percobaan gagal tercatat di audit_log DAN di kolom penghitung tiket", async () => {
    const buat = await ajukan();
    const { noTiket } = (await buat.json()) as { noTiket: string };
    await publik("/portal/status", { noTiket, nik: "3204010101900098" });

    const rows = await f.db.query<{ n: number }>(
      "select pemeriksa_percobaan as n from portal_submission where no_tiket = $1",
      [noTiket],
    );
    expect(rows[0]?.n).toBe(1);

    const audit = await f.db.query<{ n: string }>(
      `select count(*)::text as n from audit_log
        where aksi = 'portal.cek_status' and hasil = 'DITOLAK'`,
    );
    expect(Number(audit[0]?.n ?? "0")).toBeGreaterThan(0);
  });

  test("jawaban BENAR mengosongkan jatah kegagalan tiket itu", async () => {
    // Same shape as the mitra login and the staff login: the budget throttles
    // wrong ANSWERS, so nobody can lock an applicant out of their own ticket.
    const buat = await ajukan();
    const { noTiket } = (await buat.json()) as { noTiket: string };
    for (let i = 0; i < 4; i += 1) {
      const salah = await publik("/portal/status", { noTiket, nik: `320401010190009${i}` });
      expect(salah.status).toBe(404);
    }
    const benar = await publik("/portal/status", { noTiket, nik: NIK });
    expect(benar.status).toBe(200);
  });

  // ------------------------------------------------------------------ 4.

  test("pemeriksa tidak pernah tersimpan sebagai teks jelas, di kolom mana pun", async () => {
    const res = await ajukan();
    const { noTiket } = (await res.json()) as { noTiket: string };
    const rows = await f.db.query<{
      data_json: string;
      pemeriksa_hash: string | null;
      seluruh: string;
    }>(
      `select data_json::text as data_json, pemeriksa_hash,
              to_jsonb(portal_submission)::text as seluruh
         from portal_submission where no_tiket = $1`,
      [noTiket],
    );
    const baris = rows[0]!;
    expect(baris.pemeriksa_hash).toMatch(/^\$argon2id\$/);
    // The NIK appears nowhere in the row, including the form data: the engine
    // drops it after hashing rather than storing both the secret and its hash.
    expect(baris.seluruh).not.toContain(NIK);
    expect(baris.data_json).not.toContain(NIK);
  });

  test("rute portal publik tidak butuh sesi, rute petugas menolak tanpa sesi", async () => {
    expect((await f.request("/portal/submission")).status).toBe(401);
    expect((await f.request("/portal/submission/x/tindak", { method: "POST" })).status).toBe(401);
  });

  test("path portal yang tidak ada dijawab 404 dalam amplop API", async () => {
    const res = await publik("/portal/tidak-ada", {});
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { code: string }).code).toBe("TIDAK_DITEMUKAN");
  });
});
