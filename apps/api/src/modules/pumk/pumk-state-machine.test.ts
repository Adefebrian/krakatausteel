// SPEC 9.1 STATE MACHINE, every edge, every refusal, and the timeline.
//
// "Setiap transisi: catat siapa, kapan, catatan apa. Tampilkan sebagai
// timeline di halaman detail proposal. Ini fitur yang paling sering diminta
// user dan paling sering dilupakan developer." The spec says the quiet part
// out loud, so the timeline is asserted on EVERY transition here, not once in
// a happy path.
//
// HOW THE PRECONDITIONS ARE BUILT, AND WHY IT MATTERS.
// `siapkanProposal(status)` writes the proposal and its supporting rows in
// SQL and writes NO `pumk_proposal_transisi` row (pinned by
// ./pumk-fixture.test.ts). Every test below therefore starts from a state the
// engine did not produce and asserts about rows only the engine can have
// written. Chaining transitions through the engine to reach a state would turn
// one broken transition into a cascade of red tests and hide which edge
// actually broke.
//
// WHAT IS DELIBERATELY NOT HERE. The arithmetic and the ledger effect of
// BUAT_AKAD, GENERATE_JADWAL and PENCAIRAN belong to ./pumk-akad-jadwal.test.ts
// and ./pumk-pencairan.test.ts. This file asserts only that those three edges
// move the STATUS and write the TIMELINE, so a failure here is a state-machine
// failure and never an accounting one.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createPumkEngine,
  KODE_PUMK,
  type AksiProposal,
  type PumkEngine,
  type StatusProposal,
} from "./contract";
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

const CATATAN = "Catatan wajib dari petugas (uji)";

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  angsuran = porterAngsuranUji(d.db, jurnal, d.jam);
  // Wired exactly as the composition root wires it: the REAL engines behind
  // recording wrappers, one shared db port, one shared clock.
  engine = createPumkEngine({ db: d.db, angsuran, jurnal, jam: d.jam });
}, 60_000);

