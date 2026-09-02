// SPEC 2, APPLIED TO THE RKA.
//
// Every context in this file comes from `permissionsForRole`, which READS the
// shipped grant matrix out of the database. Nothing here types a permission
// string into a fixture. That distinction is not stylistic: three real gaps in
// this repository (`pumk.cluster`, `nonpumk.lpj.verifikasi`,
// `admin.closing.view`) were found only because a module named the code it
// needed, checked it against the shipped catalogue, and failed closed when it
// was not there. A fixture that grants itself the code it wants proves that the
// fixture agrees with itself.
//
// Spec 2's own wording is the map:
//   Admin Pusat  "semua kewenangan, semua cabang, kelola master data"
//                                                  -> admin.rka today
//   Auditor      "read only penuh ... tidak bisa mengubah apa pun"
//   rule 3       every access is branch-scoped except Admin Pusat and Auditor
//   rule 4       the check that matters is the SERVER's, so these call the
//                engine directly rather than a route
//   rule 5       every refusal reaches the audit log
//
// SPEC 16 SCENARIO 24 IS TESTED AS AN ID, NOT AS A FILTER. "termasuk lewat
// manipulasi ID di URL atau request API langsung" means the interesting case is
// a caller who already HOLDS a valid id for another branch's budget and asks
// for it by primary key. A list endpoint that filters correctly says nothing
// about that path, so every scope test below hands the engine a real id from
// the other branch.
//
// TWO FINDINGS WERE FILED HERE AS FAIL-CLOSED REFUSALS, AND BOTH ARE NOW
// CLOSED. `admin.rka.approve` and `admin.rka.view` were absent from the shipped
// catalogue, so `setujuiRka` and the read paths refused with
// IZIN_BELUM_TERDAFTAR rather than falling back to `admin.rka`, and NOTHING in
// ./rka-versi.test.ts could go green either, because every version test has to
// approve something. That blast radius was correct and it was the point:
// inventing the codes in a fixture to unblock the file is exactly the move the
// three earlier findings survived.
//
// The catalogue now carries both, so the tests below assert the POSITIVE and
// keep a record of what they used to claim. See PERMISSION_RKA in ./contract.ts
// for why neither is a reuse of `admin.rka`, and ./rka-fixture.test.ts for the
// catalogue evidence and for the guard that keeps IZIN_BELUM_TERDAFTAR
// exercised on codes the catalogue genuinely lacks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PERMISSIONS_BY_ROLE, canonicalPermission } from "../auth";
import { KODE_RKA, PERMISSION_RKA } from "./contract";
import {
  TAHUN_RKA,
  buatDunia,
  kodeAda,
  rp,
  tolakDengan,
  type DuniaRka,
} from "./test-support";

let d: DuniaRka;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

function barisNonPumk(bidangId: string, jumlah: string) {
  return [{ bidangId, uraian: "Anggaran bidang", bulan: 2, jumlahAnggaran: jumlah }];
}

describe("spec 2 rule 4: input RKA butuh admin.rka, diperiksa di server", () => {
  test("Maker, Checker, Approver dan Auditor tidak bisa membuat RKA", async () => {
    kodeAda(KODE_RKA.TIDAK_BERWENANG);
    for (const nama of ["maker", "checker", "approver", "auditor"] as const) {
      // Read the grant, do not assume it.
      expect(`${nama}:${d.ctx[nama].permissions.includes(PERMISSION_RKA.KELOLA)}`).toBe(
        `${nama}:false`,
      );
      await tolakDengan(
        () =>
          d.engine.buatRka(
            {
              cabangId: d.cabangId,
              tahun: TAHUN_RKA,
              jenis: "NON_PUMK",
              baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
            },
            d.ctx[nama],
          ),
        KODE_RKA.TIDAK_BERWENANG,
      );
    }
    // Spec 2 rule 1's "Sistem harus menolak, bukan hanya menyembunyikan
    // tombol" applies to side effects too.
    expect(await d.daftarRkaDb({ tahun: TAHUN_RKA })).toHaveLength(0);
  });

  test("Admin Cabang tidak memegang admin.rka hari ini, jadi anggaran cabangnya harus diketik pusat", async () => {
    // NOT AN ASSERTION THAT THIS IS RIGHT. `rka.cabang_id` is nullable
    // precisely so a branch can have its own budget, and spec 2 gives Admin
    // Cabang "semua di atas dalam scope satu cabang". The shipped matrix does
    // not grant it, so the engine must refuse; whether the grant should be
    // added is a client question, filed rather than decided here.
    expect(PERMISSIONS_BY_ROLE.ADMIN_CABANG as readonly string[]).not.toContain(
      PERMISSION_RKA.KELOLA,
    );
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangLainId,
            tahun: TAHUN_RKA,
            jenis: "NON_PUMK",
            baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
          },
          d.ctx.adminCabang,
        ),
      KODE_RKA.TIDAK_BERWENANG,
    );
  });

  test("Admin Pusat bisa, jadi penolakan di atas adalah tentang izin dan bukan tentang mesin yang buntu", async () => {
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    expect(rka.status).toBe("DRAFT");
    expect(rka.createdBy).toBe(d.userId.adminPusat);
  });
});

