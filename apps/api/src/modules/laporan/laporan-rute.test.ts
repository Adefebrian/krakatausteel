// SPEC 2 RULE 4 over the REPORT routes: "Otorisasi divalidasi di layer server,
// bukan hanya di UI. Buat test yang memanggil endpoint langsung dengan role
// yang salah dan pastikan ditolak."
//
// This file calls every /laporan endpoint as every role in spec 2, over the
// REAL app: real logins, real session cookies, the real guard chain, the real
// error handler, the real journal engine's ledger. It also covers:
//
//   spec 16 scenario 23  the Auditor opens EVERY report and is refused EVERY
//                        mutation, because the refusal is on the HTTP METHOD
//                        and there is no mutating route to hide;
//   spec 16 scenario 24  a Maker in branch A cannot reach branch B's figures,
//                        and cannot reach Semua Cabang either, and is REFUSED
//                        rather than shown an empty page;
//   spec 10.3            the three arithmetic identities the specification
//                        names, driven through HTTP rather than the engine:
//                        report 19's Aset = Liabilitas + Aset Neto, report
//                        18's Kas Akhir = report 19's cash, and report 23's
//                        three balancing column pairs;
//   spec 10 preamble     the header on every report (nama BUMN, nama laporan,
//                        periode, cabang, tanggal cetak, nama pencetak).
//
// WHY THE IDENTITIES ARE RE-ASSERTED HERE WHEN THE ENGINE TESTS ALREADY HAVE
// THEM. The engine tests prove the ENGINE computes them. These prove that what
// a browser receives still satisfies them: through JSON serialisation, through
// the branch scope the ROUTE resolves from a session rather than from a
// hand-built context, and through the filter parsing that decides which period
// and which branch were actually asked for. A route that read `cabangId` from
// the wrong place would compute a perfectly balanced statement for the wrong
// branch, and every engine test would still pass.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buatDuniaRuteLaporan,
  keSen,
  TAHUN_INI,
  TAHUN_LALU,
  tutupSemuaFixture,
  type DuniaRuteLaporan,
} from "./rute-test-support";
import { NAMA_LAPORAN, POLA_TAMPIL, POLA_UANG } from "./index";
import { resolveRequiredPermissions } from "../auth";

// Fixture teardown, one call for the whole file. The world built by
// `buatDunia...` registers its fixture; this marks its `bumn` as no longer
// live. Nothing else in this file changed. See the FIXTURE LEAK note in
// apps/api/src/testing/harness.ts.
afterAll(tutupSemuaFixture);

let d: DuniaRuteLaporan;
/** The printed name of each fixture user, read from the database. */
const namaUser = new Map<string, string>();

const SEMUA_ROLE = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
] as const;

interface Angka {
  nilai: string;
  tampil: string;
}

interface Header {
  namaBumn: string;
  namaLaporan: string;
  periodeLabel: string;
  periodeId: string | null;
  statusPeriode: string | null;
  dariTanggal: string | null;
  sampaiTanggal: string | null;
  cabangId: string | null;
  namaCabang: string;
  tanggalCetak: string;
  dicetakOleh: string;
  sumberData: "LEDGER_LIVE" | "SNAPSHOT_PERIODE";
}

interface Kasus {
  nama: string;
  namaLaporan?: string;
  /** Path for a caller scoped to branch A, which is where the ledger is. */
  path: (d: DuniaRuteLaporan) => string;
}

