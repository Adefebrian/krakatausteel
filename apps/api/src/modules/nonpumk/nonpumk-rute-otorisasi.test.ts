// SPEC 2 RULE 4: "Otorisasi divalidasi di layer server, bukan hanya di UI.
// Buat test yang memanggil endpoint langsung dengan role yang salah dan
// pastikan ditolak."
//
// This file calls every /nonpumk endpoint as every role in spec 2 and asserts
// the refusal, over the REAL app: real logins, real session cookies, the real
// guard chain, the real error handler. It also covers:
//
//   spec 16 scenario 23  the Auditor cannot change anything, structurally,
//                        because the refusal is on the HTTP METHOD and not on
//                        a hidden button;
//   spec 16 scenario 24  a Maker in branch A cannot reach branch B, INCLUDING
//                        by editing the id in the URL, because the branch is
//                        taken from the row and never from the request;
//   spec 2 rule 5        every denial leaves a DITOLAK row in audit_log.
//
// THE MATRIX IS DATA. When a later phase moves a permission between roles, the
// diff shows exactly which cell moved instead of which sentence was reworded.
//
// WHY AN ALLOWED ROLE IS ASSERTED AS "NOT 403" ON THE WRITE ROUTES
// A permitted Maker POSTing to `/nonpumk/proposal/:id/penyaluran` against a
// DRAFT proposal gets a 409, because the BUSINESS state refuses it; that is the
// correct answer and it is not what this file is measuring. What matters here
// is that the request got PAST authorisation, which "not 403 and not 401" says
// exactly and a hardcoded 409 would not (it would start failing the day the
// fixture's proposal is carried one step further). The read routes, which have
// no such state, are asserted on their exact status.
import { beforeAll, describe, expect, test } from "bun:test";
import { buatDuniaRuteNonPumk, rp, type DuniaRuteNonPumk } from "./rute-test-support";
import { resolveRequiredPermissions } from "../auth";

let d: DuniaRuteNonPumk;

/** A branch A proposal and a branch B proposal, so a scope test has real targets. */
let proposalA = "";
let proposalB = "";

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
 * Roles that hold each permission, straight from spec 2's wewenang column as
 * modules/auth grants it.
 *
 * `nonpumk.lpj.verifikasi` sits with the CHECKER and with nobody else
 * operational, and that is the whole control: the Maker FILES the LPJ
 * (`nonpumk.lpj`) and somebody else accepts it. It is deliberately not the
 * Approver's, who decided to release the money months earlier on different
 * evidence.
 */