describe("spec 2 rule 5: penolakan otorisasi tercatat di audit log", () => {
  test("percobaan tanpa izin menulis satu baris audit DITOLAK", async () => {
    d.audit.reset();
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "NON_PUMK",
            baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
          },
          d.ctx.maker,
        ),
      KODE_RKA.TIDAK_BERWENANG,
    );

    const ditolak = d.audit.panggilan.filter((p) => p.hasil === "DITOLAK");
    expect(ditolak.length).toBeGreaterThan(0);
    expect(ditolak[0].entitas).toBe("rka");
    // The row has to be readable by someone reconstructing the attempt, so it
    // carries a reason and not just a code.
    expect(ditolak[0].keterangan ?? "").not.toBe("");

    // And it reached the DATABASE, not only the recording wrapper: the wrapper
    // exists to make the call inspectable, not to satisfy the requirement.
    const baris = await d.db.query<{ n: string }>(
      `select count(*)::text as n from audit_log
        where entitas = 'rka' and hasil = 'DITOLAK' and user_id = $1`,
      [d.userId.maker],
    );
    expect(Number.parseInt(baris[0].n, 10)).toBeGreaterThan(0);
  });

  test("mesin tetap bisa dibangun tanpa audit, dan penolakannya tetap penolakan", async () => {
    // The port is optional for the reason modules/jurnal gives: an engine must
    // be constructible with a database and nothing else, and a refusal must
    // never depend on a sink being wired.
    const tanpaAudit = d.buatEngine({ audit: undefined });
    await tolakDengan(
      () =>
        tanpaAudit.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA,
            jenis: "NON_PUMK",
            baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
          },
          d.ctx.maker,
        ),
      KODE_RKA.TIDAK_BERWENANG,
    );
  });
});

describe("persetujuan RKA punya kode izin sendiri, terpisah dari input", () => {
  test("setujuiRka menuntut admin.rka.approve, dan Admin Pusat memegangnya", async () => {
    // RE-PINNED. This test used to assert
    //   canonicalPermission(PERMISSION_RKA.SETUJUI) === null
    //   setujuiRka(..., adminPusat) refuses with IZIN_BELUM_TERDAFTAR
    //   the message and detail name the missing code
    // as a finding: Admin Pusat is built as a spread of PERMISSIONS, so it
    // held everything the catalogue carried and still could not approve,
    // because the code did not exist. The catalogue now carries it.
    expect(canonicalPermission(PERMISSION_RKA.SETUJUI)).toBe(PERMISSION_RKA.SETUJUI);
    expect(d.ctx.adminPusat.permissions).toContain(PERMISSION_RKA.SETUJUI);

    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    // A DIFFERENT Admin Pusat approves, because the shipped segregation
    // default is on. That is the subject of the last describe in this file;
    // here it only has to not be the thing under test.
    const disetujui = await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain);
    expect(disetujui.status).toBe("DISETUJUI");
    expect((await d.bacaRkaDb(rka.id)).approved_by).toBe(d.userId.adminPusatLain);
  });

  test("admin.rka TIDAK cukup untuk menyetujui, karena itu menggabungkan penyusun dan pemutus", async () => {
    // UNCHANGED IN INTENT, AND IT IS THE HALF THAT SURVIVED THE DISCHARGE.
    // The finding was never "a code is missing", it was "input and approval
    // must not be one authority". So this still refuses, but now for the right
    // reason: the holder lacks a code that EXISTS (TIDAK_BERWENANG) rather
    // than naming one that does not (IZIN_BELUM_TERDAFTAR). An implementation
    // that gated approval on `admin.rka` would still fail here.
    //
    // The context comes from `permissionsForRole` with exactly one code
    // removed, the technique this file uses elsewhere, so it is not a
    // hand-written grant.
    const hanyaKelola = {
      ...d.ctx.adminPusatLain,
      permissions: d.ctx.adminPusatLain.permissions.filter(
        (p) => p !== PERMISSION_RKA.SETUJUI,
      ),
    };
    expect(hanyaKelola.permissions).toContain(PERMISSION_RKA.KELOLA);
    expect(hanyaKelola.permissions).not.toContain(PERMISSION_RKA.SETUJUI);

    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    const err = await tolakDengan(
      () => d.engine.setujuiRka({ rkaId: rka.id }, hanyaKelola),
      KODE_RKA.TIDAK_BERWENANG,
    );
    expect(err.detail.permission).toBe(PERMISSION_RKA.SETUJUI);

    // Nothing approved, so no baseline appeared as a side effect.
    expect((await d.bacaRkaDb(rka.id)).status).toBe("DRAFT");
    expect((await d.bacaRkaDb(rka.id)).approved_by).toBeNull();
  });
});

