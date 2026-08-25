// SCENARIO 21: "Submit proposal dari Portal Online, konversi jadi proposal
// internal, konfirmasi DATA TER-COPY DENGAN BENAR."
//
// Spec 9.1 also requires the list to separate them: "Wajib ada tab pemisah:
// Daftar Pemohon (internal) dan Daftar Pemohon Online (dari portal)."
//
// WHAT A CONVERSION IS, AND WHAT IT IS NOT.
// A portal submission is a form filled in by a member of the public. It is
// UNTRUSTED DATA, and migrations/0013 says so in its own comment: "never
// trusted, never used directly by the ledger; the officer retypes/validates it
// into a proposal". So conversion is not a rename and not a status flip. It
// creates an ordinary internal proposal that carries two extra facts,
// `sumber_pengajuan = PORTAL_ONLINE` and `portal_submission_id`, and then runs
// the SAME state machine, through the SAME survey, review and approval, under
// the SAME configuration limits as anything typed in a branch office.
//
// THE TWO DEFECTS THIS FILE IS AIMED AT.
//   1. A conversion that trusts the payload. `data_json` is whatever the public
//      typed, so an amount above the plafon ceiling, a nonsense tenor or a
//      malformed money string must be refused exactly as they would be on the
//      internal form. An engine that copies the numbers straight in has moved
//      the validation boundary outside the building.
//   2. A conversion that loses the link. Without `portal_submission_id` and
//      without the submission moving to DIKONVERSI, the same ticket can be
//      converted twice and the applicant's status page has nothing to point at.
//      `pumk_proposal_portal_uq` catches the duplicate, with a raw constraint
//      name; the module has to refuse first.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPumkEngine, KODE_PUMK, PERMISSION_PUMK, type PumkEngine } from "./contract";
import {
  buatDunia,
  kunci,
  porterAngsuranUji,
  porterJurnalUji,
  rp,
  tolakDengan,
  POKOK_BAKU,
  TANGGAL_PROPOSAL_BAKU,
  TENOR_BAKU,
  type DuniaPumk,
  type PorterAngsuranUji,
  type PorterJurnalUji,
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

beforeEach(async () => {
  jurnal.reset();
  angsuran.reset();
  await d.setelKonfigurasi("batasan", "plafon_min_pumk", "1000000.00");
  await d.setelKonfigurasi("batasan", "plafon_max_pumk", "250000000.00");
  await d.setelKonfigurasi("batasan", "tenor_min_bulan", "6");
  await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
});

afterAll(async () => {
  if (d) await d.tutup();
});

// ---------------------------------------------------------------------------
// The conversion itself
// ---------------------------------------------------------------------------

describe("konversi submission portal (skenario 21, spec 9.5)", () => {
  test("konversi membuat proposal PORTAL_ONLINE yang menunjuk balik ke submission-nya", async () => {
    // `mitra_nik_uq` is global and this fixture is never cleaned up, so the NIK
    // goes through `kunci()` like every other business key here. Hardcoding it
    // makes the test pass once after `db:reset` and raise 23505 on every
    // re-run, i.e. non-repeatable, which is indistinguishable from a flake.
    const nik = kunci("NIK").replace(/\D/g, "").padEnd(16, "0").slice(0, 16);
    const s = await d.buatSubmissionPortal({
      data: {
        nama_lengkap: "Siti Aminah",
        nik,
        telepon: "081200000001",
        email: "siti@example.test",
        nama_usaha: "Warung Siti",
        jumlah_diajukan: rp(8_000_000),
        tenor_diajukan: 18,
        tujuan_penggunaan: "Tambah stok dagangan menjelang lebaran",
      },
    });
    const mitra = await d.buatMitra({ nama: "Siti Aminah", nik });

    const p = await engine.konversiSubmissionPortal(
      {
        submissionId: s.id,
        cabangId: d.cabangId,
        mitraId: mitra.id,
        sektorId: d.sektorId,
        tanggalProposal: TANGGAL_PROPOSAL_BAKU,
        catatanPetugas: "Data cocok dengan KTP terlampir",
      },
      d.ctx.maker,
    );

    // The two facts that make it a portal proposal.
    expect(p.sumberPengajuan).toBe("PORTAL_ONLINE");
    expect(p.portalSubmissionId).toBe(s.id);
    // And it starts at the beginning: no shortcut past survey, review or
    // approval just because it arrived online.
    expect(p.status).toBe("DRAFT");
    expect(p.createdBy).toBe(d.userId.maker);

    const baris = await d.bacaProposal(p.id);
    expect(baris.sumber_pengajuan).toBe("PORTAL_ONLINE");
    expect(baris.portal_submission_id).toBe(s.id);
    expect(baris.cabang_id).toBe(d.cabangId);
    expect(baris.mitra_id).toBe(mitra.id);
    expect(baris.sektor_id).toBe(d.sektorId);

    // The submission is closed out and points forward, so the applicant's
    // status page (spec 9.5) can follow the proposal.
    const submission = await d.bacaSubmission(s.id);
    expect(submission.status).toBe("DIKONVERSI");
    expect(submission.converted_proposal_id).toBe(p.id);

    // Conversion moves no money.
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("DATA TER-COPY DENGAN BENAR: jumlah, tenor dan tujuan datang dari data_json", async () => {
    // The literal words of scenario 21. Values chosen to differ from every
    // default in the fixture, so a conversion that quietly substituted its own
    // defaults would be caught rather than accidentally agreeing.
    const s = await d.buatSubmissionPortal({
      data: {
        nama_lengkap: "Budi Santoso",
        nik: kunci("NIK").replace(/\D/g, "").padEnd(16, "0").slice(0, 16),
        nama_usaha: "Bengkel Budi",
        jumlah_diajukan: rp(7_500_000),
        tenor_diajukan: 24,
        tujuan_penggunaan: "Beli kompresor dan peralatan bengkel",
      },
    });
    const mitra = await d.buatMitra({ nama: "Budi Santoso" });

    const p = await engine.konversiSubmissionPortal(
      {
        submissionId: s.id,
        cabangId: d.cabangId,
        mitraId: mitra.id,
        tanggalProposal: TANGGAL_PROPOSAL_BAKU,
      },
      d.ctx.maker,
    );

    expect(p.jumlahDiajukan).toBe(rp(7_500_000));
    expect(p.jumlahDiajukan).not.toBe(POKOK_BAKU);
    expect(p.tenorDiajukan).toBe(24);
    expect(p.tenorDiajukan).not.toBe(TENOR_BAKU);
    expect(p.tujuanPenggunaan).toBe("Beli kompresor dan peralatan bengkel");

    const baris = await d.bacaProposal(p.id);
    expect(baris.jumlah_diajukan).toBe(rp(7_500_000));
    expect(baris.tenor_diajukan).toBe(24);
    expect(baris.tujuan_penggunaan).toBe("Beli kompresor dan peralatan bengkel");
    // The submission's own payload is untouched: it is the applicant's original
    // statement and the evidence behind the proposal.
    const submission = await d.bacaSubmission(s.id);
    expect(submission.data_json.jumlah_diajukan).toBe(rp(7_500_000));
    expect(submission.data_json.tenor_diajukan).toBe(24);
  }, 30_000);

  test("proposal hasil konversi menjalankan state machine yang sama", async () => {
    // A portal application that could skip survey or review would be a way
    // around the whole control structure of spec 2.
    const s = await d.buatSubmissionPortal();
    const mitra = await d.buatMitra();
    const p = await engine.konversiSubmissionPortal(
      {
        submissionId: s.id,
        cabangId: d.cabangId,
        mitraId: mitra.id,
        tanggalProposal: TANGGAL_PROPOSAL_BAKU,
      },
      d.ctx.maker,
    );

    const lanjut = await engine.submitUntukSurvey(p.id, "Berkas online lengkap", d.ctx.maker);
    expect(lanjut.status).toBe("SURVEY_PENDING");
    expect(lanjut.sumberPengajuan).toBe("PORTAL_ONLINE");

    // The timeline starts at the same place as an internal proposal's.
    const timeline = await engine.timeline(p.id, d.ctx.maker);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].statusDari).toBe("DRAFT");
    expect(timeline[0].aksi).toBe("SUBMIT_SURVEY");
    expect(timeline[0].olehUserId).toBe(d.userId.maker);
  }, 30_000);

  test("daftar proposal memisahkan internal dan portal, sesuai dua tab spec 9.1", async () => {
    const internal = await d.siapkanProposal("DRAFT");
    const s = await d.buatSubmissionPortal();
    const mitra = await d.buatMitra();
    const portal = await engine.konversiSubmissionPortal(
      {
        submissionId: s.id,
        cabangId: d.cabangId,
        mitraId: mitra.id,
        tanggalProposal: TANGGAL_PROPOSAL_BAKU,
      },
      d.ctx.maker,
    );

    const tabPortal = await engine.daftarProposal({ sumberPengajuan: "PORTAL_ONLINE" }, d.ctx.maker);
    expect(tabPortal.map((x) => x.id)).toContain(portal.id);
    expect(tabPortal.map((x) => x.id)).not.toContain(internal.proposalId);
    for (const x of tabPortal) expect(x.sumberPengajuan).toBe("PORTAL_ONLINE");

    const tabInternal = await engine.daftarProposal({ sumberPengajuan: "INTERNAL" }, d.ctx.maker);
    expect(tabInternal.map((x) => x.id)).toContain(internal.proposalId);
    expect(tabInternal.map((x) => x.id)).not.toContain(portal.id);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("penolakan konversi portal", () => {
  test("submission yang sudah dikonversi ditolak, di depan pumk_proposal_portal_uq", async () => {
    // A double click on the officer's screen, or a retried request. The partial
    // unique index would catch the second proposal with a raw constraint name;
    // more importantly, the FIRST proposal must survive untouched.
    const s = await d.buatSubmissionPortal();
    const mitraSatu = await d.buatMitra();
    const pertama = await engine.konversiSubmissionPortal(
      {
        submissionId: s.id,
        cabangId: d.cabangId,
        mitraId: mitraSatu.id,
        tanggalProposal: TANGGAL_PROPOSAL_BAKU,
      },
      d.ctx.maker,
    );

    const mitraDua = await d.buatMitra();
    const err = await tolakDengan(
      () =>
        engine.konversiSubmissionPortal(
          {
            submissionId: s.id,
            cabangId: d.cabangId,
            mitraId: mitraDua.id,
            tanggalProposal: TANGGAL_PROPOSAL_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.SUBMISSION_SUDAH_DIKONVERSI,
    );
    expect(err.message).not.toContain("pumk_proposal_portal_uq");

    const submission = await d.bacaSubmission(s.id);
    expect(submission.converted_proposal_id).toBe(pertama.id);
    const daftar = await engine.daftarProposal({ sumberPengajuan: "PORTAL_ONLINE" }, d.ctx.maker);
    expect(daftar.filter((x) => x.portalSubmissionId === s.id)).toHaveLength(1);
  }, 30_000);

  test("submission NON_PUMK tidak bisa dikonversi jadi proposal PUMK", async () => {
    // Different form, different table, different approval path. Converting one
    // into the other would produce a PUMK proposal whose payload has none of
    // the fields a PUMK proposal needs.
    const s = await d.buatSubmissionPortal({ jenis: "NON_PUMK" });
    const mitra = await d.buatMitra();
    await tolakDengan(
      () =>
        engine.konversiSubmissionPortal(
          {
            submissionId: s.id,
            cabangId: d.cabangId,
            mitraId: mitra.id,
            tanggalProposal: TANGGAL_PROPOSAL_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.SUBMISSION_BUKAN_PUMK,
    );
    expect((await d.bacaSubmission(s.id)).status).toBe("BARU");
  });

  test("submission dengan data tidak lengkap ditolak, bukan diisi diam diam dengan default", async () => {
    // The public form can arrive with anything. Substituting a default here
    // would create a proposal for an amount nobody applied for.
    const kasus: Array<Record<string, unknown>> = [
      { nama_lengkap: "Tanpa jumlah", tenor_diajukan: 12 },
      { nama_lengkap: "Tanpa tenor", jumlah_diajukan: rp(8_000_000) },
      { nama_lengkap: "Kosong sama sekali" },
    ];
    for (const data of kasus) {
      const s = await d.buatSubmissionPortal({ data });
      const mitra = await d.buatMitra();
      await tolakDengan(
        () =>
          engine.konversiSubmissionPortal(
            {
              submissionId: s.id,
              cabangId: d.cabangId,
              mitraId: mitra.id,
              tanggalProposal: TANGGAL_PROPOSAL_BAKU,
            },
            d.ctx.maker,
          ),
        KODE_PUMK.SUBMISSION_DATA_TIDAK_LENGKAP,
      );
      expect((await d.bacaSubmission(s.id)).status).toBe("BARU");
    }
  }, 30_000);

  test("data portal tetap tunduk pada batas konfigurasi yang sama dengan input internal", async () => {
    // The validation boundary is the server, not the form. A ceiling that only
    // applies to what a branch officer types is not a ceiling.
    await d.setelKonfigurasi("batasan", "plafon_max_pumk", "10000000.00");
    const s = await d.buatSubmissionPortal({
      data: {
        nama_lengkap: "Pemohon serakah",
        jumlah_diajukan: rp(90_000_000),
        tenor_diajukan: 12,
        tujuan_penggunaan: "Beli ruko",
      },
    });
    const mitra = await d.buatMitra();
    await tolakDengan(
      () =>
        engine.konversiSubmissionPortal(
          {
            submissionId: s.id,
            cabangId: d.cabangId,
            mitraId: mitra.id,
            tanggalProposal: TANGGAL_PROPOSAL_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.PLAFON_DILUAR_BATAS,
    );

    // Raise the row and the same submission converts. The mechanic, not the
    // number: docs/REGULASI.md leaves the ceiling to the client.
    await d.setelKonfigurasi("batasan", "plafon_max_pumk", "250000000.00");
    const p = await engine.konversiSubmissionPortal(
      {
        submissionId: s.id,
        cabangId: d.cabangId,
        mitraId: mitra.id,
        tanggalProposal: TANGGAL_PROPOSAL_BAKU,
      },
      d.ctx.maker,
    );
    expect(p.jumlahDiajukan).toBe(rp(90_000_000));
  }, 30_000);

  test("jumlah di data_json yang bukan desimal dua angka ditolak (invarian 7)", async () => {
    // Whatever the public typed reaches this field as JSON. "8000000",
    // "8.000.000" and a JSON number are all things a form can produce and none
    // of them is a `Uang`.
    for (const jumlah of ["8000000", "8.000.000,00", 8000000, "8000000.5"]) {
      const s = await d.buatSubmissionPortal({
        data: { nama_lengkap: "Format salah", jumlah_diajukan: jumlah, tenor_diajukan: 12 },
      });
      const mitra = await d.buatMitra();
      await tolakDengan(
        () =>
          engine.konversiSubmissionPortal(
            {
              submissionId: s.id,
              cabangId: d.cabangId,
              mitraId: mitra.id,
              tanggalProposal: TANGGAL_PROPOSAL_BAKU,
            },
            d.ctx.maker,
          ),
        KODE_PUMK.NILAI_BUKAN_DESIMAL,
      );
    }
  }, 30_000);

  test("konversi butuh portal.konversi: Checker dan Auditor ditolak", async () => {
    const s = await d.buatSubmissionPortal();
    const mitra = await d.buatMitra();
    expect(d.ctx.maker.permissions).toContain(PERMISSION_PUMK.KONVERSI_PORTAL);
    for (const ctx of [d.ctx.checker, d.ctx.auditor]) {
      expect(ctx.permissions).not.toContain(PERMISSION_PUMK.KONVERSI_PORTAL);
      await tolakDengan(
        () =>
          engine.konversiSubmissionPortal(
            {
              submissionId: s.id,
              cabangId: d.cabangId,
              mitraId: mitra.id,
              tanggalProposal: TANGGAL_PROPOSAL_BAKU,
            },
            ctx,
          ),
        KODE_PUMK.TIDAK_BERWENANG,
      );
    }
    expect((await d.bacaSubmission(s.id)).status).toBe("BARU");
  }, 30_000);

  test("konversi ke cabang lain ditolak dengan CABANG_DILUAR_SCOPE", async () => {
    // The branch arrives in the payload here too, so the same hole as
    // `buatProposal` is open unless the scope check covers this entry point.
    const s = await d.buatSubmissionPortal();
    const mitra = await d.buatMitra({ cabangId: d.cabangLainId });
    await tolakDengan(
      () =>
        engine.konversiSubmissionPortal(
          {
            submissionId: s.id,
            cabangId: d.cabangLainId,
            mitraId: mitra.id,
            tanggalProposal: TANGGAL_PROPOSAL_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.CABANG_DILUAR_SCOPE,
    );
  });

  test("submission yang tidak ada ditolak dengan SUBMISSION_TIDAK_DITEMUKAN", async () => {
    const mitra = await d.buatMitra();
    await tolakDengan(
      () =>
        engine.konversiSubmissionPortal(
          {
            submissionId: "00000000-0000-4000-8000-000000000007",
            cabangId: d.cabangId,
            mitraId: mitra.id,
            tanggalProposal: TANGGAL_PROPOSAL_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.SUBMISSION_TIDAK_DITEMUKAN,
    );
  });

  test("mitra yang sudah punya pinjaman aktif tetap ditolak walau pengajuannya dari portal", async () => {
    // Spec 5.5 does not have an online exception. The unique index only fires
    // at akad time, three screens later, so the module must refuse here.
    await d.setelKonfigurasi("batasan", "maks_pinjaman_aktif_per_mitra", "1");
    const mitra = await d.buatMitra();
    await d.siapkanProposal("DICAIRKAN", { mitra });
    const s = await d.buatSubmissionPortal();
    await tolakDengan(
      () =>
        engine.konversiSubmissionPortal(
          {
            submissionId: s.id,
            cabangId: d.cabangId,
            mitraId: mitra.id,
            tanggalProposal: TANGGAL_PROPOSAL_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF,
    );
    expect((await d.bacaSubmission(s.id)).status).toBe("BARU");
  }, 30_000);
});