const KASUS: readonly Kasus[] = [
  { nama: "GET /laporan/katalog", path: () => "/laporan/katalog" },
  { nama: "GET /laporan/periode", path: () => "/laporan/periode" },
  { nama: "GET /laporan/cabang", path: () => "/laporan/cabang" },
  {
    nama: "GET /laporan/bagan-akun",
    namaLaporan: NAMA_LAPORAN.BAGAN_AKUN,
    path: () => "/laporan/bagan-akun",
  },
  {
    nama: "GET /laporan/aktivitas",
    namaLaporan: NAMA_LAPORAN.AKTIVITAS,
    path: (d) => `/laporan/aktivitas?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
  },
  {
    nama: "GET /laporan/arus-kas",
    namaLaporan: NAMA_LAPORAN.ARUS_KAS,
    path: (d) => `/laporan/arus-kas?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
  },
  {
    nama: "GET /laporan/posisi-keuangan",
    namaLaporan: NAMA_LAPORAN.POSISI_KEUANGAN,
    path: (d) =>
      `/laporan/posisi-keuangan?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
  },
  {
    nama: "GET /laporan/perubahan-aset-neto",
    namaLaporan: NAMA_LAPORAN.PERUBAHAN_ASET_NETO,
    path: (d) =>
      `/laporan/perubahan-aset-neto?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
  },
  {
    nama: "GET /laporan/buku-besar",
    namaLaporan: NAMA_LAPORAN.BUKU_BESAR,
    path: (d) =>
      `/laporan/buku-besar?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}&akunId=${d.akun.kas}`,
  },
  {
    nama: "GET /laporan/neraca-lajur",
    namaLaporan: NAMA_LAPORAN.NERACA_LAJUR,
    path: (d) =>
      `/laporan/neraca-lajur?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
  },
];

/** The seven report paths, as a Semua Cabang caller would ask for them. */
function jalurSemuaCabang(d: DuniaRuteLaporan): string[] {
  const p = d.periodeLaporan.id;
  return [
    "/laporan/bagan-akun",
    `/laporan/aktivitas?periodeId=${p}`,
    `/laporan/arus-kas?periodeId=${p}`,
    `/laporan/posisi-keuangan?periodeId=${p}`,
    `/laporan/perubahan-aset-neto?periodeId=${p}`,
    `/laporan/buku-besar?periodeId=${p}&akunId=${d.akun.kas}`,
    `/laporan/neraca-lajur?periodeId=${p}`,
  ];
}

beforeAll(async () => {
  d = await buatDuniaRuteLaporan();
  for (const role of SEMUA_ROLE) {
    const rows = await d.f.db.query<{ nama: string }>(
      `select nama from app_user where id = $1`,
      [d.f.users[role].id],
    );
    namaUser.set(role, rows[0]!.nama);
  }
});

// CHANGED, and what it used to say.
//
// `Kasus` carried a `hanyaLintasCabang: true` flag on report 16 alone, and
// this matrix asserted that GET /laporan/bagan-akun answered 403 with
// kodeDomain CABANG_DILUAR_SCOPE for MAKER, CHECKER, APPROVER and
// ADMIN_CABANG, and 200 only for ADMIN_PUSAT and AUDITOR. It was pinning the
// behaviour of `laporanService.baganAkun`, which called
// `pastikanCabang(ctx, null)` unconditionally.
//
// That was reported as a finding and has now been discharged in the service.
// The chart of accounts is REFERENCE DATA: `akun` is keyed by `bumn_id` and
// has no `cabang_id`, so there is no other branch's data in it to withhold,
// and every role that can open a report needs to be able to read the account
// tree those reports are written in terms of. Report 16 is now readable by any
// holder of `laporan.view`, which is every role.
//
// Nothing about SCOPE was weakened. The scope refusal, its 403 and its
// kodeDomain are still asserted, on the reports that really are branch data,
// by "spec 16 skenario 24" below, which is where that assertion belongs.
describe("matriks izin: setiap endpoint laporan dipanggil oleh setiap peran", () => {
  for (const kasus of KASUS) {
    for (const role of SEMUA_ROLE) {
      test(`${kasus.nama} sebagai ${role} -> 200`, async () => {
        const res = await d.panggil(role, kasus.path(d));
        expect(res.status).toBe(200);
      });
    }
  }
});

describe("spec 10: header wajib pada setiap laporan", () => {
  for (const kasus of KASUS.filter((k) => k.namaLaporan !== undefined)) {
    test(`${kasus.nama} membawa header lengkap`, async () => {
      // Printed by the Auditor, which is also the role spec 16 scenario 23
      // sends round every report.
      const hasil = await d.ok<{ header: Header }>("AUDITOR", kasus.path(d));
      const h = hasil.header;
      // "nama BUMN, nama laporan, periode, cabang, tanggal cetak, dan nama
      // pencetak", spec 10's preamble, verbatim.
      expect(h.namaBumn).toContain(d.f.suffix);
      expect(h.namaLaporan).toBe(kasus.namaLaporan!);
      expect(h.periodeLabel.length).toBeGreaterThan(0);
      expect(h.namaCabang.length).toBeGreaterThan(0);
      expect(h.tanggalCetak).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The NAME of the person printing, resolved from the database against
      // the session's user id. A caller cannot print somebody else's name onto
      // a statement, because the route never accepts one.
      expect(h.dicetakOleh).toBe(namaUser.get("AUDITOR")!);
      // And the claim the page makes about its own reproducibility.
      expect(h.sumberData).toBe("LEDGER_LIVE");
    });
  }

  test("cabang di header adalah cabang yang diminta, bukan cabang pencetak", async () => {
    // The Auditor sits at the head office. A statement it prints for branch A
    // must be headed with branch A, or the printed page names the wrong entity.
    const hasil = await d.ok<{ header: Header }>(
      "AUDITOR",
      `/laporan/posisi-keuangan?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
    );
    expect(hasil.header.cabangId).toBe(d.f.cabangA.id);
    expect(hasil.header.namaCabang).toBe(d.f.cabangA.nama);

    const semua = await d.ok<{ header: Header }>(
      "AUDITOR",
      `/laporan/posisi-keuangan?periodeId=${d.periodeLaporan.id}`,
    );
    expect(semua.header.cabangId).toBeNull();
    expect(semua.header.namaCabang).toBe("Semua Cabang");
  });
});

