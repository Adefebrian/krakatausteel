// SPEC 2 RULE 4: "Otorisasi divalidasi di layer server, bukan hanya di UI.
// Buat test yang memanggil endpoint langsung dengan role yang salah dan
// pastikan ditolak."
//
// This file calls every /rka endpoint as every role in spec 2 and asserts the
// refusal, over the REAL app: real logins, real session cookies, the real guard
// chain, the real error handler. It also covers:
//
//   spec 16 scenario 23  the Auditor reads every budget screen and every
//                        report and cannot change anything, because the refusal
//                        is on the HTTP METHOD and not on a hidden button;
//   spec 16 scenario 24  Admin Cabang in branch A cannot reach branch B's
//                        budget, INCLUDING by editing the id in the URL,
//                        because the branch is taken from the row and never
//                        from the request;
//   spec 2 rule 5        every denial leaves a DITOLAK row in audit_log.
//
// THE MATRIX IS DATA. When a later phase moves a permission between roles, the
// diff shows exactly which cell moved instead of which sentence was reworded.
//
// WHY AN ALLOWED ROLE IS ASSERTED AS "NOT 403" ON THE WRITE ROUTES
// A permitted Admin Pusat POSTing to `/rka/:id/setujui` on an already approved
// version gets a 409, because the BUSINESS state refuses it; that is the
// correct answer and it is not what this file is measuring. What matters here
// is that the request got PAST authorisation, which "not 403 and not 401" says
// exactly and a hardcoded 409 would not. The read routes, which have no such
// state, are asserted on their exact status.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ADMIN_PUSAT_2,
  buatDuniaRuteRka,
  rp,
  TAHUN_RKA,
  tutupSemuaFixture,
  type DuniaRuteRka,
} from "./rute-test-support";
import { resolveRequiredPermissions } from "../auth";

// Fixture teardown, one call for the whole file. The world built by
// `buatDunia...` registers its fixture; this marks its `bumn` as no longer
// live. Nothing else in this file changed. See the FIXTURE LEAK note in
// apps/api/src/testing/harness.ts.
afterAll(tutupSemuaFixture);

let d: DuniaRuteRka;

/** A consolidated, APPROVED baseline, so the read routes point at something real. */
let rkaKonsolidasi = "";
/** A branch-A budget and its branch-B twin, for the scope tests. */
let rkaCabangA = "";
let rkaCabangB = "";

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
 * Roles that hold each permission, straight from spec 2's wewenang column and
 * modules/auth/permissions.ts.
 *
 * `admin.rka.view` is listed in `HANYA_BUKTI` there, so it is NOT inherited by
 * every role that can log in: the Auditor holds it as evidence, Admin Cabang
 * holds it scoped to its own branch, and the three operational roles do not.
 * That is what makes the branch-scope check on these reads reachable at all.
 */
const PEMEGANG: Readonly<Record<string, readonly Role[]>> = {
  "laporan.view": [...SEMUA_ROLE],
  "admin.rka.view": ["ADMIN_CABANG", "ADMIN_PUSAT", "AUDITOR"],
  "admin.rka": ["ADMIN_PUSAT"],
  "admin.rka.approve": ["ADMIN_PUSAT"],
};

interface Kasus {
  nama: string;
  metode: "GET" | "POST";
  path: (d: DuniaRuteRka) => string;
  body?: (d: DuniaRuteRka) => unknown;
  /** Permission codes, any-of, exactly as passed to requirePermission. */
  izin: readonly string[];
  /** For a GET with no business precondition, the status a permitted role gets. */
  statusOk?: number;
}

