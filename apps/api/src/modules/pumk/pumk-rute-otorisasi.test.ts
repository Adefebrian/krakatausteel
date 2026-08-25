// SPEC 2 RULE 4: "Otorisasi divalidasi di layer server, bukan hanya di UI.
// Buat test yang memanggil endpoint langsung dengan role yang salah dan
// pastikan ditolak."
//
// This file calls every /pumk endpoint as every role in spec 2 and asserts the
// refusal, over the REAL app: real logins, real session cookies, the real
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
// A permitted Maker POSTing to `/pumk/pencairan` with a placeholder body gets
// a 400 or a 409, because the BUSINESS state refuses it; that is the correct
// answer and it is not what this file is measuring. What matters here is that
// the request got PAST authorisation, which "not 403 and not 401" says exactly
// and a hardcoded 400 would not (it would start failing the day a validation
// message changes). The read routes, which have no such state, are asserted on
// their exact status.
import { beforeAll, describe, expect, test } from "bun:test";
import { buatDuniaRute, rp, type DuniaRute } from "./rute-test-support";
import { resolveRequiredPermissions } from "../auth";

let d: DuniaRute;

/** Branch A rows, built once, so a scope test has something real to aim at. */
let proposalA = "";
let akadA = "";
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

/** Roles that hold each permission, straight from spec 2's wewenang column. */
const PEMEGANG: Readonly<Record<string, readonly Role[]>> = {
  "pumk.view": [...SEMUA_ROLE],
  "pumk.create": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.survey": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.review": ["CHECKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.approve": ["APPROVER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.akad": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.pencairan": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.angsuran": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.reschedule": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.hapusbuku": ["APPROVER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.penagihan": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
  "pumk.cluster": ["ADMIN_CABANG", "ADMIN_PUSAT"],
  "portal.konversi": ["MAKER", "ADMIN_CABANG", "ADMIN_PUSAT"],
};

interface Kasus {
  nama: string;
  metode: "GET" | "POST";
  path: (d: DuniaRute) => string;
  body?: (d: DuniaRute) => unknown;
  /** Permission codes, any-of, exactly as passed to requirePermission. */
  izin: readonly string[];
  /** For a GET with no business precondition, the status a permitted role gets. */
  statusOk?: number;
}

const KASUS: readonly Kasus[] = [
  // --- reads --------------------------------------------------------------
  { nama: "GET /pumk/batasan", metode: "GET", path: () => "/pumk/batasan", izin: ["pumk.view"], statusOk: 200 },
  { nama: "GET /pumk/proposal", metode: "GET", path: () => "/pumk/proposal", izin: ["pumk.view"], statusOk: 200 },
  {
    nama: "GET /pumk/proposal/:id",
    metode: "GET",
    path: () => `/pumk/proposal/${proposalA}`,
    izin: ["pumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /pumk/proposal/:id/timeline",
    metode: "GET",
    path: () => `/pumk/proposal/${proposalA}/timeline`,
    izin: ["pumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /pumk/proposal/:id/jaminan",
    metode: "GET",
    path: () => `/pumk/proposal/${proposalA}/jaminan`,
    izin: ["pumk.view"],
    statusOk: 200,
  },
  { nama: "GET /pumk/akad", metode: "GET", path: () => "/pumk/akad", izin: ["pumk.view"], statusOk: 200 },
  {
    nama: "GET /pumk/akad/:id",
    metode: "GET",
    path: () => `/pumk/akad/${akadA}`,
    izin: ["pumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /pumk/akad/:id/jadwal",
    metode: "GET",
    path: () => `/pumk/akad/${akadA}/jadwal`,
    izin: ["pumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /pumk/akad/:id/tindak-lanjut",
    metode: "GET",
    path: () => `/pumk/akad/${akadA}/tindak-lanjut`,
    izin: ["pumk.view"],
    statusOk: 200,
  },
  { nama: "GET /pumk/reschedule", metode: "GET", path: () => "/pumk/reschedule", izin: ["pumk.view"], statusOk: 200 },
  { nama: "GET /pumk/pengakhiran", metode: "GET", path: () => "/pumk/pengakhiran", izin: ["pumk.view"], statusOk: 200 },
  { nama: "GET /pumk/cluster", metode: "GET", path: () => "/pumk/cluster", izin: ["pumk.view"], statusOk: 200 },
  {
    nama: "GET /pumk/cluster/:id",
    metode: "GET",
    path: (d) => `/pumk/cluster/${d.clusterA}`,
    izin: ["pumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /pumk/cluster/:id/anggota",
    metode: "GET",
    path: (d) => `/pumk/cluster/${d.clusterA}/anggota`,
    izin: ["pumk.view"],
    statusOk: 200,
  },
  {
    nama: "GET /pumk/kartu-piutang/:akadId",
    metode: "GET",
    path: () => `/pumk/kartu-piutang/${akadA}`,
    izin: ["pumk.view"],
    statusOk: 200,
  },
  { nama: "GET /pumk/mitra", metode: "GET", path: () => "/pumk/mitra", izin: ["pumk.view"], statusOk: 200 },

  // --- writes -------------------------------------------------------------
  {
    nama: "POST /pumk/proposal",
    metode: "POST",
    path: () => "/pumk/proposal",
    body: (d) => ({
      cabangId: d.f.cabangA.id,
      mitraId: d.f.cabangA.id,
      tanggalProposal: "2026-01-05",
      jumlahDiajukan: rp(10_000_000),
      tenorDiajukan: 12,
    }),
    izin: ["pumk.create"],
  },
  {
    nama: "POST /pumk/proposal/:id/jaminan",
    metode: "POST",
    path: () => `/pumk/proposal/${proposalA}/jaminan`,
    body: () => ({ jenis: "BPKB", deskripsi: "Motor" }),
    izin: ["pumk.create"],
  },
  {
    nama: "POST /pumk/proposal/:id/submit-survey",
    metode: "POST",
    path: () => `/pumk/proposal/${proposalA}/submit-survey`,
    body: () => ({ catatan: null }),
    izin: ["pumk.create"],
  },
  {
    nama: "POST /pumk/proposal/:id/ajukan-checker",
    metode: "POST",
    path: () => `/pumk/proposal/${proposalA}/ajukan-checker`,
    body: () => ({ catatan: null }),
    izin: ["pumk.create"],
  },
  {
    nama: "POST /pumk/proposal/:id/review",
    metode: "POST",
    path: () => `/pumk/proposal/${proposalA}/review`,
    body: () => ({ tanggal: "2026-01-15", keputusan: "REKOMENDASI" }),
    izin: ["pumk.review"],
  },
  {
    nama: "POST /pumk/proposal/:id/persetujuan",
    metode: "POST",
    path: () => `/pumk/proposal/${proposalA}/persetujuan`,
    body: () => ({ tanggal: "2026-01-20", keputusan: "SETUJU", plafonDisetujui: rp(10_000_000), tenorDisetujui: 12 }),
    izin: ["pumk.approve"],
  },
  {
    nama: "POST /pumk/survey",
    metode: "POST",
    path: () => "/pumk/survey",
    body: () => ({
      proposalId: proposalA,
      tanggalSurvey: "2026-01-12",
      skorTotal: "80",
      plafonRekomendasi: rp(10_000_000),
      tenorRekomendasi: 12,
    }),
    izin: ["pumk.survey"],
  },
  {
    nama: "POST /pumk/portal/konversi",
    metode: "POST",
    path: () => "/pumk/portal/konversi",
    body: (d) => ({
      submissionId: d.f.cabangA.id,
      cabangId: d.f.cabangA.id,
      mitraId: d.f.cabangA.id,
      tanggalProposal: "2026-01-05",
    }),
    izin: ["portal.konversi"],
  },
  {
    nama: "POST /pumk/akad",
    metode: "POST",
    path: () => "/pumk/akad",
    body: () => ({
      proposalId: proposalA,
      tanggalAkad: "2026-02-05",
      tanggalMulaiAngsuran: "2026-03-10",
    }),
    izin: ["pumk.akad"],
  },
  {
    nama: "POST /pumk/akad/:id/jadwal",
    metode: "POST",
    path: () => `/pumk/akad/${akadA}/jadwal`,
    body: () => ({}),
    izin: ["pumk.akad"],
  },
  {
    nama: "POST /pumk/akad/:id/tindak-lanjut",
    metode: "POST",
    path: () => `/pumk/akad/${akadA}/tindak-lanjut`,
    body: () => ({ tanggal: "2026-06-01", jenis: "KUNJUNGAN", hasil: "Bertemu mitra" }),
    izin: ["pumk.penagihan"],
  },
  {
    nama: "POST /pumk/pencairan",
    metode: "POST",
    path: () => "/pumk/pencairan",
    body: (d) => ({
      akadId: akadA,
      tanggalPencairan: "2026-02-10",
      jumlah: rp(10_000_000),
      akunKasId: d.akunKasId,
    }),
    izin: ["pumk.pencairan"],
  },
  {
    nama: "POST /pumk/angsuran",
    metode: "POST",
    path: () => "/pumk/angsuran",
    body: (d) => ({
      akadId: akadA,
      tanggalTerima: "2026-03-10",
      jumlah: rp(1_030_000),
      akunKasId: d.akunKasId,
    }),
    izin: ["pumk.angsuran"],
  },
  {
    nama: "POST /pumk/simulasi",
    metode: "POST",
    path: () => "/pumk/simulasi",
    body: () => ({
      pokok: rp(10_000_000),
      rate: "0.030000",
      metode: "FLAT",
      tenorBulan: 12,
      gracePeriodBulan: 0,
      tanggalMulaiAngsuran: "2026-03-10",
    }),
    izin: ["pumk.view"],
  },
  {
    nama: "POST /pumk/reschedule/pratinjau",
    metode: "POST",
    path: () => "/pumk/reschedule/pratinjau",
    body: () => ({ akadId: akadA, jenis: "PERPANJANG_TENOR", tenorBaru: 24 }),
    izin: ["pumk.reschedule"],
  },
  {
    nama: "POST /pumk/reschedule",
    metode: "POST",
    path: () => "/pumk/reschedule",
    body: () => ({
      akadId: akadA,
      tanggalPengajuan: "2026-06-01",
      alasan: "Usaha terdampak",
      jenis: "PERPANJANG_TENOR",
      tenorBaru: 24,
    }),
    izin: ["pumk.reschedule"],
  },
  {
    nama: "POST /pumk/reschedule/:id/setujui",
    metode: "POST",
    path: () => `/pumk/reschedule/${akadA}/setujui`,
    body: () => ({}),
    izin: ["pumk.approve"],
  },
  {
    nama: "POST /pumk/pengakhiran/pratinjau",
    metode: "POST",
    path: () => "/pumk/pengakhiran/pratinjau",
    body: () => ({ akadId: akadA, jenis: "HAPUS_BUKU", tanggal: "2027-06-30" }),
    izin: ["pumk.hapusbuku", "pumk.approve"],
  },
  {
    nama: "POST /pumk/pengakhiran",
    metode: "POST",
    path: () => "/pumk/pengakhiran",
    body: () => ({
      akadId: akadA,
      jenis: "HAPUS_BUKU",
      tanggal: "2027-06-30",
      dasarKeputusan: "SK direksi",
    }),
    izin: ["pumk.hapusbuku", "pumk.approve"],
  },
  {
    nama: "POST /pumk/cluster/:id/anggota",
    metode: "POST",
    path: (d) => `/pumk/cluster/${d.clusterA}/anggota`,
    body: (d) => ({ mitraId: d.f.cabangA.id, tanggalMasuk: "2026-01-05" }),
    izin: ["pumk.cluster"],
  },
  {
    nama: "POST /pumk/cluster/:id/anggota/keluar",
    metode: "POST",
    path: (d) => `/pumk/cluster/${d.clusterA}/anggota/keluar`,
    body: (d) => ({ mitraId: d.f.cabangA.id, tanggalKeluar: "2026-06-01", alasan: "Pindah kota" }),
    izin: ["pumk.cluster"],
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
  d = await buatDuniaRute();

  // Branch A: a proposal carried far enough to have an akad, so the by-id
  // routes point at something real rather than at a 404 that would mask a
  // missing permission check.
  const mitraA = await d.buatMitra({ nama: "Warga Cabang A" });
  const p = await d.ok<{ id: string }>("MAKER", "/pumk/proposal", {
    body: {
      cabangId: d.f.cabangA.id,
      mitraId: mitraA.id,
      sektorId: d.sektorId,
      tanggalProposal: "2026-01-05",
      jumlahDiajukan: rp(10_000_000),
      tenorDiajukan: 12,
    },
  });
  proposalA = p.id;
  await d.ok("MAKER", `/pumk/proposal/${proposalA}/submit-survey`, { body: {} });
  await d.ok("MAKER", "/pumk/survey", {
    body: {
      proposalId: proposalA,
      tanggalSurvey: "2026-01-12",
      skorTotal: "80",
      plafonRekomendasi: rp(10_000_000),
      tenorRekomendasi: 12,
    },
  });
  await d.ok("MAKER", `/pumk/proposal/${proposalA}/ajukan-checker`, { body: {} });
  await d.ok("CHECKER", `/pumk/proposal/${proposalA}/review`, {
    body: { tanggal: "2026-01-15", keputusan: "REKOMENDASI" },
  });
  await d.ok("APPROVER", `/pumk/proposal/${proposalA}/persetujuan`, {
    body: {
      tanggal: "2026-01-20",
      keputusan: "SETUJU",
      plafonDisetujui: rp(10_000_000),
      tenorDisetujui: 12,
    },
  });
  const akad = await d.ok<{ id: string }>("MAKER", "/pumk/akad", {
    body: {
      proposalId: proposalA,
      tanggalAkad: "2026-02-05",
      tanggalMulaiAngsuran: "2026-03-10",
    },
  });
  akadA = akad.id;

  // Branch B: one proposal, so the scope tests aim at a row that EXISTS and
  // the refusal cannot be confused with "not found".
  const mitraB = await d.buatMitra({ cabang: d.f.cabangB, nama: "Warga Cabang B" });
  const pb = await d.ok<{ id: string }>("MAKER_B", "/pumk/proposal", {
    body: {
      cabangId: d.f.cabangB.id,
      mitraId: mitraB.id,
      sektorId: d.sektorId,
      tanggalProposal: "2026-01-06",
      jumlahDiajukan: rp(8_000_000),
      tenorDiajukan: 12,
    },
  });
  proposalB = pb.id;
});

describe("matriks izin: setiap endpoint PUMK dipanggil oleh setiap peran", () => {
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

  test("Auditor tetap bisa membaca setiap layar PUMK", async () => {
    for (const kasus of KASUS.filter((k) => k.metode === "GET")) {
      const res = await d.panggil("AUDITOR", kasus.path(d));
      expect(res.status).toBe(200);
    }
  });
});

describe("spec 16 skenario 24: manipulasi ID di URL tidak menembus cabang", () => {
  test("Maker cabang A tidak bisa membaca proposal cabang B walau ID benar", async () => {
    const res = await d.panggil("MAKER", `/pumk/proposal/${proposalB}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; kodeDomain: string; error: string };
    expect(body.code).toBe("TIDAK_BERWENANG");
    // The refusal carries the DOMAIN reason, so an operator reading a log can
    // tell a scope problem from a permission problem.
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
    // And it does not confirm which branch the row is in: a 403 that named the
    // branch would be an oracle for enumerating another branch's data.
    expect(body.error).not.toContain(d.f.cabangB.nama);
  });

  test("timeline dan jaminan lintas cabang juga ditolak", async () => {
    for (const path of [
      `/pumk/proposal/${proposalB}/timeline`,
      `/pumk/proposal/${proposalB}/jaminan`,
    ]) {
      const res = await d.panggil("MAKER", path);
      expect(res.status).toBe(403);
    }
  });

  test("akad, kartu piutang dan cluster lintas cabang ditolak", async () => {
    const akadLain = await d.f.db.query<{ id: string }>(
      `SELECT id::text AS id FROM pumk_akad WHERE cabang_id = $1 LIMIT 1`,
      [d.f.cabangB.id],
    );
    const paths = [`/pumk/cluster/${d.clusterB}`, `/pumk/cluster/${d.clusterB}/anggota`];
    if (akadLain[0]) {
      paths.push(`/pumk/akad/${akadLain[0].id}`, `/pumk/kartu-piutang/${akadLain[0].id}`);
    }
    for (const path of paths) {
      const res = await d.panggil("MAKER", path);
      expect(res.status).toBe(403);
    }
  });

  test("MUTASI lintas cabang ditolak, bukan hanya pembacaan", async () => {
    const res = await d.panggil("MAKER", `/pumk/proposal/${proposalB}/submit-survey`, {
      body: { catatan: "coba tembus" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { kodeDomain: string };
    expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");

    // And nothing moved: the proposal in branch B is still DRAFT.
    const baris = await d.f.db.query<{ status: string }>(
      `SELECT status FROM pumk_proposal WHERE id = $1`,
      [proposalB],
    );
    expect(baris[0]!.status).toBe("DRAFT");
  });

  test("daftar hanya berisi cabang sendiri, dan cabangId dari klien tidak melebarkannya", async () => {
    const milikA = await d.ok<{ data: Array<{ id: string }> }>("MAKER", "/pumk/proposal");
    expect(milikA.data.some((b) => b.id === proposalA)).toBe(true);
    expect(milikA.data.some((b) => b.id === proposalB)).toBe(false);

    // The client asks for the OTHER branch by id. The filter is intersected
    // with what the session allows, so the answer is empty rather than wider.
    const dipaksa = await d.ok<{ data: unknown[] }>(
      "MAKER",
      `/pumk/proposal?cabangId=${d.f.cabangB.id}`,
    );
    expect(dipaksa.data).toEqual([]);
  });

  test("Admin Pusat lintas cabang memang boleh melihat keduanya", async () => {
    // The exemption of spec 2 rule 3, asserted so the scope test above cannot
    // be passing merely because everything is refused.
    const semua = await d.ok<{ data: Array<{ id: string }> }>("ADMIN_PUSAT", "/pumk/proposal");
    expect(semua.data.some((b) => b.id === proposalA)).toBe(true);
    expect(semua.data.some((b) => b.id === proposalB)).toBe(true);

    const detail = await d.panggil("ADMIN_PUSAT", `/pumk/proposal/${proposalB}`);
    expect(detail.status).toBe(200);
  });

  test("spec 2 rule 5: penolakan scope meninggalkan baris DITOLAK di audit_log", async () => {
    await d.panggil("MAKER", `/pumk/proposal/${proposalB}`);
    const baris = await d.f.auditRows({ hasil: "DITOLAK", userId: d.f.users.MAKER.id });
    expect(baris.length).toBeGreaterThan(0);
    const jalur = baris.map((b) => (b.nilai_baru_json as { path?: string } | null)?.path);
    expect(jalur).toContain(`/pumk/proposal/${proposalB}`);
  });
});

describe("tanpa sesi sama sekali", () => {
  test("setiap endpoint PUMK menjawab 401, bukan 404 dan bukan data", async () => {
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
    // like `pumk.aprove` must break the boot, not turn into a permission nobody
    // can ever hold and a 403 that reads like policy.
    expect(() => resolveRequiredPermissions(["pumk.aprove"])).toThrow(/tidak dikenal/);
  });

  test("setiap kode izin yang dipakai routes.ts ada di katalog auth", () => {
    // The same check, applied to the REAL list this file mirrors. If a route
    // starts requiring a code the catalogue does not have, this fails here
    // rather than silently locking every role out of that endpoint.
    const dipakai = [...new Set(KASUS.flatMap((k) => k.izin))];
    expect(() => resolveRequiredPermissions(dipakai)).not.toThrow();
    // Canonical form is the same string: none of these is an alias in flight.
    expect([...resolveRequiredPermissions(dipakai)] as string[]).toEqual(dipakai);
  });
});
