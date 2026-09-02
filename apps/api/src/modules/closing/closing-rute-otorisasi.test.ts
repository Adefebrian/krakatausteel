// SPEC 2 RULE 4: "Otorisasi divalidasi di layer server, bukan hanya di UI.
// Buat test yang memanggil endpoint langsung dengan role yang salah dan
// pastikan ditolak."
//
// This file calls every /closing endpoint as every role in spec 2 and asserts
// the refusal, over the REAL app: real logins, real session cookies, the real
// guard chain, the real error handler. It follows
// ../pumk/pumk-rute-otorisasi.test.ts and ../rka/rka-rute-otorisasi.test.ts,
// and it covers:
//
//   spec 16 scenario 23  an AUDITOR opens every piece of CLOSING EVIDENCE --
//                        the checklist, the run history, the snapshot, the
//                        frozen trial balance -- and is refused every run and
//                        every reopen. That is the whole reason
//                        `admin.closing.view` exists as a code separate from
//                        `admin.closing.periode`, and it is asserted here
//                        rather than assumed;
//   spec 16 scenario 24  a branch user cannot reach another branch's figures,
//                        INCLUDING by naming its id in a filter, because the
//                        engine refuses a branch outside the session's scope
//                        instead of quietly emptying the answer;
//   spec 2 rule 5        every denial leaves a DITOLAK row in audit_log, which
//                        only happens because `ClosingError` is registered in
//                        core/http.ts. It was not, until this router landed.
//
// THE MATRIX IS DATA, and it is cross-checked against `PERMISSIONS_BY_ROLE`
// rather than only written down: when a later phase moves a permission between
// roles, the diff shows exactly which cell moved, and a matrix that drifts from
// the shipped grant table fails on its own.
//
// WHY AN ALLOWED ROLE IS ASSERTED AS "NOT 403" ON THE WRITE ROUTES
// A permitted Approver POSTing to `/closing/periode/:id/tutup` before the
// preparatory steps have run gets a 409, because the CHECKLIST refuses it; that
// is the correct answer and it is not what this file is measuring. What matters
// here is that the request got PAST authorisation, which "not 403 and not 401"
// says exactly and a hardcoded status would not.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buatDuniaRuteClosing,
  tutupSemuaFixture,
  type DuniaRuteClosing,
} from "./rute-test-support";
import { PERMISSIONS_BY_ROLE, resolveRequiredPermissions } from "../auth";

// Fixture teardown, one call for the whole file. See the FIXTURE LEAK note in
// apps/api/src/testing/harness.ts.
afterAll(tutupSemuaFixture);

let d: DuniaRuteClosing;

/** The month every case aims at: a real OPEN period of this world. */
let periodeId = "";

const SEMUA_ROLE = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
] as const;
type Role = (typeof SEMUA_ROLE)[number];

/**
 * Roles that hold each permission, straight from spec 2's wewenang column.
 *
 * `admin.closing.view` is held by the AUDITOR and by nobody who inputs: it is
 * evidence, not a work queue. `admin.periode.reopen` is held by ADMIN_PUSAT
 * ALONE -- not even by the Approver who is allowed to close -- because
 * reopening rewrites a month that has already been reported on.
 */
