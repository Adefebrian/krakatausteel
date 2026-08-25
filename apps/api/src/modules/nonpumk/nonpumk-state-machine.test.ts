// SPEC 9.2 STATE MACHINE, every edge, every refusal, and the timeline.
//
//   DRAFT -> PENILAIAN -> REVIEW_CHECKER -> MENUNGGU_PERSETUJUAN -> DISETUJUI
//     -> DISALURKAN -> MENUNGGU_LPJ -> LPJ_DIAJUKAN -> SELESAI
//   Cabang: TIDAK_DIREKOMENDASIKAN, DITOLAK, LPJ_DITOLAK (kembali ke LPJ_DIAJUKAN)
//
// Spec 9.1 says the quiet part out loud for both modules: "setiap transisi:
// catat siapa, kapan, catatan apa ... ini fitur yang paling sering diminta user
// dan paling sering dilupakan developer". So the timeline is asserted on EVERY
// transition here, not once in a happy path.
//
// HOW THE PRECONDITIONS ARE BUILT, AND WHY IT MATTERS.
// `siapkanProposal(status)` writes the proposal and its supporting rows in SQL
// and writes NO `nonpumk_proposal_transisi` row (pinned by
// ./nonpumk-fixture.test.ts). Every test below therefore starts from a state
// the engine did not produce and asserts about rows only the engine can have
// written. Chaining transitions through the engine to reach a state would turn
// one broken transition into a cascade of red tests and hide which edge
// actually broke.
//
// WHAT IS DELIBERATELY NOT HERE. The money and the ledger effect of PENYALURAN,
// AJUKAN_LPJ and VERIFIKASI_LPJ belong to ./nonpumk-penyaluran.test.ts and
// ./nonpumk-lpj.test.ts. This file asserts only that those edges move the
// STATUS and write the TIMELINE, so a failure here is a state-machine failure
// and never an accounting one.
//
// THE TWO EDGES OUT OF LPJ_DIAJUKAN WERE BLOCKED ON TEMUAN 1, AND ARE NOT ANY
// MORE. Both need `nonpumk.lpj.verifikasi`, which the shipped catalogue did not
// have, so they used to assert the FAIL-CLOSED refusal (IZIN_BELUM_TERDAFTAR
// for every role, Admin Pusat included) rather than the transition. The code
// was added and granted to CHECKER, ./nonpumk-fixture.test.ts's TEMUAN 1 pin
// went red as designed, and both now assert the ordinary edge. The notes on
// them record what they used to say, because that argument is the reason the
// permission is a Checker grant and not a reuse of `nonpumk.lpj`.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createNonPumkEngine,
  KODE_NONPUMK,
  type AksiNonPumk,
  type NonPumkEngine,
  type StatusProposalNonPumk,
} from "./contract";
import {
  buatDunia,
  porterJurnalUji,
  rp,
  tolakDengan,
  DISETUJUI_BAKU,
  PENERIMA_AKTUAL_BAKU,
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

const CATATAN = "Catatan wajib dari petugas (uji)";

beforeAll(async () => {
  d = await buatDunia();
  jurnal = porterJurnalUji(d.db, d.jam);
  // Wired exactly as the composition root wires it: the REAL ledger engine
  // behind a recording wrapper, one shared db port, one shared clock.
  engine = createNonPumkEngine({ db: d.db, jurnal, jam: d.jam });
}, 60_000);

beforeEach(() => {
  jurnal.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

/**
 * Invokes the engine method that owns one edge of the diagram, with the role
 * the table names as its holder. One place, so the invalid-transition matrix
 * below can be driven generically instead of by fifteen copy-pasted calls.
 */
function jalankanAksi(
  aksi: AksiNonPumk,
  f: ProposalFixture,
  catatan: string | null,
): Promise<unknown> {
  const id = f.proposalId;
  switch (aksi) {
    case "AJUKAN_PENILAIAN":
      return engine.ajukanPenilaian(id, catatan, d.ctx.maker);
    case "INPUT_PENILAIAN":
      return engine.inputPenilaian(
        {
          proposalId: id,
          tanggal: TANGGAL_PROPOSAL_BAKU,
          petugasKaryawanId: d.karyawanId,
          hasil: { kelayakan: 80, urgensi: 75, dampak: 85, kesesuaian_bidang: 90, kesesuaian_sdg: 80 },
          skorTotal: "82.000000",
          nilaiRekomendasi: DISETUJUI_BAKU,
          catatan,
        },
        d.ctx.maker,
      );
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
          tanggal: TANGGAL_PROPOSAL_BAKU,
          keputusan: "SETUJU",
          jumlahDisetujui: DISETUJUI_BAKU,
          catatan,
        },
        d.ctx.approver,
      );
    case "TOLAK":
      return engine.putuskanPersetujuan(
        { proposalId: id, tanggal: TANGGAL_PROPOSAL_BAKU, keputusan: "TOLAK", catatan },
        d.ctx.approver,
      );
    case "KEMBALIKAN":
      return engine.putuskanPersetujuan(
        { proposalId: id, tanggal: TANGGAL_PROPOSAL_BAKU, keputusan: "KEMBALIKAN", catatan },
        d.ctx.approver,
      );
    case "PENYALURAN":
      return engine.catatPenyaluran(
        {
          proposalId: id,
          tanggalPenyaluran: TANGGAL_PENYALURAN_BAKU,
          jumlah: rp(1_000_000),
          akunKasId: d.akun.kas.id,
          akunBebanId: f.akunBebanId,
        },
        d.ctx.maker,
      );
    case "TUTUP_PENYALURAN":
      return engine.tutupPenyaluran(id, catatan, d.ctx.maker);
    case "AJUKAN_LPJ":
      return engine.ajukanLpj(
        {
          proposalId: id,
          tanggalLpj: TANGGAL_LPJ_BAKU,
          jumlahRealisasi: f.totalDisalurkan,
          penerimaManfaatAktual: PENERIMA_AKTUAL_BAKU,
          uraianRealisasi: "Realisasi kegiatan",
        },
        d.ctx.maker,
      );
    // The Checker, because that is the role the transition table names as the
    // holder of `nonpumk.lpj.verifikasi`. It was Admin Pusat while the code did
    // not exist and the assertion was IZIN_BELUM_TERDAFTAR for everyone; now
    // that it is a real grant, every edge in this dispatcher is driven by the
    // role that owns it, like all the others.
    case "VERIFIKASI_LPJ":
      return engine.verifikasiLpj(
        { proposalId: id, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: d.akun.kas.id, catatan },
        d.ctx.checker,
      );
    case "TOLAK_LPJ":
      return engine.tolakLpj(
        { proposalId: id, tanggal: TANGGAL_LPJ_BAKU, catatan: catatan ?? "" },
        d.ctx.checker,
      );
  }
}

/** The single timeline row an edge must have appended, with who/when/what. */
async function satuBarisTimeline(
  proposalId: string,
  harap: {
    dari: StatusProposalNonPumk;
    ke: StatusProposalNonPumk;
    aksi: AksiNonPumk;
    oleh: string;
    catatan: string | null;
  },
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
// The fifteen edges of the diagram
// ---------------------------------------------------------------------------

describe("transisi sah (spec 9.2)", () => {
  test("DRAFT -> PENILAIAN lewat AJUKAN_PENILAIAN, tercatat di timeline", async () => {
    const f = await d.siapkanProposal("DRAFT");
    const p = await engine.ajukanPenilaian(f.proposalId, "Berkas lengkap, mohon dinilai", d.ctx.maker);
    expect(p.status).toBe("PENILAIAN");
    expect((await d.bacaProposal(f.proposalId)).status).toBe("PENILAIAN");
    await satuBarisTimeline(f.proposalId, {
      dari: "DRAFT",
      ke: "PENILAIAN",
      aksi: "AJUKAN_PENILAIAN",
      oleh: d.userId.maker,
      catatan: "Berkas lengkap, mohon dinilai",
    });
  });

  test("PENILAIAN -> REVIEW_CHECKER lewat INPUT_PENILAIAN, hasil penilaian tersimpan (spec 4.5)", async () => {
    const f = await d.siapkanProposal("PENILAIAN");
    const p = await engine.inputPenilaian(
      {
        proposalId: f.proposalId,
        tanggal: "2026-03-12",
        petugasKaryawanId: d.karyawanId,
        // Spec 4.5's five aspects, stored as hasil_json.
        hasil: { kelayakan: 85, urgensi: 80, dampak: 75, kesesuaian_bidang: 90, kesesuaian_sdg: 85 },
        skorTotal: "83.000000",
        nilaiRekomendasi: rp(35_000_000),
        catatan: "Program sesuai bidang dan SDG yang dipetakan",
      },
      d.ctx.maker,
    );
    expect(p.status).toBe("REVIEW_CHECKER");

    const penilaian = await d.bacaPenilaian(f.proposalId);
    expect(penilaian).toHaveLength(1);
    expect(penilaian[0].skor_total).toBe("83.000000");
    expect(penilaian[0].nilai_rekomendasi).toBe(rp(35_000_000));
    expect(penilaian[0].created_by).toBe(d.userId.maker);

    await satuBarisTimeline(f.proposalId, {
      dari: "PENILAIAN",
      ke: "REVIEW_CHECKER",
      aksi: "INPUT_PENILAIAN",
      oleh: d.userId.maker,
      catatan: "Program sesuai bidang dan SDG yang dipetakan",
    });
  });

  test("REVIEW_CHECKER -> MENUNGGU_PERSETUJUAN lewat REKOMENDASI, jejak checker tersimpan", async () => {
    const f = await d.siapkanProposal("REVIEW_CHECKER");
    const p = await engine.review(
      {
        proposalId: f.proposalId,
        tanggal: "2026-03-20",
        keputusan: "REKOMENDASI",
        catatan: "Layak, sesuai hasil penilaian",
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
      catatan: "Layak, sesuai hasil penilaian",
    });
  });

  test("REVIEW_CHECKER -> TIDAK_DIREKOMENDASIKAN lewat TIDAK_REKOMENDASI [terminal]", async () => {
    const f = await d.siapkanProposal("REVIEW_CHECKER");
    const p = await engine.review(
      {
        proposalId: f.proposalId,
        tanggal: "2026-03-20",
        keputusan: "TIDAK_REKOMENDASI",
        catatan: "Program tidak sesuai bidang Non PUMK yang dipilih",
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
      catatan: "Program tidak sesuai bidang Non PUMK yang dipilih",
    });
  });

  test("REVIEW_CHECKER -> PENILAIAN lewat MINTA_PERBAIKAN, dan penilaian ulang MEMPERBARUI baris yang sama", async () => {
    // nonpumk_penilaian_proposal_uq allows exactly ONE live assessment per
    // proposal. So the loop back has to UPDATE, not insert: a second row would
    // be refused by the index, and silently dropping the correction would leave
    // the checker looking at the score they already rejected.
    const f = await d.siapkanProposal("REVIEW_CHECKER", { skorTotal: "62.000000" });
    const kembali = await engine.review(
      {
        proposalId: f.proposalId,
        tanggal: "2026-03-20",
        keputusan: "MINTA_PERBAIKAN",
        catatan: "Skor dampak belum diisi lengkap",
      },
      d.ctx.checker,
    );
    expect(kembali.status).toBe("PENILAIAN");

    const lagi = await engine.inputPenilaian(
      {
        proposalId: f.proposalId,
        tanggal: "2026-03-22",
        petugasKaryawanId: d.karyawanId,
        hasil: { kelayakan: 85, urgensi: 80, dampak: 88, kesesuaian_bidang: 90, kesesuaian_sdg: 85 },
        skorTotal: "85.600000",
        nilaiRekomendasi: DISETUJUI_BAKU,
        catatan: "Dampak dilengkapi",
      },
      d.ctx.maker,
    );
    expect(lagi.status).toBe("REVIEW_CHECKER");

    // ONE assessment row, carrying the NEW score. Its version moved, which is
    // what an update looks like under the shared audit trigger.
    const penilaian = await d.bacaPenilaian(f.proposalId);
    expect(penilaian).toHaveLength(1);
    expect(penilaian[0].skor_total).toBe("85.600000");
    expect(penilaian[0].version).toBeGreaterThan(1);

    const baris = await d.bacaTransisi(f.proposalId);
    expect(baris.map((b) => b.aksi)).toEqual(["MINTA_PERBAIKAN", "INPUT_PENILAIAN"]);
    expect(baris[0].oleh_user_id).toBe(d.userId.checker);
    expect(baris[0].catatan).toBe("Skor dampak belum diisi lengkap");
    expect(baris[1].oleh_user_id).toBe(d.userId.maker);
    expect(Date.parse(baris[1].waktu)).toBeGreaterThanOrEqual(Date.parse(baris[0].waktu));

    // The checker's "fix this" is itself a recorded decision.
    expect((await d.bacaReview(f.proposalId)).map((r) => r.keputusan)).toEqual(["MINTA_PERBAIKAN"]);
  }, 30_000);

  test("MENUNGGU_PERSETUJUAN -> DISETUJUI lewat SETUJU, nilai disetujui turun ke proposal", async () => {
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: "2026-04-01",
        keputusan: "SETUJU",
        jumlahDisetujui: DISETUJUI_BAKU,
        catatan: "Disetujui sesuai rekomendasi",
      },
      d.ctx.approver,
    );
    expect(p.status).toBe("DISETUJUI");
    expect(p.jumlahDisetujui).toBe(DISETUJUI_BAKU);

    const approval = await d.bacaApproval(f.proposalId);
    expect(approval).toHaveLength(1);
    expect(approval[0].approver_user_id).toBe(d.userId.approver);
    expect(approval[0].keputusan).toBe("SETUJU");
    expect(approval[0].jumlah_disetujui).toBe(DISETUJUI_BAKU);
    // ASSUMPTIONS.md A-15: denormalised onto the proposal, because that column
    // is the single ceiling the deferred TJSL-NPK-002 trigger reads.
    expect((await d.bacaProposal(f.proposalId)).jumlah_disetujui).toBe(DISETUJUI_BAKU);

    await satuBarisTimeline(f.proposalId, {
      dari: "MENUNGGU_PERSETUJUAN",
      ke: "DISETUJUI",
      aksi: "SETUJU",
      oleh: d.userId.approver,
      catatan: "Disetujui sesuai rekomendasi",
    });
  });

  test("approver MEMOTONG nilai, dan pagu penyaluran mengikuti yang dipotong bukan yang diajukan", async () => {
    // The Non PUMK twin of scenario 3. A cut that is recorded and then ignored
    // is worse than no cut at all: the ceiling the disbursement guard reads
    // would still be the requested amount.
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN", { jumlahDiajukan: rp(50_000_000) });
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: "2026-04-01",
        keputusan: "SETUJU",
        jumlahDisetujui: rp(20_000_000),
        catatan: "Dipotong sesuai ketersediaan anggaran",
      },
      d.ctx.approver,
    );
    expect(p.jumlahDisetujui).toBe(rp(20_000_000));
    expect(p.jumlahDiajukan).toBe(rp(50_000_000));
    expect((await d.bacaProposal(f.proposalId)).jumlah_disetujui).toBe(rp(20_000_000));
  });

  test("MENUNGGU_PERSETUJUAN -> DITOLAK lewat TOLAK [terminal], tanpa nilai disetujui", async () => {
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: "2026-04-01",
        keputusan: "TOLAK",
        catatan: "Anggaran bidang sudah habis tahun ini",
      },
      d.ctx.approver,
    );
    expect(p.status).toBe("DITOLAK");
    // A rejected proposal must never acquire a disbursement ceiling.
    expect(p.jumlahDisetujui).toBeNull();
    expect((await d.bacaProposal(f.proposalId)).jumlah_disetujui).toBeNull();
    expect((await d.bacaApproval(f.proposalId))[0].keputusan).toBe("TOLAK");
    await satuBarisTimeline(f.proposalId, {
      dari: "MENUNGGU_PERSETUJUAN",
      ke: "DITOLAK",
      aksi: "TOLAK",
      oleh: d.userId.approver,
      catatan: "Anggaran bidang sudah habis tahun ini",
    });
  });

  test("MENUNGGU_PERSETUJUAN -> REVIEW_CHECKER lewat KEMBALIKAN, dan checker lain bisa merekomendasi ulang", async () => {
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const kembali = await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: "2026-04-01",
        keputusan: "KEMBALIKAN",
        catatan: "Minta checker konfirmasi jumlah penerima manfaat",
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
        tanggal: "2026-04-03",
        keputusan: "REKOMENDASI",
        catatan: "Penerima manfaat dikonfirmasi ulang",
      },
      d.ctx.checkerDua,
    );
    expect(lagi.status).toBe("MENUNGGU_PERSETUJUAN");

    const baris = await d.bacaTransisi(f.proposalId);
    expect(baris.map((b) => b.aksi)).toEqual(["KEMBALIKAN", "REKOMENDASI"]);
    expect(baris.map((b) => b.oleh_user_id)).toEqual([d.userId.approver, d.userId.checkerDua]);
    // The KEMBALIKAN decision is on the approval trail, not silently dropped.
    expect((await d.bacaApproval(f.proposalId)).map((a) => a.keputusan)).toEqual(["KEMBALIKAN"]);
  }, 30_000);

  test("DISETUJUI -> DISALURKAN lewat PENYALURAN termin pertama", async () => {
    const f = await d.siapkanProposal("DISETUJUI");
    const hasil = await engine.catatPenyaluran(
      {
        proposalId: f.proposalId,
        tanggalPenyaluran: TANGGAL_PENYALURAN_BAKU,
        jumlah: rp(15_000_000),
        akunKasId: d.akun.kas.id,
        akunBebanId: f.akunBebanId,
        noBukti: "BKK-NPK-2026-0001",
        keterangan: "Termin 1",
      },
      d.ctx.maker,
    );
    expect(hasil.termin).toBe(1);
    expect(hasil.jumlah).toBe(rp(15_000_000));
    expect((await d.bacaProposal(f.proposalId)).status).toBe("DISALURKAN");
    await satuBarisTimeline(f.proposalId, {
      dari: "DISETUJUI",
      ke: "DISALURKAN",
      aksi: "PENYALURAN",
      oleh: d.userId.maker,
      catatan: null,
    });
  }, 30_000);

  test("DISALURKAN -> DISALURKAN lewat PENYALURAN termin berikutnya, satu baris timeline per termin", async () => {
    // The self loop of spec 9.2's "penyaluran bisa bertahap". Without it a
    // second termin is either an unguarded write or a status round trip.
    const f = await d.siapkanProposal("DISALURKAN", { terminPenyaluran: [rp(15_000_000)] });
    const dua = await engine.catatPenyaluran(
      {
        proposalId: f.proposalId,
        tanggalPenyaluran: "2026-05-10",
        jumlah: rp(10_000_000),
        akunKasId: d.akun.kas.id,
        akunBebanId: f.akunBebanId,
      },
      d.ctx.maker,
    );
    expect(dua.termin).toBe(2);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("DISALURKAN");
    await satuBarisTimeline(f.proposalId, {
      dari: "DISALURKAN",
      ke: "DISALURKAN",
      aksi: "PENYALURAN",
      oleh: d.userId.maker,
      catatan: null,
    });
  }, 30_000);

  test("DISALURKAN -> MENUNGGU_LPJ lewat TUTUP_PENYALURAN, dan termin berikutnya jadi tidak sah", async () => {
    const f = await d.siapkanProposal("DISALURKAN", { terminPenyaluran: [rp(15_000_000)] });
    const p = await engine.tutupPenyaluran(f.proposalId, "Penyaluran selesai, LPJ ditunggu", d.ctx.maker);
    expect(p.status).toBe("MENUNGGU_LPJ");
    await satuBarisTimeline(f.proposalId, {
      dari: "DISALURKAN",
      ke: "MENUNGGU_LPJ",
      aksi: "TUTUP_PENYALURAN",
      oleh: d.userId.maker,
      catatan: "Penyaluran selesai, LPJ ditunggu",
    });

    // Closing the staging is the whole point: more money after the LPJ clock
    // started would make the ageing of spec 9.2 count from the wrong date.
    await tolakDengan(() => jalankanAksi("PENYALURAN", f, null), KODE_NONPUMK.TRANSISI_TIDAK_VALID);
    expect(await d.bacaPenyaluran(f.proposalId)).toHaveLength(1);
  }, 30_000);

  test("MENUNGGU_LPJ -> LPJ_DIAJUKAN lewat AJUKAN_LPJ", async () => {
    const f = await d.siapkanProposal("MENUNGGU_LPJ");
    const lpj = await engine.ajukanLpj(
      {
        proposalId: f.proposalId,
        tanggalLpj: TANGGAL_LPJ_BAKU,
        jumlahRealisasi: f.totalDisalurkan,
        penerimaManfaatAktual: PENERIMA_AKTUAL_BAKU,
        uraianRealisasi: "Seluruh dana terserap sesuai rencana",
      },
      d.ctx.maker,
    );
    expect(lpj.status).toBe("DIAJUKAN");
    expect((await d.bacaProposal(f.proposalId)).status).toBe("LPJ_DIAJUKAN");
    await satuBarisTimeline(f.proposalId, {
      dari: "MENUNGGU_LPJ",
      ke: "LPJ_DIAJUKAN",
      aksi: "AJUKAN_LPJ",
      oleh: d.userId.maker,
      catatan: null,
    });
  }, 30_000);

  test("LPJ_DIAJUKAN -> SELESAI lewat VERIFIKASI_LPJ [terminal]", async () => {
    // THIS TEST USED TO ASSERT IZIN_BELUM_TERDAFTAR, because
    // `nonpumk.lpj.verifikasi` was not in the shipped catalogue and no role
    // could hold it, not even Admin Pusat. It was filed as a standing demand
    // rather than worked around (the pin is in ./nonpumk-fixture.test.ts), the
    // catalogue owner added the code and granted it to CHECKER, and the edge is
    // now an ordinary transition.
    //
    // The default fixture leaves NO remainder, so this stays a pure
    // state-machine assertion. The return journal and its ledger effect belong
    // to ./nonpumk-lpj.test.ts, which is where scenario 9 lives.
    const f = await d.siapkanProposal("LPJ_DIAJUKAN");
    expect(f.sisaDikembalikan).toBe("0.00");

    const lpj = await engine.verifikasiLpj(
      { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU },
      d.ctx.checker,
    );
    expect(lpj.status).toBe("DIVERIFIKASI");
    // WHO accepted it and WHEN, which is what spec 4.5's verified_by /
    // verified_at exist for and what nonpumk_lpj_verifikasi_ck insists on.
    expect(lpj.verifiedBy).toBe(d.userId.checker);
    expect(lpj.verifiedAt).toBeTruthy();
    expect((await d.bacaProposal(f.proposalId)).status).toBe("SELESAI");

    await satuBarisTimeline(f.proposalId, {
      dari: "LPJ_DIAJUKAN",
      ke: "SELESAI",
      aksi: "VERIFIKASI_LPJ",
      oleh: d.userId.checker,
      catatan: null,
    });
    // Nothing to return, so nothing posted.
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("LPJ_DIAJUKAN -> LPJ_DITOLAK lewat TOLAK_LPJ, dengan catatan wajib", async () => {
    // The other half of what used to be a pair of fail-closed assertions. A
    // rejection whose reason is optional is a rejection the recipient cannot
    // act on, so the note is mandatory here exactly as it is on the four
    // proposal-side rejections.
    const f = await d.siapkanProposal("LPJ_DIAJUKAN", { jumlahRealisasi: rp(25_000_000) });
    await tolakDengan(() => jalankanAksi("TOLAK_LPJ", f, null), KODE_NONPUMK.CATATAN_WAJIB);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("LPJ_DIAJUKAN");

    const p = await engine.tolakLpj(
      {
        proposalId: f.proposalId,
        tanggal: TANGGAL_LPJ_BAKU,
        catatan: "Bukti pengeluaran tidak lengkap",
      },
      d.ctx.checker,
    );
    expect(p.status).toBe("LPJ_DITOLAK");
    const lpj = await d.bacaLpj(f.proposalId);
    expect(lpj[0].status).toBe("DITOLAK");
    // A rejected LPJ was never accepted, so it carries no verifier and no
    // return journal: the remainder is still with the recipient.
    expect(lpj[0].verified_by).toBeNull();
    expect(lpj[0].jurnal_id_pengembalian).toBeNull();
    expect(jurnal.panggilan).toHaveLength(0);

    await satuBarisTimeline(f.proposalId, {
      dari: "LPJ_DIAJUKAN",
      ke: "LPJ_DITOLAK",
      aksi: "TOLAK_LPJ",
      oleh: d.userId.checker,
      catatan: "Bukti pengeluaran tidak lengkap",
    });
  }, 30_000);

  test("LPJ_DITOLAK -> LPJ_DIAJUKAN lewat AJUKAN_LPJ, memperbarui LPJ yang sama", async () => {
    // The spec's own parenthesis. nonpumk_lpj_proposal_uq allows one live LPJ
    // per proposal, so a resubmission UPDATES it; the timeline carries the
    // history of the loop.
    const f = await d.siapkanProposal("LPJ_DITOLAK", { jumlahRealisasi: rp(25_000_000) });
    const lagi = await engine.ajukanLpj(
      {
        proposalId: f.proposalId,
        tanggalLpj: "2026-07-05",
        jumlahRealisasi: rp(28_000_000),
        penerimaManfaatAktual: 110,
        uraianRealisasi: "Bukti pengeluaran dilengkapi",
      },
      d.ctx.maker,
    );
    expect(lagi.status).toBe("DIAJUKAN");
    expect(lagi.jumlahRealisasi).toBe(rp(28_000_000));
    expect((await d.bacaProposal(f.proposalId)).status).toBe("LPJ_DIAJUKAN");

    const lpj = await d.bacaLpj(f.proposalId);
    expect(lpj).toHaveLength(1);
    expect(lpj[0].jumlah_realisasi).toBe(rp(28_000_000));
    expect(lpj[0].penerima_manfaat_aktual).toBe(110);

    await satuBarisTimeline(f.proposalId, {
      dari: "LPJ_DITOLAK",
      ke: "LPJ_DIAJUKAN",
      aksi: "AJUKAN_LPJ",
      oleh: d.userId.maker,
      catatan: null,
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("penolakan state machine", () => {
  test("status terminal menolak setiap aksi dengan STATUS_TERMINAL", async () => {
    // TIDAK_DIREKOMENDASIKAN, DITOLAK and SELESAI have no outgoing edge. A
    // reopened rejection is a new proposal, not a resurrected one, and a closed
    // grant is closed: reopening SELESAI would let a verified LPJ be replaced
    // after its return journal was posted.
    for (const status of ["TIDAK_DIREKOMENDASIKAN", "DITOLAK", "SELESAI"] as const) {
      const f = await d.siapkanProposal(status);
      for (const aksi of ["AJUKAN_PENILAIAN", "REKOMENDASI", "SETUJU", "PENYALURAN", "AJUKAN_LPJ"] as const) {
        await tolakDengan(() => jalankanAksi(aksi, f, CATATAN), KODE_NONPUMK.STATUS_TERMINAL);
      }
      expect((await d.bacaProposal(f.proposalId)).status).toBe(status);
      expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
    }
    expect(jurnal.panggilan).toHaveLength(0);
  }, 60_000);

  test("aksi dari status yang salah ditolak dengan TRANSISI_TIDAK_VALID, tanpa mengubah apa pun", async () => {
    // A representative slice of the (status, aksi) pairs the table does NOT
    // contain. Each one is a real mis-click or a replayed request.
    const kasus: Array<[StatusProposalNonPumk, AksiNonPumk]> = [
      ["DRAFT", "REKOMENDASI"],
      ["DRAFT", "SETUJU"],
      ["DRAFT", "PENYALURAN"],
      ["PENILAIAN", "REKOMENDASI"],
      ["REVIEW_CHECKER", "TOLAK"],
      ["MENUNGGU_PERSETUJUAN", "REKOMENDASI"],
      ["DISETUJUI", "TUTUP_PENYALURAN"],
      ["DISETUJUI", "AJUKAN_LPJ"],
      ["DISALURKAN", "AJUKAN_LPJ"],
      ["MENUNGGU_LPJ", "PENYALURAN"],
      ["MENUNGGU_LPJ", "TUTUP_PENYALURAN"],
      ["LPJ_DIAJUKAN", "AJUKAN_LPJ"],
      ["LPJ_DITOLAK", "PENYALURAN"],
    ];
    for (const [status, aksi] of kasus) {
      const f = await d.siapkanProposal(status);
      await tolakDengan(() => jalankanAksi(aksi, f, CATATAN), KODE_NONPUMK.TRANSISI_TIDAK_VALID);
      expect((await d.bacaProposal(f.proposalId)).status).toBe(status);
      expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
    }
  }, 120_000);

  test("DISETUJUI -> AJUKAN_LPJ ditolak: tidak ada uang yang keluar untuk dipertanggungjawabkan", async () => {
    // Called out on its own because it is the one invalid pair a plausible
    // implementation gets wrong: an LPJ over zero disbursement satisfies
    // TJSL-NPK-003 arithmetically (0 + 0 = 0) and would close a grant that never
    // happened.
    const f = await d.siapkanProposal("DISETUJUI");
    await tolakDengan(() => jalankanAksi("AJUKAN_LPJ", f, null), KODE_NONPUMK.TRANSISI_TIDAK_VALID);
    expect(await d.bacaLpj(f.proposalId)).toHaveLength(0);
  });

  test("kelima transisi penolakan menolak catatan kosong dengan CATATAN_WAJIB", async () => {
    // "Catat siapa, kapan, CATATAN APA." A rejection with no reason is the
    // complaint the timeline exists to answer, so every edge marked
    // catatanWajib must refuse null AND whitespace.
    for (const kosong of [null, "", "   "]) {
      const a = await d.siapkanProposal("REVIEW_CHECKER");
      await tolakDengan(() => jalankanAksi("TIDAK_REKOMENDASI", a, kosong), KODE_NONPUMK.CATATAN_WAJIB);
      expect((await d.bacaProposal(a.proposalId)).status).toBe("REVIEW_CHECKER");

      const b = await d.siapkanProposal("REVIEW_CHECKER");
      await tolakDengan(() => jalankanAksi("MINTA_PERBAIKAN", b, kosong), KODE_NONPUMK.CATATAN_WAJIB);

      const c = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
      await tolakDengan(() => jalankanAksi("TOLAK", c, kosong), KODE_NONPUMK.CATATAN_WAJIB);

      const e = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
      await tolakDengan(() => jalankanAksi("KEMBALIKAN", e, kosong), KODE_NONPUMK.CATATAN_WAJIB);

      // Nothing was written on any of the four: no review row, no approval row,
      // no timeline row.
      expect(await d.bacaReview(a.proposalId)).toHaveLength(0);
      expect(await d.bacaTransisi(c.proposalId)).toHaveLength(0);
      expect(await d.bacaApproval(c.proposalId)).toHaveLength(0);
    }
  }, 120_000);

  test("transisi yang tidak mewajibkan catatan tetap menerima null", async () => {
    // The mirror of the rule above: AJUKAN_PENILAIAN, REKOMENDASI and SETUJU are
    // not confessions, so a null note must not be turned into a mandatory one.
    const f = await d.siapkanProposal("REVIEW_CHECKER");
    const p = await engine.review(
      { proposalId: f.proposalId, tanggal: "2026-03-20", keputusan: "REKOMENDASI", catatan: null },
      d.ctx.checker,
    );
    expect(p.status).toBe("MENUNGGU_PERSETUJUAN");
    expect((await d.bacaTransisi(f.proposalId))[0].catatan).toBeNull();
  });

  test("REKOMENDASI di bawah skor minimum ditolak, dan ambangnya dibaca dari konfigurasi", async () => {
    // Spec 5's preamble makes the threshold the client's decision, so this
    // asserts the MECHANIC (change the row, change the outcome) and never that
    // 70 is the right number.
    const rendah = await d.siapkanProposal("REVIEW_CHECKER", { skorTotal: "65.000000" });
    await d.denganKonfigurasi("batasan", "skor_penilaian_minimum_lolos_non_pumk", "70", () =>
      tolakDengan(() => jalankanAksi("REKOMENDASI", rendah, null), KODE_NONPUMK.SKOR_DIBAWAH_MINIMUM),
    );

    // Same score, lower threshold: now it passes. That is the mechanic.
    const lagi = await d.siapkanProposal("REVIEW_CHECKER", { skorTotal: "65.000000" });
    const p = await d.denganKonfigurasi("batasan", "skor_penilaian_minimum_lolos_non_pumk", "60", () =>
      engine.review(
        { proposalId: lagi.proposalId, tanggal: "2026-03-20", keputusan: "REKOMENDASI", catatan: null },
        d.ctx.checker,
      ),
    );
    expect(p.status).toBe("MENUNGGU_PERSETUJUAN");
  }, 30_000);

  test("konfigurasi yang tidak bisa diurai ditolak dengan KONFIGURASI_TIDAK_VALID, bukan NaN diam diam", async () => {
    // Fail closed. A threshold that parses to NaN makes every comparison false
    // and quietly disables the check, which is worse than an outage.
    const f = await d.siapkanProposal("REVIEW_CHECKER");
    await d.denganKonfigurasi("batasan", "skor_penilaian_minimum_lolos_non_pumk", "tujuh puluh", () =>
      tolakDengan(() => jalankanAksi("REKOMENDASI", f, null), KODE_NONPUMK.KONFIGURASI_TIDAK_VALID),
    );
  });

  test("SETUJU tanpa nilai disetujui ditolak dengan NILAI_DISETUJUI_WAJIB, sebelum constraint DB", async () => {
    // nonpumk_approval_setuju_ck already refuses this, and that is the point:
    // the caller must see a domain error, not a constraint name. Without the
    // amount there is no disbursement ceiling and TJSL-NPK-001 would refuse
    // every later termin with a message about a proposal id.
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const err = await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          { proposalId: f.proposalId, tanggal: "2026-04-01", keputusan: "SETUJU", jumlahDisetujui: null },
          d.ctx.approver,
        ),
      KODE_NONPUMK.NILAI_DISETUJUI_WAJIB,
    );
    expect(err.message).not.toContain("nonpumk_approval_setuju_ck");
    expect(await d.bacaApproval(f.proposalId)).toHaveLength(0);
  });

  test("SETUJU di atas nilai yang diajukan ditolak: approver boleh memotong, bukan menaikkan", async () => {
    // Spec 9.1's approval page lets the approver CHANGE the amount, and in
    // practice that means cut it. Granting more than was asked for is not a
    // decision on this proposal, it is a different proposal, and it would let a
    // grant exceed what the applicant documented and the checker reviewed.
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN", { jumlahDiajukan: rp(20_000_000) });
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: f.proposalId,
            tanggal: "2026-04-01",
            keputusan: "SETUJU",
            jumlahDisetujui: rp(20_000_001),
          },
          d.ctx.approver,
        ),
      KODE_NONPUMK.NILAI_DISETUJUI_MELEBIHI_PENGAJUAN,
    );
    // AT the boundary the other way: exactly the requested amount is fine.
    const sama = await d.siapkanProposal("MENUNGGU_PERSETUJUAN", { jumlahDiajukan: rp(20_000_000) });
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: sama.proposalId,
        tanggal: "2026-04-01",
        keputusan: "SETUJU",
        jumlahDisetujui: rp(20_000_000),
      },
      d.ctx.approver,
    );
    expect(p.jumlahDisetujui).toBe(rp(20_000_000));
  }, 30_000);

  test("proposal yang tidak ada ditolak dengan PROPOSAL_TIDAK_DITEMUKAN", async () => {
    const hantu = "00000000-0000-4000-8000-000000000001";
    await tolakDengan(
      () => engine.ajukanPenilaian(hantu, null, d.ctx.maker),
      KODE_NONPUMK.PROPOSAL_TIDAK_DITEMUKAN,
    );
    await tolakDengan(() => engine.timeline(hantu, d.ctx.maker), KODE_NONPUMK.PROPOSAL_TIDAK_DITEMUKAN);
    await tolakDengan(() => engine.ringkasan(hantu, d.ctx.maker), KODE_NONPUMK.PROPOSAL_TIDAK_DITEMUKAN);
  });
});

