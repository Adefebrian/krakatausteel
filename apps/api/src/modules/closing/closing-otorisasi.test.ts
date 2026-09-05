// SPEC 2, APPLIED TO CLOSING.
//
// Every context in this file comes from `permissionsForRole`, which READS the
// shipped grant matrix out of the database. Nothing here types a permission
// string into a fixture. That distinction is not stylistic: two real gaps in
// this repository (`pumk.cluster`, `nonpumk.lpj.verifikasi`) were found only
// because a module named the code it needed, checked it against the shipped
// catalogue, and failed closed when it was not there. A fixture that grants
// itself the code it wants proves that the fixture agrees with itself.
//
// Spec 2's own wording is the map:
//   Approver     "eksekusi closing"                 -> admin.closing.*
//   Admin Pusat  "semua kewenangan ... reopen periode" -> admin.periode.reopen
//   Auditor      "read only penuh ... tidak bisa mengubah apa pun"
//   rule 3       every access is branch-scoped except Admin Pusat and Auditor
//   rule 4       the check that matters is the server's, so these call the
//                engine directly rather than a route
//
// ONE FINDING WAS FILED HERE AND IS NOW CLOSED. The read paths (the
// prerequisite checklist, the run history, a closed period's frozen balances)
// had no read-only permission in the catalogue, so an Auditor whose whole job
// is to examine how a period was closed could not reach the evidence without
// being granted a WRITE code. This file used to pin that as a FAIL-CLOSED
// refusal (`IZIN_BELUM_TERDAFTAR`); the catalogue now carries
// `admin.closing.view`, so the last describe block asserts the positive
// behaviour instead. See `PERMISSION_CLOSING.LIHAT` and the block's own note
// for what changed and what is still pinned.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { canonicalPermission, PERMISSIONS_BY_ROLE } from "../auth";
import { KODE_CLOSING, PERMISSION_CLOSING } from "./contract";
import { buatDunia, rp, tolakDengan, type DuniaClosing } from "./test-support";

let d: DuniaClosing;

beforeEach(async () => {
  d = await buatDunia();
});
afterEach(async () => {
  await d?.tutup();
});

describe("spec 2: siapa boleh menjalankan langkah closing", () => {
  test("Maker, Checker dan Auditor tidak bisa menjalankan closing kolektibilitas", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });

    for (const nama of ["maker", "checker", "auditor"] as const) {
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_CLOSING.KOLEKTIBILITAS);
      await tolakDengan(
        () => d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx[nama]),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
    }
    // Refused, and nothing written: spec 2 rule 1's "Sistem harus menolak,
    // bukan hanya menyembunyikan tombol" applies to side effects too.
    expect(await d.jumlahSnapshot(p.id)).toBe(0);
  });

  test("preview juga butuh izin, karena ia membuka seluruh portofolio piutang", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });

    // A preview writes nothing, which is exactly why it is tempting to leave
    // ungated. It still returns every akad's outstanding, arrears and
    // classification for every branch in scope, which is the most sensitive
    // read in the PUMK module.
    await tolakDengan(
      () => d.engine.previewKolektibilitas({ periodeId: p.id }, d.ctx.maker),
      KODE_CLOSING.TIDAK_BERWENANG,
    );
  });

  test("penyisihan dan akrual memakai admin.closing.hitung, bukan izin tutup periode", async () => {
    // OPEN-QUESTIONS 29, decided by the repo owner 2026-09-02. These two steps
    // used to sit behind `admin.closing.periode`, the same code as the close
    // itself, so making the close Admin Pusat's would have moved both monthly
    // computations to head office as a side effect. They now have their own
    // code, held by APPROVER and inherited by ADMIN_CABANG: what is centralised
    // is the DECLARATION that the month is finished, not the arithmetic that
    // prepares it.
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    for (const nama of ["maker", "checker", "auditor"] as const) {
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_CLOSING.HITUNG);
      await tolakDengan(
        () => d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx[nama]),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
      await tolakDengan(
        () => d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx[nama]),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
    }
    expect(await d.bacaPenyisihan(p.id)).toHaveLength(0);
    expect(await d.bacaAkrual(p.id)).toHaveLength(0);

    // AND THE POSITIVE HALF, which is the half the decision was at risk of
    // taking away. Holding the computing code WITHOUT the closing code is
    // enough to run both steps.
    for (const nama of ["approver", "adminCabang"] as const) {
      expect(d.ctx[nama].permissions).toContain(PERMISSION_CLOSING.HITUNG);
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_CLOSING.PERIODE);
    }
    await d.engine.jalankanPenyisihan({ periodeId: p.id }, d.ctx.approver);
    await d.engine.jalankanAkrualJasaAdm({ periodeId: p.id }, d.ctx.adminCabang);
    expect((await d.bacaPenyisihan(p.id)).length).toBeGreaterThan(0);
  });

  test("kolektibilitas tetap boleh dijalankan Approver dan Admin Cabang", async () => {
    // `admin.closing.kolektibilitas` already had its own code and did NOT
    // change. Asserted here so a future edit to the catalogue cannot quietly
    // sweep spec 8.1 along with spec 8.4.
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });

    for (const nama of ["approver", "adminCabang"] as const) {
      expect(d.ctx[nama].permissions).toContain(PERMISSION_CLOSING.KOLEKTIBILITAS);
    }
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.adminCabang);
    expect(await d.jumlahSnapshot(p.id)).toBeGreaterThan(0);
  });

  test("HANYA Admin Pusat boleh eksekusi closing periode, dan penolakannya tercatat", async () => {
    // OPEN-QUESTIONS 29's actual decision. `admin.closing.periode` now gates
    // `tutupPeriode` and nothing else, and ADMIN_PUSAT is the only role that
    // holds it. An Approver prepares the month and reads the ten-item
    // checklist; head office declares it finished.
    const p = d.periode(2026, 1);
    d.setelJam(p.tanggalMulai);
    await d.postingAlokasiDana(p.tanggalMulai, rp(50_000_000));
    d.setelJam(p.tanggalAkhir);
    await d.siapkanTutup(p);

    for (const nama of ["approver", "adminCabang", "maker", "checker", "auditor"] as const) {
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_CLOSING.PERIODE);
      await tolakDengan(
        () => d.engine.tutupPeriode({ periodeId: p.id }, d.ctx[nama]),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
      // Spec 2 rule 1: refused, and nothing written.
      expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
    }

    // The DITOLAK row spec 2 rule 5 requires is written by the HTTP error
    // handler, not by the engine, so it is asserted where it is produced:
    // ./closing-rute-otorisasi.test.ts, "penolakan tutup periode oleh Approver
    // meninggalkan baris DITOLAK". Asserting it here would need this file to
    // reach past the engine it is testing.
    const hasil = await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.adminPusat);
    expect(hasil.periode.status).toBe("CLOSED");
  });
});

