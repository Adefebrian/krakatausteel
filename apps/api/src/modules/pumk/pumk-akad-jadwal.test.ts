// SPEC 9.1 "Halaman persetujuan dengan kemampuan approver MENGUBAH PLAFON DAN
// TENOR dari yang diajukan (ini sering terjadi di praktik)", and scenario 3:
// "Login sebagai Approver, setujui dengan plafon yang DIUBAH dari pengajuan."
//
// THE DEFECT THIS FILE EXISTS TO CATCH. An approver's cut is the easiest thing
// in this whole module to record and then ignore: `pumk_approval` gets the new
// figures, `pumk_akad` is built from `pumk_proposal.jumlah_diajukan` because
// that is the object already in hand, and every screen looks right. The mitra
// signs an akad for an amount nobody approved, the schedule is generated from
// it, and the disbursement journal moves that amount. Nothing in the database
// stops it: `pumk_akad.pokok_pinjaman` has no relationship to
// `pumk_approval.plafon_disetujui` and cannot have one, because the approval
// is nullable and a restructure may legitimately move the principal later
// (ADR 0011). Only a test can hold this.
//
// THE NUMBERS, CHOSEN SO NOTHING NEEDS A CALCULATOR.
//   asked     12.000.000 over 12 months
//   approved   9.000.000 over 18 months, FLAT 3 percent per year, rounding 0
//   schedule   18 rows: pokok 500.000,00, jasa 22.500,00, total 522.500,00
//              (9.000.000 x 3% x 18/12 = 405.000,00 of jasa, 405.000/18 = 22.500)
// Every figure below is either 9.000.000 (approved) or 12.000.000 (asked), so
// a test that reads the wrong one fails loudly instead of by a few rupiah.
//
// THE SCHEDULE IS BUILT BY THE REAL INSTALMENT ENGINE, wrapped in a recorder.
// Invariant 8 says this module never writes a `pumk_jadwal_angsuran` row, and
// invariant 9's "total pokok = pokok pinjaman" is a DEFERRED constraint trigger
// that only fires at COMMIT. A schedule double would satisfy neither, and
// modules/angsuran/test-support.ts records what a double that answers in the
// real engine's place costs.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPumkEngine, KODE_PUMK, type PumkEngine } from "./contract";
import {
  buatDunia,
  keSen,
  porterAngsuranUji,
  porterJurnalUji,
  rp,
  tambahBulan,
  tolakDengan,
  MULAI_ANGSURAN_BAKU,
  POKOK_BAKU,
  RATE_BAKU,
  TANGGAL_AKAD_BAKU,
  TENOR_BAKU,
  type DuniaPumk,
  type PorterAngsuranUji,
  type PorterJurnalUji,
} from "./test-support";

let d: DuniaPumk;
let engine: PumkEngine;
let jurnal: PorterJurnalUji;
let angsuran: PorterAngsuranUji;

/** What the mitra asked for. */
const DIAJUKAN = POKOK_BAKU; // 12.000.000,00
const TENOR_DIAJUKAN = TENOR_BAKU; // 12
/** What the approver actually granted. Different in BOTH dimensions. */
const DISETUJUI = rp(9_000_000);
const TENOR_DISETUJUI = 18;
const POKOK_PER_BARIS = rp(500_000);
const JASA_PER_BARIS = rp(22_500);

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

// ---------------------------------------------------------------------------
// The approval carries the change
// ---------------------------------------------------------------------------