// ---------------------------------------------------------------------------
// The timeline as a read model
// ---------------------------------------------------------------------------

describe("timeline (spec 9.2)", () => {
  test("timeline() mengembalikan seluruh riwayat urut lama ke baru, dengan siapa kapan catatan apa", async () => {
    const f = await d.siapkanProposal("DRAFT");
    await engine.ajukanPenilaian(f.proposalId, "Berkas lengkap", d.ctx.maker);
    await engine.inputPenilaian(
      {
        proposalId: f.proposalId,
        tanggal: "2026-03-12",
        petugasKaryawanId: d.karyawanId,
        hasil: { kelayakan: 80, urgensi: 80, dampak: 80, kesesuaian_bidang: 80, kesesuaian_sdg: 80 },
        skorTotal: "80.000000",
        nilaiRekomendasi: DISETUJUI_BAKU,
        catatan: "Penilaian selesai",
      },
      d.ctx.maker,
    );
    await engine.review(
      { proposalId: f.proposalId, tanggal: "2026-03-20", keputusan: "REKOMENDASI", catatan: null },
      d.ctx.checker,
    );
    await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: "2026-04-01",
        keputusan: "SETUJU",
        jumlahDisetujui: DISETUJUI_BAKU,
        catatan: "Setuju",
      },
      d.ctx.approver,
    );

    const timeline = await engine.timeline(f.proposalId, d.ctx.maker);
    expect(timeline.map((t) => t.aksi)).toEqual([
      "AJUKAN_PENILAIAN",
      "INPUT_PENILAIAN",
      "REKOMENDASI",
      "SETUJU",
    ]);
    expect(timeline.map((t) => t.statusKe)).toEqual([
      "PENILAIAN",
      "REVIEW_CHECKER",
      "MENUNGGU_PERSETUJUAN",
      "DISETUJUI",
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
      d.userId.checker,
      d.userId.approver,
    ]);
    expect(timeline.map((t) => t.catatan)).toEqual(["Berkas lengkap", "Penilaian selesai", null, "Setuju"]);
  }, 30_000);

  test("waktu transisi diambil dari jam yang disuntikkan, bukan dari jam dinding", async () => {
    // `NonPumkEngineDeps.jam` exists so a test is not hostage to the wall clock,
    // and so a backdated import can be recorded honestly. An engine that lets
    // the column default to now() makes both impossible, and the difference is
    // invisible in any assertion that only checks "is a date". The LPJ ageing of
    // spec 9.2 is measured against the same clock, so this is not cosmetic.
    const f = await d.siapkanProposal("DRAFT");
    await engine.ajukanPenilaian(f.proposalId, null, d.ctx.maker);
    const baris = await d.bacaTransisi(f.proposalId);
    expect(baris).toHaveLength(1);
    expect(Date.parse(baris[0].waktu)).toBe(d.jam().getTime());
  });

  test("transisi yang ditolak tidak meninggalkan jejak di timeline", async () => {
    // The timeline is what an auditor reads. A refused attempt is an audit-log
    // entry (spec 2 rule 5), not a state transition, and putting it here would
    // make the chain above stop being a chain.
    const f = await d.siapkanProposal("DRAFT");
    await tolakDengan(() => jalankanAksi("SETUJU", f, null), KODE_NONPUMK.TRANSISI_TIDAK_VALID);
    await tolakDengan(() => jalankanAksi("REKOMENDASI", f, null), KODE_NONPUMK.TRANSISI_TIDAK_VALID);
    expect(await engine.timeline(f.proposalId, d.ctx.maker)).toHaveLength(0);
  });
});