const KASUS: readonly Kasus[] = [
  // --- reads: the entry screens (admin.rka.view) --------------------------
  {
    nama: "GET /rka/referensi",
    metode: "GET",
    path: () => "/rka/referensi?jenis=PUMK",
    izin: ["admin.rka.view"],
    statusOk: 200,
  },
  {
    nama: "GET /rka/periode",
    metode: "GET",
    path: () => "/rka/periode",
    izin: ["admin.rka.view"],
    statusOk: 200,
  },
  { nama: "GET /rka", metode: "GET", path: () => "/rka", izin: ["admin.rka.view"], statusOk: 200 },
  {
    nama: "GET /rka/baseline",
    metode: "GET",
    path: () => `/rka/baseline?tahun=${TAHUN_RKA}&jenis=KEUANGAN`,
    izin: ["admin.rka.view"],
    statusOk: 200,
  },
  {
    nama: "GET /rka/:id",
    metode: "GET",
    path: () => `/rka/${rkaKonsolidasi}`,
    izin: ["admin.rka.view"],
    statusOk: 200,
  },

  // --- reads: report 24 (laporan.view, held by every role) ----------------
  {
    nama: "GET /rka/laporan/realisasi",
    metode: "GET",
    path: () => `/rka/laporan/realisasi?tahun=${TAHUN_RKA}&jenis=KEUANGAN&mode=BULANAN&bulan=2`,
    izin: ["laporan.view"],
    statusOk: 200,
  },
  {
    nama: "GET /rka/laporan/metode-realisasi",
    metode: "GET",
    path: (d) => `/rka/laporan/metode-realisasi?periodeId=${d.periodeOpenId}&jenis=KEUANGAN`,
    izin: ["laporan.view"],
    statusOk: 200,
  },

  // --- writes -------------------------------------------------------------
  {
    nama: "POST /rka",
    metode: "POST",
    path: () => "/rka",
    body: (d) => ({
      cabangId: d.f.cabangA.id,
      tahun: TAHUN_RKA + 1,
      jenis: "PUMK",
      baris: [
        {
          sektorId: d.sektorId,
          uraian: "Target mitra sektor perdagangan",
          bulan: 1,
          jumlahAnggaran: rp(10_000_000),
          jumlahUnit: 5,
        },
      ],
    }),
    izin: ["admin.rka"],
  },
  {
    nama: "POST /rka/:id/baris",
    metode: "POST",
    path: () => `/rka/${rkaCabangA}/baris`,
    body: (d) => ({
      baris: [
        {
          sektorId: d.sektorId,
          uraian: "Target mitra sektor perdagangan (revisi grid)",
          bulan: 1,
          jumlahAnggaran: rp(12_000_000),
          jumlahUnit: 6,
        },
      ],
    }),
    izin: ["admin.rka"],
  },
  {
    nama: "POST /rka/:id/setujui",
    metode: "POST",
    path: () => `/rka/${rkaCabangA}/setujui`,
    body: () => ({ catatan: "matriks izin" }),
    izin: ["admin.rka.approve"],
  },
  {
    nama: "POST /rka/:id/revisi",
    metode: "POST",
    path: () => `/rka/${rkaKonsolidasi}/revisi`,
    body: () => ({ keterangan: "matriks izin" }),
    izin: ["admin.rka"],
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
  d = await buatDuniaRuteRka();

  // The consolidated baseline (cabang_id IS NULL): an entity-wide RKA
  // Keuangan, drafted by one Admin Pusat and APPROVED BY ANOTHER, because
  // `rka.pemisahan_tugas_persetujuan` ships on. Every read route above points
  // at this rather than at a 404 that would mask a missing permission check.
  const konsolidasi = await d.ok<{ id: string }>("ADMIN_PUSAT", "/rka", {
    body: {
      cabangId: null,
      tahun: TAHUN_RKA,
      jenis: "KEUANGAN",
      keterangan: "RKA Keuangan konsolidasi (uji rute)",
      baris: [
        {
          akunId: d.akunBebanId,
          uraian: "Beban pembinaan",
          bulan: 2,
          jumlahAnggaran: rp(50_000_000),
        },
      ],
    },
  });
  rkaKonsolidasi = konsolidasi.id;
  await d.ok(ADMIN_PUSAT_2, `/rka/${rkaKonsolidasi}/setujui`, { body: {} });

  // Branch A and branch B, one RKA PUMK each. Both EXIST, so a scope refusal
  // cannot be confused with "not found".
  const a = await d.ok<{ id: string }>("ADMIN_PUSAT", "/rka", {
    body: {
      cabangId: d.f.cabangA.id,
      tahun: TAHUN_RKA,
      jenis: "PUMK",
      baris: [
        {
          sektorId: d.sektorId,
          uraian: "Target mitra cabang A",
          bulan: 1,
          jumlahAnggaran: rp(20_000_000),
          jumlahUnit: 10,
        },
      ],
    },
  });
  rkaCabangA = a.id;

  const b = await d.ok<{ id: string }>("ADMIN_PUSAT", "/rka", {
    body: {
      cabangId: d.f.cabangB.id,
      tahun: TAHUN_RKA,
      jenis: "PUMK",
      baris: [
        {
          sektorId: d.sektorId,
          uraian: "Target mitra cabang B",
          bulan: 1,
          jumlahAnggaran: rp(18_000_000),
          jumlahUnit: 9,
        },
      ],
    },
  });
  rkaCabangB = b.id;
});