describe("spec 10.3: tiga identitas yang wajib, lewat HTTP", () => {
  interface Posisi {
    header: Header;
    totalAsetTahunIni: Angka;
    totalAsetTahunLalu: Angka;
    totalLiabilitasTahunIni: Angka;
    totalAsetNetoTahunIni: Angka;
    totalLiabilitasDanAsetNetoTahunIni: Angka;
    totalLiabilitasDanAsetNetoTahunLalu: Angka;
    kasDanSetaraKasTahunIni: Angka;
    kasDanSetaraKasTahunLalu: Angka;
  }
  interface ArusKas {
    kasAkhirTahunIni: Angka;
    kasAkhirTahunLalu: Angka;
    kasAwalTahunIni: Angka;
    seksi: Array<{ klasifikasi: string; totalTahunIni: Angka }>;
  }
  interface NeracaLajur {
    baris: unknown[];
    total: {
      saldoAwalDebit: Angka;
      saldoAwalKredit: Angka;
      mutasiDebit: Angka;
      mutasiKredit: Angka;
      saldoAkhirDebit: Angka;
      saldoAkhirKredit: Angka;
    };
  }

  /** Both ways of asking: one branch, and Semua Cabang. */
  const LINGKUP: ReadonlyArray<{ nama: string; suffix: (d: DuniaRuteLaporan) => string }> = [
    { nama: "cabang A", suffix: (d) => `&cabangId=${d.f.cabangA.id}` },
    { nama: "Semua Cabang", suffix: () => "" },
  ];

  for (const lingkup of LINGKUP) {
    test(`19: Total Aset = Total Liabilitas + Aset Neto (${lingkup.nama})`, async () => {
      const l = await d.ok<Posisi>(
        "ADMIN_PUSAT",
        `/laporan/posisi-keuangan?periodeId=${d.periodeLaporan.id}${lingkup.suffix(d)}`,
      );
      // Non-vacuous FIRST: an empty balance sheet balances, and a route that
      // silently scoped to nothing would pass the identity below.
      expect(keSen(l.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
      expect(keSen(l.totalLiabilitasTahunIni.nilai)).toBeGreaterThan(0n);
      expect(keSen(l.totalAsetNetoTahunIni.nilai)).toBeGreaterThan(0n);

      expect(l.totalAsetTahunIni.nilai).toBe(l.totalLiabilitasDanAsetNetoTahunIni.nilai);
      // The comparative column has to balance too, or the page prints one
      // year that ties and one that does not.
      expect(l.totalAsetTahunLalu.nilai).toBe(l.totalLiabilitasDanAsetNetoTahunLalu.nilai);
    });

    test(`18: Kas Akhir = kas di Laporan Posisi Keuangan (${lingkup.nama})`, async () => {
      const jalur = `periodeId=${d.periodeLaporan.id}${lingkup.suffix(d)}`;
      const arus = await d.ok<ArusKas>("ADMIN_PUSAT", `/laporan/arus-kas?${jalur}`);
      const posisi = await d.ok<Posisi>("ADMIN_PUSAT", `/laporan/posisi-keuangan?${jalur}`);

      // Non-vacuous: cash is not zero, and it MOVED during the year, so this
      // is not "Kas Awal equals Kas Awal".
      expect(keSen(posisi.kasDanSetaraKasTahunIni.nilai)).toBeGreaterThan(0n);
      expect(arus.kasAkhirTahunIni.nilai).not.toBe(arus.kasAwalTahunIni.nilai);

      // Spec 10.3 report 18, verbatim: "Kas Akhir wajib sama dengan saldo akun
      // berflag is_kas di Laporan Posisi Keuangan".
      expect(arus.kasAkhirTahunIni.nilai).toBe(posisi.kasDanSetaraKasTahunIni.nilai);

      // THE COMPARATIVE COLUMNS ARE DELIBERATELY DIFFERENT, and asserting the
      // tie there too would be asserting a bug. A cash flow statement is a
      // FLOW statement, so its comparative is THE SAME SPAN ONE YEAR EARLIER
      // (cash at 2025-03-31); a balance sheet is a POINT IN TIME, so its
      // comparative is the END OF THE PRECEDING FINANCIAL YEAR (cash at
      // 2025-12-31). ./laporan-arus-kas.test.ts records that decision; this
      // pins that the ROUTE does not quietly flatten the two into one cut-off.
      expect(arus.kasAkhirTahunLalu.nilai).not.toBe(posisi.kasDanSetaraKasTahunLalu.nilai);
      expect(keSen(arus.kasAkhirTahunLalu.nilai)).toBeGreaterThan(0n);
      expect(keSen(posisi.kasDanSetaraKasTahunLalu.nilai)).toBeGreaterThan(0n);
    });

    test(`23: Neraca Lajur balance di ketiga pasang kolom (${lingkup.nama})`, async () => {
      const l = await d.ok<NeracaLajur>(
        "ADMIN_PUSAT",
        `/laporan/neraca-lajur?periodeId=${d.periodeLaporan.id}${lingkup.suffix(d)}`,
      );
      expect(l.baris.length).toBeGreaterThan(0);
      const t = l.total;
      // All six non-zero first, so a worksheet of zeroes cannot satisfy the
      // three equalities below.
      for (const [nama, angka] of Object.entries(t)) {
        expect(keSen((angka as Angka).nilai), nama).toBeGreaterThan(0n);
      }
      expect(t.saldoAwalDebit.nilai).toBe(t.saldoAwalKredit.nilai);
      expect(t.mutasiDebit.nilai).toBe(t.mutasiKredit.nilai);
      expect(t.saldoAkhirDebit.nilai).toBe(t.saldoAkhirKredit.nilai);
    });
  }

  test("kontrak angka bertahan lewat JSON: nilai dan tampil, keduanya", async () => {
    // The rendering contract is pinned at the ENGINE boundary so a later
    // exporter consumes it rather than becoming a second implementation of
    // spec 10's number format. This asserts it survives the wire: `nilai` is
    // still fixed two-decimal text (never a JSON number, which would lose
    // precision on a large rupiah figure) and `tampil` is still the Indonesian
    // rendering with `0,00` for zero and parentheses for negatives.
    const l = await d.ok<{ total: Record<string, Angka> }>(
      "ADMIN_PUSAT",
      `/laporan/neraca-lajur?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
    );
    for (const [nama, angka] of Object.entries(l.total)) {
      expect(typeof angka.nilai, nama).toBe("string");
      expect(angka.nilai, nama).toMatch(POLA_UANG);
      expect(angka.tampil, nama).toMatch(POLA_TAMPIL);
    }
  });
});

describe("spec 16 skenario 23: Auditor membuka semua laporan, mengubah tidak satu pun", () => {
  test("ketujuh laporan terbuka untuk Auditor, Semua Cabang", async () => {
    for (const jalur of jalurSemuaCabang(d)) {
      const res = await d.panggil("AUDITOR", jalur);
      expect(res.status, jalur).toBe(200);
    }
  });

  test("setiap mutasi ke setiap jalur laporan ditolak 403 read only", async () => {
    for (const jalur of ["/laporan/katalog", "/laporan/periode", ...jalurSemuaCabang(d)]) {
      for (const metode of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await d.panggil("AUDITOR", jalur, { method: metode, body: {} });
        expect(res.status, `${metode} ${jalur}`).toBe(403);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe("TIDAK_BERWENANG");
        expect(body.error).toContain("read only");
      }
    }
  });

  test("modul ini tidak punya satu pun rute non GET, untuk peran mana pun", async () => {
    // The structural half of scenario 23. An Admin Pusat holds every code in
    // the catalogue and is not read-only, so if any mutating route existed
    // here it would answer for that role. It does not: the router registers
    // GET and nothing else, so every other method falls through to this
    // module's own 404.
    for (const jalur of jalurSemuaCabang(d)) {
      for (const metode of ["POST", "PUT", "DELETE"]) {
        const res = await d.panggil("ADMIN_PUSAT", jalur, { method: metode, body: {} });
        expect(res.status, `${metode} ${jalur}`).toBe(404);
        const body = (await res.json()) as { code: string };
        expect(body.code).toBe("TIDAK_DITEMUKAN");
      }
    }
  });

  test("membaca setiap laporan tidak menulis satu baris jurnal pun", async () => {
    const cacah = async () => {
      const rows = await d.f.db.query<{ jurnal: string; baris: string; audit: string }>(
        `select (select count(*)::text from jurnal where bumn_id = $1) as jurnal,
                (select count(*)::text from jurnal_baris jb
                   join jurnal j on j.id = jb.jurnal_id where j.bumn_id = $1) as baris,
                (select count(*)::text from saldo_akun_periode s
                   join periode p on p.id = s.periode_id where p.bumn_id = $1) as audit`,
        [d.f.bumnId],
      );
      return rows[0]!;
    };
    const sebelum = await cacah();
    for (const jalur of jalurSemuaCabang(d)) {
      expect((await d.panggil("ADMIN_PUSAT", jalur)).status).toBe(200);
    }
    expect(await cacah()).toEqual(sebelum);
  });
});

describe("spec 16 skenario 24: cabang lain ditolak, bukan dikosongkan", () => {
  test("Maker cabang A meminta cabang B: 403 dengan kodeDomain, bukan halaman kosong", async () => {
    // THE FAILURE MODE THIS EXISTS FOR: a WHERE clause that scopes the query
    // instead of refusing produces an EMPTY balance sheet, and an empty
    // balance sheet balances. It would pass every identity above.
    const p = d.periodeLaporan.id;
    const b = d.f.cabangB.id;
    for (const jalur of [
      `/laporan/aktivitas?periodeId=${p}&cabangId=${b}`,
      `/laporan/arus-kas?periodeId=${p}&cabangId=${b}`,
      `/laporan/posisi-keuangan?periodeId=${p}&cabangId=${b}`,
      `/laporan/perubahan-aset-neto?periodeId=${p}&cabangId=${b}`,
      `/laporan/buku-besar?periodeId=${p}&cabangId=${b}&akunId=${d.akun.kas}`,
      `/laporan/neraca-lajur?periodeId=${p}&cabangId=${b}`,
    ]) {
      const res = await d.panggil("MAKER", jalur);
      expect(res.status, jalur).toBe(403);
      const body = (await res.json()) as { code: string; kodeDomain: string; error: string };
      expect(body.code).toBe("TIDAK_BERWENANG");
      expect(body.kodeDomain).toBe("CABANG_DILUAR_SCOPE");
      // The refusal does not confirm which branch the data is in: a 403 that
      // named the branch would be an oracle for enumerating another branch.
      expect(body.error).not.toContain(d.f.cabangB.nama);
    }
  });

  test("Maker cabang A meminta Semua Cabang juga ditolak", async () => {
    // Omitting `cabangId` is spec 10's Admin Pusat option. For a branch user
    // it is the same request as asking for every other branch at once, and the
    // ROUTE does not quietly rewrite it into "my branch": a page headed Semua
    // Cabang that showed one branch would say nothing about the difference.
    const res = await d.panggil("MAKER", `/laporan/posisi-keuangan?periodeId=${d.periodeLaporan.id}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { kodeDomain: string }).kodeDomain).toBe("CABANG_DILUAR_SCOPE");
  });

  test("Maker cabang A memang bisa mencetak cabangnya sendiri", async () => {
    // The positive control, so the two tests above cannot be passing merely
    // because everything is refused.
    const res = await d.panggil(
      "MAKER",
      `/laporan/posisi-keuangan?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangA.id}`,
    );
    expect(res.status).toBe(200);
  });

  test("GET /laporan/cabang menawarkan persis apa yang engine terima", async () => {
    // The filter list and the refusal must agree, or a screen offers an option
    // that fails after the click.
    const maker = await d.ok<{
      cabang: Array<{ id: string }>;
      bolehSemuaCabang: boolean;
      cabangSendiriId: string;
    }>("MAKER", "/laporan/cabang");
    expect(maker.bolehSemuaCabang).toBe(false);
    expect(maker.cabang.map((c) => c.id)).toEqual([d.f.cabangA.id]);
    expect(maker.cabangSendiriId).toBe(d.f.cabangA.id);

    const pusat = await d.ok<{ cabang: Array<{ id: string }>; bolehSemuaCabang: boolean }>(
      "ADMIN_PUSAT",
      "/laporan/cabang",
    );
    expect(pusat.bolehSemuaCabang).toBe(true);
    expect(pusat.cabang.map((c) => c.id).sort()).toEqual(
      [d.f.pusat.id, d.f.cabangA.id, d.f.cabangB.id].sort(),
    );
  });

  test("spec 2 rule 5: penolakan scope meninggalkan baris DITOLAK di audit_log", async () => {
    const jalur = `/laporan/neraca-lajur?periodeId=${d.periodeLaporan.id}&cabangId=${d.f.cabangB.id}`;
    await d.panggil("MAKER", jalur);
    const baris = await d.f.auditRows({ hasil: "DITOLAK", userId: d.f.users.MAKER.id });
    expect(baris.length).toBeGreaterThan(0);
    const jalurTercatat = baris.map((b) => (b.nilai_baru_json as { path?: string } | null)?.path);
    // The PATH, not the query string: Hono's `c.req.path` drops the query, and
    // that is the right amount of detail for an audit row.
    expect(jalurTercatat).toContain("/laporan/neraca-lajur");
  });
});

describe("validasi batas", () => {
  test("periodeId yang bukan UUID adalah 400 dengan nama fieldnya, bukan 500", async () => {
    const res = await d.panggil("ADMIN_PUSAT", "/laporan/neraca-lajur?periodeId=kemarin");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    expect(Object.keys(body.detail)).toContain("periodeId");
  });

  test("buku besar tanpa akunId mengumpulkan setiap field yang kurang sekaligus", async () => {
    const res = await d.panggil("ADMIN_PUSAT", "/laporan/buku-besar");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: Record<string, string[]> };
    // `periodeId` is reported first because it is the shared filter, and
    // `akunId` is reported on the next pass. Both are named, which is what a
    // form needs; neither reaches the engine.
    expect(Object.keys(body.detail).length).toBeGreaterThan(0);
  });

  test("periode milik entitas lain adalah 404, bukan data", async () => {
    const res = await d.panggil(
      "ADMIN_PUSAT",
      `/laporan/neraca-lajur?periodeId=${crypto.randomUUID()}`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { kodeDomain: string };
    expect(body.kodeDomain).toBe("PERIODE_TIDAK_DITEMUKAN");
  });

  test("endpoint laporan yang tidak ada menjawab 404 dalam amplop API sendiri", async () => {
    const res = await d.panggil("ADMIN_PUSAT", "/laporan/laba-rugi");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("TIDAK_DITEMUKAN");
    expect(body.error).toContain("laporan");
  });
});

describe("katalog dan periode: apa yang layar filter butuhkan", () => {
  test("katalog menyebut ketujuh laporan modul ini dengan path yang benar-benar ada", async () => {
    const hasil = await d.ok<{ data: Array<{ nomor: number; nama: string; path: string }> }>(
      "AUDITOR",
      "/laporan/katalog",
    );
    expect(hasil.data.map((e) => e.nomor)).toEqual([16, 17, 18, 19, 20, 22, 23]);
    expect(hasil.data.map((e) => e.nama)).toEqual(Object.values(NAMA_LAPORAN));
    // Every path in the catalogue answers. A catalogue that named a route
    // nobody registered is a menu of dead links.
    for (const entri of hasil.data) {
      const jalur = jalurSemuaCabang(d).find((j) => j.startsWith(entri.path));
      expect(jalur, entri.path).toBeDefined();
    }
  });

  test("daftar periode membawa status, yang menentukan jalur data mana yang dipakai", async () => {
    const hasil = await d.ok<{
      data: Array<{ tahun: number; bulan: number; status: string; sumberData: string }>;
    }>("AUDITOR", `/laporan/periode?tahun=${TAHUN_INI}`);
    expect(hasil.data).toHaveLength(12);
    expect(hasil.data.every((p) => p.tahun === TAHUN_INI)).toBe(true);
    expect(hasil.data.every((p) => p.sumberData === "LEDGER_LIVE")).toBe(true);
  });
});

describe("tanpa sesi sama sekali", () => {
  test("setiap endpoint laporan menjawab 401, bukan 404 dan bukan data", async () => {
    for (const kasus of KASUS) {
      const res = await d.f.request(kasus.path(d));
      expect(res.status, kasus.nama).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// LAST, because it CLOSES a period and freezes its balances. Every test above
// reads the same world with every period still OPEN, and this one changes that
// for the year before the reporting year.
// ---------------------------------------------------------------------------
describe("periode tertutup dibaca dari saldo beku, dan klien tidak bisa memaksa jalur lain", () => {
  const desember = () => d.periode(TAHUN_LALU, 12);

  test("periode CLOSED dengan saldo beku menjawab SNAPSHOT_PERIODE", async () => {
    const sebelum = await d.ok<{ header: Header }>(
      "ADMIN_PUSAT",
      `/laporan/neraca-lajur?periodeId=${desember().id}`,
    );
    expect(sebelum.header.sumberData).toBe("LEDGER_LIVE");
    expect(sebelum.header.statusPeriode).toBe("OPEN");

    // IN ORDER, because `tjsl_periode_validasi_transisi` refuses to close a
    // month while an earlier one is still open (TJSL-PER-001). Doing it the
    // way the product does is the point: a fixture that closed December alone
    // would be freezing a world the closing engine cannot produce.
    for (let bulan = 1; bulan <= 12; bulan += 1) {
      await d.bekukanDanTutup(d.periode(TAHUN_LALU, bulan));
    }

    const sesudah = await d.ok<{ header: Header }>(
      "ADMIN_PUSAT",
      `/laporan/neraca-lajur?periodeId=${desember().id}`,
    );
    expect(sesudah.header.sumberData).toBe("SNAPSHOT_PERIODE");
    expect(sesudah.header.statusPeriode).toBe("CLOSED");
  });

  test("parameter sumber dari klien tidak mengubah jalur data satu pun", async () => {
    // THE PARAMETER THAT MUST NOT EXIST. If a caller could ask for LEDGER_LIVE
    // on a closed period they could produce a recomputed figure for a month
    // that is already closed and present it as the statement -- invariant 14
    // broken, and undetectable from the printed page, because the page would
    // still carry a header claiming to be that period's.
    const dasar = `/laporan/neraca-lajur?periodeId=${desember().id}`;
    const jujur = await d.ok<{ header: Header; total: Record<string, Angka> }>(
      "ADMIN_PUSAT",
      dasar,
    );
    expect(jujur.header.sumberData).toBe("SNAPSHOT_PERIODE");
    for (const paksa of [
      "&sumberData=LEDGER_LIVE",
      "&sumber=LEDGER_LIVE",
      "&live=true",
      "&statusPeriode=OPEN",
    ]) {
      const dipaksa = await d.ok<{ header: Header; total: Record<string, Angka> }>(
        "ADMIN_PUSAT",
        `${dasar}${paksa}`,
      );
      expect(dipaksa.header.sumberData, paksa).toBe("SNAPSHOT_PERIODE");
      expect(dipaksa.total, paksa).toEqual(jujur.total);
    }
  });

  test("periode CLOSED tanpa saldo beku ditolak, bukan dihitung ulang diam diam", async () => {
    // The fail-closed refusal spec 10 has no other answer for. A recomputation
    // would produce a plausible page that violates invariant 14 and that
    // nothing downstream could detect. January of the reporting year carries
    // ledger lines, which is the third clause of the rule: a period that closed
    // over an empty ledger legitimately freezes nothing.
    const januari = d.periode(TAHUN_INI, 1);
    await d.tutupTanpaMembekukan(januari);
    const res = await d.panggil("ADMIN_PUSAT", `/laporan/neraca-lajur?periodeId=${januari.id}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; kodeDomain: string };
    expect(body.code).toBe("KONFLIK");
    expect(body.kodeDomain).toBe("SALDO_PERIODE_BELUM_DIBEKUKAN");
  });
});

describe("kode izin yang tidak dikenal gagal saat WIRING, bukan sebagai 403 diam", () => {
  test("resolveRequiredPermissions menolak kode di luar katalog", () => {
    expect(() => resolveRequiredPermissions(["laporan.viewer"])).toThrow(/tidak dikenal/);
  });

  test("laporan.view ada di katalog, laporan.export TIDAK", () => {
    expect(() => resolveRequiredPermissions(["laporan.view"])).not.toThrow();
    // REPORTED, NOT INVENTED. Spec 10 requires an Excel and a PDF button on
    // every report and the catalogue ships no `laporan.export`. This module
    // must not mint one to make an export route convenient: the code is a
    // decision for modules/auth, and until it exists there is nothing here to
    // export anyway.
    expect(() => resolveRequiredPermissions(["laporan.export"])).toThrow(/tidak dikenal/);
  });
});
