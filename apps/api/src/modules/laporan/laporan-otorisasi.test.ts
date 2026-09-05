// OTORISASI (spec 2, spec 16 scenarios 23 and 24).
//
//   "Login sebagai Auditor, konfirmasi semua laporan terbuka dan tidak ada
//    satu pun tombol yang mengubah data."             -- scenario 23
//   "Login sebagai Maker dari Cabang A, konfirmasi tidak bisa melihat atau
//    mengubah data Cabang B, termasuk lewat manipulasi ID di URL atau request
//    API langsung."                                   -- scenario 24
//
// TWO RULES, AND THE SECOND ONE IS WHERE REPORTS GO WRONG.
//
// A report is a QUERY, and the tempting implementation of branch scope in a
// query is a WHERE clause: ask for another branch and get an empty page. Spec
// 2 rule 1 is explicit that the system must REFUSE rather than merely hide
// ("Sistem harus menolak, bukan hanya menyembunyikan tombol"), and scenario 24
// names the API-level attempt specifically. An empty Laporan Posisi Keuangan
// is also a perfectly balanced one (0 = 0 + 0), so silently scoping a report
// to nothing produces a page that passes every other test in this folder.
//
// THE PERMISSION LIST IS READ OUT OF THE DATABASE, never typed into a fixture.
// `permissionsForRole` reads the shipped grant matrix, so if someone narrows
// `laporan.view` these tests say so instead of agreeing with themselves. That
// mechanism is how `jurnal.update` / `jurnal.delete` being grantable to nobody
// was found, and how `admin.closing.view` was found missing from the catalogue
// entirely.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buatDunia, keSen, tolakDengan, type DuniaLaporan } from "./test-support";
import { KODE_LAPORAN, PERMISSION_LAPORAN, type LaporanContext } from "./contract";
import { PERMISSIONS, PERMISSIONS_BY_ROLE, ROLE_CODES } from "../auth";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterAll(async () => {
  await d?.tutup();
});

/** Every read path of this pass, as thunks, so all seven are covered at once. */
function semuaJalur(ctx: LaporanContext, cabangId: string | null) {
  const f = { periodeId: d.periodeLaporan().id, cabangId };
  return {
    baganAkun: () => d.engine.baganAkun({}, ctx),
    aktivitas: () => d.engine.laporanAktivitas(f, ctx),
    arusKas: () => d.engine.laporanArusKas(f, ctx),
    posisiKeuangan: () => d.engine.laporanPosisiKeuangan(f, ctx),
    perubahanAsetNeto: () => d.engine.laporanPerubahanAsetNeto(f, ctx),
    bukuBesar: () => d.engine.bukuBesar({ ...f, akunId: d.akun.kas.id }, ctx),
    neracaLajur: () => d.engine.neracaLajur(f, ctx),
  };
}

describe("laporan.view: kode terkirim, dan siapa yang memegangnya", () => {
  test("kode ini ADA di katalog terkirim, jadi modul ini tidak mengarang izin", async () => {
    // The fail-closed convention of this repo: a module names the code it
    // needs, and a code absent from the catalogue is a FINDING and a refusal,
    // never something silently treated as granted.
    expect(PERMISSIONS).toContain(PERMISSION_LAPORAN.LIHAT);
  });

  test("setiap role terkirim memegang laporan.view, Auditor termasuk (skenario 23)", async () => {
    for (const role of ROLE_CODES) {
      expect(PERMISSIONS_BY_ROLE[role], `role ${role}`).toContain(PERMISSION_LAPORAN.LIHAT);
    }
    // And the fixture's contexts got it from the DATABASE, not from the line
    // above: `permissionsForRole` reads the grant matrix out of `role_permission`.
    for (const nama of ["maker", "checker", "approver", "auditor", "adminCabang", "adminPusat"] as const) {
      expect(d.ctx[nama].permissions, nama).toContain(PERMISSION_LAPORAN.LIHAT);
    }
  });

  test("auditor membuka ketujuh laporan (skenario 23)", async () => {
    for (const [nama, panggil] of Object.entries(semuaJalur(d.ctx.auditor, d.cabangId))) {
      const hasil = await panggil();
      expect(hasil, nama).toBeDefined();
      expect((hasil as { header: { dicetakOleh: string } }).header.dicetakOleh).toBe(
        d.namaUser.auditor,
      );
    }
  });

  test("tanpa laporan.view setiap jalur ditolak dengan TIDAK_BERWENANG", async () => {
    const buta = d.ctxTanpaIzin(d.ctx.adminPusat, PERMISSION_LAPORAN.LIHAT);
    expect(buta.permissions).not.toContain(PERMISSION_LAPORAN.LIHAT);
    for (const [nama, panggil] of Object.entries(semuaJalur(buta, d.cabangId))) {
      await tolakDengan(panggil, KODE_LAPORAN.TIDAK_BERWENANG);
      expect(nama.length).toBeGreaterThan(0);
    }
  });

  test("izin yang belum terdaftar di katalog membuat jalur gagal tertutup", async () => {
    // The mechanic itself, exercised against a code that deliberately is not
    // in the catalogue. It used to name `laporan.export` as that code; the
    // export pass added it to modules/auth, so this now names a spelling that
    // is not and never will be a permission. The invariant under test is
    // unchanged: a code this module names must exist in the shipped catalogue,
    // and a code that does not exist must fail closed rather than be assumed.
    expect(PERMISSIONS).not.toContain("laporan.ekspor.semua" as never);
    expect(Object.values(PERMISSION_LAPORAN).every((p) => PERMISSIONS.includes(p))).toBe(true);
    // Both of this module's codes ship, including the export one.
    expect(PERMISSIONS).toContain("laporan.export" as never);
    expect(KODE_LAPORAN.IZIN_BELUM_TERDAFTAR).toBe("IZIN_BELUM_TERDAFTAR");
  });
});

