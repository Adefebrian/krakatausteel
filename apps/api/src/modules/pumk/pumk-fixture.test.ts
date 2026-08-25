// FIXTURE INTEGRITY. The only file in this folder that is expected to be
// GREEN today.
//
// WHY IT EXISTS. Every other file here is a tests-first specification against
// an unimplemented engine, so every other file is RED. That makes a fixture
// bug invisible: "world would not build" and "module not written yet" both
// show up as a red folder. This file separates the two. If it is green and the
// rest are red, the failures are the module. If it is red, nothing else in the
// folder means anything yet and this is the first thing to fix.
//
// It also pins the two things ./test-support.ts promises that a reader would
// otherwise have to take on trust: the permission lists really come from the
// SHIPPED grant matrix in the database (never a literal), and `siapkanProposal`
// really leaves the timeline EMPTY so a timeline assertion elsewhere can only
// pass if the ENGINE wrote the row.
//
// It replaces apps/api/src/modules/pumk/zz-smoke.test.ts, a scratch probe left
// behind mid-task that failed on a driver quirk (see the seedRbac note in
// ./test-support.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PERMISSION_PUMK, STATUS_TERMINAL, TRANSISI_SAH, type StatusProposal } from "./contract";
import {
  buatDunia,
  keSen,
  POKOK_BAKU,
  TENOR_BAKU,
  periksaRekonsiliasiNol,
  type DuniaPumk,
} from "./test-support";

let d: DuniaPumk;

beforeAll(async () => {
  d = await buatDunia();
}, 60_000);

afterAll(async () => {
  if (d) await d.tutup();
});

