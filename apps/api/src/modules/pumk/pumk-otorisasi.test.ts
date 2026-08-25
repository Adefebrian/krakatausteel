// SPEC 2 (peran dan otorisasi) AND SCENARIO 24, at the SERVER layer.
//
// "Otorisasi divalidasi di layer server, bukan hanya di UI. Buat test yang
// memanggil endpoint langsung dengan role yang salah dan pastikan ditolak."
// There is no HTTP surface yet, so these call the ENGINE directly, which is
// the layer behind any future route: a guard that only exists in routes.ts
// would leave every other caller (a job, a tool, an import) unguarded.
//
// "Sistem harus menolak, bukan hanya menyembunyikan tombol." Every case here
// is a refusal, not an absent button.
//
// WHY THE PERMISSIONS COME OUT OF THE DATABASE.
// Every `d.ctx.*` list was resolved with `permissionsForRole`, which reads the
// SHIPPED grant matrix. A fixture that wrote `permissions: ["pumk.approve"]`
// by hand would prove only that the fixture agrees with itself; that is
// precisely how a permission the engine checks but no role can hold stays
// invisible (see the `jurnal.update` / `jurnal.delete` story in
// modules/jurnal/jurnal-gabungan.test.ts).
//
// WHY THE SEGREGATION CASES USE ADMIN_CABANG.
// Spec 2 rules 1 and 2 are per DOCUMENT, not per role: the conflict only
// exists for someone who could legitimately play both parts. ADMIN_CABANG is
// the only shipped role holding create AND review AND approve, so it is the
// only role that can express "the same human on both sides of the same
// proposal" without inventing a grant.
//
// AND WHY THE DOMAIN ERROR MATTERS MORE THAN THE REFUSAL.
// migrations/0008 already refuses both conflicts with
// trg_pumk_review_10_sod / trg_pumk_approval_10_sod. These tests are NOT
// asserting that Postgres works. They assert the module refuses FIRST, with a
// clean Indonesian message: `tolakDengan` fails the test if the string
// "TJSL-SOD-001" ever reaches the caller.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { canonicalPermission } from "../auth";
import { createPumkEngine, KODE_PUMK, PERMISSION_PUMK, type PumkEngine } from "./contract";
import {
  buatDunia,
  porterAngsuranUji,
  porterJurnalUji,
  rp,
  tolakDengan,
  MULAI_ANGSURAN_BAKU,
  POKOK_BAKU,
  TANGGAL_AKAD_BAKU,
  TANGGAL_PROPOSAL_BAKU,
  TENOR_BAKU,
  type DuniaPumk,
  type PorterAngsuranUji,
  type PorterJurnalUji,
  type ProposalFixture,
} from "./test-support";

let d: DuniaPumk;
let engine: PumkEngine;
let jurnal: PorterJurnalUji;
let angsuran: PorterAngsuranUji;

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  angsuran = porterAngsuranUji(d.db, jurnal, d.jam);
  engine = createPumkEngine({ db: d.db, angsuran, jurnal, jam: d.jam });
}, 60_000);