describe("approver mengubah plafon dan tenor (spec 9.1, skenario 3)", () => {
  test("keputusan SETUJU menyimpan plafon dan tenor yang DIUBAH, bukan yang diajukan", async () => {
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN", {
      jumlahDiajukan: DIAJUKAN,
      tenorDiajukan: TENOR_DIAJUKAN,
    });
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: TANGGAL_AKAD_BAKU,
        keputusan: "SETUJU",
        plafonDisetujui: DISETUJUI,
        tenorDisetujui: TENOR_DISETUJUI,
        catatan: "Plafon dipotong menyesuaikan kapasitas usaha",
      },
      d.ctx.approver,
    );
    expect(p.status).toBe("DISETUJUI");

    const approval = await d.bacaApproval(f.proposalId);
    expect(approval).toHaveLength(1);
    expect(approval[0].plafon_disetujui).toBe(DISETUJUI);
    expect(approval[0].tenor_disetujui).toBe(TENOR_DISETUJUI);

    // The REQUEST is history and must survive intact: a report comparing what
    // was asked with what was granted is the point of keeping both.
    const proposal = await d.bacaProposal(f.proposalId);
    expect(proposal.jumlah_diajukan).toBe(DIAJUKAN);
    expect(proposal.tenor_diajukan).toBe(TENOR_DIAJUKAN);
    expect(p.jumlahDiajukan).toBe(DIAJUKAN);
    expect(p.tenorDiajukan).toBe(TENOR_DIAJUKAN);
  });

  test("SETUJU tanpa plafon atau tenor ditolak sebagai KEPUTUSAN_TIDAK_VALID, di depan pumk_approval_setuju_ck", async () => {
    // The CHECK constraint would catch it, but with a raw Postgres string. An
    // approval screen that submits an empty amount is an ordinary mistake and
    // deserves an ordinary message.
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          { proposalId: f.proposalId, tanggal: TANGGAL_AKAD_BAKU, keputusan: "SETUJU" },
          d.ctx.approver,
        ),
      KODE_PUMK.KEPUTUSAN_TIDAK_VALID,
    );
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: f.proposalId,
            tanggal: TANGGAL_AKAD_BAKU,
            keputusan: "SETUJU",
            plafonDisetujui: DISETUJUI,
          },
          d.ctx.approver,
        ),
      KODE_PUMK.KEPUTUSAN_TIDAK_VALID,
    );
    expect(await d.bacaApproval(f.proposalId)).toHaveLength(0);
  });

  test("plafon disetujui di luar batas konfigurasi ditolak, dan batasnya dibaca dari konfigurasi", async () => {
    // docs/REGULASI.md finding 3 and spec 5's preamble: the ceiling is the
    // client's, not this repo's. So the MECHANIC is asserted, never the number.
    await d.setelKonfigurasi("batasan", "plafon_max_pumk", "10000000.00");
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: f.proposalId,
            tanggal: TANGGAL_AKAD_BAKU,
            keputusan: "SETUJU",
            plafonDisetujui: rp(11_000_000),
            tenorDisetujui: TENOR_DIAJUKAN,
          },
          d.ctx.approver,
        ),
      KODE_PUMK.PLAFON_DILUAR_BATAS,
    );

    // Raise the row, the same amount goes through. That is the mechanic.
    await d.setelKonfigurasi("batasan", "plafon_max_pumk", "250000000.00");
    const lagi = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const p = await engine.putuskanPersetujuan(
      {
        proposalId: lagi.proposalId,
        tanggal: TANGGAL_AKAD_BAKU,
        keputusan: "SETUJU",
        plafonDisetujui: rp(11_000_000),
        tenorDisetujui: TENOR_DIAJUKAN,
      },
      d.ctx.approver,
    );
    expect(p.status).toBe("DISETUJUI");
  }, 30_000);

  test("tenor disetujui di luar batas konfigurasi ditolak", async () => {
    await d.setelKonfigurasi("batasan", "tenor_max_bulan", "36");
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: f.proposalId,
            tanggal: TANGGAL_AKAD_BAKU,
            keputusan: "SETUJU",
            plafonDisetujui: DISETUJUI,
            tenorDisetujui: 48,
          },
          d.ctx.approver,
        ),
      KODE_PUMK.TENOR_DILUAR_BATAS,
    );
    await tolakDengan(
      () =>
        engine.putuskanPersetujuan(
          {
            proposalId: f.proposalId,
            tanggal: TANGGAL_AKAD_BAKU,
            keputusan: "SETUJU",
            plafonDisetujui: DISETUJUI,
            tenorDisetujui: 3,
          },
          d.ctx.approver,
        ),
      KODE_PUMK.TENOR_DILUAR_BATAS,
    );
  });
});

// ---------------------------------------------------------------------------
// The akad is built from the approval
// ---------------------------------------------------------------------------

