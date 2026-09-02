// apps/api/src/modules/laporan/laporan-rute-operasional.test.ts
//
// THE HTTP SURFACE OF THE OTHER TWENTY-THREE REPORTS, over the REAL app: real
// logins, real session cookies, the real guard chain, the real error handler.
//
// ./laporan-pumk.test.ts, ./laporan-nonpumk.test.ts and ./laporan-lainnya.test.ts
// prove the ENGINES compute the right figures. This file proves the ROUTES
// exist, are reachable by every role spec 2 grants `laporan.view`, refuse a
// malformed query at the boundary with per-field detail, and carry the domain
// refusal's own code out to the client. A route that read `cabangId` from the
// wrong place would compute a perfectly correct report for the wrong branch and
// every engine test would still pass.
//
// AND IT CLOSES THE CATALOGUE'S ONE REMAINING HOLE. `GET /laporan/katalog` now
// names thirty reports; the first test below calls EVERY path it names with
// valid parameters and asserts a 200. A catalogue entry pointing at a route
// nobody registered is a menu of dead links, and that is not detectable by
// reading either file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buatDuniaRuteLaporan,
  tutupSemuaFixture,
  type DuniaRuteLaporan,
} from "./rute-test-support";
import { BATAS_AUDIT_TRAIL_MAKS, NAMA_LAPORAN_OPERASIONAL } from "./index";

afterAll(tutupSemuaFixture);

let d: DuniaRuteLaporan;

const SEMUA_ROLE = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
] as const;

interface EntriKatalog {
  nomor: number;
  kode: string;
  nama: string;
  path: string;
  perluPeriode: boolean;
  perluAkun: boolean;
}

/**
 * A valid query string for every path in the catalogue, as a Semua Cabang
 * caller would send it.
 *
 * DRIVEN BY THE CATALOGUE'S OWN `perluPeriode` AND `perluAkun` FLAGS, plus the
 * three paths that need something else. That is deliberate: if a later report
 * arrives in the catalogue and needs a parameter, this map does not silently
 * cover it -- the call 400s and this file fails, which is the point.
 */
function kueri(entri: EntriKatalog, d: DuniaRuteLaporan): string {
  const bagian: string[] = [];
  if (entri.perluPeriode) bagian.push(`periodeId=${d.periodeLaporan.id}`);
  if (entri.perluAkun) bagian.push(`akunId=${d.akun.kas}`);
  if (entri.path === "/laporan/kartu-piutang") bagian.push(`mitraId=${d.mitraKosong}`);
  if (entri.path === "/laporan/jatuh-tempo") {
    bagian.push("dariTanggal=2026-04-01", "sampaiTanggal=2026-06-30");
  }
  if (entri.path === "/laporan/audit-trail") {
    bagian.push("dariTanggal=2026-03-01", "sampaiTanggal=2026-03-31");
  }
  return bagian.length === 0 ? entri.path : `${entri.path}?${bagian.join("&")}`;
}

async function katalog(): Promise<EntriKatalog[]> {
  const hasil = await d.ok<{ data: EntriKatalog[] }>("ADMIN_PUSAT", "/laporan/katalog");
  return hasil.data;
}

beforeAll(async () => {
  d = await buatDuniaRuteLaporan();
});

// ---------------------------------------------------------------------------
// The catalogue is not a menu of dead links
// ---------------------------------------------------------------------------