describe("membaca RKA punya kode baca sendiri, dan Auditor memegangnya", () => {
  test("daftarRka, bacaRka dan baseline terbuka untuk Auditor, tanpa kode tulis", async () => {
    // RE-PINNED. This test used to assert
    //   canonicalPermission(PERMISSION_RKA.LIHAT) === null
    //   daftarRka / bacaRka / baseline all refuse with IZIN_BELUM_TERDAFTAR
    // as a finding: spec 16 scenario 23 requires the Auditor to open every
    // report and every audit screen, "which budget version was approved, by
    // whom and when" is exactly that evidence, and the role could not reach it
    // without being granted a WRITE code. The catalogue now carries
    // `admin.rka.view` and the Auditor holds it.
    expect(canonicalPermission(PERMISSION_RKA.LIHAT)).toBe(PERMISSION_RKA.LIHAT);
    expect(d.ctx.auditor.permissions).toContain(PERMISSION_RKA.LIHAT);

    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain);

    // All three reads open, and the evidence the finding was about is actually
    // present in what comes back: which version is the baseline, and who
    // approved it.
    const daftar = await d.engine.daftarRka({ tahun: TAHUN_RKA }, d.ctx.auditor);
    expect(daftar.map((r) => r.id)).toContain(rka.id);
    const dibaca = await d.engine.bacaRka(rka.id, d.ctx.auditor);
    expect(dibaca.status).toBe("DISETUJUI");
    expect(dibaca.approvedBy).toBe(d.userId.adminPusatLain);
    const dasar = await d.engine.baseline(
      { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId },
      d.ctx.auditor,
    );
    expect(dasar?.id).toBe(rka.id);

    // AND STILL READ ONLY, which is the half of spec 2 that a read grant could
    // have quietly broken. The Auditor holds neither write code, so both write
    // paths refuse on the permission rather than on anything incidental.
    expect(d.ctx.auditor.permissions).not.toContain(PERMISSION_RKA.KELOLA);
    expect(d.ctx.auditor.permissions).not.toContain(PERMISSION_RKA.SETUJUI);
    await tolakDengan(
      () =>
        d.engine.buatRka(
          {
            cabangId: d.cabangId,
            tahun: TAHUN_RKA + 1,
            jenis: "NON_PUMK",
            baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
          },
          d.ctx.auditor,
        ),
      KODE_RKA.TIDAK_BERWENANG,
    );
  });

  test("laporan 24 TIDAK ikut terkunci, karena laporan.view memang ada dan Auditor memegangnya", async () => {
    // The boundary of the finding. Report 24 is one of the 31 reports of spec
    // 10, so it has a code, the Auditor holds it, and the read gap is exactly
    // one screen wide: the budget versions behind the report.
    expect(d.ctx.auditor.permissions).toContain(PERMISSION_RKA.LAPORAN);
    d.setelJam("2026-04-15");
    await d.buatPenyaluranNonPumk({ tanggal: "2026-02-20", jumlah: rp(5_000_000) });
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(6_000_000)),
      },
      d.ctx.adminPusat,
    );

    const laporan = await d.engine.laporanRkaVsRealisasi(
      {
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        cabangId: d.cabangId,
        rkaId: rka.id,
        mode: "BULANAN",
        bulan: 2,
      },
      d.ctx.auditor,
    );
    expect(laporan.baris.length).toBeGreaterThan(0);
  });

  test("pengguna tanpa laporan.view ditolak dari laporan 24", async () => {
    // There is no role in the shipped matrix without `laporan.view`, so the
    // check is exercised with a context whose permission list has it removed.
    // The list still comes from `permissionsForRole`; only the one code under
    // test is taken away, so this is not a hand-written grant.
    const tanpaLaporan = {
      ...d.ctx.adminPusat,
      permissions: d.ctx.adminPusat.permissions.filter((p) => p !== PERMISSION_RKA.LAPORAN),
    };
    await tolakDengan(
      () =>
        d.engine.laporanRkaVsRealisasi(
          { tahun: TAHUN_RKA, jenis: "NON_PUMK", cabangId: d.cabangId, mode: "BULANAN", bulan: 2 },
          tanpaLaporan,
        ),
      KODE_RKA.TIDAK_BERWENANG,
    );
  });
});