beforeEach(() => {
  jurnal.reset();
  angsuran.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

function inputProposal(cabangId: string, mitraId: string) {
  return {
    cabangId,
    mitraId,
    sektorId: d.sektorId,
    tanggalProposal: TANGGAL_PROPOSAL_BAKU,
    jumlahDiajukan: POKOK_BAKU,
    tenorDiajukan: TENOR_BAKU,
    tujuanPenggunaan: "Tambahan modal kerja",
  };
}

// ---------------------------------------------------------------------------
// The role matrix of spec 2
// ---------------------------------------------------------------------------

describe("matriks wewenang (spec 2)", () => {
  test("Maker tidak bisa menyetujui", async () => {
    // The Maker's row in spec 2's table has no "setujui atau tolak proposal".
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_PUMK.APPROVE);
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: f.proposalId,
            tanggal: TANGGAL_AKAD_BAKU,
            keputusan: "SETUJU",
            plafonDisetujui: POKOK_BAKU,
            tenorDisetujui: TENOR_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.TIDAK_BERWENANG,
    );
    // Refused means NOTHING happened: no approval row, no status move, no
    // timeline entry a later reader would mistake for a decision.
    expect(await d.bacaApproval(f.proposalId)).toHaveLength(0);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("MENUNGGU_PERSETUJUAN");
    expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
  });

  test("Maker tidak bisa mereview", async () => {
    const f = await d.siapkanProposal("REVIEW_CHECKER", { makerUserId: d.userId.makerDua });
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_PUMK.REVIEW);
    await tolakDengan(
      () =>
        engine.review(
          { proposalId: f.proposalId, tanggal: TANGGAL_PROPOSAL_BAKU, keputusan: "REKOMENDASI" },
          d.ctx.maker,
        ),
      KODE_PUMK.TIDAK_BERWENANG,
    );
    expect(await d.bacaReview(f.proposalId)).toHaveLength(0);
  });

  test("Checker tidak bisa input data baru: proposal, survey, akad, pencairan, angsuran", async () => {
    // Spec 2, Checker row, verbatim: "Tidak bisa input data baru."
    const mitra = await d.buatMitra();
    await tolakDengan(
      () => engine.buatProposal(inputProposal(d.cabangId, mitra.id), d.ctx.checker),
      KODE_PUMK.TIDAK_BERWENANG,
    );

    const survey = await d.siapkanProposal("SURVEY_PENDING");
    await tolakDengan(
      () =>
        engine.inputSurvey(
          {
            proposalId: survey.proposalId,
            tanggalSurvey: TANGGAL_PROPOSAL_BAKU,
            hasil: { karakter: 80 },
            skorTotal: "80.000000",
            plafonRekomendasi: POKOK_BAKU,
            tenorRekomendasi: TENOR_BAKU,
          },
          d.ctx.checker,
        ),
      KODE_PUMK.TIDAK_BERWENANG,
    );
    expect(await d.bacaSurvey(survey.proposalId)).toHaveLength(0);

    const disetujui = await d.siapkanProposal("DISETUJUI");
    await tolakDengan(
      () =>
        engine.buatAkad(
          {
            proposalId: disetujui.proposalId,
            tanggalAkad: TANGGAL_AKAD_BAKU,
            tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
          },
          d.ctx.checker,
        ),
      KODE_PUMK.TIDAK_BERWENANG,
    );
    expect(await d.bacaAkadByProposal(disetujui.proposalId)).toBeNull();

    const siap = await d.siapkanProposal("JADWAL_SIAP");
    await tolakDengan(
      () =>
        engine.catatPencairan(
          {
            akadId: siap.akadId as string,
            tanggalPencairan: TANGGAL_AKAD_BAKU,
            jumlah: siap.plafonDisetujui,
            akunKasId: d.akun.kas.id,
          },
          d.ctx.checker,
        ),
      KODE_PUMK.TIDAK_BERWENANG,
    );
    // Nothing was disbursed, so no journal was even attempted.
    expect(jurnal.panggilan).toHaveLength(0);
    expect(await d.bacaPencairan(siap.akadId as string)).toHaveLength(0);

    const cair = await d.siapkanProposal("DICAIRKAN");
    await tolakDengan(
      () =>
        engine.terimaAngsuran(
          {
            akadId: cair.akadId as string,
            tanggalTerima: MULAI_ANGSURAN_BAKU,
            jumlah: rp(1_030_000),
            akunKasId: d.akun.kas.id,
          },
          d.ctx.checker,
        ),
      KODE_PUMK.TIDAK_BERWENANG,
    );
    expect(angsuran.panggilan).toHaveLength(0);
  }, 60_000);

  test("Approver tidak bisa membuat proposal atau input survey", async () => {
    const mitra = await d.buatMitra();
    await tolakDengan(
      () => engine.buatProposal(inputProposal(d.cabangId, mitra.id), d.ctx.approver),
      KODE_PUMK.TIDAK_BERWENANG,
    );

    const f = await d.siapkanProposal("SURVEY_PENDING");
    await tolakDengan(
      () =>
        engine.inputSurvey(
          {
            proposalId: f.proposalId,
            tanggalSurvey: TANGGAL_PROPOSAL_BAKU,
            hasil: { karakter: 80 },
            skorTotal: "80.000000",
            plafonRekomendasi: POKOK_BAKU,
            tenorRekomendasi: TENOR_BAKU,
          },
          d.ctx.approver,
        ),
      KODE_PUMK.TIDAK_BERWENANG,
    );
  });

  test("hapus buku butuh pumk.hapusbuku: Maker ditolak, Approver yang memegangnya", async () => {
    // Writing a receivable off the balance sheet is the single most consequential
    // act in this module, and spec 2 puts it with the Approver.
    const f = await d.siapkanProposal("DICAIRKAN");
    expect(d.ctx.maker.permissions).not.toContain(PERMISSION_PUMK.HAPUSBUKU);
    expect(d.ctx.approver.permissions).toContain(PERMISSION_PUMK.HAPUSBUKU);
    await tolakDengan(
      () =>
        engine.catatPengakhiran(
          {
            akadId: f.akadId as string,
            jenis: "HAPUS_BUKU",
            tanggal: "2026-06-10",
            dasarKeputusan: "Macet lebih dari 12 bulan",
            noSk: "SK-UJI-001",
          },
          d.ctx.maker,
        ),
      KODE_PUMK.TIDAK_BERWENANG,
    );
    expect(await d.bacaPengakhiran(f.akadId as string)).toHaveLength(0);
    expect(jurnal.panggilan).toHaveLength(0);
    // The akad is untouched and still an active receivable.
    expect((await d.bacaAkad(f.akadId as string)).status).toBe("AKTIF");
  });
});