describe("dunia uji", () => {
  test("izin setiap konteks dibaca dari matriks grant yang dikirim, bukan dari literal", () => {
    // Spec 2's wewenang column, as the database holds it. A fixture that wrote
    // these arrays by hand would assert against its own opinion; that is how
    // `jurnal.update` / `jurnal.delete` being grantable to nobody stayed
    // invisible for a whole phase.
    expect(d.ctx.maker.permissions).toContain(PERMISSION_PUMK.CREATE);
    expect(d.ctx.maker.permissions).toContain(PERMISSION_PUMK.SURVEY);
    expect(d.ctx.maker.permissions).toContain(PERMISSION_PUMK.AKAD);
    expect(d.ctx.maker.permissions).toContain(PERMISSION_PUMK.PENCAIRAN);
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_PUMK.REVIEW);
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_PUMK.APPROVE);

    expect(d.ctx.checker.permissions).toContain(PERMISSION_PUMK.REVIEW);
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_PUMK.CREATE);
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_PUMK.APPROVE);

    expect(d.ctx.approver.permissions).toContain(PERMISSION_PUMK.APPROVE);
    expect(d.ctx.approver.permissions).toContain(PERMISSION_PUMK.HAPUSBUKU);
    expect(d.ctx.approver.permissions).not.toContain(PERMISSION_PUMK.CREATE);

    // ADMIN_CABANG holds create AND review AND approve, which is exactly what
    // makes spec 2 rules 1 and 2 testable with the shipped matrix: the two
    // conflicts have to be refused per DOCUMENT, not per role.
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_PUMK.CREATE);
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_PUMK.REVIEW);
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_PUMK.APPROVE);

    // Spec 2: Auditor changes nothing. Read rights only.
    expect(d.ctx.auditor.permissions).toContain(PERMISSION_PUMK.VIEW);
    for (const izin of [
      PERMISSION_PUMK.CREATE,
      PERMISSION_PUMK.SURVEY,
      PERMISSION_PUMK.REVIEW,
      PERMISSION_PUMK.APPROVE,
      PERMISSION_PUMK.AKAD,
      PERMISSION_PUMK.PENCAIRAN,
      PERMISSION_PUMK.ANGSURAN,
      PERMISSION_PUMK.RESCHEDULE,
      PERMISSION_PUMK.HAPUSBUKU,
      PERMISSION_PUMK.PENAGIHAN,
      PERMISSION_PUMK.KONVERSI_PORTAL,
    ]) {
      expect(d.ctx.auditor.permissions).not.toContain(izin);
    }
  });

  test("pumk.cluster sudah ada di katalog dan dipegang Admin Cabang, bukan Maker", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and that is the point of keeping
    // the note. Spec 9.1 requires a cluster page and the shipped catalogue had
    // no code for it, so this file filed a standing TEMUAN: not even
    // ADMIN_PUSAT, which receives the whole catalogue, could hold
    // `pumk.cluster`, and every cluster operation had to fail closed with
    // IZIN_BELUM_TERDAFTAR. The catalogue owner has since added the code, so
    // the demand is discharged and the assertion inverts.
    //
    // WHERE IT LANDED MATTERS AS MUCH AS THAT IT EXISTS. Managing a group's
    // roster is branch operational administration, so it sits with
    // ADMIN_CABANG and is inherited by ADMIN_PUSAT. The two reuses this file
    // argued against are still wrong and still absent: `pumk.create` would let
    // any Maker restructure the very groups whose kolektibilitas performance is
    // reported per cluster, and `konfigurasi.master` would put an operational
    // PUMK screen behind Admin Pusat.
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_PUMK.CLUSTER);
    expect(d.ctx.adminPusat.permissions).toContain(PERMISSION_PUMK.CLUSTER);
    for (const nama of ["maker", "checker", "approver", "auditor"] as const) {
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_PUMK.CLUSTER);
    }
  });

  test("scope cabang: hanya Admin Pusat dan Auditor melihat lebih dari satu cabang (spec 2 aturan 3)", () => {
    expect(d.ctx.adminPusat.cabangDalamScope).toContain(d.cabangLainId);
    expect(d.ctx.auditor.cabangDalamScope).toContain(d.cabangLainId);
    expect(d.ctx.maker.cabangDalamScope).toEqual([d.cabangId]);
    expect(d.ctx.makerLain.cabangDalamScope).toEqual([d.cabangLainId]);
    expect(d.ctx.makerLain.cabangId).toBe(d.cabangLainId);
  });

  test("siapkanProposal membangun setiap status TANPA menulis satu pun baris timeline", async () => {
    // The precondition builder writes proposal, survey, review, approval, akad
    // and schedule rows directly, but NEVER a pumk_proposal_transisi row. That
    // is what makes the timeline assertions in ./pumk-state-machine.test.ts
    // honest: a timeline row can only exist if the ENGINE appended it.
    const semua: StatusProposal[] = [
      "DRAFT",
      "SURVEY_PENDING",
      "SURVEY_SELESAI",
      "REVIEW_CHECKER",
      "MENUNGGU_PERSETUJUAN",
      "DISETUJUI",
      "AKAD_DIBUAT",
      "JADWAL_SIAP",
      "DICAIRKAN",
      "TIDAK_DIREKOMENDASIKAN",
      "DITOLAK",
    ];
    for (const status of semua) {
      const f = await d.siapkanProposal(status);
      const p = await d.bacaProposal(f.proposalId);
      expect(p.status).toBe(status);
      expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
    }
  }, 60_000);

  test("prasyarat DICAIRKAN memakai engine nyata dan sudah rekonsiliasi nol sejak awal", async () => {
    // Spec 8.4 check 10 at the STARTING LINE. If the fixture itself could not
    // reconcile, every ledger assertion downstream would be measuring the
    // fixture rather than the module.
    const f = await d.siapkanProposal("DICAIRKAN");
    expect(f.akadId).not.toBeNull();
    const akadId = f.akadId as string;

    const jadwal = await d.bacaJadwal(akadId);
    expect(jadwal).toHaveLength(TENOR_BAKU);
    expect(jadwal[0].pokok).toBe("1000000.00");
    expect(jadwal[0].jasa_adm).toBe("30000.00");
    expect(jadwal[TENOR_BAKU - 1].saldo_pokok_setelah).toBe("0.00");
    // Invariant 9, enforced by the DEFERRED trigger TJSL-JDW-001: the schedule
    // sums to the principal exactly.
    const totalPokok = jadwal.reduce((acc, b) => acc + keSen(b.pokok), 0n);
    expect(totalPokok).toBe(keSen(POKOK_BAKU));

    const akad = await d.bacaAkad(akadId);
    expect(akad.status).toBe("AKTIF");
    expect(akad.outstanding_pokok).toBe(POKOK_BAKU);
    periksaRekonsiliasiNol(await d.rekonsiliasi(akadId), POKOK_BAKU);
    expect(await d.akadTidakRekonsiliasi()).toHaveLength(0);

    // And no pumk_pencairan row: the fixture posts the LEDGER effect through
    // the real engine but deliberately leaves the business row to the module,
    // so ./pumk-pencairan.test.ts is testing something.
    expect(await d.bacaPencairan(akadId)).toHaveLength(0);
  }, 60_000);

  test("tabel transisi kontrak sama persis dengan diagram spec 9.1", () => {
    // A pin, not a behaviour test. The engine and the tests both read
    // TRANSISI_SAH, so if the table drifted from the spec they would drift
    // together and agree with each other about the wrong thing. This is the
    // one place the table is compared against the spec's own diagram, edge by
    // edge, transcribed by hand.
    const edges = TRANSISI_SAH.map((t) => `${t.dari}-${t.aksi}->${t.ke}`);
    expect(edges).toEqual([
      "DRAFT-SUBMIT_SURVEY->SURVEY_PENDING",
      "SURVEY_PENDING-INPUT_SURVEY->SURVEY_SELESAI",
      "SURVEY_SELESAI-AJUKAN_CHECKER->REVIEW_CHECKER",
      "REVIEW_CHECKER-REKOMENDASI->MENUNGGU_PERSETUJUAN",
      "REVIEW_CHECKER-TIDAK_REKOMENDASI->TIDAK_DIREKOMENDASIKAN",
      "REVIEW_CHECKER-MINTA_PERBAIKAN->SURVEY_SELESAI",
      "MENUNGGU_PERSETUJUAN-SETUJU->DISETUJUI",
      "MENUNGGU_PERSETUJUAN-TOLAK->DITOLAK",
      "MENUNGGU_PERSETUJUAN-KEMBALIKAN->REVIEW_CHECKER",
      "DISETUJUI-BUAT_AKAD->AKAD_DIBUAT",
      "AKAD_DIBUAT-GENERATE_JADWAL->JADWAL_SIAP",
      "JADWAL_SIAP-PENCAIRAN->DICAIRKAN",
    ]);

    // Terminal means terminal: no outgoing edge at all.
    for (const status of STATUS_TERMINAL) {
      expect(TRANSISI_SAH.filter((t) => t.dari === status)).toHaveLength(0);
    }

    // The four transitions that reject or send back demand a reason. A
    // rejection with no note is the complaint spec 9.1 is answering.
    const wajibCatatan = TRANSISI_SAH.filter((t) => t.catatanWajib).map((t) => t.aksi).sort();
    expect(wajibCatatan).toEqual(["KEMBALIKAN", "MINTA_PERBAIKAN", "TIDAK_REKOMENDASI", "TOLAK"]);
  });
});