describe("spec 8.4: reopen adalah wewenang Admin Pusat saja", () => {
  test("Approver dan Admin Cabang tidak bisa reopen walaupun keduanya bisa closing", async () => {
    const p = d.periode(2026, 1);
    d.setelJam(p.tanggalMulai);
    await d.postingAlokasiDana(p.tanggalMulai, rp(50_000_000));
    d.setelJam(p.tanggalAkhir);
    await d.siapkanTutup(p);
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.adminPusat);

    // Since OPEN-QUESTIONS 29 both acts are Admin Pusat's, so the asymmetry is
    // now one of degree rather than of kind: a reopen additionally demands a
    // written reason and refuses unless this is the latest closed period. The
    // Approver holds neither code.
    for (const nama of ["approver", "adminCabang", "maker", "auditor"] as const) {
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_CLOSING.REOPEN);
      await tolakDengan(
        () =>
          d.engine.bukaKembaliPeriode(
            { periodeId: p.id, alasan: "Koreksi (fixture)" },
            d.ctx[nama],
          ),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
      expect((await d.bacaPeriode(p.id)).status).toBe("CLOSED");
    }

    const dibuka = await d.engine.bukaKembaliPeriode(
      { periodeId: p.id, alasan: "Koreksi klasifikasi beban, permintaan KAP (fixture)" },
      d.ctx.adminPusat,
    );
    expect(dibuka.status).toBe("OPEN");
  });

  test("matriks hibah terkirim memberi perhitungan ke Approver dan tutup buku hanya ke Admin Pusat", () => {
    // Asserted against the SHIPPED matrix rather than against the fixture's
    // contexts, so a change to the grant table is a failing test here and not a
    // silent widening discovered in production.
    expect(PERMISSIONS_BY_ROLE.APPROVER).toContain(PERMISSION_CLOSING.KOLEKTIBILITAS);
    expect(PERMISSIONS_BY_ROLE.APPROVER).toContain(PERMISSION_CLOSING.HITUNG);
    // OPEN-QUESTIONS 29. The Approver runs spec 8.1, 8.2 and 8.3 and reads the
    // checklist; it does not declare the month finished.
    expect(PERMISSIONS_BY_ROLE.APPROVER).not.toContain(PERMISSION_CLOSING.PERIODE);
    expect(PERMISSIONS_BY_ROLE.ADMIN_CABANG).not.toContain(PERMISSION_CLOSING.PERIODE);
    expect(PERMISSIONS_BY_ROLE.ADMIN_PUSAT).toContain(PERMISSION_CLOSING.PERIODE);
    expect(PERMISSIONS_BY_ROLE.APPROVER).not.toContain(PERMISSION_CLOSING.REOPEN);
    expect(PERMISSIONS_BY_ROLE.ADMIN_CABANG).not.toContain(PERMISSION_CLOSING.REOPEN);
    expect(PERMISSIONS_BY_ROLE.ADMIN_PUSAT).toContain(PERMISSION_CLOSING.REOPEN);
    expect(PERMISSIONS_BY_ROLE.MAKER).not.toContain(PERMISSION_CLOSING.PERIODE);
    expect(PERMISSIONS_BY_ROLE.CHECKER).not.toContain(PERMISSION_CLOSING.PERIODE);
    // spec 2: "Auditor / Viewer: Read only penuh ... Tidak bisa mengubah apa pun".
    for (const kode of [
      PERMISSION_CLOSING.KOLEKTIBILITAS,
      PERMISSION_CLOSING.PERIODE,
      PERMISSION_CLOSING.REOPEN,
    ]) {
      expect(PERMISSIONS_BY_ROLE.AUDITOR).not.toContain(kode);
    }
  });
});