describe("spec 2 rule 3 dan spec 16 skenario 24: scope cabang, lewat manipulasi ID langsung", () => {
  test("RKA cabang lain tidak bisa dibaca dengan menyebut id-nya", async () => {
    kodeAda(KODE_RKA.CABANG_DILUAR_SCOPE);
    // FIXTURE BUG FIXED, ASSERTION UNCHANGED. This used to build the budget in
    // `d.cabangLainId`, which is the fixture's Admin Cabang's OWN branch
    // (`ctxUntuk` gives that role `cabangLain` as its home), and then demand a
    // scope refusal for reading it. While no branch-scoped role held any RKA
    // read code the call refused anyway, on the permission, so the wrong
    // branch id was invisible. Now that Admin Cabang holds `admin.rka.view`
    // the scope check is reachable, which is what it was granted for, and the
    // budget has to actually be in the OTHER branch for the test to mean what
    // its title says.
    //
    // `d.cabangId` is that other branch: it is the world's main branch, and
    // Admin Cabang's scope is `[cabangLain]` alone. The sibling test below
    // already used `d.cabangId` for the same reason.
    const rkaCabangLain = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(3_000_000)),
      },
      d.ctx.adminPusat,
    );
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_RKA.LIHAT);
    expect(d.ctx.adminCabang.cabangId).not.toBe(d.cabangId);

    // A branch-scoped caller holding the id. This is scenario 24's exact
    // shape: not "the list did not show it" but "asking for it by primary key
    // is refused". And it must refuse on SCOPE, not on permission, or the
    // check under test never ran.
    const err = await tolakDengan(
      () => d.engine.bacaRka(rkaCabangLain.id, d.ctx.adminCabang),
      KODE_RKA.CABANG_DILUAR_SCOPE,
    );
    expect(err.detail.cabangId).toBe(d.cabangId);

    // The same caller CAN read its own branch's budget, so the refusal above
    // is about the branch and not about the role being locked out entirely.
    const milikSendiri = await d.engine.buatRka(
      {
        cabangId: d.cabangLainId,
        tahun: TAHUN_RKA,
        jenis: "PUMK",
        baris: [
          {
            sektorId: d.sektor.a.id,
            uraian: "Target sektor A",
            bulan: 2,
            jumlahAnggaran: rp(1_000_000),
            jumlahUnit: 2,
          },
        ],
      },
      d.ctx.adminPusat,
    );
    expect((await d.engine.bacaRka(milikSendiri.id, d.ctx.adminCabang)).id).toBe(
      milikSendiri.id,
    );
  });

  test("laporan 24 untuk cabang di luar scope ditolak, bukan dikosongkan", async () => {
    // Returning an empty report would look like "that branch spent nothing",
    // which is a wrong answer presented as a right one.
    await tolakDengan(
      () =>
        d.engine.laporanRkaVsRealisasi(
          {
            tahun: TAHUN_RKA,
            jenis: "NON_PUMK",
            cabangId: d.cabangId,
            mode: "BULANAN",
            bulan: 2,
          },
          d.ctx.adminCabang,
        ),
      KODE_RKA.CABANG_DILUAR_SCOPE,
    );
  });

  test("menyimpan baris ke RKA cabang lain ditolak dengan alasan scope, bukan alasan izin", async () => {
    // The distinction matters: a caller who holds `admin.rka` but not the
    // branch must be told which of the two failed, and an implementation that
    // collapsed both into TIDAK_BERWENANG would hide a scope bug behind a
    // permission message.
    const rkaCabangLain = await d.engine.buatRka(
      {
        cabangId: d.cabangLainId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(3_000_000)),
      },
      d.ctx.adminPusat,
    );
    const pusatSatuCabang = {
      ...d.ctx.adminPusat,
      cabangDalamScope: [d.cabangId],
    };
    await tolakDengan(
      () =>
        d.engine.simpanBaris(
          { rkaId: rkaCabangLain.id, baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)) },
          pusatSatuCabang,
        ),
      KODE_RKA.CABANG_DILUAR_SCOPE,
    );
  });

  test("daftarRka hanya mengembalikan cabang dalam scope, dan Admin Pusat melihat keduanya", async () => {
    await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    await d.engine.buatRka(
      {
        cabangId: d.cabangLainId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(2_000_000)),
      },
      d.ctx.adminPusat,
    );

    const semua = await d.engine.daftarRka({ tahun: TAHUN_RKA }, d.ctx.adminPusat);
    expect(new Set(semua.map((r) => r.cabangId))).toEqual(
      new Set([d.cabangId, d.cabangLainId]),
    );

    const pusatSatuCabang = { ...d.ctx.adminPusat, cabangDalamScope: [d.cabangId] };
    const terbatas = await d.engine.daftarRka({ tahun: TAHUN_RKA }, pusatSatuCabang);
    expect(terbatas.map((r) => r.cabangId)).toEqual([d.cabangId]);
  });

  test("RKA milik BUMN lain tidak ditemukan, bukan ditolak karena scope", async () => {
    // A different tenant is not "a branch you may not see": it must not be
    // acknowledged to exist at all, or the id itself becomes a probe.
    const lain = await buatDunia();
    try {
      const rkaLain = await lain.engine.buatRka(
        {
          cabangId: lain.cabangId,
          tahun: TAHUN_RKA,
          jenis: "NON_PUMK",
          baris: [
            {
              bidangId: lain.bidang.a.id,
              uraian: "Anggaran BUMN lain",
              bulan: 2,
              jumlahAnggaran: rp(1_000_000),
            },
          ],
        },
        lain.ctx.adminPusat,
      );
      kodeAda(KODE_RKA.RKA_TIDAK_DITEMUKAN);
      await tolakDengan(
        () => d.engine.bacaRka(rkaLain.id, d.ctx.adminPusat),
        KODE_RKA.RKA_TIDAK_DITEMUKAN,
      );
    } finally {
      await lain.tutup();
    }
  });
});