describe("akad dibangun dari APPROVAL, bukan dari proposal (spec 9.1)", () => {
  test("pokok dan tenor akad mengikuti yang disetujui, bukan yang diajukan", async () => {
    const f = await d.siapkanProposal("DISETUJUI", {
      jumlahDiajukan: DIAJUKAN,
      tenorDiajukan: TENOR_DIAJUKAN,
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
    });
    const akad = await engine.buatAkad(
      {
        proposalId: f.proposalId,
        tanggalAkad: TANGGAL_AKAD_BAKU,
        tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
      },
      d.ctx.maker,
    );

    // THE ASSERTION THIS WHOLE FILE IS FOR.
    expect(akad.pokokPinjaman).toBe(DISETUJUI);
    expect(akad.pokokPinjaman).not.toBe(DIAJUKAN);
    expect(akad.tenorBulan).toBe(TENOR_DISETUJUI);
    expect(akad.tenorBulan).not.toBe(TENOR_DIAJUKAN);

    const baris = await d.bacaAkad(akad.id);
    expect(baris.pokok_pinjaman).toBe(DISETUJUI);
    expect(baris.tenor_bulan).toBe(TENOR_DISETUJUI);
    expect(baris.status).toBe("BELUM_CAIR");
    // Not disbursed yet, so nothing is outstanding. The receivable begins at
    // the disbursement, not at the signature.
    expect(baris.outstanding_pokok).toBe("0.00");
    expect(baris.outstanding_jasa).toBe("0.00");
    // TJSL-AKD-001: an akad's branch is its proposal's branch.
    expect(baris.cabang_id).toBe(f.cabangId);
    expect(baris.mitra_id).toBe(f.mitraId);
    expect(baris.no_akad.length).toBeGreaterThan(0);
  });

  test("tanggal jatuh tempo akhir mengikuti tenor yang disetujui", async () => {
    // 18 months from 2026-03-10 is instalment 18 on 2027-08-10, not instalment
    // 12 on 2027-02-10. A date computed from the PROPOSAL's tenor is the same
    // bug as an amount taken from the proposal, and is easy to miss.
    const f = await d.siapkanProposal("DISETUJUI", {
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
    });
    const akad = await engine.buatAkad(
      {
        proposalId: f.proposalId,
        tanggalAkad: TANGGAL_AKAD_BAKU,
        tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
      },
      d.ctx.maker,
    );
    expect(akad.tanggalMulaiAngsuran).toBe(MULAI_ANGSURAN_BAKU);
    expect(akad.tanggalJatuhTempoAkhir).toBe(tambahBulan(MULAI_ANGSURAN_BAKU, TENOR_DISETUJUI - 1));
    expect(akad.tanggalJatuhTempoAkhir).toBe("2027-08-10");
  });

  test("rate akad diambil dari konfigurasi saat approval tidak menyebut rate", async () => {
    // Spec 5.3's rate is contested (docs/REGULASI.md finding 3: FLAT 3 percent
    // contradicts PER-1/MBU/03/2023, and the choice belongs to the client's
    // accounting team). So this asserts THE MECHANIC: the value comes out of
    // `konfigurasi`, and changing the row changes the akad. It deliberately
    // does not assert that any particular rate is correct.
    await d.setelKonfigurasi("jasa_adm", "jasa_adm_rate_default", "0.060000");
    const f = await d.siapkanProposal("DISETUJUI", {
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
      rate: RATE_BAKU,
    });
    // The fixture's approval row carries no rate for this case.
    await d.db.query(`update pumk_approval set jasa_adm_rate = null where proposal_id = $1`, [
      f.proposalId,
    ]);

    const akad = await engine.buatAkad(
      {
        proposalId: f.proposalId,
        tanggalAkad: TANGGAL_AKAD_BAKU,
        tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
      },
      d.ctx.maker,
    );
    expect(akad.jasaAdmRate).toBe("0.060000");
    expect(akad.jasaAdmRate).not.toBe(RATE_BAKU);
    await d.setelKonfigurasi("jasa_adm", "jasa_adm_rate_default", RATE_BAKU);
  });

  test("rate yang ditulis approver menang atas default konfigurasi", async () => {
    // The approver's decision is the more specific fact. If config won here, a
    // concessional rate granted on one file would silently revert.
    await d.setelKonfigurasi("jasa_adm", "jasa_adm_rate_default", "0.030000");
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    await engine.putuskanPersetujuan(
      {
        proposalId: f.proposalId,
        tanggal: TANGGAL_AKAD_BAKU,
        keputusan: "SETUJU",
        plafonDisetujui: DISETUJUI,
        tenorDisetujui: TENOR_DISETUJUI,
        jasaAdmRate: "0.010000",
      },
      d.ctx.approver,
    );
    const akad = await engine.buatAkad(
      {
        proposalId: f.proposalId,
        tanggalAkad: TANGGAL_AKAD_BAKU,
        tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
      },
      d.ctx.maker,
    );
    expect(akad.jasaAdmRate).toBe("0.010000");
  });

  test("metode perhitungan diambil dari konfigurasi saat form akad tidak menyebutnya", async () => {
    await d.setelKonfigurasi("jasa_adm", "jasa_adm_metode_default", "FLAT");
    const f = await d.siapkanProposal("DISETUJUI", {
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
    });
    const akad = await engine.buatAkad(
      {
        proposalId: f.proposalId,
        tanggalAkad: TANGGAL_AKAD_BAKU,
        tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
      },
      d.ctx.maker,
    );
    expect(akad.metodePerhitungan).toBe("FLAT");
  });

  test("grace period di atas batas konfigurasi ditolak dengan GRACE_DILUAR_BATAS", async () => {
    await d.setelKonfigurasi("batasan", "grace_period_max_bulan", "6");
    const f = await d.siapkanProposal("DISETUJUI", {
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
    });
    await tolakDengan(
      () =>
        engine.buatAkad(
          {
            proposalId: f.proposalId,
            tanggalAkad: TANGGAL_AKAD_BAKU,
            tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
            gracePeriodBulan: 9,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.GRACE_DILUAR_BATAS,
    );
    expect(await d.bacaAkadByProposal(f.proposalId)).toBeNull();
  });

  test("tanggal mulai angsuran sebelum tanggal akad ditolak dengan TANGGAL_TIDAK_VALID", async () => {
    // Instalments that begin before the contract is signed produce a schedule
    // whose first rows are already overdue on day one, which then drives
    // kolektibilitas and penyisihan off a fiction.
    const f = await d.siapkanProposal("DISETUJUI", {
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
    });
    await tolakDengan(
      () =>
        engine.buatAkad(
          {
            proposalId: f.proposalId,
            tanggalAkad: TANGGAL_AKAD_BAKU,
            tanggalMulaiAngsuran: "2026-01-10",
          },
          d.ctx.maker,
        ),
      KODE_PUMK.TANGGAL_TIDAK_VALID,
    );
  });

  test("mitra yang sudah punya pinjaman aktif ditolak di depan pumk_akad_satu_aktif_per_mitra_uq", async () => {
    // Spec 5.5. The partial unique index only fires at INSERT time, by which
    // point the operator has typed a whole akad form; and its message is a raw
    // constraint name. The module must refuse cleanly, and the LIMIT must come
    // from configuration because it is a program parameter, not a law.
    await d.setelKonfigurasi("batasan", "maks_pinjaman_aktif_per_mitra", "1");
    const mitra = await d.buatMitra();
    const pertama = await d.siapkanProposal("DICAIRKAN", { mitra });
    expect(await d.dihitungSebagaiPiutangAktif(pertama.akadId as string)).toBe(true);

    const kedua = await d.siapkanProposal("DISETUJUI", { mitra });
    const err = await tolakDengan(
      () =>
        engine.buatAkad(
          {
            proposalId: kedua.proposalId,
            tanggalAkad: TANGGAL_AKAD_BAKU,
            tanggalMulaiAngsuran: MULAI_ANGSURAN_BAKU,
          },
          d.ctx.maker,
        ),
      KODE_PUMK.MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF,
    );
    expect(err.message).not.toContain("pumk_akad_satu_aktif_per_mitra_uq");
    expect(await d.bacaAkadByProposal(kedua.proposalId)).toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The schedule follows the akad, through the real engine
// ---------------------------------------------------------------------------

describe("jadwal mengikuti akad yang disetujui (invarian 8 dan 9)", () => {
  test("jadwal dibangun 18 baris dari pokok 9.000.000, bukan 12 baris dari 12.000.000", async () => {
    await d.setelKonfigurasi("angsuran", "pembulatan_angsuran", "0");
    const f = await d.siapkanProposal("AKAD_DIBUAT", {
      jumlahDiajukan: DIAJUKAN,
      tenorDiajukan: TENOR_DIAJUKAN,
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
      rate: RATE_BAKU,
    });
    const jadwal = await engine.generateJadwal(f.akadId as string, d.ctx.maker);

    expect(jadwal.baris).toHaveLength(TENOR_DISETUJUI);
    expect(jadwal.versi).toBe(1);
    expect(jadwal.isActiveVersion).toBe(true);
    expect(jadwal.ringkasan.totalPokok).toBe(DISETUJUI);
    expect(jadwal.ringkasan.totalJasa).toBe(rp(405_000));
    expect(jadwal.ringkasan.angsuranPerBulan).toBe(rp(522_500));
    // The parameters the engine actually used, echoed back: proof it read the
    // akad rather than its own defaults.
    expect(jadwal.parameterTerpakai.pokok).toBe(DISETUJUI);
    expect(jadwal.parameterTerpakai.tenorBulan).toBe(TENOR_DISETUJUI);

    const baris = await d.bacaJadwal(f.akadId as string);
    expect(baris).toHaveLength(TENOR_DISETUJUI);
    expect(baris[0].pokok).toBe(POKOK_PER_BARIS);
    expect(baris[0].jasa_adm).toBe(JASA_PER_BARIS);
    expect(baris[0].total).toBe(rp(522_500));
    expect(baris[0].tanggal_jatuh_tempo).toBe(MULAI_ANGSURAN_BAKU);
    expect(baris[TENOR_DISETUJUI - 1].tanggal_jatuh_tempo).toBe("2027-08-10");
    expect(baris[TENOR_DISETUJUI - 1].saldo_pokok_setelah).toBe("0.00");

    // Invariant 9, and the DEFERRED trigger TJSL-JDW-001 that enforces it: the
    // schedule sums to the approved principal EXACTLY.
    const total = baris.reduce((acc, b) => acc + keSen(b.pokok), 0n);
    expect(total).toBe(keSen(DISETUJUI));
  }, 30_000);

  test("modul tidak menulis satu baris jadwal pun sendiri, semuanya lewat engine angsuran (invarian 8)", async () => {
    const f = await d.siapkanProposal("AKAD_DIBUAT", {
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
    });
    await engine.generateJadwal(f.akadId as string, d.ctx.maker);
    // Exactly one delegation, with the akad id and nothing else: this module
    // has no schedule arithmetic of its own to pass along.
    expect(angsuran.panggilan).toHaveLength(1);
    expect(angsuran.panggilan[0].metode).toBe("generateJadwal");
    expect(angsuran.panggilan[0].argumen).toEqual({ akadId: f.akadId as string });
  });

  test("jadwal kedua atas akad yang sama ditolak, versi 1 tetap satu-satunya", async () => {
    // Invariant 8: a generated schedule is immutable, and a second version can
    // only come from a reschedule. pumk_jadwal_versi_aktif_uq would catch a
    // second active version, again with a raw constraint name.
    const f = await d.siapkanProposal("JADWAL_SIAP", {
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
    });
    await tolakDengan(
      () => engine.generateJadwal(f.akadId as string, d.ctx.maker),
      KODE_PUMK.TRANSISI_TIDAK_VALID,
    );
    expect(await d.bacaVersi(f.akadId as string)).toHaveLength(1);
    expect(await d.bacaJadwal(f.akadId as string)).toHaveLength(TENOR_DISETUJUI);
  });

  test("kegagalan engine jadwal membatalkan seluruh langkah dan tidak membocorkan teks trigger", async () => {
    // The one thing a double is legitimately for: a collaborator's FAILURE.
    // `gagalkan` throws BEFORE delegating, with a string shaped exactly like a
    // raw TJSL-JDW-001 trigger message, so this asserts both halves at once:
    // the step rolled back, and the raw text did not reach the caller.
    const f = await d.siapkanProposal("AKAD_DIBUAT", {
      plafonDisetujui: DISETUJUI,
      tenorDisetujui: TENOR_DISETUJUI,
    });
    angsuran.gagalkan("generateJadwal");
    const err = await tolakDengan(
      () => engine.generateJadwal(f.akadId as string, d.ctx.maker),
      KODE_PUMK.JADWAL_GAGAL,
    );
    expect(err.message).not.toContain("TJSL-JDW-001");
    // The raw cause is kept, for the log, out of the user's way.
    expect(err.penyebabDb ?? "").toContain("TJSL-JDW-001");

    expect(await d.bacaJadwal(f.akadId as string)).toHaveLength(0);
    expect(await d.bacaVersi(f.akadId as string)).toHaveLength(0);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("AKAD_DIBUAT");
    expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
  });
});