describe("spec 2 aturan 3: scope cabang", () => {
  test("Approver satu cabang tidak bisa menjalankan closing kolektibilitas cabang lain", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({
      hariTunggakan: 45,
      padaTanggal: p.tanggalAkhir,
      cabangId: d.cabangLainId,
    });

    // `approverLain` lives in the other branch and holds every closing code, so
    // the only thing standing between them and this branch's portfolio is the
    // scope check. Spec 16 scenario 24 is this test at the HTTP layer.
    await tolakDengan(
      () =>
        d.engine.jalankanKolektibilitas(
          { periodeId: p.id, cabangId: d.cabangId },
          d.ctx.approverLain,
        ),
      KODE_CLOSING.CABANG_DILUAR_SCOPE,
    );
    expect(await d.jumlahSnapshot(p.id)).toBe(0);
  });

  test("run tanpa cabang oleh pengguna satu cabang hanya menyentuh cabangnya sendiri", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const milikSendiri = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    await d.buatAkad({
      hariTunggakan: 45,
      padaTanggal: p.tanggalAkhir,
      cabangId: d.cabangLainId,
      tanggalPencairan: "2026-01-05",
    });

    // "Semua cabang sekaligus" means every branch IN SCOPE, not every branch in
    // the database. A branch Approver running the all-branches option must not
    // quietly become a cross-branch read.
    const hasil = await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);
    expect(hasil.baris.map((b) => b.akadId)).toEqual([milikSendiri.akadId]);
    expect(hasil.cabangId).toBe(d.cabangId);
  });

  test("Admin Pusat memang lintas cabang, dan itu satu satunya pengecualian yang dipakai di sini", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    const a = await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    const b = await d.buatAkad({
      hariTunggakan: 45,
      padaTanggal: p.tanggalAkhir,
      cabangId: d.cabangLainId,
      tanggalPencairan: "2026-01-05",
    });

    const hasil = await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.adminPusat);
    expect(hasil.baris.map((x) => x.akadId).sort()).toEqual([a.akadId, b.akadId].sort());
  });
});