const PEMEGANG: Readonly<Record<string, readonly Role[]>> = {
  "admin.closing.view": ["APPROVER", "ADMIN_CABANG", "ADMIN_PUSAT", "AUDITOR"],
  "admin.closing.kolektibilitas": ["APPROVER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "admin.closing.periode": ["APPROVER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "admin.periode.reopen": ["ADMIN_PUSAT"],
};

interface Kasus {
  nama: string;
  metode: "GET" | "POST";
  path: () => string;
  body?: () => unknown;
  /** Permission codes, any-of, exactly as passed to requirePermission. */
  izin: readonly string[];
  /** For a GET with no business precondition, the status a permitted role gets. */
  statusOk?: number;
}

const KASUS: readonly Kasus[] = [
  // --- reads: the closing EVIDENCE, all on `admin.closing.view` -----------
  {
    nama: "GET /closing/referensi",
    metode: "GET",
    path: () => "/closing/referensi",
    izin: ["admin.closing.view"],
    statusOk: 200,
  },
  {
    nama: "GET /closing/periode",
    metode: "GET",
    path: () => "/closing/periode",
    izin: ["admin.closing.view"],
    statusOk: 200,
  },
  {
    nama: "GET /closing/periode/:id",
    metode: "GET",
    path: () => `/closing/periode/${periodeId}`,
    izin: ["admin.closing.view"],
    statusOk: 200,
  },
  {
    nama: "GET /closing/periode/:id/prasyarat",
    metode: "GET",
    path: () => `/closing/periode/${periodeId}/prasyarat`,
    izin: ["admin.closing.view"],
    statusOk: 200,
  },
  {
    nama: "GET /closing/periode/:id/saldo",
    metode: "GET",
    path: () => `/closing/periode/${periodeId}/saldo`,
    izin: ["admin.closing.view"],
    statusOk: 200,
  },
  {
    nama: "GET /closing/periode/:id/kolektibilitas/riwayat",
    metode: "GET",
    path: () => `/closing/periode/${periodeId}/kolektibilitas/riwayat`,
    izin: ["admin.closing.view"],
    statusOk: 200,
  },
  {
    nama: "GET /closing/periode/:id/kolektibilitas/snapshot",
    metode: "GET",
    path: () => `/closing/periode/${periodeId}/kolektibilitas/snapshot`,
    izin: ["admin.closing.view"],
    statusOk: 200,
  },

  // --- writes: the runs ---------------------------------------------------
  {
    nama: "POST /closing/periode/:id/kolektibilitas/pratinjau",
    metode: "POST",
    path: () => `/closing/periode/${periodeId}/kolektibilitas/pratinjau`,
    body: () => ({}),
    izin: ["admin.closing.kolektibilitas"],
  },
  {
    nama: "POST /closing/periode/:id/kolektibilitas",
    metode: "POST",
    path: () => `/closing/periode/${periodeId}/kolektibilitas`,
    body: () => ({}),
    izin: ["admin.closing.kolektibilitas"],
  },
  {
    nama: "POST /closing/periode/:id/penyisihan/pratinjau",
    metode: "POST",
    path: () => `/closing/periode/${periodeId}/penyisihan/pratinjau`,
    body: () => ({}),
    izin: ["admin.closing.periode"],
  },
  {
    nama: "POST /closing/periode/:id/penyisihan",
    metode: "POST",
    path: () => `/closing/periode/${periodeId}/penyisihan`,
    body: () => ({}),
    izin: ["admin.closing.periode"],
  },
  {
    nama: "POST /closing/periode/:id/akrual",
    metode: "POST",
    path: () => `/closing/periode/${periodeId}/akrual`,
    body: () => ({}),
    izin: ["admin.closing.periode"],
  },
  {
    nama: "POST /closing/periode/:id/tutup",
    metode: "POST",
    path: () => `/closing/periode/${periodeId}/tutup`,
    body: () => ({}),
    izin: ["admin.closing.periode"],
  },
  {
    nama: "POST /closing/periode/:id/buka",
    metode: "POST",
    path: () => `/closing/periode/${periodeId}/buka`,
    body: () => ({ alasan: "Koreksi klasifikasi beban atas permintaan KAP (uji rute)" }),
    izin: ["admin.periode.reopen"],
  },
];

/** Roles allowed by ANY of the permissions a case names. */
function diizinkan(kasus: Kasus): Role[] {
  const set = new Set<Role>();
  for (const izin of kasus.izin) {
    for (const role of PEMEGANG[izin] ?? []) set.add(role);
  }
  // A read-only role is refused every non-GET before the permission is even
  // consulted, so it is not "allowed" on a write however wide its reads are.
  if (kasus.metode !== "GET") set.delete("AUDITOR");
  return [...set];
}

beforeAll(async () => {
  d = await buatDuniaRuteClosing();
  // March, deliberately NOT January: closing it would be refused by check 1
  // anyway (February is still open), so no case in this file can accidentally
  // close a period and change what a later case sees. Authorisation is what is
  // under test here; ./closing-rute-alur.test.ts owns the successful close.
  periodeId = d.periode.get(3)!.id;
});

describe("matriks izin: setiap endpoint closing dipanggil oleh setiap peran", () => {
  for (const kasus of KASUS) {
    for (const role of SEMUA_ROLE) {
      const boleh = diizinkan(kasus).includes(role);
      test(`${kasus.nama} sebagai ${role} -> ${boleh ? "lolos otorisasi" : "ditolak"}`, async () => {
        const res = await d.panggil(role, kasus.path(), {
          method: kasus.metode,
          ...(kasus.body ? { body: kasus.body() } : {}),
        });
        if (boleh) {
          expect(res.status).not.toBe(401);
          expect(res.status).not.toBe(403);
          if (kasus.statusOk !== undefined) expect(res.status).toBe(kasus.statusOk);
          return;
        }
        expect(res.status).toBe(403);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe("TIDAK_BERWENANG");
        // The refusal never names the permission the caller is missing: that is
        // a map of the system for anyone probing it.
        for (const izin of kasus.izin) expect(body.error).not.toContain(izin);
      });
    }
  }
});

describe("spec 16 skenario 23: Auditor membaca semua bukti closing, tidak bisa menjalankan apa pun", () => {
  const tulis = KASUS.filter((k) => k.metode === "POST");
  for (const kasus of tulis) {
    test(`${kasus.nama} sebagai AUDITOR -> 403`, async () => {
      const res = await d.panggil("AUDITOR", kasus.path(), {
        method: "POST",
        ...(kasus.body ? { body: kasus.body() } : {}),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("TIDAK_BERWENANG");
      // Refused on the METHOD, before the permission is consulted: read-only is
      // structural here, not a hidden button.
      expect(body.error).toContain("read only");
    });
  }

  test("Auditor tetap bisa membaca setiap layar bukti closing", async () => {
    for (const kasus of KASUS.filter((k) => k.metode === "GET")) {
      const res = await d.panggil("AUDITOR", kasus.path());
      expect(res.status).toBe(200);
    }
  });

  test("checklist sepuluh butir terbuka untuk Auditor, lengkap dan berurutan", async () => {
    // The point of `admin.closing.view`: the auditor's primary object is HOW a
    // period was closed and against which checklist, and it is not one of spec
    // 10's 31 reports, so `laporan.view` does not reach it.
    const daftar = await d.ok<{
      hasil: Array<{ nomor: number; kode: string; status: string; alasan: string }>;
    }>("AUDITOR", `/closing/periode/${periodeId}/prasyarat`);
    expect(daftar.hasil).toHaveLength(10);
    expect(daftar.hasil.map((h) => h.nomor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("MAKER dan CHECKER tidak memegang bukti closing sama sekali", async () => {
    // Not an oversight: the closing evidence is not a work queue, and a role
    // that inputs proposals has no business reading the whole portfolio's
    // classification. Asserted so a later "just add it to LIHAT" is visible.
    for (const role of ["MAKER", "CHECKER"] as const) {
      const res = await d.panggil(role, `/closing/periode/${periodeId}/prasyarat`);
      expect(res.status).toBe(403);
    }
  });
});

describe("spec 16 skenario 24: cabang di luar scope ditolak, bukan dikosongkan", () => {
  test("Admin Cabang tidak bisa menyaring saldo beku ke cabang lain", async () => {
    const res = await d.panggil(
      "ADMIN_CABANG",
      `/closing/periode/${periodeId}/saldo?cabangId=${d.f.cabangB.id}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; kodeDomain: string; error: string };
    expect(body.code).toBe("TIDAK_BERWENANG");
    // The refusal carries the DOMAIN reason, so an operator reading a log can
    // tell a scope problem from a permission problem. This only reaches the
    // client because `ClosingError` is registered in core/http.ts.
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
    // And it does not confirm which branch the row is in: a 403 that named the
    // branch would be an oracle for enumerating another branch's data.
    expect(body.error).not.toContain(d.f.cabangB.nama);
  });

  test("Admin Cabang tidak bisa menjalankan kolektibilitas untuk cabang lain", async () => {
    const res = await d.panggil("ADMIN_CABANG", `/closing/periode/${periodeId}/kolektibilitas`, {
      body: { cabangId: d.f.cabangB.id },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { kodeDomain: string };
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
  });

  test("pratinjau lintas cabang ditolak juga: preview bukan celah baca", async () => {
    // A preview writes nothing, which is exactly why it is tempting to leave
    // ungated. It still returns every akad's outstanding and arrears for the
    // branch named, which is the most sensitive read in the module.
    const res = await d.panggil(
      "ADMIN_CABANG",
      `/closing/periode/${periodeId}/kolektibilitas/pratinjau`,
      { body: { cabangId: d.f.cabangB.id } },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe("CABANG_DILUAR_SCOPE");
  });

  test("Admin Pusat lintas cabang memang boleh menyaring ke cabang mana pun", async () => {
    // The exemption of spec 2 rule 3, asserted so the scope tests above cannot
    // be passing merely because everything is refused.
    const res = await d.panggil(
      "ADMIN_PUSAT",
      `/closing/periode/${periodeId}/saldo?cabangId=${d.f.cabangB.id}`,
    );
    expect(res.status).toBe(200);
  });

  test("spec 2 rule 5: penolakan scope meninggalkan baris DITOLAK di audit_log", async () => {
    const path = `/closing/periode/${periodeId}/saldo?cabangId=${d.f.cabangB.id}`;
    await d.panggil("ADMIN_CABANG", path);
    const baris = await d.f.auditRows({
      hasil: "DITOLAK",
      userId: d.f.users.ADMIN_CABANG.id,
    });
    expect(baris.length).toBeGreaterThan(0);
    const jalur = baris.map((b) => (b.nilai_baru_json as { path?: string } | null)?.path);
    // The path in the row is the pathname; the query string is not part of it.
    expect(jalur).toContain(`/closing/periode/${periodeId}/saldo`);
  });
});

describe("tanpa sesi sama sekali", () => {
  test("setiap endpoint closing menjawab 401, bukan 404 dan bukan data", async () => {
    for (const kasus of KASUS) {
      const res = await d.f.request(kasus.path(), {
        method: kasus.metode,
        ...(kasus.body ? { body: kasus.body() } : {}),
      });
      expect(res.status).toBe(401);
    }
  });
});

describe("kode izin yang tidak dikenal gagal saat WIRING, bukan sebagai 403 diam", () => {
  test("resolveRequiredPermissions menolak kode di luar katalog", () => {
    // The mechanism `requirePermission` runs at ROUTE REGISTRATION time. A typo
    // like `admin.closing.peridoe` must break the boot, not turn into a
    // permission nobody can ever hold and a 403 that reads like policy.
    expect(() => resolveRequiredPermissions(["admin.closing.peridoe"])).toThrow(/tidak dikenal/);
  });

  test("setiap kode izin yang dipakai routes.ts ada di katalog auth", () => {
    const dipakai = [...new Set(KASUS.flatMap((k) => k.izin))];
    expect(() => resolveRequiredPermissions(dipakai)).not.toThrow();
    // Canonical form is the same string: none of these is an alias in flight.
    expect([...resolveRequiredPermissions(dipakai)] as string[]).toEqual(dipakai);
  });

  test("matriks di file ini sama dengan tabel grant yang dikirim", () => {
    // The matrix above is written down so a moved permission shows as a moved
    // cell. This keeps the writing honest: if spec 2's grant table changes and
    // nobody updates `PEMEGANG`, the whole file would keep passing against a
    // world that no longer exists.
    for (const [izin, peran] of Object.entries(PEMEGANG)) {
      const nyata = SEMUA_ROLE.filter((role) =>
        (PERMISSIONS_BY_ROLE[role] as readonly string[]).includes(izin),
      );
      expect({ izin, peran: [...nyata].sort() }).toEqual({ izin, peran: [...peran].sort() });
    }
  });
});

describe("validasi batas: setiap handler menolak input cacat sebelum menyentuh engine", () => {
  test("id periode yang bukan UUID menjadi 400 dengan detail per field", async () => {
    const res = await d.panggil("ADMIN_PUSAT", "/closing/periode/bukan-uuid/prasyarat");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    expect(body.detail.id).toBeDefined();
  });

  test("filter periode yang cacat mengumpulkan SEMUA field bermasalah dalam satu 400", async () => {
    // One submission, one answer: a form with a bad year and a bad status
    // deserves to learn both at once rather than to be sent back twice.
    const res = await d.panggil("ADMIN_PUSAT", "/closing/periode?tahun=1899&status=SETENGAH");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: Record<string, string[]> };
    expect(Object.keys(body.detail).sort()).toEqual(["status", "tahun"]);
  });

  test("konfirmasiKasNegatif bukan boolean ditolak, bukan dianggap konfirmasi", async () => {
    // spec 8.4 check 8 is a deliberate act recorded in the audit log. A body
    // that says "mungkin" must be a 400 rather than a confirmation nobody made.
    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${periodeId}/tutup`, {
      body: { konfirmasiKasNegatif: "mungkin" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: Record<string, string[]> };
    expect(body.detail.konfirmasiKasNegatif).toBeDefined();
  });

  test("reopen tanpa alasan yang berarti ditolak di boundary", async () => {
    for (const alasan of [undefined, "", "  ", "ok"]) {
      const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${periodeId}/buka`, {
        body: alasan === undefined ? {} : { alasan },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail: Record<string, string[]> };
      expect(body.detail.alasan).toBeDefined();
    }
  });

  test("cabangId cacat di body ditolak sebelum engine dipanggil", async () => {
    const res = await d.panggil("ADMIN_PUSAT", `/closing/periode/${periodeId}/kolektibilitas`, {
      body: { cabangId: "01" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: Record<string, string[]> }).detail.cabangId).toBeDefined();
  });

  test("path closing yang tidak ada menjawab 404 dalam amplop API, bukan teks polos", async () => {
    const res = await d.panggil("ADMIN_PUSAT", "/closing/tidak-ada-ini");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("TIDAK_DITEMUKAN");
  });
});