describe("scope cabang (skenario 24): ditolak, bukan dikosongkan", () => {
  // CHANGED, and what it used to say.
  //
  // This loop ran over ALL SEVEN paths of `semuaJalur`, `baganAkun` included,
  // and asserted CABANG_DILUAR_SCOPE from every one. `baganAkun` ignores the
  // `cabangId` argument entirely; it was refusing because
  // `laporanService.baganAkun` called `pastikanCabang(ctx, null)`
  // unconditionally, so a branch-bound Maker got 403 on report 16 no matter
  // what it asked for.
  //
  // That was reported as a finding and has now been discharged in the service:
  // `akun` is keyed by `bumn_id` and carries no `cabang_id`, so the chart of
  // accounts is entity reference data and there is no other branch's figure in
  // it to withhold. Report 16 is now open to any holder of `laporan.view`, and
  // the test directly below pins that.
  //
  // The six paths that DO read branch figures are unchanged, and this is still
  // the test that proves they refuse rather than return an empty, balancing
  // report.
  test("maker cabang A meminta cabang B: CABANG_DILUAR_SCOPE, bukan halaman kosong", async () => {
    // THE FAILURE MODE THIS EXISTS FOR: a WHERE clause that scopes the query
    // instead of refusing produces an EMPTY balance sheet, and an empty
    // balance sheet balances. It passes every test in
    // ./laporan-posisi-keuangan.test.ts.
    const { baganAkun: _entitas, ...jalurCabang } = semuaJalur(d.ctx.maker, d.cabangLainId);
    for (const [nama, panggil] of Object.entries(jalurCabang)) {
      await tolakDengan(panggil, KODE_LAPORAN.CABANG_DILUAR_SCOPE);
      expect(nama.length).toBeGreaterThan(0);
    }
    // NON-VACUOUS: six branch-scoped paths were actually exercised, not zero.
    expect(Object.keys(jalurCabang)).toHaveLength(6);
  });

  test("bagan akun terbuka untuk setiap peran yang memegang laporan.view, termasuk yang terikat cabang", async () => {
    // Report 16 is reference data, not branch data. A Maker who can open the
    // reports for their own branch must be able to read the account tree those
    // reports are written in terms of.
    for (const nama of ["maker", "checker", "approver", "adminCabang", "adminPusat", "auditor"] as const) {
      const l = await d.engine.baganAkun({}, d.ctx[nama]);
      // NON-VACUOUS: a real chart came back, not an empty, permitted shell.
      expect(l.baris.length, nama).toBeGreaterThan(0);
      expect(l.header.cabangId, nama).toBeNull();
      expect(l.header.namaCabang, nama).toBe("Semua Cabang");
      expect(l.header.dicetakOleh, nama).toBe(d.namaUser[nama]);
    }
  });

  test("dan tetap ditolak tanpa laporan.view: izin, bukan scope, yang menjaganya", async () => {
    const buta = d.ctxTanpaIzin(d.ctx.maker, PERMISSION_LAPORAN.LIHAT);
    await tolakDengan(() => d.engine.baganAkun({}, buta), KODE_LAPORAN.TIDAK_BERWENANG);
  });

  test("maker cabang A meminta Semua Cabang juga ditolak", async () => {
    // `cabangId: null` is spec 10's Admin Pusat option. For a branch user it
    // is the same request as asking for every other branch at once.
    await tolakDengan(
      () =>
        d.engine.laporanPosisiKeuangan(
          { periodeId: d.periodeLaporan().id, cabangId: null },
          d.ctx.maker,
        ),
      KODE_LAPORAN.CABANG_DILUAR_SCOPE,
    );
  });

  test("maker cabang A membuka cabangnya sendiri dengan angka yang nyata", async () => {
    const l = await d.engine.laporanPosisiKeuangan(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.maker,
    );
    // NON-VACUOUS: proves the refusals above are about scope and not about the
    // report being empty for everyone.
    expect(keSen(l.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
    expect(l.header.namaCabang).toBe(d.namaCabang);
  });

  test("maker cabang B membuka cabangnya sendiri, dan angkanya berbeda", async () => {
    const l = await d.engine.laporanPosisiKeuangan(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangLainId },
      d.ctx.makerLain,
    );
    expect(keSen(l.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
    expect(l.header.namaCabang).toBe(d.namaCabangLain);
    const utama = await d.engine.laporanPosisiKeuangan(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.maker,
    );
    expect(l.totalAsetTahunIni.nilai).not.toBe(utama.totalAsetTahunIni.nilai);
  });

  test("admin pusat dan auditor melintasi cabang, sesuai spec 2 aturan 3", async () => {
    // "Semua akses data terikat scope cabang KECUALI role Admin Pusat dan
    // Auditor", verbatim. Nothing else belongs in that set.
    for (const nama of ["adminPusat", "auditor"] as const) {
      const l = await d.engine.laporanPosisiKeuangan(
        { periodeId: d.periodeLaporan().id, cabangId: null },
        d.ctx[nama],
      );
      expect(l.header.cabangId, nama).toBeNull();
      expect(keSen(l.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
    }
    for (const nama of ["maker", "checker", "approver", "adminCabang"] as const) {
      await tolakDengan(
        () =>
          d.engine.laporanPosisiKeuangan(
            { periodeId: d.periodeLaporan().id, cabangId: d.cabangLainId },
            d.ctx[nama],
          ),
        KODE_LAPORAN.CABANG_DILUAR_SCOPE,
      );
    }
  });

  test("cabang milik bumn lain ditolak, bukan mengembalikan nol", async () => {
    const lain = await buatDunia();
    try {
      await tolakDengan(
        () =>
          d.engine.laporanPosisiKeuangan(
            { periodeId: d.periodeLaporan().id, cabangId: lain.cabangId },
            d.ctx.adminPusat,
          ),
        KODE_LAPORAN.CABANG_DILUAR_SCOPE,
      );
      // And a period belonging to another bumn is not this bumn's period.
      await tolakDengan(
        () =>
          d.engine.laporanPosisiKeuangan(
            { periodeId: lain.periodeLaporan().id, cabangId: d.cabangId },
            d.ctx.adminPusat,
          ),
        KODE_LAPORAN.PERIODE_TIDAK_DITEMUKAN,
      );
    } finally {
      await lain.tutup();
    }
  });
});

describe("read only: laporan tidak pernah menulis (skenario 23)", () => {
  test("membuka ketujuh laporan tidak menambah satu pun baris ledger atau audit", async () => {
    const hitung = async () => {
      const j = await d.db.query<{ n: string }>(
        `select count(*)::text as n from jurnal where bumn_id = $1`,
        [d.bumnId],
      );
      const b = await d.db.query<{ n: string }>(
        `select count(*)::text as n from jurnal_baris b
           join jurnal j on j.id = b.jurnal_id where j.bumn_id = $1`,
        [d.bumnId],
      );
      const s = await d.db.query<{ n: string }>(
        `select count(*)::text as n from saldo_akun_periode s
           join periode p on p.id = s.periode_id where p.bumn_id = $1`,
        [d.bumnId],
      );
      const l = await d.db.query<{ n: string }>(
        `select count(*)::text as n from baris_laporan where bumn_id = $1`,
        [d.bumnId],
      );
      return `${j[0].n}/${b[0].n}/${s[0].n}/${l[0].n}`;
    };
    const sebelum = await hitung();
    for (const panggil of Object.values(semuaJalur(d.ctx.auditor, d.cabangId))) await panggil();
    expect(await hitung()).toBe(sebelum);
  });
});