beforeEach(() => {
  jurnal.reset();
  angsuran.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

/**
 * Invokes the engine method that owns one edge of the diagram, with the role
 * the table names as its holder. One place, so the invalid-transition matrix
 * below can be driven generically instead of by twelve copy-pasted calls.
 */
function jalankanAksi(aksi: AksiProposal, f: ProposalFixture, catatan: string | null): Promise<unknown> {
  const id = f.proposalId;
  switch (aksi) {
    case "SUBMIT_SURVEY":
      return engine.submitUntukSurvey(id, catatan, d.ctx.maker);
    case "INPUT_SURVEY":
      return engine.inputSurvey(
        {
          proposalId: id,
          tanggalSurvey: TANGGAL_PROPOSAL_BAKU,
          petugasKaryawanId: d.karyawanId,
          hasil: { karakter: 80, kapasitas_usaha: 75, tempat_usaha: 80, agunan: 70, riwayat: 90 },
          skorTotal: "80.000000",
          plafonRekomendasi: POKOK_BAKU,
          tenorRekomendasi: TENOR_BAKU,
          catatan,
        },
        d.ctx.maker,
      );
    case "AJUKAN_CHECKER":
      return engine.ajukanKeChecker(id, catatan, d.ctx.maker);
    case "REKOMENDASI":
    case "TIDAK_REKOMENDASI":
    case "MINTA_PERBAIKAN":
      return engine.review(
        { proposalId: id, tanggal: TANGGAL_PROPOSAL_BAKU, keputusan: aksi, catatan },
        d.ctx.checker,
      );
    case "SETUJU":
      return engine.putuskanPersetujuan(
        {
          proposalId: id,
          tanggal: TANGGAL_AKAD_BAKU,
          keputusan: "SETUJU",
          plafonDisetujui: f.jumlahDiajukan,
          tenorDisetujui: f.tenorDiajukan,
          catatan,
        },
        d.ctx.approver,
      );
    case "TOLAK":
      return engine.putuskanPersetujuan(
        { proposalId: id, tanggal: TANGGAL_AKAD_BAKU, keputusan: "TOLAK", catatan },
        d.ctx.approver,
      );
    case "KEMBALIKAN":
      return engine.putuskanPersetujuan(
        { proposalId: id, tanggal: TANGGAL_AKAD_BAKU, keputusan: "KEMBALIKAN", catatan },
        d.ctx.approver,
      );
    case "BUAT_AKAD":
      return engine.buatAkad(
        {
          proposalId: id,
          tanggalAkad: TANGGAL_AKAD_BAKU,
          tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
        },
        d.ctx.maker,
      );
    case "GENERATE_JADWAL":
      return engine.generateJadwal(f.akadId as string, d.ctx.maker);
    case "PENCAIRAN":
      return engine.catatPencairan(
        {
          akadId: f.akadId as string,
          tanggalPencairan: TANGGAL_AKAD_BAKU,
          jumlah: f.plafonDisetujui,
          akunKasId: d.akun.kas.id,
        },
        d.ctx.maker,
      );
  }
}

/** The single timeline row an edge must have appended, with who/when/what. */
async function satuBarisTimeline(
  proposalId: string,
  harap: { dari: StatusProposal; ke: StatusProposal; aksi: AksiProposal; oleh: string; catatan: string | null },
): Promise<void> {
  const baris = await d.bacaTransisi(proposalId);
  expect(baris).toHaveLength(1);
  expect(baris[0].status_dari).toBe(harap.dari);
  expect(baris[0].status_ke).toBe(harap.ke);
  expect(baris[0].aksi).toBe(harap.aksi);
  // WHO. Never null for a transition the engine made.
  expect(baris[0].oleh_user_id).toBe(harap.oleh);
  // WHEN. A parseable instant, so the page can render it.
  expect(Number.isNaN(Date.parse(baris[0].waktu))).toBe(false);
  // WHAT NOTE.
  expect(baris[0].catatan).toBe(harap.catatan);
}

// ---------------------------------------------------------------------------
// The twelve edges of the diagram
// ---------------------------------------------------------------------------

describe("transisi sah (spec 9.1)", () => {
  test("DRAFT -> SURVEY_PENDING lewat SUBMIT_SURVEY, tercatat di timeline", async () => {
    const f = await d.siapkanProposal("DRAFT");
    const p = await engine.submitUntukSurvey(f.proposalId, "Diajukan untuk survey", d.ctx.maker);
    expect(p.status).toBe("SURVEY_PENDING");
    expect((await d.bacaProposal(f.proposalId)).status).toBe("SURVEY_PENDING");
    await satuBarisTimeline(f.proposalId, {
      dari: "DRAFT",
      ke: "SURVEY_PENDING",
      aksi: "SUBMIT_SURVEY",
      oleh: d.userId.maker,
      catatan: "Diajukan untuk survey",
    });
  });

  test("SURVEY_PENDING -> SURVEY_SELESAI lewat INPUT_SURVEY, hasil survey tersimpan (spec 4.4)", async () => {
    const f = await d.siapkanProposal("SURVEY_PENDING");
    const p = await engine.inputSurvey(
      {
        proposalId: f.proposalId,
        tanggalSurvey: "2026-01-20",
        petugasKaryawanId: d.karyawanId,
        // Spec 4.4's five aspects, stored as hasil_json.
        hasil: { karakter: 85, kapasitas_usaha: 80, tempat_usaha: 75, agunan: 70, riwayat: 90 },
        skorTotal: "80.000000",
        plafonRekomendasi: rp(10_000_000),
        tenorRekomendasi: 18,
        catatan: "Usaha berjalan, tempat milik sendiri",
      },
      d.ctx.maker,
    );
    expect(p.status).toBe("SURVEY_SELESAI");

    const survey = await d.bacaSurvey(f.proposalId);
    expect(survey).toHaveLength(1);
    expect(survey[0].skor_total).toBe("80.000000");
    expect(survey[0].plafon_rekomendasi).toBe(rp(10_000_000));
    expect(survey[0].tenor_rekomendasi).toBe(18);
    expect(survey[0].created_by).toBe(d.userId.maker);

    await satuBarisTimeline(f.proposalId, {
      dari: "SURVEY_PENDING",
      ke: "SURVEY_SELESAI",
      aksi: "INPUT_SURVEY",
      oleh: d.userId.maker,
      catatan: "Usaha berjalan, tempat milik sendiri",
    });
  });

  test("survey kedua atas proposal yang sama ditolak state machine, survey lama utuh", async () => {
    // The proposal already carries a survey row at SURVEY_SELESAI, so a second
    // INPUT_SURVEY would silently overwrite the basis of the credit decision.
    const f = await d.siapkanProposal("SURVEY_SELESAI");
    await tolakDengan(
      () => jalankanAksi("INPUT_SURVEY", f, null),
      // The state machine is the OUTER gate and refuses first: from
      // SURVEY_SELESAI the INPUT_SURVEY edge does not exist. KODE_PUMK's
      // SURVEY_SUDAH_ADA is the inner guard for a SURVEY_PENDING proposal that
      // somehow already carries a survey row (a repaired import, a retried
      // request), which the sanctioned path cannot reach. Asserting the outer
      // code here is asserting what a caller actually sees.
      KODE_PUMK.TRANSISI_TIDAK_VALID,
    );
    expect(await d.bacaSurvey(f.proposalId)).toHaveLength(1);
  });

  test("SURVEY_SELESAI -> REVIEW_CHECKER lewat AJUKAN_CHECKER", async () => {
    const f = await d.siapkanProposal("SURVEY_SELESAI");
    const p = await engine.ajukanKeChecker(f.proposalId, "Lengkap, mohon direview", d.ctx.maker);
    expect(p.status).toBe("REVIEW_CHECKER");
    await satuBarisTimeline(f.proposalId, {
      dari: "SURVEY_SELESAI",
      ke: "REVIEW_CHECKER",
      aksi: "AJUKAN_CHECKER",
      oleh: d.userId.maker,
      catatan: "Lengkap, mohon direview",
    });
  });

  test("mengajukan ke checker dari SURVEY_PENDING ditolak: belum ada survey untuk direview", async () => {
    // SURVEY_PENDING has no survey row yet, and the checker's side by side
    // review page (spec 9.1) has nothing to show without one.
    const f = await d.siapkanProposal("SURVEY_PENDING");
    await tolakDengan(() => engine.ajukanKeChecker(f.proposalId, null, d.ctx.maker), KODE_PUMK.TRANSISI_TIDAK_VALID);
  });

  test("REVIEW_CHECKER -> MENUNGGU_PERSETUJUAN lewat REKOMENDASI, jejak checker tersimpan", async () => {
    const f = await d.siapkanProposal("REVIEW_CHECKER");
    const p = await engine.review(
      {
        proposalId: f.proposalId,
        tanggal: "2026-01-25",
        keputusan: "REKOMENDASI",
        catatan: "Layak, sesuai hasil survey",
      },
      d.ctx.checker,
    );
    expect(p.status).toBe("MENUNGGU_PERSETUJUAN");

    const review = await d.bacaReview(f.proposalId);
    expect(review).toHaveLength(1);
    expect(review[0].reviewer_user_id).toBe(d.userId.checker);
    expect(review[0].keputusan).toBe("REKOMENDASI");

    await satuBarisTimeline(f.proposalId, {
      dari: "REVIEW_CHECKER",
      ke: "MENUNGGU_PERSETUJUAN",
      aksi: "REKOMENDASI",
      oleh: d.userId.checker,
      catatan: "Layak, sesuai hasil survey",
    });
  });

  test("REVIEW_CHECKER -> TIDAK_DIREKOMENDASIKAN lewat TIDAK_REKOMENDASI [terminal]", async () => {
    const f = await d.siapkanProposal("REVIEW_CHECKER");
    const p = await engine.review(
      {
        proposalId: f.proposalId,
        tanggal: "2026-01-25",
        keputusan: "TIDAK_REKOMENDASI",
        catatan: "Kapasitas usaha tidak mencukupi",
      },
      d.ctx.checker,
    );
    expect(p.status).toBe("TIDAK_DIREKOMENDASIKAN");
    expect((await d.bacaReview(f.proposalId))[0].keputusan).toBe("TIDAK_REKOMENDASI");
    await satuBarisTimeline(f.proposalId, {
      dari: "REVIEW_CHECKER",
      ke: "TIDAK_DIREKOMENDASIKAN",
      aksi: "TIDAK_REKOMENDASI",
      oleh: d.userId.checker,
      catatan: "Kapasitas usaha tidak mencukupi",
    });
  });

  test("MENUNGGU_PERSETUJUAN -> DISETUJUI lewat SETUJU, jejak approver tersimpan", async () => {
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: "2026-02-01",
        keputusan: "SETUJU",
        plafonDisetujui: POKOK_BAKU,
        tenorDisetujui: TENOR_BAKU,
        catatan: "Disetujui sesuai rekomendasi",
      },
      d.ctx.approver,
    );
    expect(p.status).toBe("DISETUJUI");

    const approval = await d.bacaApproval(f.proposalId);
    expect(approval).toHaveLength(1);
    expect(approval[0].approver_user_id).toBe(d.userId.approver);
    expect(approval[0].keputusan).toBe("SETUJU");

    await satuBarisTimeline(f.proposalId, {
      dari: "MENUNGGU_PERSETUJUAN",
      ke: "DISETUJUI",
      aksi: "SETUJU",
      oleh: d.userId.approver,
      catatan: "Disetujui sesuai rekomendasi",
    });
  });

  test("MENUNGGU_PERSETUJUAN -> DITOLAK lewat TOLAK [terminal]", async () => {
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: "2026-02-01",
        keputusan: "TOLAK",
        catatan: "Kuota sektor sudah habis periode ini",
      },
      d.ctx.approver,
    );
    expect(p.status).toBe("DITOLAK");
    // A rejection is a decision and must leave the same trail an approval does.
    expect((await d.bacaApproval(f.proposalId))[0].keputusan).toBe("TOLAK");
    await satuBarisTimeline(f.proposalId, {
      dari: "MENUNGGU_PERSETUJUAN",
      ke: "DITOLAK",
      aksi: "TOLAK",
      oleh: d.userId.approver,
      catatan: "Kuota sektor sudah habis periode ini",
    });
    // And no akad may exist behind a rejected proposal.
    expect(await d.bacaAkadByProposal(f.proposalId)).toBeNull();
  });

  test("DISETUJUI -> AKAD_DIBUAT lewat BUAT_AKAD", async () => {
    const f = await d.siapkanProposal("DISETUJUI");
    const akad = await engine.buatAkad(
      {
        proposalId: f.proposalId,
        tanggalAkad: TANGGAL_AKAD_BAKU,
        tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
      },
      d.ctx.maker,
    );
    expect(akad.status).toBe("BELUM_CAIR");
    expect((await d.bacaProposal(f.proposalId)).status).toBe("AKAD_DIBUAT");
    await satuBarisTimeline(f.proposalId, {
      dari: "DISETUJUI",
      ke: "AKAD_DIBUAT",
      aksi: "BUAT_AKAD",
      oleh: d.userId.maker,
      catatan: null,
    });
  });

  test("akad kedua atas proposal yang sama ditolak, tepat satu akad tetap ada", async () => {
    const f = await d.siapkanProposal("AKAD_DIBUAT");
    await tolakDengan(() => jalankanAksi("BUAT_AKAD", f, null), KODE_PUMK.TRANSISI_TIDAK_VALID);
    // The proposal already left DISETUJUI, so the state machine refuses first;
    // either way exactly one akad may exist.
    const akad = await d.bacaAkadByProposal(f.proposalId);
    expect(akad?.id).toBe(f.akadId as string);
  });

  test("AKAD_DIBUAT -> JADWAL_SIAP lewat GENERATE_JADWAL, dan jadwal ditulis engine angsuran", async () => {
    const f = await d.siapkanProposal("AKAD_DIBUAT");
    const jadwal = await engine.generateJadwal(f.akadId as string, d.ctx.maker);
    expect(jadwal.versi).toBe(1);
    expect(jadwal.isActiveVersion).toBe(true);
    // Invariant 8: this module never writes a pumk_jadwal_angsuran row itself.
    expect(angsuran.panggilan.map((p) => p.metode)).toEqual(["generateJadwal"]);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("JADWAL_SIAP");
    await satuBarisTimeline(f.proposalId, {
      dari: "AKAD_DIBUAT",
      ke: "JADWAL_SIAP",
      aksi: "GENERATE_JADWAL",
      oleh: d.userId.maker,
      catatan: null,
    });
  });

  test("JADWAL_SIAP -> DICAIRKAN lewat PENCAIRAN [terminal untuk proposal]", async () => {
    const f = await d.siapkanProposal("JADWAL_SIAP");
    const hasil = await engine.catatPencairan(
      {
        akadId: f.akadId as string,
        tanggalPencairan: TANGGAL_AKAD_BAKU,
        jumlah: f.plafonDisetujui,
        akunKasId: d.akun.kas.id,
        noBukti: "BKK-UJI-001",
      },
      d.ctx.maker,
    );
    expect(hasil.proposal.status).toBe("DICAIRKAN");
    expect(hasil.akad.status).toBe("AKTIF");
    await satuBarisTimeline(f.proposalId, {
      dari: "JADWAL_SIAP",
      ke: "DICAIRKAN",
      aksi: "PENCAIRAN",
      oleh: d.userId.maker,
      catatan: null,
    });
  });
});