describe("pemisahan tugas pada persetujuan RKA: mekanik dari konfigurasi, bukan angka kebijakan", () => {
  test("tanpa baris bumn, default global yang menjawab, dan defaultnya konservatif", async () => {
    // RE-PINNED. This test used to assert
    //   setujuiRka refuses with KONFIGURASI_TIDAK_ADA naming the key
    // as a finding: `rka.pemisahan_tugas_persetujuan` was not in the shipped
    // catalogue, so the module could not read the client's answer and had to
    // refuse rather than decide the control itself.
    //
    // The catalogue now carries it, as an ASUMSI with a global default of
    // `true` and a description that says it is waiting on the client
    // (./rka-fixture.test.ts pins that provenance). So the state this test
    // named is no longer reachable by omission: KONFIGURASI_AWAL still seeds
    // no bumn-scoped row, and bumn-then-global resolution finds the shipped
    // default. What is worth asserting instead is that the default is the
    // CONSERVATIVE one, because a shipped `false` would be the system quietly
    // permitting self-approval on a document nobody can check afterwards.
    expect(await d.bacaKonfigurasi("rka", "pemisahan_tugas_persetujuan")).toBeNull();

    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    // Out of the box, the drafter may not approve their own budget...
    await tolakDengan(
      () => d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusat),
      KODE_RKA.KONFLIK_MAKER_APPROVER,
    );
    // ...and somebody else may, so the default is a control and not a lockout.
    const disetujui = await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain);
    expect(disetujui.status).toBe("DISETUJUI");
  });

  test("kalau kuncinya benar benar tidak ada di kedua level, setujuiRka menolak NAMING THE KEY", async () => {
    kodeAda(KODE_RKA.KONFIGURASI_TIDAK_ADA);
    // THE GUARD THE DISCHARGE ABOVE WOULD OTHERWISE HAVE KILLED, and it is not
    // theoretical: spec 2 scopes its two segregation rules to "dua modul (PUMK
    // dan Non PUMK)", the RKA has an approval and no Checker stage, so neither
    // rule reaches it verbatim and this module must never decide the question
    // by falling back to a literal. If the row is gone at BOTH levels the only
    // honest answer is a refusal that names the key.
    //
    // `tanpaKonfigurasi` needs this world to own a row before it can remove
    // one, and KONFIGURASI_AWAL deliberately seeds none for this key, so the
    // test writes one first. What it writes is irrelevant: it is removed.
    await d.setelKonfigurasi("rka", "pemisahan_tugas_persetujuan", "true");
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    const err = await d.tanpaKonfigurasi("rka", "pemisahan_tugas_persetujuan", () =>
      tolakDengan(
        () => d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain),
        KODE_RKA.KONFIGURASI_TIDAK_ADA,
      ),
    );
    expect(err.message).toContain("rka.pemisahan_tugas_persetujuan");
    // Refused before deciding, so nothing was approved on a guess.
    expect((await d.bacaRkaDb(rka.id)).status).toBe("DRAFT");
  });

  test("dengan kebijakan menyala, penyusun tidak boleh menyetujui RKA-nya sendiri", async () => {
    kodeAda(KODE_RKA.KONFLIK_MAKER_APPROVER);
    // The MECHANIC, not the policy: this test says "when the row says true,
    // self-approval is refused", and says nothing about whether it should be
    // true. `setelKonfigurasi` refuses uncatalogued keys, so this line is also
    // red until the catalogue carries the key, and that is the finding.
    await d.setelKonfigurasi("rka", "pemisahan_tugas_persetujuan", "true");
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    await tolakDengan(
      () => d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusat),
      KODE_RKA.KONFLIK_MAKER_APPROVER,
    );
    // Someone else may.
    const disetujui = await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain);
    expect(disetujui.status).toBe("DISETUJUI");
    expect(disetujui.approvedBy).toBe(d.userId.adminPusatLain);
  });

  test("dengan kebijakan mati, penyusun boleh menyetujui RKA-nya sendiri", async () => {
    // The other direction, which is what makes the pair a mechanic rather than
    // a smuggled policy. An engine with the rule hardcoded ON passes the test
    // above and fails this one.
    await d.setelKonfigurasi("rka", "pemisahan_tugas_persetujuan", "false");
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    const disetujui = await d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusat);
    expect(disetujui.status).toBe("DISETUJUI");
    expect(disetujui.approvedBy).toBe(d.userId.adminPusat);
  });

  test("kebijakan menilai penyunting TERAKHIR, bukan hanya pembuat pertama", async () => {
    // The loophole a maker-only check leaves: draft it as A, hand it to B, have
    // B "review" it by editing the numbers, then approve as A. Whoever last
    // touched the grid is the person the control is about.
    await d.setelKonfigurasi("rka", "pemisahan_tugas_persetujuan", "true");
    const rka = await d.engine.buatRka(
      {
        cabangId: d.cabangId,
        tahun: TAHUN_RKA,
        jenis: "NON_PUMK",
        baris: barisNonPumk(d.bidang.a.id, rp(1_000_000)),
      },
      d.ctx.adminPusat,
    );
    await d.engine.simpanBaris(
      { rkaId: rka.id, baris: barisNonPumk(d.bidang.a.id, rp(2_500_000)) },
      d.ctx.adminPusatLain,
    );
    await tolakDengan(
      () => d.engine.setujuiRka({ rkaId: rka.id }, d.ctx.adminPusatLain),
      KODE_RKA.KONFLIK_MAKER_APPROVER,
    );
  });
});