describe("matriks izin: setiap endpoint RKA dipanggil oleh setiap peran", () => {
  for (const kasus of KASUS) {
    for (const role of SEMUA_ROLE) {
      const boleh = diizinkan(kasus).includes(role);
      test(`${kasus.nama} sebagai ${role} -> ${boleh ? "lolos otorisasi" : "ditolak"}`, async () => {
        const res = await d.panggil(role, kasus.path(d), {
          method: kasus.metode,
          ...(kasus.body ? { body: kasus.body(d) } : {}),
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
        // The refusal never names the permission the caller is missing: that
        // is a map of the system for anyone probing it.
        for (const izin of kasus.izin) expect(body.error).not.toContain(izin);
      });
    }
  }
});

describe("admin.rka.view tidak diperoleh lewat laporan.view, dan sebaliknya", () => {
  test("Maker membaca report 24 tetapi tidak daftar versinya", async () => {
    // The distinction the catalogue draws, exercised end to end: report 24 is
    // one of spec 10's reports and every role opens it; the budget VERSIONS it
    // compares against are evidence and are not everybody's.
    const laporan = await d.panggil(
      "MAKER",
      `/rka/laporan/realisasi?tahun=${TAHUN_RKA}&jenis=KEUANGAN&mode=BULANAN&bulan=2`,
    );
    expect(laporan.status).toBe(200);

    const daftar = await d.panggil("MAKER", "/rka");
    expect(daftar.status).toBe(403);
  });
});

describe("spec 16 skenario 23: Auditor membaca semua, mengubah tidak satu pun", () => {
  const tulis = KASUS.filter((k) => k.metode === "POST");
  for (const kasus of tulis) {
    test(`${kasus.nama} sebagai AUDITOR -> 403 read only`, async () => {
      const res = await d.panggil("AUDITOR", kasus.path(d), {
        method: "POST",
        ...(kasus.body ? { body: kasus.body(d) } : {}),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("TIDAK_BERWENANG");
      expect(body.error).toContain("read only");
    });
  }

  test("Auditor tetap bisa membaca setiap layar RKA", async () => {
    for (const kasus of KASUS.filter((k) => k.metode === "GET")) {
      const res = await d.panggil("AUDITOR", kasus.path(d));
      expect(res.status).toBe(200);
    }
  });
});

describe("tidak ada GET yang mengubah data", () => {
  test("membaca setiap layar RKA sebagai Admin Pusat tidak menulis satu baris pun", async () => {
    const cacah = async () => {
      const rows = await d.f.db.query<{ rka: string; baris: string }>(
        `select (select count(*)::text from rka where bumn_id = $1) as rka,
                (select count(*)::text from rka_detail rd
                   join rka r on r.id = rd.rka_id where r.bumn_id = $1) as baris`,
        [d.f.bumnId],
      );
      return rows[0]!;
    };
    const sebelum = await cacah();
    for (const kasus of KASUS.filter((k) => k.metode === "GET")) {
      const res = await d.panggil("ADMIN_PUSAT", kasus.path(d));
      expect(res.status).toBe(200);
    }
    expect(await cacah()).toEqual(sebelum);
  });
});

describe("spec 16 skenario 24: manipulasi ID di URL tidak menembus cabang", () => {
  test("Admin Cabang A tidak bisa membaca RKA cabang B walau ID benar", async () => {
    const res = await d.panggil("ADMIN_CABANG", `/rka/${rkaCabangB}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; kodeDomain: string; error: string };
    expect(body.code).toBe("TIDAK_BERWENANG");
    // The refusal carries the DOMAIN reason, so an operator reading a log can
    // tell a scope problem from a permission problem. Before `RkaError` was
    // registered in core/http.ts this was an anonymous 500 with no code.
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
    // And it does not confirm which branch the row is in: a 403 that named the
    // branch would be an oracle for enumerating another branch's data.
    expect(body.error).not.toContain(d.f.cabangB.nama);
  });

  test("Admin Cabang A memang bisa membaca RKA cabangnya sendiri", async () => {
    // The positive control, so the test above cannot be passing merely because
    // everything is refused.
    const res = await d.panggil("ADMIN_CABANG", `/rka/${rkaCabangA}`);
    expect(res.status).toBe(200);
  });

  test("daftar hanya berisi cabang sendiri, dan cabangId dari klien tidak melebarkannya", async () => {
    const milikA = await d.ok<{ data: Array<{ id: string }> }>("ADMIN_CABANG", "/rka");
    expect(milikA.data.some((r) => r.id === rkaCabangA)).toBe(true);
    expect(milikA.data.some((r) => r.id === rkaCabangB)).toBe(false);

    // The client asks for the OTHER branch by id. The filter is intersected
    // with what the session allows, so the answer is empty rather than wider.
    const dipaksa = await d.ok<{ data: unknown[] }>(
      "ADMIN_CABANG",
      `/rka?cabangId=${d.f.cabangB.id}`,
    );
    expect(dipaksa.data).toEqual([]);
  });

  test("konsolidasi adalah filternya sendiri, bukan cabangId yang kosong", async () => {
    // The two absences a query string cannot tell apart. Omitting `cabangId`
    // must mean "every branch I may see", and `konsolidasi=true` must mean
    // "the entity-wide budget only". Passing null for the first answered every
    // list with the consolidated budgets alone, which looked like a working
    // filter and hid every branch budget from its own branch.
    const tanpaFilter = await d.ok<{ data: Array<{ id: string; cabangId: string | null }> }>(
      "ADMIN_PUSAT",
      "/rka",
    );
    expect(tanpaFilter.data.some((r) => r.id === rkaCabangA)).toBe(true);
    expect(tanpaFilter.data.some((r) => r.id === rkaKonsolidasi)).toBe(true);

    const hanyaKonsolidasi = await d.ok<{ data: Array<{ id: string; cabangId: string | null }> }>(
      "ADMIN_PUSAT",
      "/rka?konsolidasi=true",
    );
    expect(hanyaKonsolidasi.data.some((r) => r.id === rkaKonsolidasi)).toBe(true);
    expect(hanyaKonsolidasi.data.every((r) => r.cabangId === null)).toBe(true);
  });

  test("Admin Pusat lintas cabang memang boleh melihat keduanya", async () => {
    const semua = await d.ok<{ data: Array<{ id: string }> }>("ADMIN_PUSAT", "/rka");
    expect(semua.data.some((r) => r.id === rkaCabangA)).toBe(true);
    expect(semua.data.some((r) => r.id === rkaCabangB)).toBe(true);
    expect((await d.panggil("ADMIN_PUSAT", `/rka/${rkaCabangB}`)).status).toBe(200);
  });

  test("report 24 untuk cabang lain DITOLAK, bukan dikosongkan", async () => {
    // Refused rather than emptied, deliberately: an empty report reads as
    // "that branch spent nothing", which is a wrong answer presented as a
    // right one.
    const res = await d.panggil(
      "MAKER",
      `/rka/laporan/realisasi?tahun=${TAHUN_RKA}&jenis=PUMK&mode=BULANAN&bulan=1&cabangId=${d.f.cabangB.id}`,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { kodeDomain: string };
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
  });

  test("MUTASI lintas cabang ditolak, bukan hanya pembacaan", async () => {
    // Admin Pusat is the only holder of `admin.rka`, and it is cross-branch,
    // so the reachable branch-scope mutation refusal is the one an Admin
    // Cabang gets on the WRITE code itself: 403, before the row is ever read.
    const res = await d.panggil("ADMIN_CABANG", `/rka/${rkaCabangB}/baris`, {
      body: { baris: [] },
    });
    expect(res.status).toBe(403);

    // And nothing moved: branch B's grid still has its one line.
    const baris = await d.f.db.query<{ n: string }>(
      `select count(*)::text as n from rka_detail where rka_id = $1 and deleted_at is null`,
      [rkaCabangB],
    );
    expect(Number(baris[0]!.n)).toBeGreaterThan(0);
  });

  test("spec 2 rule 5: penolakan scope meninggalkan baris DITOLAK di audit_log", async () => {
    await d.panggil("ADMIN_CABANG", `/rka/${rkaCabangB}`);
    const baris = await d.f.auditRows({
      hasil: "DITOLAK",
      userId: d.f.users.ADMIN_CABANG.id,
    });
    expect(baris.length).toBeGreaterThan(0);
    const jalur = baris.map((b) => (b.nilai_baru_json as { path?: string } | null)?.path);
    expect(jalur).toContain(`/rka/${rkaCabangB}`);
  });
});

describe("validasi batas: satu 400 yang menyebut setiap field yang salah", () => {
  test("POST /rka mengumpulkan seluruh field bermasalah sekaligus", async () => {
    const res = await d.panggil("ADMIN_PUSAT", "/rka", {
      body: {
        cabangId: "bukan-uuid",
        tahun: 1700,
        jenis: "TIDAK_ADA",
        baris: [{ uraian: "", bulan: 13, jumlahAnggaran: "1000" }],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    // Every one of them, in ONE response: a grid is not submitted five times
    // to learn five problems.
    for (const field of [
      "cabangId",
      "tahun",
      "jenis",
      "baris[0].uraian",
      "baris[0].bulan",
      "baris[0].jumlahAnggaran",
    ]) {
      expect(Object.keys(body.detail)).toContain(field);
    }
  });

  test("report 24 menolak tahun dan bulan yang tidak masuk akal, sebelum menyentuh engine", async () => {
    const res = await d.panggil(
      "ADMIN_PUSAT",
      "/rka/laporan/realisasi?jenis=KEUANGAN&mode=BULANAN&bulan=99",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: Record<string, string[]> };
    expect(Object.keys(body.detail).sort()).toEqual(["bulan", "tahun"]);
  });
});

describe("report 24 lewat HTTP: sumber realisasi dilaporkan dan tidak bisa dipaksa", () => {
  test("periode OPEN dibaca live, dan parameter sumber dari klien tidak mengubahnya", async () => {
    const jalur = `/rka/laporan/realisasi?tahun=${TAHUN_RKA}&jenis=KEUANGAN&mode=BULANAN&bulan=2`;
    const jujur = await d.ok<{
      versi: number;
      statusRka: string;
      sumberPerPeriode: Array<{ bulan: number; statusPeriode: string; sumber: string }>;
    }>("ADMIN_PUSAT", jalur);
    expect(jujur.statusRka).toBe("DISETUJUI");
    expect(jujur.sumberPerPeriode).toHaveLength(1);
    expect(jujur.sumberPerPeriode[0]!.statusPeriode).toBe("OPEN");
    expect(jujur.sumberPerPeriode[0]!.sumber).toBe("V_LEDGER_BARIS");

    // THE PARAMETER THAT MUST NOT EXIST. A caller naming a source is ignored,
    // because the route accepts no such field and the engine decides from the
    // period's own status. If this ever starts mattering, somebody can produce
    // a live figure for a closed month and present it as the outturn.
    const dipaksa = await d.ok<typeof jujur>(
      "ADMIN_PUSAT",
      `${jalur}&sumber=SALDO_AKUN_PERIODE&sumberRealisasi=SALDO_AKUN_PERIODE`,
    );
    expect(dipaksa.sumberPerPeriode).toEqual(jujur.sumberPerPeriode);
  });

  test("metode realisasi untuk periode OPEN adalah pembacaan ledger", async () => {
    const hasil = await d.ok<{ metode: string }>(
      "AUDITOR",
      `/rka/laporan/metode-realisasi?periodeId=${d.periodeOpenId}&jenis=PUMK`,
    );
    expect(hasil.metode).toBe("V_LEDGER_BARIS");
  });
});

describe("tanpa sesi sama sekali", () => {
  test("setiap endpoint RKA menjawab 401, bukan 404 dan bukan data", async () => {
    for (const kasus of KASUS) {
      const res = await d.f.request(kasus.path(d), {
        method: kasus.metode,
        ...(kasus.body ? { body: kasus.body(d) } : {}),
      });
      expect(res.status).toBe(401);
    }
  });
});

describe("kode izin yang tidak dikenal gagal saat WIRING, bukan sebagai 403 diam", () => {
  test("resolveRequiredPermissions menolak kode di luar katalog", () => {
    // The mechanism `requirePermission` runs at ROUTE REGISTRATION time. A typo
    // like `admin.rka.aprove` must break the boot, not turn into a permission
    // nobody can ever hold and a 403 that reads like policy.
    expect(() => resolveRequiredPermissions(["admin.rka.aprove"])).toThrow(/tidak dikenal/);
  });

  test("setiap kode izin yang dipakai routes.ts ada di katalog auth", () => {
    const dipakai = [...new Set(KASUS.flatMap((k) => k.izin))];
    expect(() => resolveRequiredPermissions(dipakai)).not.toThrow();
    // Canonical form is the same string: none of these is an alias in flight.
    expect([...resolveRequiredPermissions(dipakai)] as string[]).toEqual(dipakai);
  });
});