describe("katalog: setiap laporan yang disebut benar-benar menjawab", () => {
  test("ketiga puluh path menjawab 200 untuk Admin Pusat", async () => {
    const entri = await katalog();
    expect(entri).toHaveLength(30);
    for (const e of entri) {
      const res = await d.panggil("ADMIN_PUSAT", kueri(e, d));
      expect(res.status, `${e.nomor} ${e.path}`).toBe(200);
    }
  });

  test("nama di katalog = nama yang dicetak di header laporan itu", async () => {
    const entri = await katalog();
    for (const e of entri) {
      const hasil = await d.ok<{ header?: { namaLaporan: string } }>(
        "ADMIN_PUSAT",
        kueri(e, d),
      );
      // Report 16 is a chart with a header like every other report; every
      // entry in this catalogue prints one, so a mismatch here is a screen
      // title and a printed page disagreeing about what the reader is holding.
      expect(hasil.header?.namaLaporan, e.path).toBe(e.nama);
    }
  });

  test("nama laporan operasional persis seperti katalog spesifikasi", async () => {
    const entri = await katalog();
    const perNomor = new Map(entri.map((e) => [e.nomor, e.nama]));
    expect(perNomor.get(1)).toBe(NAMA_LAPORAN_OPERASIONAL.REALISASI_WILAYAH);
    expect(perNomor.get(5)).toBe(NAMA_LAPORAN_OPERASIONAL.JATUH_TEMPO);
    expect(perNomor.get(12)).toBe(NAMA_LAPORAN_OPERASIONAL.PENYALURAN_NON_PUMK);
    expect(perNomor.get(21)).toBe(NAMA_LAPORAN_OPERASIONAL.REKAP_JURNAL);
    expect(perNomor.get(25)).toBe(NAMA_LAPORAN_OPERASIONAL.PORTAL_PUMK);
    expect(perNomor.get(26)).toBe(NAMA_LAPORAN_OPERASIONAL.PORTAL_NON_PUMK);
    expect(perNomor.get(31)).toBe(NAMA_LAPORAN_OPERASIONAL.AUDIT_TRAIL);
    // Report 24 is modules/rka's, and this catalogue must not claim it.
    expect(perNomor.has(24)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authorisation, spec 2 rule 4
// ---------------------------------------------------------------------------

describe("otorisasi: satu izin, enam peran, dan tidak ada sesi", () => {
  test("setiap peran boleh membuka laporan operasional di cabangnya sendiri", async () => {
    // Spec 2 gives ONE reporting privilege, `laporan.view`, to all six roles.
    // A branch-scoped role asks for its OWN branch; Semua Cabang is a separate
    // question, tested below.
    const jalur = [
      `/laporan/realisasi-sektor?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
      `/laporan/penerimaan-angsuran?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
      `/laporan/penyaluran-non-pumk?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
      `/laporan/rekap-jurnal?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
      `/laporan/demografi-mitra?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
    ];
    for (const role of SEMUA_ROLE) {
      for (const j of jalur) {
        const res = await d.panggil(role, j);
        expect(res.status, `${role} ${j}`).toBe(200);
      }
    }
  });

  test("tanpa sesi setiap jalur operasional menjawab 401, bukan 404 dan bukan data", async () => {
    for (const e of await katalog()) {
      const res = await d.f.request(kueri(e, d));
      expect(res.status, e.path).toBe(401);
    }
  });

  test("spec 16 skenario 24: cabang lain dan Semua Cabang DITOLAK, bukan dikosongkan", async () => {
    const p = d.periodeLaporan.id;
    for (const jalur of [
      `/laporan/realisasi-wilayah?periodeId=${p}`,
      `/laporan/aging-piutang?periodeId=${p}`,
      `/laporan/monitoring-lpj?periodeId=${p}`,
      `/laporan/portal-pumk?periodeId=${p}`,
      "/laporan/audit-trail?dariTanggal=2026-03-01&sampaiTanggal=2026-03-31",
    ]) {
      const res = await d.panggil("MAKER", jalur);
      expect(res.status, jalur).toBe(403);
      const body = (await res.json()) as { code: string; kodeDomain?: string };
      expect(body.kodeDomain, jalur).toBe("CABANG_DILUAR_SCOPE");
    }
    // And the same for an explicitly named branch the session does not carry.
    const res = await d.panggil(
      "MAKER",
      `/laporan/realisasi-sektor?periodeId=${p}&cabangId=${d.f.cabangB.id}`,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { kodeDomain?: string }).kodeDomain).toBe(
      "CABANG_DILUAR_SCOPE",
    );
  });
});

// ---------------------------------------------------------------------------
// Boundary validation, BEFORE any engine call
// ---------------------------------------------------------------------------

describe("validasi di batas: 400 dengan rincian per field", () => {
  async function tolak400(jalur: string, field: string): Promise<void> {
    const res = await d.panggil("ADMIN_PUSAT", jalur);
    expect(res.status, jalur).toBe(400);
    const body = (await res.json()) as { code: string; detail?: Record<string, string[]> };
    expect(body.code, jalur).toBe("VALIDASI");
    expect(Object.keys(body.detail ?? {}), jalur).toContain(field);
  }

  test("periodeId hilang atau bukan UUID", async () => {
    await tolak400("/laporan/realisasi-sektor", "periodeId");
    await tolak400("/laporan/aging-piutang?periodeId=bukan-uuid", "periodeId");
    await tolak400("/laporan/rekap-jurnal?periodeId=12345", "periodeId");
  });

  test("mode hanya BULANAN atau KUMULATIF_YTD", async () => {
    await tolak400(
      `/laporan/realisasi-sektor?periodeId=${d.periodeLaporan.id}&mode=ytd`,
      "mode",
    );
    // And the two legal values really are accepted.
    for (const mode of ["BULANAN", "KUMULATIF_YTD"]) {
      const res = await d.panggil(
        "ADMIN_PUSAT",
        `/laporan/realisasi-sektor?periodeId=${d.periodeLaporan.id}&mode=${mode}`,
      );
      expect(res.status, mode).toBe(200);
    }
  });

  test("laporan 5 butuh dua tanggal, dan menolak yang bukan tanggal", async () => {
    await tolak400("/laporan/jatuh-tempo?sampaiTanggal=2026-06-30", "dariTanggal");
    await tolak400(
      "/laporan/jatuh-tempo?dariTanggal=1-4-2026&sampaiTanggal=2026-06-30",
      "dariTanggal",
    );
    // A window whose end precedes its start passes the SHAPE check and is
    // refused by the ENGINE, with its own domain code rather than a 400.
    const res = await d.panggil(
      "ADMIN_PUSAT",
      "/laporan/jatuh-tempo?dariTanggal=2026-06-30&sampaiTanggal=2026-04-01",
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { kodeDomain?: string }).kodeDomain).toBe(
      "TANGGAL_TIDAK_VALID",
    );
  });

  test("laporan 9 butuh mitraId, laporan 31 menolak hasil dan paging di luar rentang", async () => {
    await tolak400(`/laporan/kartu-piutang?periodeId=${d.periodeLaporan.id}`, "mitraId");
    const audit = "/laporan/audit-trail?dariTanggal=2026-03-01&sampaiTanggal=2026-03-31";
    await tolak400(`${audit}&hasil=MUNGKIN`, "hasil");
    await tolak400(`${audit}&batas=0`, "batas");
    await tolak400(`${audit}&batas=${BATAS_AUDIT_TRAIL_MAKS + 1}`, "batas");
    await tolak400(`${audit}&offset=-1`, "offset");
    await tolak400(`${audit}&userId=bukan-uuid`, "userId");
  });

  test("setiap field yang salah dikumpulkan dalam SATU jawaban", async () => {
    // One round trip, one list of everything wrong with the request. A form
    // that has to be submitted five times to learn five problems is the thing
    // this collects against.
    const res = await d.panggil(
      "ADMIN_PUSAT",
      "/laporan/kartu-piutang?periodeId=bukan&cabangId=juga-bukan&mitraId=bukan-juga",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: Record<string, string[]> };
    expect(Object.keys(body.detail ?? {}).sort()).toEqual([
      "cabangId",
      "mitraId",
      "periodeId",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Domain refusals reach the client with their own code
// ---------------------------------------------------------------------------

describe("penolakan domain sampai ke klien dengan kodeDomain-nya sendiri", () => {
  test("periode tidak dikenal -> PERIODE_TIDAK_DITEMUKAN", async () => {
    const res = await d.panggil(
      "ADMIN_PUSAT",
      "/laporan/realisasi-sektor?periodeId=00000000-0000-4000-8000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { kodeDomain?: string }).kodeDomain).toBe(
      "PERIODE_TIDAK_DITEMUKAN",
    );
  });

  test("mitra tidak dikenal -> MITRA_TIDAK_DITEMUKAN", async () => {
    const res = await d.panggil(
      "ADMIN_PUSAT",
      `/laporan/kartu-piutang?periodeId=${d.periodeLaporan.id}` +
        "&mitraId=00000000-0000-4000-8000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { kodeDomain?: string }).kodeDomain).toBe(
      "MITRA_TIDAK_DITEMUKAN",
    );
  });

  test("path laporan yang tidak ada tetap 404 dalam amplop API, bukan teks Hono", async () => {
    const res = await d.panggil("ADMIN_PUSAT", "/laporan/laporan-yang-tidak-ada");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("TIDAK_DITEMUKAN");
    expect(body.error).toContain("laporan");
  });
});

// ---------------------------------------------------------------------------
// Spec 16 scenario 23, over the new surface
// ---------------------------------------------------------------------------

describe("spec 16 skenario 23: tidak ada satu pun rute yang mengubah data", () => {
  test("setiap metode selain GET pada setiap jalur katalog ditolak", async () => {
    for (const e of await katalog()) {
      for (const metode of ["POST", "PUT", "PATCH", "DELETE"]) {
        // The read-only guard answers first for an Auditor; for a writing role
        // the router simply has no such route and falls through to this
        // module's own 404. Either way NOTHING is registered that could write.
        const res = await d.panggil("AUDITOR", kueri(e, d), { method: metode, body: {} });
        expect(res.status, `${metode} ${e.path}`).toBe(403);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe("TIDAK_BERWENANG");
        expect(body.error).toContain("read only");
      }
    }
  });

  test("Admin Pusat, yang tidak read only, tetap tidak menemukan rute non GET", async () => {
    for (const jalur of [
      "/laporan/realisasi-wilayah",
      "/laporan/aging-piutang",
      "/laporan/audit-trail",
    ]) {
      for (const metode of ["POST", "PUT", "DELETE"]) {
        const res = await d.panggil("ADMIN_PUSAT", jalur, { method: metode, body: {} });
        expect(res.status, `${metode} ${jalur}`).toBe(404);
      }
    }
  });
});
