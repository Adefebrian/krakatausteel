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
// ONE FINDING IS FILED HERE AND IS RED ON PURPOSE. The read paths (the
// prerequisite checklist, the run history, a closed period's frozen balances)
// have no read-only permission in the catalogue, so an Auditor whose whole job
// is to examine how a period was closed cannot reach the evidence without
// being granted a WRITE code. See `PERMISSION_CLOSING.LIHAT`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PERMISSIONS_BY_ROLE } from "../auth";
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

  test("penyisihan dan akrual memakai izin closing periode, bukan izin bebas", async () => {
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });
    await d.engine.jalankanKolektibilitas({ periodeId: p.id }, d.ctx.approver);

    // Both post real journals that move the allowance and recognise income, so
    // they sit behind the same code as the closing they are steps of. Spec 9.3
    // lists two closing screens, not four, which is why this module does not
    // invent codes of its own for them.
    for (const nama of ["maker", "checker", "auditor"] as const) {
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_CLOSING.PERIODE);
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
  });

  test("Approver boleh eksekusi closing periode; Maker dan Checker tidak", async () => {
    const p = d.periode(2026, 1);
    d.setelJam(p.tanggalMulai);
    await d.postingAlokasiDana(p.tanggalMulai, rp(50_000_000));
    d.setelJam(p.tanggalAkhir);
    await d.siapkanTutup(p);

    for (const nama of ["maker", "checker", "auditor"] as const) {
      await tolakDengan(
        () => d.engine.tutupPeriode({ periodeId: p.id }, d.ctx[nama]),
        KODE_CLOSING.TIDAK_BERWENANG,
      );
      expect((await d.bacaPeriode(p.id)).status).toBe("OPEN");
    }

    // spec 2: the Approver's row literally says "eksekusi closing".
    const hasil = await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);
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
    await d.engine.tutupPeriode({ periodeId: p.id }, d.ctx.approver);

    // The asymmetry is the control. Closing a period is an operational act;
    // reopening one rewrites a period that has already been reported on, which
    // is why spec 2 puts it with Admin Pusat and nowhere else.
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

  test("matriks hibah terkirim memang memberi closing ke Approver dan reopen hanya ke Admin Pusat", () => {
    // Asserted against the SHIPPED matrix rather than against the fixture's
    // contexts, so a change to the grant table is a failing test here and not a
    // silent widening discovered in production.
    expect(PERMISSIONS_BY_ROLE.APPROVER).toContain(PERMISSION_CLOSING.KOLEKTIBILITAS);
    expect(PERMISSIONS_BY_ROLE.APPROVER).toContain(PERMISSION_CLOSING.PERIODE);
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

describe("TEMUAN: jalur baca closing tidak punya kode izin baca-saja", () => {
  test("jalur baca gagal tertutup selama kodenya belum ada di katalog", async () => {
    // FAIL-CLOSED, and red on purpose until the catalogue carries the code.
    //
    // Reading the prerequisite checklist, the run history and a closed
    // period's frozen balances is EVIDENCE, not an operation. Spec 2 gives the
    // Auditor "read only penuh termasuk semua laporan dan audit trail" and
    // spec 16 scenario 23 tests that every report opens for them; how a period
    // was closed is not one of the 31 reports in spec 10, so `laporan.view`
    // does not reach it.
    //
    // The two ways out are both wrong. Gating the reads on
    // `admin.closing.periode` hands a WRITE code to a role that must never
    // write, and `ROLES_READ_ONLY` would then be the only thing preventing a
    // write, which is a much thinner guarantee than not holding the right.
    // Leaving the reads ungated makes the whole closing history world-readable
    // to any authenticated user.
    //
    // So the engine names `admin.closing.view`, refuses until it exists, and
    // this test stays red. Adding the string to `d.ctx.auditor.permissions`
    // would make it pass and the gap invisible, which is the move `pumk.cluster`
    // and `nonpumk.lpj.verifikasi` both survived.
    const p = d.periode(2027, 6);
    d.setelJam(p.tanggalAkhir);
    await d.buatAkad({ hariTunggakan: 45, padaTanggal: p.tanggalAkhir });

    const err = await tolakDengan(
      () => d.engine.periksaPrasyarat(p.id, d.ctx.auditor),
      KODE_CLOSING.IZIN_BELUM_TERDAFTAR,
    );
    // The refusal has to name what is missing, or an operator sees a 403 with
    // nothing to escalate.
    expect(JSON.stringify(err.detail)).toContain(PERMISSION_CLOSING.LIHAT);

    await tolakDengan(
      () => d.engine.riwayatKolektibilitas(p.id, d.ctx.auditor),
      KODE_CLOSING.IZIN_BELUM_TERDAFTAR,
    );
    await tolakDengan(
      () => d.engine.saldoAkunPeriode({ periodeId: p.id }, d.ctx.auditor),
      KODE_CLOSING.IZIN_BELUM_TERDAFTAR,
    );
    await tolakDengan(
      () => d.engine.snapshotKolektibilitas({ periodeId: p.id }, d.ctx.auditor),
      KODE_CLOSING.IZIN_BELUM_TERDAFTAR,
    );
  });

  test("sampai kodenya ada, TIDAK ADA satu pun role yang bisa membaca jalur itu, termasuk Admin Pusat", () => {
    // The precise shape of the earlier findings: a code that no role can hold
    // is not a stricter system, it is a dead screen. ADMIN_PUSAT is built as a
    // spread of `PERMISSIONS`, so if the code were in the catalogue this would
    // already be satisfied; it is not, which is the whole content of the
    // finding.
    const kodeLihat: string = PERMISSION_CLOSING.LIHAT;
    const pemegang = Object.entries(PERMISSIONS_BY_ROLE)
      .filter(([, izin]) => (izin as readonly string[]).includes(kodeLihat))
      .map(([role]) => role);
    expect(pemegang).not.toEqual([]);
  });
});