// ---------------------------------------------------------------------------
// Auditor (spec 2 and scenario 23)
// ---------------------------------------------------------------------------

describe("Auditor tidak mengubah apa pun (spec 2, skenario 23)", () => {
  test("setiap operasi yang mengubah data ditolak untuk Auditor", async () => {
    const mitra = await d.buatMitra();
    const draft = await d.siapkanProposal("DRAFT");
    const review = await d.siapkanProposal("REVIEW_CHECKER");
    const menunggu = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const disetujui = await d.siapkanProposal("DISETUJUI");
    const akadDibuat = await d.siapkanProposal("AKAD_DIBUAT");
    const siap = await d.siapkanProposal("JADWAL_SIAP");
    const cair = await d.siapkanProposal("DICAIRKAN");
    const submission = await d.buatSubmissionPortal();

    // Every mutating method on the engine's surface, in one list, so a method
    // added later without a guard is a visibly missing line here.
    const mutasi: Array<[string, () => Promise<unknown>]> = [
      ["buatProposal", () => engine.buatProposal(inputProposal(d.cabangId, mitra.id), d.ctx.auditor)],
      [
        "tambahJaminan",
        () => engine.tambahJaminan(draft.proposalId, { jenis: "BPKB", nilaiTaksasi: rp(20_000_000) }, d.ctx.auditor),
      ],
      ["submitUntukSurvey", () => engine.submitUntukSurvey(draft.proposalId, null, d.ctx.auditor)],
      [
        "inputSurvey",
        () =>
          engine.inputSurvey(
            {
              proposalId: draft.proposalId,
              tanggalSurvey: TANGGAL_PROPOSAL_BAKU,
              hasil: {},
              skorTotal: "80.000000",
              plafonRekomendasi: POKOK_BAKU,
              tenorRekomendasi: TENOR_BAKU,
            },
            d.ctx.auditor,
          ),
      ],
      ["ajukanKeChecker", () => engine.ajukanKeChecker(draft.proposalId, null, d.ctx.auditor)],
      [
        "review",
        () =>
          engine.review(
            { proposalId: review.proposalId, tanggal: TANGGAL_PROPOSAL_BAKU, keputusan: "REKOMENDASI" },
            d.ctx.auditor,
          ),
      ],
      [
        "putuskanPersetujuan",
        () =>
          engine.putuskanPersetujuan(
            {
              proposalId: menunggu.proposalId,
              tanggal: TANGGAL_AKAD_BAKU,
              keputusan: "SETUJU",
              plafonDisetujui: POKOK_BAKU,
              tenorDisetujui: TENOR_BAKU,
            },
            d.ctx.auditor,
          ),
      ],
      [
        "buatAkad",
        () =>
          engine.buatAkad(
            {
              proposalId: disetujui.proposalId,
              tanggalAkad: TANGGAL_AKAD_BAKU,
              tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
            },
            d.ctx.auditor,
          ),
      ],
      ["generateJadwal", () => engine.generateJadwal(akadDibuat.akadId as string, d.ctx.auditor)],
      [
        "catatPencairan",
        () =>
          engine.catatPencairan(
            {
              akadId: siap.akadId as string,
              tanggalPencairan: TANGGAL_AKAD_BAKU,
              jumlah: siap.plafonDisetujui,
              akunKasId: d.akun.kas.id,
            },
            d.ctx.auditor,
          ),
      ],
      [
        "terimaAngsuran",
        () =>
          engine.terimaAngsuran(
            {
              akadId: cair.akadId as string,
              tanggalTerima: MULAI_ANGSURAN_BAKU,
              jumlah: rp(1_030_000),
              akunKasId: d.akun.kas.id,
            },
            d.ctx.auditor,
          ),
      ],
      [
        "ajukanReschedule",
        () =>
          engine.ajukanReschedule(
            {
              akadId: cair.akadId as string,
              tanggalPengajuan: "2026-06-20",
              alasan: "Usaha menurun",
              jenis: "PERPANJANG_TENOR",
              tenorBaru: 18,
            },
            d.ctx.auditor,
          ),
      ],
      [
        "catatPengakhiran",
        () =>
          engine.catatPengakhiran(
            {
              akadId: cair.akadId as string,
              jenis: "HAPUS_BUKU",
              tanggal: "2026-06-10",
              dasarKeputusan: "Macet",
            },
            d.ctx.auditor,
          ),
      ],
      [
        "catatTindakLanjut",
        () =>
          engine.catatTindakLanjut(
            { akadId: cair.akadId as string, tanggal: "2026-06-10", jenis: "KUNJUNGAN" },
            d.ctx.auditor,
          ),
      ],
      [
        "konversiSubmissionPortal",
        () =>
          engine.konversiSubmissionPortal(
            {
              submissionId: submission.id,
              cabangId: d.cabangId,
              mitraId: mitra.id,
              tanggalProposal: TANGGAL_PROPOSAL_BAKU,
            },
            d.ctx.auditor,
          ),
      ],
    ];

    // Every method must appear here. If the engine grows one and this list does
    // not, the missing line is the finding.
    expect(mutasi.map(([nama]) => nama).sort()).toEqual(
      [
        "ajukanReschedule",
        "ajukanKeChecker",
        "buatAkad",
        "buatProposal",
        "catatPencairan",
        "catatPengakhiran",
        "catatTindakLanjut",
        "generateJadwal",
        "inputSurvey",
        "konversiSubmissionPortal",
        "putuskanPersetujuan",
        "review",
        "submitUntukSurvey",
        "tambahJaminan",
        "terimaAngsuran",
      ].sort(),
    );

    for (const [nama, panggil] of mutasi) {
      // The name is folded into the assertion so a failure says WHICH method
      // let the auditor through, instead of "expected PumkError" fifteen times.
      const err = await tolakDengan(panggil, KODE_PUMK.TIDAK_BERWENANG);
      expect(`${nama}: ${err.kode}`).toBe(`${nama}: ${KODE_PUMK.TIDAK_BERWENANG}`);
    }

    // And the world is exactly as it was.
    expect(await d.bacaTransisi(draft.proposalId)).toHaveLength(0);
    expect(await d.bacaPencairan(siap.akadId as string)).toHaveLength(0);
    expect(await d.bacaPengakhiran(cair.akadId as string)).toHaveLength(0);
    expect(await d.bacaTindakLanjut(cair.akadId as string)).toHaveLength(0);
    expect((await d.bacaSubmission(submission.id)).status).toBe("BARU");
    expect(jurnal.panggilan).toHaveLength(0);
    expect(angsuran.panggilan).toHaveLength(0);
  }, 90_000);

  test("Auditor tetap bisa membaca: kartu piutang, timeline, daftar proposal, di semua cabang", async () => {
    // "Read only PENUH." A read-only role that cannot read is not a working
    // control, it is a broken one, so the positive half is asserted too.
    const f = await d.siapkanProposal("DICAIRKAN");
    const kartu = await engine.kartuPiutang(f.akadId as string, d.ctx.auditor);
    expect(kartu.akad.id).toBe(f.akadId as string);
    expect(kartu.selisihRekonsiliasi).toBe("0.00");

    const lain = await d.siapkanProposal("DRAFT", {
      cabangId: d.cabangLainId,
      makerUserId: d.userId.makerLain,
    });
    // Spec 2 rule 3 exempts Auditor and Admin Pusat from branch scope.
    const daftar = await engine.daftarProposal({}, d.ctx.auditor);
    const ids = daftar.map((p) => p.id);
    expect(ids).toContain(f.proposalId);
    expect(ids).toContain(lain.proposalId);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Segregation of duties (spec 2 rules 1 and 2)
// ---------------------------------------------------------------------------

describe("pemisahan tugas (spec 2 aturan 1 dan 2)", () => {
  test("maker proposal tidak boleh menjadi checker-nya sendiri", async () => {
    const f = await d.siapkanProposal("REVIEW_CHECKER", { makerUserId: d.userId.adminCabang });
    // The role is not the problem: this user legitimately holds pumk.review.
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_PUMK.REVIEW);

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
      KODE_PUMK.KONFLIK_MAKER_CHECKER,
    );
    // The module refused AHEAD of trg_pumk_review_10_sod, so the raw trigger
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
    expect(d.ctx.adminCabang.permissions).toContain(PERMISSION_PUMK.APPROVE);

    const err = await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: f.proposalId,
            tanggal: TANGGAL_AKAD_BAKU,
            keputusan: "SETUJU",
            plafonDisetujui: POKOK_BAKU,
            tenorDisetujui: TENOR_BAKU,
          },
          d.ctx.adminCabang,
        ),
      KODE_PUMK.KONFLIK_CHECKER_APPROVER,
    );
    expect(err.message).not.toContain("TJSL-SOD-002");
    expect(await d.bacaApproval(f.proposalId)).toHaveLength(0);
  });

  test("maker yang BUKAN checker tetap boleh, jadi aturan ini per dokumen bukan per role", async () => {
    // The mirror case. Without it, an engine that simply refused every
    // ADMIN_CABANG review would pass the two tests above and be wrong.
    const f = await d.siapkanProposal("REVIEW_CHECKER", { makerUserId: d.userId.maker });
    const p = await engine.review(
      {
        proposalId: f.proposalId,
        tanggal: TANGGAL_PROPOSAL_BAKU,
        keputusan: "REKOMENDASI",
        catatan: null,
      },
      d.ctx.adminCabang,
    );
    expect(p.status).toBe("MENUNGGU_PERSETUJUAN");
    expect((await d.bacaReview(f.proposalId))[0].reviewer_user_id).toBe(d.userId.adminCabang);
  });
});