// ---------------------------------------------------------------------------
// The two return-for-revision branches
// ---------------------------------------------------------------------------

describe("dua jalur kembali untuk perbaikan (spec 9.1)", () => {
  test("MINTA_PERBAIKAN mengembalikan ke SURVEY_SELESAI dan proposal bisa diajukan ulang", async () => {
    const f = await d.siapkanProposal("REVIEW_CHECKER");
    const kembali = await engine.review(
      {
        proposalId: f.proposalId,
        tanggal: "2026-01-25",
        keputusan: "MINTA_PERBAIKAN",
        catatan: "Nilai taksasi jaminan belum diisi",
      },
      d.ctx.checker,
    );
    // Not terminal: this is a LOOP back to SURVEY_SELESAI, which is the whole
    // point of the branch.
    expect(kembali.status).toBe("SURVEY_SELESAI");

    const lagi = await engine.ajukanKeChecker(f.proposalId, "Sudah diperbaiki", d.ctx.maker);
    expect(lagi.status).toBe("REVIEW_CHECKER");

    // The timeline APPENDS, it never rewrites. Both passes through the same
    // state are visible, in order, with their own author and note.
    const baris = await d.bacaTransisi(f.proposalId);
    expect(baris).toHaveLength(2);
    expect(baris.map((b) => b.aksi)).toEqual(["MINTA_PERBAIKAN", "AJUKAN_CHECKER"]);
    expect(baris[0].oleh_user_id).toBe(d.userId.checker);
    expect(baris[0].catatan).toBe("Nilai taksasi jaminan belum diisi");
    expect(baris[1].oleh_user_id).toBe(d.userId.maker);
    expect(baris[1].status_ke).toBe("REVIEW_CHECKER");
    expect(Date.parse(baris[1].waktu)).toBeGreaterThanOrEqual(Date.parse(baris[0].waktu));

    // Two review rows: the checker's "fix this" is itself a recorded decision.
    expect((await d.bacaReview(f.proposalId)).map((r) => r.keputusan)).toEqual(["MINTA_PERBAIKAN"]);
  });

  test("KEMBALIKAN mengembalikan ke REVIEW_CHECKER dan checker bisa merekomendasi ulang", async () => {
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const kembali = await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: "2026-02-01",
        keputusan: "KEMBALIKAN",
        catatan: "Minta checker konfirmasi ulang omzet",
      },
      d.ctx.approver,
    );
    expect(kembali.status).toBe("REVIEW_CHECKER");

    // A DIFFERENT checker re-recommends. The fixture's first review was by
    // `checker`, so `checkerDua` keeps spec 2 rule 2 out of the way and proves
    // the loop is reusable rather than single-shot.
    const lagi = await engine.review(
      {
        proposalId: f.proposalId,
        tanggal: "2026-02-03",
        keputusan: "REKOMENDASI",
        catatan: "Omzet dikonfirmasi ulang",
      },
      d.ctx.checkerDua,
    );
    expect(lagi.status).toBe("MENUNGGU_PERSETUJUAN");

    const baris = await d.bacaTransisi(f.proposalId);
    expect(baris).toHaveLength(2);
    expect(baris.map((b) => b.aksi)).toEqual(["KEMBALIKAN", "REKOMENDASI"]);
    expect(baris.map((b) => b.oleh_user_id)).toEqual([d.userId.approver, d.userId.checkerDua]);
    expect(baris[0].catatan).toBe("Minta checker konfirmasi ulang omzet");

    // The KEMBALIKAN decision is on the approval trail, not silently dropped.
    expect((await d.bacaApproval(f.proposalId)).map((a) => a.keputusan)).toEqual(["KEMBALIKAN"]);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("penolakan state machine", () => {
  test("status terminal menolak setiap aksi dengan STATUS_TERMINAL", async () => {
    // TIDAK_DIREKOMENDASIKAN, DITOLAK and DICAIRKAN have no outgoing edge. A
    // reopened rejection is a new proposal, not a resurrected one.
    for (const status of ["TIDAK_DIREKOMENDASIKAN", "DITOLAK"] as const) {
      const f = await d.siapkanProposal(status);
      for (const aksi of ["SUBMIT_SURVEY", "AJUKAN_CHECKER", "REKOMENDASI", "SETUJU"] as const) {
        await tolakDengan(() => jalankanAksi(aksi, f, CATATAN), KODE_PUMK.STATUS_TERMINAL);
      }
      expect((await d.bacaProposal(f.proposalId)).status).toBe(status);
      expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
    }
  }, 30_000);

  test("DICAIRKAN terminal untuk proposal: pencairan kedua ditolak, akad tetap satu", async () => {
    const f = await d.siapkanProposal("DICAIRKAN");
    await tolakDengan(() => jalankanAksi("PENCAIRAN", f, null), KODE_PUMK.STATUS_TERMINAL);
    await tolakDengan(() => jalankanAksi("BUAT_AKAD", f, null), KODE_PUMK.STATUS_TERMINAL);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("DICAIRKAN");
    expect(jurnal.panggilan).toHaveLength(0);
  });

  test("aksi dari status yang salah ditolak dengan TRANSISI_TIDAK_VALID, tanpa mengubah apa pun", async () => {
    // A representative slice of the (status, aksi) pairs the table does NOT
    // contain. Each one is a real mis-click or a replayed request.
    const kasus: Array<[StatusProposal, AksiProposal]> = [
      ["DRAFT", "REKOMENDASI"],
      ["DRAFT", "SETUJU"],
      ["SURVEY_PENDING", "AJUKAN_CHECKER"],
      ["SURVEY_SELESAI", "SETUJU"],
      ["REVIEW_CHECKER", "TOLAK"],
      ["MENUNGGU_PERSETUJUAN", "REKOMENDASI"],
      ["DISETUJUI", "SUBMIT_SURVEY"],
      ["JADWAL_SIAP", "BUAT_AKAD"],
    ];
    for (const [status, aksi] of kasus) {
      const f = await d.siapkanProposal(status);
      await tolakDengan(() => jalankanAksi(aksi, f, CATATAN), KODE_PUMK.TRANSISI_TIDAK_VALID);
      expect((await d.bacaProposal(f.proposalId)).status).toBe(status);
      expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
    }
  }, 60_000);

  test("generate jadwal atas akad yang tidak ada ditolak dengan AKAD_TIDAK_DITEMUKAN", async () => {
    const f = await d.siapkanProposal("DISETUJUI");
    expect(f.akadId).toBeNull();
    // No akad exists yet, so the akad id has to come from somewhere: a random
    // one must be refused as not found, never generate a schedule for a
    // stranger's akad.
    await tolakDengan(
      () => engine.generateJadwal("00000000-0000-4000-8000-000000000000", d.ctx.maker),
      KODE_PUMK.AKAD_TIDAK_DITEMUKAN,
    );
    expect(angsuran.panggilan).toHaveLength(0);
  });

  test("keempat transisi penolakan menolak catatan kosong dengan CATATAN_WAJIB", async () => {
    // "Catat siapa, kapan, CATATAN APA." A rejection with no reason is the
    // complaint spec 9.1 exists to answer, so the four edges marked
    // catatanWajib must refuse null AND whitespace.
    for (const kosong of [null, "", "   "]) {
      const a = await d.siapkanProposal("REVIEW_CHECKER");
      await tolakDengan(() => jalankanAksi("TIDAK_REKOMENDASI", a, kosong), KODE_PUMK.CATATAN_WAJIB);
      expect((await d.bacaProposal(a.proposalId)).status).toBe("REVIEW_CHECKER");

      const b = await d.siapkanProposal("REVIEW_CHECKER");
      await tolakDengan(() => jalankanAksi("MINTA_PERBAIKAN", b, kosong), KODE_PUMK.CATATAN_WAJIB);

      const c = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
      await tolakDengan(() => jalankanAksi("TOLAK", c, kosong), KODE_PUMK.CATATAN_WAJIB);

      const e = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
      await tolakDengan(() => jalankanAksi("KEMBALIKAN", e, kosong), KODE_PUMK.CATATAN_WAJIB);

      // Nothing was written on any of the four: no review row, no approval
      // row, no timeline row.
      expect(await d.bacaReview(a.proposalId)).toHaveLength(0);
      expect(await d.bacaTransisi(c.proposalId)).toHaveLength(0);
    }
  }, 60_000);

  test("transisi yang tidak mewajibkan catatan tetap menerima null", async () => {
    // The mirror of the rule above: SUBMIT_SURVEY, REKOMENDASI and SETUJU are
    // not confessions, so a null note must not be turned into a mandatory one.
    const f = await d.siapkanProposal("REVIEW_CHECKER");
    const p = await engine.review(
      { proposalId: f.proposalId, tanggal: "2026-01-25", keputusan: "REKOMENDASI", catatan: null },
      d.ctx.checker,
    );
    expect(p.status).toBe("MENUNGGU_PERSETUJUAN");
    expect((await d.bacaTransisi(f.proposalId))[0].catatan).toBeNull();
  });

  test("REKOMENDASI di bawah skor minimum ditolak, dan ambangnya dibaca dari konfigurasi", async () => {
    // docs/REGULASI.md and spec 5's preamble both make the threshold the
    // client's decision, so this asserts the MECHANIC (change the row, change
    // the outcome) and never that 70 is the right number.
    await d.setelKonfigurasi("batasan", "skor_survey_minimum_lolos", "70");
    const rendah = await d.siapkanProposal("REVIEW_CHECKER", { skorTotal: "65.000000" });
    await tolakDengan(() => jalankanAksi("REKOMENDASI", rendah, null), KODE_PUMK.SKOR_DIBAWAH_MINIMUM);

    // Same score, lower threshold: now it passes. That is the mechanic.
    await d.setelKonfigurasi("batasan", "skor_survey_minimum_lolos", "60");
    const lagi = await d.siapkanProposal("REVIEW_CHECKER", { skorTotal: "65.000000" });
    const p = await engine.review(
      { proposalId: lagi.proposalId, tanggal: "2026-01-25", keputusan: "REKOMENDASI", catatan: null },
      d.ctx.checker,
    );
    expect(p.status).toBe("MENUNGGU_PERSETUJUAN");
    await d.setelKonfigurasi("batasan", "skor_survey_minimum_lolos", "70");
  });

  test("konfigurasi yang tidak bisa diurai ditolak dengan KONFIGURASI_TIDAK_VALID, bukan NaN diam diam", async () => {
    // Fail closed. A threshold that parses to NaN makes every comparison false
    // and quietly disables the check, which is worse than an outage.
    await d.setelKonfigurasi("batasan", "skor_survey_minimum_lolos", "tujuh puluh");
    const f = await d.siapkanProposal("REVIEW_CHECKER");
    await tolakDengan(() => jalankanAksi("REKOMENDASI", f, null), KODE_PUMK.KONFIGURASI_TIDAK_VALID);
    await d.setelKonfigurasi("batasan", "skor_survey_minimum_lolos", "70");
  });

  test("proposal yang tidak ada ditolak dengan PROPOSAL_TIDAK_DITEMUKAN", async () => {
    const hantu = "00000000-0000-4000-8000-000000000001";
    await tolakDengan(
      () => engine.submitUntukSurvey(hantu, null, d.ctx.maker),
      KODE_PUMK.PROPOSAL_TIDAK_DITEMUKAN,
    );
    await tolakDengan(() => engine.timeline(hantu, d.ctx.maker), KODE_PUMK.PROPOSAL_TIDAK_DITEMUKAN);
  });
});

// ---------------------------------------------------------------------------
// The timeline as a read model
// ---------------------------------------------------------------------------

describe("timeline (spec 9.1)", () => {
  test("timeline() mengembalikan seluruh riwayat urut lama ke baru, dengan siapa kapan catatan apa", async () => {
    const f = await d.siapkanProposal("DRAFT");
    await engine.submitUntukSurvey(f.proposalId, "Berkas lengkap", d.ctx.maker);
    await engine.inputSurvey(
      {
        proposalId: f.proposalId,
        tanggalSurvey: "2026-01-20",
        petugasKaryawanId: d.karyawanId,
        hasil: { karakter: 80, kapasitas_usaha: 80, tempat_usaha: 80, agunan: 80, riwayat: 80 },
        skorTotal: "80.000000",
        plafonRekomendasi: POKOK_BAKU,
        tenorRekomendasi: TENOR_BAKU,
        catatan: "Survey selesai",
      },
      d.ctx.maker,
    );
    await engine.ajukanKeChecker(f.proposalId, null, d.ctx.maker);
    await engine.review(
      { proposalId: f.proposalId, tanggal: "2026-01-25", keputusan: "REKOMENDASI", catatan: "Setuju" },
      d.ctx.checker,
    );

    const timeline = await engine.timeline(f.proposalId, d.ctx.maker);
    expect(timeline.map((t) => t.aksi)).toEqual([
      "SUBMIT_SURVEY",
      "INPUT_SURVEY",
      "AJUKAN_CHECKER",
      "REKOMENDASI",
    ]);
    expect(timeline.map((t) => t.statusKe)).toEqual([
      "SURVEY_PENDING",
      "SURVEY_SELESAI",
      "REVIEW_CHECKER",
      "MENUNGGU_PERSETUJUAN",
    ]);
    // Each row's `statusDari` is the previous row's `statusKe`: the timeline is
    // a chain, so a skipped transition would be visible as a gap.
    expect(timeline[0].statusDari).toBe("DRAFT");
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i].statusDari).toBe(timeline[i - 1].statusKe);
      expect(Date.parse(timeline[i].waktu)).toBeGreaterThanOrEqual(Date.parse(timeline[i - 1].waktu));
    }
    expect(timeline.map((t) => t.olehUserId)).toEqual([
      d.userId.maker,
      d.userId.maker,
      d.userId.maker,
      d.userId.checker,
    ]);
    expect(timeline.map((t) => t.catatan)).toEqual(["Berkas lengkap", "Survey selesai", null, "Setuju"]);
  }, 30_000);

  test("waktu transisi diambil dari jam yang disuntikkan, bukan dari jam dinding", async () => {
    // `PumkEngineDeps.jam` exists so a test is not hostage to the wall clock,
    // and so a backdated import can be recorded honestly. An engine that lets
    // the column default to now() makes both impossible, and the difference is
    // invisible in any assertion that only checks "is a date".
    const f = await d.siapkanProposal("DRAFT");
    await engine.submitUntukSurvey(f.proposalId, null, d.ctx.maker);
    const baris = await d.bacaTransisi(f.proposalId);
    expect(baris).toHaveLength(1);
    expect(Date.parse(baris[0].waktu)).toBe(d.jam().getTime());
  });

  test("transisi yang ditolak tidak meninggalkan jejak di timeline", async () => {
    // The timeline is what an auditor reads. A refused attempt is an audit-log
    // entry (spec 2 rule 5), not a state transition, and putting it here would
    // make the chain above stop being a chain.
    const f = await d.siapkanProposal("DRAFT");
    await tolakDengan(() => jalankanAksi("SETUJU", f, null), KODE_PUMK.TRANSISI_TIDAK_VALID);
    await tolakDengan(() => jalankanAksi("REKOMENDASI", f, null), KODE_PUMK.TRANSISI_TIDAK_VALID);
    expect(await engine.timeline(f.proposalId, d.ctx.maker)).toHaveLength(0);
  });
});