describe("TEMUAN DITUTUP: jalur baca closing punya kode izin baca-saja", () => {
  // WHAT THIS BLOCK USED TO ASSERT, AND WHY IT WAS INVERTED.
  //
  // Until `admin.closing.view` existed, these four reads FAILED CLOSED with
  // `IZIN_BELUM_TERDAFTAR` and this block asserted exactly that, deliberately
  // red, because the two ways out were both wrong: gating the reads on
  // `admin.closing.periode` hands a WRITE code to a role spec 2 makes read
  // only, and leaving them ungated makes the whole closing history readable to
  // any authenticated account. The module named the code it needed and refused
  // until the catalogue carried it, which is the same shape that closed
  // `pumk.cluster` and `nonpumk.lpj.verifikasi`.
  //
  // The catalogue now carries it, granted to AUDITOR and APPROVER and inherited
  // by ADMIN_CABANG and ADMIN_PUSAT, so the correct assertion is now the
  // POSITIVE one: an Auditor reaches the evidence holding no write code at all.
  // The fail-closed guard itself is NOT dropped with the finding; the third
  // test below keeps it from quietly becoming dead code.

  test("Auditor membaca bukti closing tanpa memegang satu pun kode tulis", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    // Spec 2: "Auditor / Viewer: Read only penuh termasuk semua laporan dan
    // audit trail". How a period was closed, and against which checklist, is
    // the auditor's primary object, and it is not one of the 31 reports in
    // spec 10, so `laporan.view` never reached it.
    expect(d.ctx.auditor.permissions).toContain(PERMISSION_CLOSING.LIHAT);
    for (const kode of [
      PERMISSION_CLOSING.KOLEKTIBILITAS,
      PERMISSION_CLOSING.PERIODE,
      PERMISSION_CLOSING.REOPEN,
    ]) {
      expect(d.ctx.auditor.permissions).not.toContain(kode);
    }

    const daftar = await d.engine.periksaPrasyarat(p.id, d.ctx.auditor);
    expect(daftar.hasil).toHaveLength(10);
    const riwayat = await d.engine.riwayatKolektibilitas(p.id, d.ctx.auditor);
    expect(riwayat.filter((r) => r.status === "SELESAI")).toHaveLength(1);
    const snapshot = await d.engine.snapshotKolektibilitas({ periodeId: p.id }, d.ctx.auditor);
    expect(snapshot).toHaveLength(1);
    // Nothing is frozen yet for an OPEN period, and an empty list is the right
    // answer rather than a refusal.
    expect(await d.engine.saldoAkunPeriode({ periodeId: p.id }, d.ctx.auditor)).toEqual([]);

    // Reading is not writing. The read code must not have widened anything.
    await tolakDengan(
      () => d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.auditor),
      KODE_CLOSING.TIDAK_BERWENANG,
    );
  });

  test("role yang tidak memegang kode baca ditolak TIDAK_BERWENANG, bukan dibiarkan lewat", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });

    // Maker and Checker close nothing, and spec 9.3's two closing screens are
    // the Approver's. A read code that everybody inherits would make the whole
    // closing history world-readable to any authenticated account, which is one
    // of the two outcomes the finding existed to prevent.
    for (const nama of ["maker", "checker"] as const) {
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_CLOSING.LIHAT);
      await tolakDengan(
        () => d.engine.periksaPrasyarat(p.id, d.ctx[nama]),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
      await tolakDengan(
        () => d.engine.riwayatKolektibilitas(p.id, d.ctx[nama]),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
      await tolakDengan(
        () => d.engine.snapshotKolektibilitas({ periodeId: p.id }, d.ctx[nama]),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
      await tolakDengan(
        () => d.engine.saldoAkunPeriode({ periodeId: p.id }, d.ctx[nama]),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
    }
  });

  test("fail closed masih hidup: kode di luar katalog tidak pernah dianggap sudah diberikan", () => {
    // THE HALF OF THE FINDING THAT SURVIVES ITS CLOSURE.
    //
    // The mechanism that produced three findings is "resolve the code against
    // the SHIPPED catalogue, and refuse with IZIN_BELUM_TERDAFTAR when it is
    // not there". Deleting this assertion along with the finding would leave
    // the branch unexercised and the next missing code would resolve to
    // `undefined`, fail the `includes` test, and be reported as
    // TIDAK_BERWENANG: a configuration fault wearing the costume of a policy
    // decision, which is exactly how such a gap stays invisible.
    //
    // So: the catalogue must still DISCRIMINATE, and the code must still exist
    // for the guard to raise.
    expect(canonicalPermission("admin.closing.tidak.pernah.ada")).toBeNull();
    expect(canonicalPermission(PERMISSION_CLOSING.LIHAT)).toBe(PERMISSION_CLOSING.LIHAT);
    expect(Object.values(KODE_CLOSING)).toContain(KODE_CLOSING.IZIN_BELUM_TERDAFTAR);
  });

  test("matriks terkirim memberi kode baca ke pemegang bukti, bukan ke semua orang", () => {
    // A code no role can hold is not a stricter system, it is a dead screen;
    // a code every role holds is not a control. Asserted against the SHIPPED
    // matrix, so a change to the grant table is a failing test here and not a
    // silent widening discovered in production.
    const kodeLihat: string = PERMISSION_CLOSING.LIHAT;
    const pemegang = Object.entries(PERMISSIONS_BY_ROLE)
      .filter(([, izin]) => (izin as readonly string[]).includes(kodeLihat))
      .map(([role]) => role)
      .sort();
    expect(pemegang).not.toEqual([]);
    expect(pemegang).toContain("AUDITOR");
    expect(pemegang).toContain("APPROVER");
    expect(pemegang).toContain("ADMIN_PUSAT");
    expect(pemegang).not.toContain("MAKER");
    expect(pemegang).not.toContain("CHECKER");
    // ...and holding the read code never implies holding a write one.
    expect(PERMISSIONS_BY_ROLE.AUDITOR).not.toContain(PERMISSION_CLOSING.PERIODE);
  });
});
