// SPEC 2 (peran dan otorisasi) AND SCENARIO 24, at the SERVER layer.
//
// "Otorisasi divalidasi di layer server, bukan hanya di UI. Buat test yang
// memanggil endpoint langsung dengan role yang salah dan pastikan ditolak."
// There is no HTTP surface yet, so these call the ENGINE directly, which is the
// layer behind any future route: a guard that only exists in routes.ts would
// leave every other caller (a job, a tool, an import) unguarded.
//
// "Sistem harus menolak, bukan hanya menyembunyikan tombol." Every case here is
// a refusal, not an absent button.
//
// WHY THE PERMISSIONS COME OUT OF THE DATABASE.
// Every `d.ctx.*` list was resolved with `permissionsForRole`, which reads the
// SHIPPED grant matrix. A fixture that wrote `permissions: ["nonpumk.approve"]`
// by hand would prove only that the fixture agrees with itself; that is
// precisely how a permission the engine checks but no role can hold stays
// invisible, and it is how `pumk.cluster` was found.
//
// WHY THE SEGREGATION CASES USE ADMIN_CABANG.
// Spec 2 rules 1 and 2 are per DOCUMENT, not per role: the conflict only exists
// for someone who could legitimately play both parts. ADMIN_CABANG is the only
// shipped role holding create AND review AND approve, so it is the only role
// that can express "the same human on both sides of the same proposal" without
// inventing a grant.
//
// AND WHY THE DOMAIN ERROR MATTERS MORE THAN THE REFUSAL.
// migrations/0009 already refuses both conflicts with
// trg_nonpumk_review_10_sod / trg_nonpumk_approval_10_sod, reusing the same
// trigger FUNCTIONS as PUMK. These tests are NOT asserting that Postgres works.
// They assert the module refuses FIRST, with a clean Indonesian message:
// `tolakDengan` fails the test if the string "TJSL-SOD-001" ever reaches the
// caller.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { canonicalPermission } from "../auth";
import {
  createNonPumkEngine,
  KODE_NONPUMK,
  PERMISSION_NONPUMK,
  type NonPumkEngine,
} from "./contract";
import {
  buatDunia,
  porterJurnalUji,
  rp,
  tolakDengan,
  DIAJUKAN_BAKU,
  DISETUJUI_BAKU,
  PENERIMA_AKTUAL_BAKU,
  PENERIMA_ESTIMASI_BAKU,
  TANGGAL_LPJ_BAKU,
  TANGGAL_PENYALURAN_BAKU,
  TANGGAL_PROPOSAL_BAKU,
  type DuniaNonPumk,
  type PorterJurnalUji,
  type ProposalFixture,
} from "./test-support";

let d: DuniaNonPumk;
let engine: NonPumkEngine;
let jurnal: PorterJurnalUji;

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  engine = createNonPumkEngine({ db: d.db, jurnal, jam: d.jam });
}, 60_000);