// ---------------------------------------------------------------------------
// Branch scope (spec 2 rule 3, scenario 24)
// ---------------------------------------------------------------------------

describe("scope cabang (spec 2 aturan 3, skenario 24)", () => {
  /** A complete cabang B proposal at `status`, owned entirely by cabang B users. */
  function proposalCabangB(status: Parameters<DuniaPumk["siapkanProposal"]>[0]): Promise<ProposalFixture> {
    return d.siapkanProposal(status, {
      cabangId: d.cabangLainId,
      makerUserId: d.userId.makerLain,
    });
  }

  test("Maker cabang A tidak bisa MEMBACA proposal cabang B, walau id-nya dia tebak benar", async () => {
    // Scenario 24, the "manipulasi ID di URL atau request API langsung" half:
    // the id is REAL and correct, and the only thing standing between the
    // caller and another branch's data is the server-side scope check.
    const b = await proposalCabangB("MENUNGGU_PERSETUJUAN");
    await tolakDengan(() => engine.timeline(b.proposalId, d.ctx.maker), KODE_PUMK.CABANG_DILUAR_SCOPE);
  });

  test("Maker cabang A tidak bisa MENGUBAH proposal cabang B lewat id yang ditebak", async () => {
    const b = await proposalCabangB("DRAFT");
    await tolakDengan(
      () => engine.submitUntukSurvey(b.proposalId, null, d.ctx.maker),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
    expect((await d.bacaProposal(b.proposalId)).status).toBe("DRAFT");
    expect(await d.bacaTransisi(b.proposalId)).toHaveLength(0);
  });

  test("Approver cabang B tidak bisa menyetujui proposal cabang A", async () => {
    // The other direction, with a role that DOES hold the permission. Scope is
    // orthogonal to permission and both have to hold.
    const a = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    expect(d.ctx.approverLain.permissions).toContain(PERMISSION_PUMK.APPROVE);
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: a.proposalId,
            tanggal: TANGGAL_AKAD_BAKU,
            keputusan: "SETUJU",
            plafonDisetujui: POKOK_BAKU,
            tenorDisetujui: TENOR_BAKU,
          },
          d.ctx.approverLain,
        ),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
    expect(await d.bacaApproval(a.proposalId)).toHaveLength(0);
  });

  test("Maker tidak bisa MEMBUAT proposal atas nama cabang lain", async () => {
    // The write-side version of the same hole: the branch arrives in the
    // PAYLOAD, so a caller can simply type another branch's id into the form.
    const mitraB = await d.buatMitra({ cabangId: d.cabangLainId });
    await tolakDengan(
      () => engine.buatProposal(inputProposal(d.cabangLainId, mitraB.id), d.ctx.maker),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
  });

  test("akad, jadwal, pencairan, angsuran dan kartu piutang cabang B semuanya tertutup untuk cabang A", async () => {
    // The scope check has to sit on EVERY entry point, not only the proposal
    // ones: an akad id is just as guessable as a proposal id, and the akad
    // path is where the money is.
    const b = await proposalCabangB("DICAIRKAN");
    const akadId = b.akadId as string;

    await tolakDengan(() => engine.generateJadwal(akadId, d.ctx.maker), KODE_PUMK.CABANG_DILUAR_SCOPE);
    await tolakDengan(
      () =>
        engine.catatPencairan(
          {
            akadId,
            tanggalPencairan: TANGGAL_AKAD_BAKU,
            jumlah: b.plafonDisetujui,
            akunKasId: d.akun.kas.id,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
    await tolakDengan(
      () =>
        engine.terimaAngsuran(
          {
            akadId,
            tanggalTerima: MULAI_ANGSURAN_BAKU,
            jumlah: rp(1_030_000),
            akunKasId: d.akun.kas.id,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
    await tolakDengan(() => engine.kartuPiutang(akadId, d.ctx.maker), KODE_PUMK.CABANG_DILUAR_SCOPE);
    await tolakDengan(
      () => engine.daftarTindakLanjut(akadId, d.ctx.maker),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );

    expect(jurnal.panggilan).toHaveLength(0);
    expect(angsuran.panggilan).toHaveLength(0);
  }, 30_000);

  test("daftarProposal tidak melebar walau filter cabang diisi cabang lain", async () => {
    // The filter is a NARROWING device, never a widening one. Passing another
    // branch's id must not become a back door around the scope check.
    const a = await d.siapkanProposal("DRAFT");
    const b = await proposalCabangB("DRAFT");

    const semua = await engine.daftarProposal({}, d.ctx.maker);
    expect(semua.map((p) => p.id)).toContain(a.proposalId);
    expect(semua.map((p) => p.id)).not.toContain(b.proposalId);

    const dipaksa = await engine.daftarProposal({ cabangId: d.cabangLainId }, d.ctx.maker);
    expect(dipaksa.map((p) => p.id)).not.toContain(b.proposalId);
    for (const p of dipaksa) expect(p.cabangId).toBe(d.cabangId);
  }, 30_000);

  test("Admin Pusat menembus scope cabang, karena spec 2 aturan 3 mengecualikannya", async () => {
    const b = await proposalCabangB("MENUNGGU_PERSETUJUAN");
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: b.proposalId,
        tanggal: TANGGAL_AKAD_BAKU,
        keputusan: "SETUJU",
        plafonDisetujui: POKOK_BAKU,
        tenorDisetujui: TENOR_BAKU,
      },
      d.ctx.adminPusat,
    );
    expect(p.status).toBe("DISETUJUI");
    expect(p.cabangId).toBe(d.cabangLainId);
  });
});

// ---------------------------------------------------------------------------
// Fail closed on a permission the catalogue does not have
// ---------------------------------------------------------------------------

describe("izin cluster, dan penjaga gagal tertutup yang masih hidup", () => {
  test("operasi cluster butuh pumk.cluster: Admin Cabang boleh, Maker dan Checker ditolak", async () => {
    // THIS TEST USED TO ASSERT IZIN_BELUM_TERDAFTAR FOR EVERYONE, including
    // ADMIN_PUSAT, because spec 9.1 required a cluster page that the shipped
    // catalogue had no code for. That was filed as a standing demand rather
    // than worked around, the catalogue owner added `pumk.cluster`, and the
    // assertion now inverts to the ordinary authorisation rule.
    //
    // The two reuses this suite argued against are still wrong and still
    // absent: `pumk.create` would let any Maker restructure the groups whose
    // kolektibilitas is reported per cluster, `konfigurasi.master` would put an
    // operational screen behind Admin Pusat. The code went to ADMIN_CABANG,
    // roster administration being branch operational work, and ADMIN_PUSAT
    // inherits it.
    const klaster = await d.buatCluster();
    const boleh = await d.buatMitra();
    const anggota = await engine.tambahAnggotaCluster(
      { clusterId: klaster.id, mitraId: boleh.id, tanggalMasuk: "2026-01-05" },
      d.ctx.adminCabang,
    );
    expect(anggota.mitraId).toBe(boleh.id);

    // Everyone else is refused as a POLICY decision (TIDAK_BERWENANG), which is
    // a different statement from "this permission does not exist".
    const ditolak = await d.buatMitra();
    for (const nama of ["maker", "checker", "approver", "auditor"] as const) {
      expect(d.ctx[nama].permissions).not.toContain(PERMISSION_PUMK.CLUSTER);
      await tolakDengan(
        () =>
          engine.tambahAnggotaCluster(
            { clusterId: klaster.id, mitraId: ditolak.id, tanggalMasuk: "2026-01-05" },
            d.ctx[nama],
          ),
        KODE_PUMK.TIDAK_BERWENANG,
      );
    }
    // Only the authorised call wrote anything.
    const roster = await d.bacaAnggotaCluster(klaster.id);
    expect(roster.map((a) => a.mitra_id)).toEqual([boleh.id]);
  }, 30_000);

  test("setiap izin yang dijaga modul ini dipegang minimal satu role di database", async () => {
    // A TYPO in any of these is a permanent 403 that reads like a policy
    // decision, so the codes are checked against the grant matrix the database
    // actually holds, never against a literal in a fixture. `pumk.cluster` no
    // longer needs its exception.
    const dipegang = new Set<string>();
    for (const nama of Object.keys(d.ctx) as Array<keyof DuniaPumk["ctx"]>) {
      for (const izin of d.ctx[nama].permissions) dipegang.add(izin);
    }
    for (const [nama, kode] of Object.entries(PERMISSION_PUMK)) {
      // If this fails, the engine is guarding a door with a key that exists in
      // no role: the operation is unreachable for every user in the system.
      expect(`${nama}:${dipegang.has(kode)}`).toBe(`${nama}:true`);
      // And each one is a code the catalogue can actually resolve, which is the
      // condition that decides IZIN_BELUM_TERDAFTAR vs TIDAK_BERWENANG.
      expect(canonicalPermission(kode)).toBe(kode);
    }
  });

  test("penjaga gagal tertutup masih hidup: kode di luar katalog tidak bisa diresolusi", async () => {
    // THE GUARD DID NOT GO AWAY WITH THE TEMUAN. `IZIN_BELUM_TERDAFTAR` exists
    // so that an operation naming a code the catalogue does not know FAILS
    // CLOSED, instead of falling through to a permission check nobody can
    // satisfy and surfacing as TIDAK_BERWENANG, i.e. as a deliberate policy
    // decision rather than the configuration fault it is.
    //
    // With every PERMISSION_PUMK code now registered, the guard has no
    // reachable input through the module's public surface, so what is pinned
    // here is the CONDITION it branches on: an unregistered code resolves to
    // null, and the sanctioned refusal code still exists. The day an operation
    // names a code the catalogue lacks, that pair is what turns it into a
    // refusal instead of a silent lockout.
    expect(canonicalPermission("pumk.belum-ada-di-katalog")).toBeNull();
    expect(canonicalPermission("pumk.cluster.manage")).toBeNull();
    expect(Object.values(KODE_PUMK)).toContain(KODE_PUMK.IZIN_BELUM_TERDAFTAR);
  });
});