const PEMEGANG: Readonly<Record<string, readonly Role[]>> = {
  "nonpumk.view": [...SEMUA_ROLE],
  "nonpumk.create": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "nonpumk.penilaian": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "nonpumk.review": ["CHECKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "nonpumk.approve": ["APPROVER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "nonpumk.penyaluran": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "nonpumk.lpj": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "nonpumk.lpj.verifikasi": ["CHECKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
};

interface Kasus {
  nama: string;
  metode: "GET" | "POST";
  path: (d: DuniaRuteNonPumk) => string;
  body?: (d: DuniaRuteNonPumk) => unknown;
  /** Permission codes, any-of, exactly as passed to requirePermission. */
  izin: readonly string[];
  /** For a GET with no business precondition, the status a permitted role gets. */
  statusOk?: number;
}

const KASUS: readonly Kasus[] = [
  // --- reads --------------------------------------------------------------
  {
    nama: "GET /nonpumk/batasan",
    metode: "GET",
    path: () => "/nonpumk/batasan",
    izin: ["nonpumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /nonpumk/bidang",
    metode: "GET",
    path: () => "/nonpumk/bidang",
    izin: ["nonpumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /nonpumk/sdg",
    metode: "GET",
    path: () => "/nonpumk/sdg",
    izin: ["nonpumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /nonpumk/akun-beban",
    metode: "GET",
    path: () => "/nonpumk/akun-beban",
    izin: ["nonpumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /nonpumk/proposal",
    metode: "GET",
    path: () => "/nonpumk/proposal",
    izin: ["nonpumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /nonpumk/proposal/:id",
    metode: "GET",
    path: () => `/nonpumk/proposal/${proposalA}`,
    izin: ["nonpumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /nonpumk/proposal/:id/timeline",
    metode: "GET",
    path: () => `/nonpumk/proposal/${proposalA}/timeline`,
    izin: ["nonpumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /nonpumk/monitoring-lpj",
    metode: "GET",
    path: () => "/nonpumk/monitoring-lpj",
    izin: ["nonpumk.view"],
    statusOk: 200,
  },

  // --- writes -------------------------------------------------------------
  {
    nama: "POST /nonpumk/proposal",
    metode: "POST",
    path: () => "/nonpumk/proposal",
    body: (d) => ({
      cabangId: d.f.cabangA.id,
      tanggalProposal: "2026-01-05",
      namaPemohon: "Yayasan Uji Otorisasi",
      bidangId: d.bidangA,
      sdg: [{ sdgId: d.sdg1 }],
      judulProgram: "Program uji otorisasi",
      jumlahDiajukan: rp(20_000_000),
      penerimaManfaatEstimasi: 40,
    }),
    izin: ["nonpumk.create"],
  },
  {
    nama: "POST /nonpumk/proposal/:id/ajukan-penilaian",
    metode: "POST",
    path: () => `/nonpumk/proposal/${proposalA}/ajukan-penilaian`,
    body: () => ({ catatan: null }),
    izin: ["nonpumk.create"],
  },
  {
    nama: "POST /nonpumk/proposal/:id/penilaian",
    metode: "POST",
    path: () => `/nonpumk/proposal/${proposalA}/penilaian`,
    body: () => ({
      tanggal: "2026-01-12",
      skorTotal: "82",
      nilaiRekomendasi: rp(18_000_000),
    }),
    izin: ["nonpumk.penilaian"],
  },
  {
    nama: "POST /nonpumk/proposal/:id/review",
    metode: "POST",
    path: () => `/nonpumk/proposal/${proposalA}/review`,
    body: () => ({ tanggal: "2026-01-15", keputusan: "REKOMENDASI" }),
    izin: ["nonpumk.review"],
  },
  {
    nama: "POST /nonpumk/proposal/:id/persetujuan",
    metode: "POST",
    path: () => `/nonpumk/proposal/${proposalA}/persetujuan`,
    body: () => ({
      tanggal: "2026-01-20",
      keputusan: "SETUJU",
      jumlahDisetujui: rp(18_000_000),
    }),
    izin: ["nonpumk.approve"],
  },
  {
    nama: "POST /nonpumk/proposal/:id/penyaluran",
    metode: "POST",
    path: () => `/nonpumk/proposal/${proposalA}/penyaluran`,
    body: (d) => ({
      tanggalPenyaluran: "2026-02-10",
      jumlah: rp(9_000_000),
      akunKasId: d.akunKasId,
      akunBebanId: d.akunBebanId,
    }),
    izin: ["nonpumk.penyaluran"],
  },
  {
    nama: "POST /nonpumk/proposal/:id/tutup-penyaluran",
    metode: "POST",
    path: () => `/nonpumk/proposal/${proposalA}/tutup-penyaluran`,
    body: () => ({ catatan: null }),
    izin: ["nonpumk.penyaluran"],
  },
  {
    nama: "POST /nonpumk/proposal/:id/lpj",
    metode: "POST",
    path: () => `/nonpumk/proposal/${proposalA}/lpj`,
    body: () => ({
      tanggalLpj: "2026-05-01",
      jumlahRealisasi: rp(9_000_000),
      penerimaManfaatAktual: 40,
    }),
    izin: ["nonpumk.lpj"],
  },
  {
    nama: "POST /nonpumk/proposal/:id/lpj/verifikasi",
    metode: "POST",
    path: () => `/nonpumk/proposal/${proposalA}/lpj/verifikasi`,
    body: (d) => ({ tanggalVerifikasi: "2026-05-10", akunKasId: d.akunKasId }),
    izin: ["nonpumk.lpj.verifikasi"],
  },
  {
    nama: "POST /nonpumk/proposal/:id/lpj/tolak",
    metode: "POST",
    path: () => `/nonpumk/proposal/${proposalA}/lpj/tolak`,
    body: () => ({ tanggal: "2026-05-10", catatan: "Bukti belum lengkap" }),
    izin: ["nonpumk.lpj.verifikasi"],
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
  d = await buatDuniaRuteNonPumk();

  // Both proposals start in DRAFT, and the matrix below WALKS proposalA
  // forward as it goes: a permitted role's write really does execute, so the
  // proposal moves DRAFT -> PENILAIAN -> ... and the later cells meet a
  // proposal in whatever state the earlier ones left it.
  //
  // THE ASSERTIONS ARE IMMUNE TO THAT, deliberately, and that is why the file
  // is written this way rather than resetting between cells:
  //   - a role WITHOUT the permission is refused by the guard chain BEFORE any
  //     handler, any state read and any transaction, so its 403 cannot depend
  //     on the state at all;
  //   - a role WITH the permission is only ever asserted as "not 401 and not
  //     403", which holds whether the business layer accepts the call (200) or
  //     refuses it on state (409).
  // Pinning an exact status on the writes is what would make this file
  // order-dependent, so it does not.
  proposalA = (await d.buatProposal({ nama: "Yayasan Cabang A" })).id;
  proposalB = (await d.buatProposal({ cabang: d.f.cabangB, nama: "Yayasan Cabang B" })).id;
});

describe("matriks izin: setiap endpoint Non PUMK dipanggil oleh setiap peran", () => {
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

describe("spec 16 skenario 23: Auditor tidak bisa mengubah apa pun", () => {
  const tulis = KASUS.filter((k) => k.metode === "POST");
  for (const kasus of tulis) {
    test(`${kasus.nama} sebagai AUDITOR -> 403`, async () => {
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

  test("Auditor tetap bisa membaca setiap layar Non PUMK", async () => {
    for (const kasus of KASUS.filter((k) => k.metode === "GET")) {
      const res = await d.panggil("AUDITOR", kasus.path(d));
      expect(res.status).toBe(200);
    }
  });
});

describe("spec 16 skenario 24: manipulasi ID di URL tidak menembus cabang", () => {
  test("Maker cabang A tidak bisa membaca proposal cabang B walau ID benar", async () => {
    const res = await d.panggil("MAKER", `/nonpumk/proposal/${proposalB}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; kodeDomain: string; error: string };
    expect(body.code).toBe("TIDAK_BERWENANG");
    // The refusal carries the DOMAIN reason, so an operator reading a log can
    // tell a scope problem from a permission problem. This only survives the
    // shared error handler because `NonPumkError` is on its coded-error
    // allowlist; without that the 403 would be an anonymous 500.
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
    // And it does not confirm which branch the row is in: a 403 that named the
    // branch would be an oracle for enumerating another branch's data.
    expect(body.error).not.toContain(d.f.cabangB.nama);
  });

  test("timeline lintas cabang juga ditolak", async () => {
    const res = await d.panggil("MAKER", `/nonpumk/proposal/${proposalB}/timeline`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe(
      "CABANG_DILUAR_SCOPE",
    );
  });

  test("MUTASI lintas cabang ditolak, bukan hanya pembacaan", async () => {
    const res = await d.panggil("MAKER", `/nonpumk/proposal/${proposalB}/ajukan-penilaian`, {
      body: { catatan: "coba tembus" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe(
      "CABANG_DILUAR_SCOPE",
    );

    // And nothing moved: the proposal in branch B is still DRAFT.
    const baris = await d.f.db.query<{ status: string }>(
      `SELECT status FROM nonpumk_proposal WHERE id = $1`,
      [proposalB],
    );
    expect(baris[0]!.status).toBe("DRAFT");
  });

  test("membuat proposal DI cabang lain ditolak, walau cabang itu ada", async () => {
    // The one payload in the module that names a branch, because there is no
    // row yet to read it from. It is checked against the caller's scope before
    // anything is written.
    const res = await d.panggil("MAKER", "/nonpumk/proposal", {
      body: {
        cabangId: d.f.cabangB.id,
        tanggalProposal: "2026-01-05",
        namaPemohon: "Yayasan Titipan",
        bidangId: d.bidangA,
        sdg: [{ sdgId: d.sdg1 }],
        judulProgram: "Program di cabang orang lain",
        jumlahDiajukan: rp(20_000_000),
        penerimaManfaatEstimasi: 10,
      },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe(
      "CABANG_DILUAR_SCOPE",
    );
  });

  test("daftar hanya berisi cabang sendiri, dan cabangId dari klien tidak melebarkannya", async () => {
    const milikA = await d.ok<{ data: Array<{ id: string }> }>("MAKER", "/nonpumk/proposal");
    expect(milikA.data.some((b) => b.id === proposalA)).toBe(true);
    expect(milikA.data.some((b) => b.id === proposalB)).toBe(false);

    // The client asks for the OTHER branch by id. The filter is a CEILING, not
    // a trapdoor: a branch outside the caller's scope is IGNORED and the
    // caller's own branches answer, so the list neither widens nor silently
    // empties. An empty list here would be indistinguishable from "your branch
    // has no data", which is a worse answer than the true one.
    const dipaksa = await d.ok<{ data: Array<{ id: string }> }>(
      "MAKER",
      `/nonpumk/proposal?cabangId=${d.f.cabangB.id}`,
    );
    expect(dipaksa.data.some((b) => b.id === proposalB)).toBe(false);
    expect(dipaksa.data.some((b) => b.id === proposalA)).toBe(true);
  });

  test("monitoring LPJ juga tidak melebar lewat cabangId dari klien", async () => {
    const res = await d.panggil(
      "MAKER",
      `/nonpumk/monitoring-lpj?cabangId=${d.f.cabangB.id}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ cabangId: string }> };
    for (const baris of body.data) expect(baris.cabangId).not.toBe(d.f.cabangB.id);
  });

  test("Admin Pusat lintas cabang memang boleh melihat keduanya", async () => {
    // The exemption of spec 2 rule 3, asserted so the scope tests above cannot
    // be passing merely because everything is refused.
    const semua = await d.ok<{ data: Array<{ id: string }> }>(
      "ADMIN_PUSAT",
      "/nonpumk/proposal",
    );
    expect(semua.data.some((b) => b.id === proposalA)).toBe(true);
    expect(semua.data.some((b) => b.id === proposalB)).toBe(true);

    const detail = await d.panggil("ADMIN_PUSAT", `/nonpumk/proposal/${proposalB}`);
    expect(detail.status).toBe(200);
  });

  test("spec 2 rule 5: penolakan scope meninggalkan baris DITOLAK di audit_log", async () => {
    await d.panggil("MAKER", `/nonpumk/proposal/${proposalB}`);
    const baris = await d.f.auditRows({ hasil: "DITOLAK", userId: d.f.users.MAKER.id });
    expect(baris.length).toBeGreaterThan(0);
    const jalur = baris.map((b) => (b.nilai_baru_json as { path?: string } | null)?.path);
    expect(jalur).toContain(`/nonpumk/proposal/${proposalB}`);
  });
});

describe("tanpa sesi sama sekali", () => {
  test("setiap endpoint Non PUMK menjawab 401, bukan 404 dan bukan data", async () => {
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
    // like `nonpumk.penyalur` must break the boot, not turn into a permission
    // nobody can ever hold and a 403 that reads like policy.
    expect(() => resolveRequiredPermissions(["nonpumk.penyalur"])).toThrow(/tidak dikenal/);
  });

  test("setiap kode izin yang dipakai routes.ts ada di katalog auth", () => {
    // The same check, applied to the REAL list this file mirrors. This is the
    // pin that would have caught `nonpumk.lpj.verifikasi` being absent from the
    // catalogue: it is there now, granted to the Checker, and if it is ever
    // removed this fails here rather than locking every role out of LPJ
    // verification with a 403 that looks deliberate.
    const dipakai = [...new Set(KASUS.flatMap((k) => k.izin))];
    expect(() => resolveRequiredPermissions(dipakai)).not.toThrow();
    // Canonical form is the same string: none of these is an alias in flight.
    expect([...resolveRequiredPermissions(dipakai)] as string[]).toEqual(dipakai);
  });
});