beforeEach(() => {
  jurnal.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

function inputProposal(cabangId: string, bidangId: string) {
  return {
    cabangId,
    tanggalProposal: TANGGAL_PROPOSAL_BAKU,
    namaPemohon: "Yayasan Uji Otorisasi",
    bidangId,
    sdg: [{ sdgId: d.sdg[0].id }],
    judulProgram: "Bantuan sarana belajar",
    jumlahDiajukan: DIAJUKAN_BAKU,
    penerimaManfaatEstimasi: PENERIMA_ESTIMASI_BAKU,
  };
}

// ---------------------------------------------------------------------------
// The role matrix of spec 2
// ---------------------------------------------------------------------------

describe("matriks wewenang (spec 2)", () => {
  test("Maker tidak bisa menyetujui", async () => {
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_NONPUMK.APPROVE);
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: f.proposalId,
            tanggal: TANGGAL_PROPOSAL_BAKU,
            keputusan: "SETUJU",
            jumlahDisetujui: DISETUJUI_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    expect(await d.bacaApproval(f.proposalId)).toHaveLength(0);
    expect((await d.bacaProposal(f.proposalId)).jumlah_disetujui).toBeNull();
  });

  test("Maker tidak bisa mereview", async () => {
    const f = await d.siapkanProposal("REVIEW_CHECKER", { makerUserId: d.userId.makerDua });
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_NONPUMK.REVIEW);
    await tolakDengan(
      () =>
        engine.review(
          { proposalId: f.proposalId, tanggal: TANGGAL_PROPOSAL_BAKU, keputusan: "REKOMENDASI" },
          d.ctx.maker,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    expect(await d.bacaReview(f.proposalId)).toHaveLength(0);
  });

  test("Checker tidak bisa input data baru: proposal, penilaian, penyaluran, LPJ", async () => {
    // Spec 2: "Checker ... TIDAK BISA INPUT DATA BARU". Four entry points, one
    // rule; a guard that sits on only the proposal form leaves the other three
    // open to exactly the role the control exists to stop.
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_NONPUMK.CREATE);
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_NONPUMK.PENILAIAN);
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_NONPUMK.PENYALURAN);
    expect(d.ctx.checker.permissions).not.toContain(PERMISSION_NONPUMK.LPJ);

    await tolakDengan(
      () => engine.buatProposal(inputProposal(d.cabangId, d.bidang.id), d.ctx.checker),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );

    const nilai = await d.siapkanProposal("PENILAIAN");
    await tolakDengan(
      () =>
        engine.inputPenilaian(
          {
            proposalId: nilai.proposalId,
            tanggal: TANGGAL_PROPOSAL_BAKU,
            hasil: { kelayakan: 80 },
            skorTotal: "80.000000",
            nilaiRekomendasi: DISETUJUI_BAKU,
          },
          d.ctx.checker,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );

    const setuju = await d.siapkanProposal("DISETUJUI");
    await tolakDengan(
      () =>
        engine.catatPenyaluran(
          {
            proposalId: setuju.proposalId,
            tanggalPenyaluran: TANGGAL_PENYALURAN_BAKU,
            jumlah: rp(1_000_000),
            akunKasId: d.akun.kas.id,
            akunBebanId: setuju.akunBebanId,
          },
          d.ctx.checker,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );

    const lpj = await d.siapkanProposal("MENUNGGU_LPJ");
    await tolakDengan(
      () =>
        engine.ajukanLpj(
          {
            proposalId: lpj.proposalId,
            tanggalLpj: TANGGAL_LPJ_BAKU,
            jumlahRealisasi: lpj.totalDisalurkan,
            penerimaManfaatAktual: PENERIMA_AKTUAL_BAKU,
          },
          d.ctx.checker,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );

    expect(await d.bacaPenilaian(nilai.proposalId)).toHaveLength(0);
    expect(await d.bacaPenyaluran(setuju.proposalId)).toHaveLength(0);
    expect(await d.bacaLpj(lpj.proposalId)).toHaveLength(0);
    // Not one refused call reached the ledger.
    expect(jurnal.panggilan).toHaveLength(0);
  }, 60_000);

  test("Approver tidak bisa membuat proposal, menilai, atau menyalurkan", async () => {
    // The Approver decides; it does not operate. An approver who can also
    // disburse is one person from decision to cash.
    expect(d.ctx.approver.permissions).not.toContain(PERMISSION_NONPUMK.PENYALURAN);
    await tolakDengan(
      () => engine.buatProposal(inputProposal(d.cabangId, d.bidang.id), d.ctx.approver),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    const f = await d.siapkanProposal("DISETUJUI");
    await tolakDengan(
      () =>
        engine.catatPenyaluran(
          {
            proposalId: f.proposalId,
            tanggalPenyaluran: TANGGAL_PENYALURAN_BAKU,
            jumlah: rp(1_000_000),
            akunKasId: d.akun.kas.id,
            akunBebanId: f.akunBebanId,
          },
          d.ctx.approver,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    expect(await d.bacaPenyaluran(f.proposalId)).toHaveLength(0);
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("setiap operasi yang mengubah data ditolak untuk Auditor (skenario 23)", async () => {
    // "Read only PENUH ... tidak bisa mengubah apa pun", and scenario 23 tests
    // it. Every WRITE method of the engine, in one place, so a method added
    // later without a guard shows up here.
    const draft = await d.siapkanProposal("DRAFT");
    const nilai = await d.siapkanProposal("PENILAIAN");
    const review = await d.siapkanProposal("REVIEW_CHECKER");
    const tunggu = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const setuju = await d.siapkanProposal("DISETUJUI");
    const salur = await d.siapkanProposal("DISALURKAN", { terminPenyaluran: [rp(10_000_000)] });
    const menunggu = await d.siapkanProposal("MENUNGGU_LPJ");

    await tolakDengan(
      () => engine.buatProposal(inputProposal(d.cabangId, d.bidang.id), d.ctx.auditor),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    await tolakDengan(
      () => engine.ajukanPenilaian(draft.proposalId, null, d.ctx.auditor),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    await tolakDengan(
      () =>
        engine.inputPenilaian(
          {
            proposalId: nilai.proposalId,
            tanggal: TANGGAL_PROPOSAL_BAKU,
            hasil: { kelayakan: 80 },
            skorTotal: "80.000000",
            nilaiRekomendasi: DISETUJUI_BAKU,
          },
          d.ctx.auditor,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    await tolakDengan(
      () =>
        engine.review(
          { proposalId: review.proposalId, tanggal: TANGGAL_PROPOSAL_BAKU, keputusan: "REKOMENDASI" },
          d.ctx.auditor,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: tunggu.proposalId,
            tanggal: TANGGAL_PROPOSAL_BAKU,
            keputusan: "SETUJU",
            jumlahDisetujui: DISETUJUI_BAKU,
          },
          d.ctx.auditor,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    await tolakDengan(
      () =>
        engine.catatPenyaluran(
          {
            proposalId: setuju.proposalId,
            tanggalPenyaluran: TANGGAL_PENYALURAN_BAKU,
            jumlah: rp(1_000_000),
            akunKasId: d.akun.kas.id,
            akunBebanId: setuju.akunBebanId,
          },
          d.ctx.auditor,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    await tolakDengan(
      () => engine.tutupPenyaluran(salur.proposalId, null, d.ctx.auditor),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    await tolakDengan(
      () =>
        engine.ajukanLpj(
          {
            proposalId: menunggu.proposalId,
            tanggalLpj: TANGGAL_LPJ_BAKU,
            jumlahRealisasi: menunggu.totalDisalurkan,
            penerimaManfaatAktual: PENERIMA_AKTUAL_BAKU,
          },
          d.ctx.auditor,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );

    // Nothing moved anywhere.
    expect((await d.bacaProposal(draft.proposalId)).status).toBe("DRAFT");
    expect(await d.bacaTransisi(draft.proposalId)).toHaveLength(0);
    expect(await d.bacaPenilaian(nilai.proposalId)).toHaveLength(0);
    expect(await d.bacaReview(review.proposalId)).toHaveLength(0);
    expect(await d.bacaApproval(tunggu.proposalId)).toHaveLength(0);
    expect(await d.bacaPenyaluran(setuju.proposalId)).toHaveLength(0);
    expect(await d.bacaLpj(menunggu.proposalId)).toHaveLength(0);
    expect(jurnal.panggilan).toHaveLength(0);
  }, 120_000);

  test("Auditor tetap bisa membaca: ringkasan, timeline, daftar, monitoring, di semua cabang", async () => {
    // "Read only PENUH." A read-only role that cannot read is not a working
    // control, it is a broken one, so the positive half is asserted too.
    const f = await d.siapkanProposal("MENUNGGU_LPJ");
    const ringkasan = await engine.ringkasan(f.proposalId, d.ctx.auditor);
    expect(ringkasan.proposal.id).toBe(f.proposalId);
    expect(ringkasan.totalDisalurkan).toBe(f.totalDisalurkan);

    const lain = await d.siapkanProposal("DRAFT", {
      cabangId: d.cabangLainId,
      makerUserId: d.userId.makerLain,
    });
    // Spec 2 rule 3 exempts Auditor and Admin Pusat from branch scope.
    const daftar = await engine.daftarProposal({}, d.ctx.auditor);
    const ids = daftar.map((p) => p.id);
    expect(ids).toContain(f.proposalId);
    expect(ids).toContain(lain.proposalId);

    const monitoring = await engine.monitoringLpj({}, d.ctx.auditor);
    expect(monitoring.map((m) => m.proposalId)).toContain(f.proposalId);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Segregation of duties (spec 2 rules 1 and 2)
// ---------------------------------------------------------------------------

describe("pemisahan tugas (spec 2 aturan 1 dan 2)", () => {
  test("maker proposal tidak boleh menjadi checker-nya sendiri", async () => {
    const f = await d.siapkanProposal("REVIEW_CHECKER", { makerUserId: d.userId.adminCabang });
    // The role is not the problem: this user legitimately holds nonpumk.review.
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_NONPUMK.REVIEW);

    const err = await tolakDengan(
      () =>
        engine.review(
          {
            proposalId: f.proposalId,
            tanggal: TANGGAL_PROPOSAL_BAKU,
            keputusan: "REKOMENDASI",
            catatan: "Saya sendiri yang input",
          },
          d.ctx.adminCabang,
        ),
      KODE_NONPUMK.KONFLIK_MAKER_CHECKER,
    );
    // The module refused AHEAD of trg_nonpumk_review_10_sod, so the raw trigger
    // text never reached the caller. `tolakDengan` already fails on any
    // TJSL-xxx-nnn in the message; this pins where the raw text belongs.
    expect(err.message).not.toContain("TJSL-SOD-001");
    expect(await d.bacaReview(f.proposalId)).toHaveLength(0);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("REVIEW_CHECKER");
  });

  test("checker proposal tidak boleh menjadi approver-nya sendiri", async () => {
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN", {
      checkerUserId: d.userId.adminCabang,
    });
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_NONPUMK.APPROVE);

    const err = await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: f.proposalId,
            tanggal: TANGGAL_PROPOSAL_BAKU,
            keputusan: "SETUJU",
            jumlahDisetujui: DISETUJUI_BAKU,
          },
          d.ctx.adminCabang,
        ),
      KODE_NONPUMK.KONFLIK_CHECKER_APPROVER,
    );
    expect(err.message).not.toContain("TJSL-SOD-002");
    expect(await d.bacaApproval(f.proposalId)).toHaveLength(0);
    // And the ceiling was never written, so no termin can slip through later.
    expect((await d.bacaProposal(f.proposalId)).jumlah_disetujui).toBeNull();
  });

  test("maker yang BUKAN checker tetap boleh, jadi aturan ini per dokumen bukan per role", async () => {
    // The mirror case. Without it, an engine that simply refused every
    // ADMIN_CABANG review would pass the two tests above and be wrong.
    const f = await d.siapkanProposal("REVIEW_CHECKER", { makerUserId: d.userId.maker });
    const p = await engine.review(
      { proposalId: f.proposalId, tanggal: TANGGAL_PROPOSAL_BAKU, keputusan: "REKOMENDASI", catatan: null },
      d.ctx.adminCabang,
    );
    expect(p.status).toBe("MENUNGGU_PERSETUJUAN");
    expect((await d.bacaReview(f.proposalId))[0].reviewer_user_id).toBe(d.userId.adminCabang);
  });

  test("checker yang BUKAN checker dokumen ini tetap boleh menyetujui", async () => {
    // The mirror of rule 2. The fixture's review was by `checker`, so
    // ADMIN_CABANG is not the checker OF THIS DOCUMENT and must be allowed.
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN", { checkerUserId: d.userId.checker });
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: TANGGAL_PROPOSAL_BAKU,
        keputusan: "SETUJU",
        jumlahDisetujui: DISETUJUI_BAKU,
      },
      d.ctx.adminCabang,
    );
    expect(p.status).toBe("DISETUJUI");
    expect((await d.bacaApproval(f.proposalId))[0].approver_user_id).toBe(d.userId.adminCabang);
  });
});

// ---------------------------------------------------------------------------
// Branch scope (spec 2 rule 3, scenario 24)
// ---------------------------------------------------------------------------

describe("scope cabang (spec 2 aturan 3, skenario 24)", () => {
  /** A complete cabang B proposal at `status`, owned entirely by cabang B users. */
  function proposalCabangB(
    status: Parameters<DuniaNonPumk["siapkanProposal"]>[0],
    opsi: Parameters<DuniaNonPumk["siapkanProposal"]>[1] = {},
  ): Promise<ProposalFixture> {
    return d.siapkanProposal(status, {
      ...opsi,
      cabangId: d.cabangLainId,
      makerUserId: d.userId.makerLain,
    });
  }

  test("Maker cabang A tidak bisa MEMBACA proposal cabang B, walau id-nya dia tebak benar", async () => {
    // Scenario 24, the "manipulasi ID di URL atau request API langsung" half:
    // the id is REAL and correct, and the only thing standing between the caller
    // and another branch's data is the server-side scope check.
    const b = await proposalCabangB("MENUNGGU_PERSETUJUAN");
    await tolakDengan(() => engine.timeline(b.proposalId, d.ctx.maker), KODE_NONPUMK.CABANG_DILUAR_SCOPE);
    await tolakDengan(() => engine.ringkasan(b.proposalId, d.ctx.maker), KODE_NONPUMK.CABANG_DILUAR_SCOPE);
  });

  test("Maker cabang A tidak bisa MENGUBAH proposal cabang B lewat id yang ditebak", async () => {
    const b = await proposalCabangB("DRAFT");
    await tolakDengan(
      () => engine.ajukanPenilaian(b.proposalId, null, d.ctx.maker),
      KODE_NONPUMK.CABANG_DILUAR_SCOPE,
    );
    expect((await d.bacaProposal(b.proposalId)).status).toBe("DRAFT");
    expect(await d.bacaTransisi(b.proposalId)).toHaveLength(0);
  });

  test("Approver cabang B tidak bisa menyetujui proposal cabang A", async () => {
    // The other direction, with a role that DOES hold the permission. Scope is
    // orthogonal to permission and both have to hold.
    const a = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    expect(d.ctx.approverLain.permissions).toContain(PERMISSION_NONPUMK.APPROVE);
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: a.proposalId,
            tanggal: TANGGAL_PROPOSAL_BAKU,
            keputusan: "SETUJU",
            jumlahDisetujui: DISETUJUI_BAKU,
          },
          d.ctx.approverLain,
        ),
      KODE_NONPUMK.CABANG_DILUAR_SCOPE,
    );
    expect(await d.bacaApproval(a.proposalId)).toHaveLength(0);
  });

  test("Maker tidak bisa MEMBUAT proposal atas nama cabang lain", async () => {
    // The write-side version of the same hole: the branch arrives in the
    // PAYLOAD, so a caller can simply type another branch's id into the form.
    await tolakDengan(
      () => engine.buatProposal(inputProposal(d.cabangLainId, d.bidang.id), d.ctx.maker),
      KODE_NONPUMK.CABANG_DILUAR_SCOPE,
    );
  });

  test("PENYALURAN dan LPJ cabang B tertutup untuk cabang A: di sinilah uangnya", async () => {
    // The scope check has to sit on EVERY entry point, not only the proposal
    // ones. These two move money, so a hole here is not a privacy problem, it is
    // an unauthorised disbursement from another branch's budget.
    const setuju = await proposalCabangB("DISETUJUI");
    await tolakDengan(
      () =>
        engine.catatPenyaluran(
          {
            proposalId: setuju.proposalId,
            tanggalPenyaluran: TANGGAL_PENYALURAN_BAKU,
            jumlah: rp(1_000_000),
            akunKasId: d.akun.kas.id,
            akunBebanId: setuju.akunBebanId,
          },
          d.ctx.maker,
        ),
      KODE_NONPUMK.CABANG_DILUAR_SCOPE,
    );
    expect(await d.bacaPenyaluran(setuju.proposalId)).toHaveLength(0);
    // The refusal happened BEFORE the ledger was touched, not after a rollback:
    // a posted-then-reversed journal in another branch's books is still two rows
    // an auditor has to ask about.
    expect(jurnal.panggilan).toHaveLength(0);

    const salur = await proposalCabangB("DISALURKAN", { terminPenyaluran: [rp(10_000_000)] });
    await tolakDengan(
      () => engine.tutupPenyaluran(salur.proposalId, null, d.ctx.maker),
      KODE_NONPUMK.CABANG_DILUAR_SCOPE,
    );

    const menunggu = await proposalCabangB("MENUNGGU_LPJ");
    await tolakDengan(
      () =>
        engine.ajukanLpj(
          {
            proposalId: menunggu.proposalId,
            tanggalLpj: TANGGAL_LPJ_BAKU,
            jumlahRealisasi: menunggu.totalDisalurkan,
            penerimaManfaatAktual: PENERIMA_AKTUAL_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_NONPUMK.CABANG_DILUAR_SCOPE,
    );
    expect(await d.bacaLpj(menunggu.proposalId)).toHaveLength(0);
    expect(jurnal.panggilan).toHaveLength(0);
  }, 90_000);

  test("daftarProposal dan monitoringLpj tidak melebar walau filter cabang diisi cabang lain", async () => {
    // The list endpoints are the other half of scenario 24: a scope check that
    // only guards the by-id path leaks the whole branch through the index page,
    // and a filter parameter is the easiest thing in the world to edit.
    const b = await proposalCabangB("MENUNGGU_LPJ");
    const a = await d.siapkanProposal("MENUNGGU_LPJ");

    const daftar = await engine.daftarProposal({ cabangId: d.cabangLainId }, d.ctx.maker);
    expect(daftar.map((p) => p.id)).not.toContain(b.proposalId);
    for (const p of daftar) expect(p.cabangId).toBe(d.cabangId);

    const monitoring = await engine.monitoringLpj({ cabangId: d.cabangLainId }, d.ctx.maker);
    expect(monitoring.map((m) => m.proposalId)).not.toContain(b.proposalId);
    for (const m of monitoring) expect(m.cabangId).toBe(d.cabangId);
    // And the maker's own branch is still visible, so this is scoping and not a
    // filter that silently returns nothing.
    expect(monitoring.map((m) => m.proposalId)).toContain(a.proposalId);
  }, 60_000);

  test("Admin Pusat menembus scope cabang, karena spec 2 aturan 3 mengecualikannya", async () => {
    const b = await proposalCabangB("MENUNGGU_PERSETUJUAN");
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: b.proposalId,
        tanggal: TANGGAL_PROPOSAL_BAKU,
        keputusan: "SETUJU",
        jumlahDisetujui: DISETUJUI_BAKU,
      },
      d.ctx.adminPusat,
    );
    expect(p.status).toBe("DISETUJUI");
    expect((await d.bacaApproval(b.proposalId))[0].approver_user_id).toBe(d.userId.adminPusat);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Fail closed on a permission the catalogue does not have
// ---------------------------------------------------------------------------

describe("izin verifikasi LPJ, dan penjaga gagal tertutup", () => {
  test("TEMUAN 1 (ditutup): verifikasi LPJ dipegang Checker, ditolak untuk Maker dan Approver", async () => {
    // THIS TEST USED TO ASSERT IZIN_BELUM_TERDAFTAR FOR EVERY ROLE, including
    // ADMIN_PUSAT, because spec 4.5 required an LPJ verification the shipped
    // catalogue had no code for. The distinguishing property of a MISSING
    // permission is exactly that Admin Pusat cannot do it either, since
    // ADMIN_PUSAT is a spread of PERMISSIONS and a code that is not in
    // PERMISSIONS is in nobody's list; that is what made the old assertion a
    // statement about configuration rather than about policy.
    //
    // It was filed rather than worked around, `nonpumk.lpj.verifikasi` was
    // added and granted to CHECKER, and the assertion now inverts to the
    // ordinary authorisation rule. The three reuses this suite argued against
    // are still wrong and still absent: `nonpumk.lpj` is the Maker's filing
    // code, `nonpumk.approve` is the decision to release the money, and
    // `nonpumk.review` is the proposal review.
    expect(canonicalPermission(PERMISSION_NONPUMK.LPJ_VERIFIKASI)).toBe(
      PERMISSION_NONPUMK.LPJ_VERIFIKASI,
    );

    // THE HOLDERS. Asserted through a real call, not just through the list: a
    // grant that reached the catalogue but not the grant matrix would still
    // leave the operation unreachable, which is the failure mode the finding
    // was about.
    for (const nama of ["checker", "adminCabang", "adminPusat"] as const) {
      expect(d.ctx[nama].permissions).toContain(PERMISSION_NONPUMK.LPJ_VERIFIKASI);
      const f = await d.siapkanProposal("LPJ_DIAJUKAN");
      const lpj = await engine.verifikasiLpj(
        { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: d.akun.kas.id },
        d.ctx[nama],
      );
      expect(lpj.status).toBe("DIVERIFIKASI");
      expect(lpj.verifiedBy).toBe(d.userId[nama]);
      expect((await d.bacaProposal(f.proposalId)).status).toBe("SELESAI");
    }

    // AND THE ONES WHO MUST NOT HOLD IT, which is the entire content of the
    // control. TIDAK_BERWENANG, not IZIN_BELUM_TERDAFTAR: this is now a
    // deliberate policy decision and the engine has to say so.
    for (const nama of ["maker", "approver", "auditor"] as const) {
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_NONPUMK.LPJ_VERIFIKASI);
      const f = await d.siapkanProposal("LPJ_DIAJUKAN");
      await tolakDengan(
        () =>
          engine.verifikasiLpj(
            { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: d.akun.kas.id },
            d.ctx[nama],
          ),
        KODE_NONPUMK.TIDAK_BERWENANG,
      );
      await tolakDengan(
        () =>
          engine.tolakLpj(
            { proposalId: f.proposalId, tanggal: TANGGAL_LPJ_BAKU, catatan: "Bukti kurang" },
            d.ctx[nama],
          ),
        KODE_NONPUMK.TIDAK_BERWENANG,
      );
      expect((await d.bacaLpj(f.proposalId))[0].status).toBe("DIAJUKAN");
      expect((await d.bacaLpj(f.proposalId))[0].verified_by).toBeNull();
    }
  }, 180_000);

  test("Maker yang MENGAJUKAN LPJ tidak bisa memverifikasinya, walau dokumennya miliknya", async () => {
    // The reason the code went to CHECKER rather than being folded into
    // `nonpumk.lpj`. Spec 2 rule 1's shape, applied to the accountability
    // report: filing and accepting are two decisions and must be two people.
    // Held at the ROLE level here, so unlike the proposal segregation rules
    // there is no ADMIN_CABANG case where one human could legitimately do both.
    const f = await d.siapkanProposal("LPJ_DIAJUKAN");
    expect(d.ctx.maker.permissions).toContain(PERMISSION_NONPUMK.LPJ);
    await tolakDengan(
      () =>
        engine.verifikasiLpj(
          { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: d.akun.kas.id },
          d.ctx.maker,
        ),
      KODE_NONPUMK.TIDAK_BERWENANG,
    );
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("setiap izin yang dijaga modul ini dipegang minimal satu role di database", async () => {
    // A TYPO in any of these is a permanent 403 that reads like a policy
    // decision, so the codes are checked against the grant matrix the database
    // actually holds, never against a literal in a fixture. LPJ_VERIFIKASI used
    // to need an exception here, and that exception WAS the finding; it no
    // longer does.
    const dipegang = new Set<string>();
    for (const nama of Object.keys(d.ctx) as Array<keyof DuniaNonPumk["ctx"]>) {
      for (const izin of d.ctx[nama].permissions) dipegang.add(izin);
    }
    for (const [nama, kode] of Object.entries(PERMISSION_NONPUMK)) {
      // If this fails, the engine is guarding a door with a key that exists in
      // no role: the operation is unreachable for every user in the system.
      expect(`${nama}:${dipegang.has(kode)}`).toBe(`${nama}:true`);
      // And each one is a code the catalogue can actually resolve, which is the
      // condition that decides IZIN_BELUM_TERDAFTAR vs TIDAK_BERWENANG.
      expect(String(canonicalPermission(kode))).toBe(kode);
    }
  });

  test("penjaga gagal tertutup membedakan kode yang tidak ada dari kode yang tidak dipegang", async () => {
    // Two refusals that look identical from the outside and mean completely
    // different things: one is "you may not", the other is "nobody may, and that
    // is a configuration fault". Collapsing them is how a missing permission
    // survives a whole phase looking like a deliberate rule, which is precisely
    // what happened to `nonpumk.lpj.verifikasi` until the pin above caught it.
    //
    // THE GUARD DID NOT GO AWAY WITH THE TEMUAN. With every PERMISSION_NONPUMK
    // code now registered, `IZIN_BELUM_TERDAFTAR` has no reachable input
    // through the module's public surface, so what is pinned here is the
    // CONDITION it branches on: an unregistered code resolves to null, a
    // registered one resolves to itself, and both refusal codes still exist.
    // The day an operation names a code the catalogue lacks, that pair is what
    // turns it into a refusal instead of a silent lockout.
    expect(canonicalPermission("nonpumk.belum-ada-di-katalog")).toBeNull();
    expect(canonicalPermission("nonpumk.lpj.verify")).toBeNull();
    expect(canonicalPermission(PERMISSION_NONPUMK.APPROVE)).toBe(PERMISSION_NONPUMK.APPROVE);
    expect(Object.values(KODE_NONPUMK)).toContain(KODE_NONPUMK.IZIN_BELUM_TERDAFTAR);
    expect(Object.values(KODE_NONPUMK)).toContain(KODE_NONPUMK.TIDAK_BERWENANG);
  });
});
