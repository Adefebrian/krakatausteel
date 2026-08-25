// SPEC 9.2's LPJ, AND SCENARIO 9.
//
//   scenario 9  "Input proposal Non PUMK, jalankan sampai disalurkan, submit
//                LPJ dengan realisasi LEBIH KECIL, konfirmasi JURNAL
//                PENGEMBALIAN SISA terbentuk."
//   spec 9.2    "LPJ bisa melaporkan realisasi lebih kecil dari yang
//                disalurkan, SISANYA HARUS DIKEMBALIKAN dan menghasilkan
//                jurnal PENGEMBALIAN_SISA_NON_PUMK."
//   spec 6.4    PENGEMBALIAN_SISA_NON_PUMK: debit Kas, kredit Beban Penyaluran
//                Non PUMK.
//
// THE ASSERTION IS THE LEDGER, NOT THE ROW. `nonpumk_lpj.jumlah_sisa_
// dikembalikan` being 10 juta proves only that somebody typed 10 juta. What
// scenario 9 is really asking is whether the BOOKS now say the programme cost
// what it actually cost: after 40 juta out, 30 juta realised and 10 juta back,
// the net expense must be exactly 30 juta and the net cash movement exactly
// -30 juta. `d.efekBukuBesar` reads that from POSTED journal lines, so a test
// cannot pass by agreeing with a number the module wrote down.
//
// WHY THE REMAINDER IS COMPUTED, NEVER TAKEN FROM THE CALLER.
// trg_nonpumk_lpj_50_rekonsiliasi (TJSL-NPK-003) demands realisasi + sisa =
// total disbursed, and it is DEFERRED, so a form that lets the two disagree
// fails at COMMIT with a plpgsql message. Computing the remainder makes the
// invariant true by construction and leaves the trigger as a backstop rather
// than a validator.
//
// WHY THE JOURNAL IS POSTED AT VERIFICATION AND NOT AT SUBMISSION.
// An LPJ can be rejected (spec 9.2's LPJ_DITOLAK). If filing it moved the
// ledger, every rejection would need a reversal, and spec 6.3 calls reversal
// the correction path for POSTED entries, not a routine step in a
// back-and-forth. So `ajukanLpj` writes the accountability record and
// `verifikasiLpj` moves the money. Scenario 9 still holds end to end, one step
// later; the last test in this file walks it.
//
// THE VERIFICATION BLOCK WAS BLOCKED ON TEMUAN 1, AND IS NOT ANY MORE.
// `verifikasiLpj` and `tolakLpj` need `nonpumk.lpj.verifikasi`, which the
// shipped catalogue did not have, so for a while these tests specified what
// those two operations must DO while every one of them failed closed. That is
// the reason the finding was worth filing rather than working around: the
// specification was already written when the permission landed. The code is now
// in the catalogue and granted to CHECKER, and the whole block runs.
//
// TEMUAN 2 IS DISCHARGED HERE TOO, and it changed what one of these tests
// asserts rather than just whether it passes. The refund's credit leg used to
// be bound to the pooled 5.1.03 while the disbursement debited a per-bidang
// account; it now comes from the payload, so the assertion is no longer "the
// mapping's account" but "the account this grant's disbursement debited". The
// difference only shows for a bidang carrying its own account, which is exactly
// why it survived a review.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createNonPumkEngine, KODE_NONPUMK, type NonPumkEngine } from "./contract";
import {
  buatDunia,
  keSen,
  porterJurnalUji,
  rp,
  tolakDengan,
  DISETUJUI_BAKU,
  PENERIMA_AKTUAL_BAKU,
  PENERIMA_ESTIMASI_BAKU,
  PESAN_JURNAL_GAGAL,
  REALISASI_BAKU,
  SISA_BAKU,
  TANGGAL_LPJ_BAKU,
  TANGGAL_PENYALURAN_BAKU,
  type DuniaNonPumk,
  type PorterJurnalUji,
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

function lpjInput(proposalId: string, realisasi: string, penerima = PENERIMA_AKTUAL_BAKU) {
  return {
    proposalId,
    tanggalLpj: TANGGAL_LPJ_BAKU,
    jumlahRealisasi: realisasi,
    penerimaManfaatAktual: penerima,
    uraianRealisasi: "Realisasi kegiatan sesuai proposal",
  };
}

/**
 * The account the refund must CREDIT: the one this proposal's last live termin
 * DEBITED, read from the business row.
 *
 * This used to read `akun_kredit_id` off the mapping, because the shipped row
 * bound the credit to the pooled 5.1.03. That was TEMUAN 2: a payload leg that
 * is not mirrored by its reverse. The corrected row carries
 * `kredit_dari_payload = true` and no account at all, so the old helper now
 * returns null and asserting against it would assert nothing. ADR 0004 still
 * holds and is why this reads a ROW rather than naming "5.1.03": the mapping is
 * data, and a literal here would be a second, silently diverging copy of it.
 */
async function akunKreditPengembalian(proposalId: string): Promise<string> {
  const baris = await d.db.query<{ akun_beban_id: string }>(
    `select akun_beban_id::text as akun_beban_id from nonpumk_penyaluran
      where proposal_id = $1 and deleted_at is null order by termin desc limit 1`,
    [proposalId],
  );
  expect(baris.length).toBeGreaterThan(0);
  return baris[0].akun_beban_id;
}

// ---------------------------------------------------------------------------
// Filing the LPJ
// ---------------------------------------------------------------------------

describe("ajukan LPJ (spec 9.2, spec 4.5)", () => {
  test("realisasi penuh: sisa nol, tidak ada jurnal, status DIAJUKAN", async () => {
    const f = await d.siapkanProposal("MENUNGGU_LPJ");
    const lpj = await engine.ajukanLpj(lpjInput(f.proposalId, f.totalDisalurkan), d.ctx.maker);

    expect(lpj.status).toBe("DIAJUKAN");
    expect(lpj.jumlahRealisasi).toBe(f.totalDisalurkan);
    expect(lpj.jumlahSisaDikembalikan).toBe("0.00");
    expect(lpj.jurnalIdPengembalian).toBeNull();
    expect(lpj.verifiedBy).toBeNull();
    // Filing an accountability report moves no money, whatever the numbers say.
    expect(jurnal.panggilan).toHaveLength(0);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("LPJ_DIAJUKAN");
  }, 30_000);

  test("realisasi lebih kecil: sisa DIHITUNG engine, bukan diambil dari pemanggil", async () => {
    // The caller never supplies the remainder, so the two numbers cannot
    // disagree. The DEFERRED TJSL-NPK-003 then has nothing left to catch, which
    // is the point: a constraint that never fires is a constraint that never
    // reaches a user as a plpgsql string.
    const f = await d.siapkanProposal("MENUNGGU_LPJ");
    const lpj = await engine.ajukanLpj(lpjInput(f.proposalId, REALISASI_BAKU), d.ctx.maker);

    expect(lpj.jumlahRealisasi).toBe(REALISASI_BAKU);
    expect(lpj.jumlahSisaDikembalikan).toBe(SISA_BAKU);
    expect(keSen(lpj.jumlahRealisasi) + keSen(lpj.jumlahSisaDikembalikan)).toBe(
      keSen(f.totalDisalurkan),
    );

    const db = await d.bacaLpj(f.proposalId);
    expect(db).toHaveLength(1);
    expect(db[0].jumlah_sisa_dikembalikan).toBe(SISA_BAKU);
    expect(db[0].created_by).toBe(d.userId.maker);
    // STILL no journal: the money comes back when the LPJ is accepted.
    expect(jurnal.panggilan).toHaveLength(0);
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe(DISETUJUI_BAKU);
  }, 30_000);

  test("realisasi yang PERSIS sama dengan yang disalurkan diterima: batasnya inklusif", async () => {
    // THE BOUNDARY, permissive side. A grant that spent every rupiah is the
    // normal case, and an engine comparing with >= would refuse it.
    const f = await d.siapkanProposal("MENUNGGU_LPJ", { terminPenyaluran: [rp(25_000_000)] });
    const lpj = await engine.ajukanLpj(lpjInput(f.proposalId, rp(25_000_000)), d.ctx.maker);
    expect(lpj.jumlahSisaDikembalikan).toBe("0.00");
  }, 30_000);

  test("realisasi satu sen di atas yang disalurkan ditolak, sebelum TJSL-NPK-003", async () => {
    // THE BOUNDARY, refusing side, one minor unit past it. A realisation larger
    // than what actually left the account is either a typo or an attempt to
    // account for money from somewhere else; either way it would force the
    // computed remainder negative and break the CHECK on the column.
    const f = await d.siapkanProposal("MENUNGGU_LPJ", { terminPenyaluran: [rp(25_000_000)] });
    const err = await tolakDengan(
      () => engine.ajukanLpj(lpjInput(f.proposalId, "25000000.01"), d.ctx.maker),
      KODE_NONPUMK.REALISASI_MELEBIHI_PENYALURAN,
    );
    expect(err.message).not.toContain("TJSL-NPK-003");
    expect(await d.bacaLpj(f.proposalId)).toHaveLength(0);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("MENUNGGU_LPJ");
  }, 30_000);

  test("realisasi nol diterima: dana yang sama sekali tidak terserap harus bisa dilaporkan", async () => {
    // A programme that never ran is exactly the case the return journal exists
    // for, so refusing zero would make the worst outcome the one the system
    // cannot record.
    const f = await d.siapkanProposal("MENUNGGU_LPJ", { terminPenyaluran: [rp(25_000_000)] });
    const lpj = await engine.ajukanLpj(lpjInput(f.proposalId, "0.00", 0), d.ctx.maker);
    expect(lpj.jumlahRealisasi).toBe("0.00");
    expect(lpj.jumlahSisaDikembalikan).toBe(rp(25_000_000));
  }, 30_000);

  test("penerima manfaat AKTUAL wajib diisi, dan boleh berbeda dari estimasi", async () => {
    // Spec 9.2 puts the estimate on the proposal and the ACTUAL on the LPJ
    // precisely so the two can be compared. An LPJ that may omit it makes the
    // comparison impossible for exactly the programmes that under-delivered.
    const f = await d.siapkanProposal("MENUNGGU_LPJ");
    await tolakDengan(
      () =>
        engine.ajukanLpj(
          {
            proposalId: f.proposalId,
            tanggalLpj: TANGGAL_LPJ_BAKU,
            jumlahRealisasi: f.totalDisalurkan,
            penerimaManfaatAktual: undefined as unknown as number,
          },
          d.ctx.maker,
        ),
      KODE_NONPUMK.PENERIMA_MANFAAT_WAJIB,
    );
    await tolakDengan(
      () => engine.ajukanLpj(lpjInput(f.proposalId, f.totalDisalurkan, -1), d.ctx.maker),
      KODE_NONPUMK.PENERIMA_MANFAAT_WAJIB,
    );
    expect(await d.bacaLpj(f.proposalId)).toHaveLength(0);

    const lpj = await engine.ajukanLpj(lpjInput(f.proposalId, f.totalDisalurkan, 87), d.ctx.maker);
    expect(lpj.penerimaManfaatAktual).toBe(87);

    // Both numbers are visible side by side, which is the whole reason the spec
    // asks for two.
    const r = await engine.ringkasan(f.proposalId, d.ctx.maker);
    expect(r.proposal.penerimaManfaatEstimasi).toBe(PENERIMA_ESTIMASI_BAKU);
    expect(r.lpj?.penerimaManfaatAktual).toBe(87);
  }, 60_000);

  test("satu LPJ per proposal: pengajuan ulang MEMPERBARUI baris yang sama", async () => {
    // nonpumk_lpj_proposal_uq allows one live LPJ per proposal, so a
    // resubmission after LPJ_DITOLAK has to update. A second insert would raise
    // 23505, and the caller must never see that.
    const f = await d.siapkanProposal("LPJ_DITOLAK", { jumlahRealisasi: rp(20_000_000) });
    const lagi = await engine.ajukanLpj(lpjInput(f.proposalId, rp(32_000_000), 99), d.ctx.maker);
    expect(lagi.jumlahRealisasi).toBe(rp(32_000_000));
    expect(lagi.jumlahSisaDikembalikan).toBe(rp(8_000_000));

    const db = await d.bacaLpj(f.proposalId);
    expect(db).toHaveLength(1);
    expect(db[0].status).toBe("DIAJUKAN");
    expect(db[0].penerima_manfaat_aktual).toBe(99);
    // A rejected LPJ never got a return journal, so there is none to clean up.
    expect(db[0].jurnal_id_pengembalian).toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Verification and the return journal (scenario 9)
//
// Driven by the CHECKER, the role that holds `nonpumk.lpj.verifikasi`. It ran
// as Admin Pusat while the code did not exist and every test here failed closed
// with IZIN_BELUM_TERDAFTAR; the grant matrix now answers the question and the
// role that owns the operation drives it, like everywhere else in this folder.
// ---------------------------------------------------------------------------

describe("verifikasi LPJ dan jurnal pengembalian sisa (skenario 9)", () => {
  test("sisa lebih dari nol menghasilkan SATU jurnal PENGEMBALIAN_SISA_NON_PUMK", async () => {
    const f = await d.siapkanProposal("LPJ_DIAJUKAN", { jumlahRealisasi: REALISASI_BAKU });
    const lpj = await engine.verifikasiLpj(
      { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: d.akun.kas.id },
      d.ctx.checker,
    );

    expect(lpj.status).toBe("DIVERIFIKASI");
    expect(lpj.verifiedBy).toBe(d.userId.checker);
    expect(lpj.verifiedAt).toBeTruthy();
    expect(lpj.jurnalIdPengembalian).toBeTruthy();
    expect((await d.bacaProposal(f.proposalId)).status).toBe("SELESAI");

    // ONE journal for one business act.
    expect(jurnal.panggilan).toHaveLength(1);
    const panggilan = jurnal.panggilan[0];
    expect(panggilan.eventCode).toBe("PENGEMBALIAN_SISA_NON_PUMK");
    expect(panggilan.nilai).toBe(SISA_BAKU);
    expect(panggilan.cabangId).toBe(f.cabangId);
    expect(panggilan.referensiTipe).toBe("nonpumk_lpj");
    expect(panggilan.referensiId).toBe(lpj.id);
    // The bidang dimension travels with the return too, or the per-bidang
    // expense report would net the disbursement against nothing.
    expect(panggilan.dimensi?.bidangId).toBe(f.bidangId);

    const header = await d.bacaJurnal(lpj.jurnalIdPengembalian as string);
    expect(header.status).toBe("POSTED");
    expect(header.total_debit).toBe(SISA_BAKU);
    expect(header.total_kredit).toBe(SISA_BAKU);
    expect(header.jalur_posting).toBe("ENGINE");

    // Spec 6.4: cash IN, expense DOWN. The direction matters more than anything
    // else here; reversed, it would double the programme's cost.
    const baris = await d.bacaBarisJurnal(lpj.jurnalIdPengembalian as string);
    expect(baris).toHaveLength(2);
    const debit = baris.find((b) => b.debit !== "0.00");
    const kredit = baris.find((b) => b.kredit !== "0.00");
    expect(debit?.akun_id).toBe(d.akun.kas.id);
    expect(kredit?.akun_id).toBe(await akunKreditPengembalian(f.proposalId));

    // The FK on nonpumk_lpj.jurnal_id_pengembalian is real and non-deferrable.
    expect((await d.bacaLpj(f.proposalId))[0].jurnal_id_pengembalian).toBe(lpj.jurnalIdPengembalian);
  }, 60_000);

  test("EFEK BUKU BESAR: beban bersih = realisasi, kas bersih = minus realisasi", async () => {
    // The assertion scenario 9 is actually about. 40 juta out, 30 juta spent,
    // 10 juta back: the books must say the programme cost 30 juta. A return
    // journal that posted to the wrong side, or to a different expense account,
    // still balances and still produces a plausible-looking row; only this
    // arithmetic catches it.
    const f = await d.siapkanProposal("LPJ_DIAJUKAN", { jumlahRealisasi: REALISASI_BAKU });
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe(DISETUJUI_BAKU);

    await engine.verifikasiLpj(
      { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: d.akun.kas.id },
      d.ctx.checker,
    );

    const efek = await d.efekBukuBesar(f.proposalId);
    expect(efek.beban).toBe(REALISASI_BAKU);
    expect(keSen(efek.kas)).toBe(-keSen(REALISASI_BAKU));

    // And the read model agrees with the ledger.
    const r = await engine.ringkasan(f.proposalId, d.ctx.adminPusat);
    expect(r.bebanBersihBukuBesar).toBe(REALISASI_BAKU);
    expect(keSen(r.kasBersihBukuBesar)).toBe(-keSen(REALISASI_BAKU));
    expect(r.lpj?.jumlahSisaDikembalikan).toBe(SISA_BAKU);
  }, 60_000);

  test("TEMUAN 2 (ditutup): pengembalian mengkredit akun beban BIDANG ITU, bukan akun kolektif", async () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG, and the one the rest of
    // this file could not: every other test here runs on the fixture's default
    // bidang, which rides the pooled 5.1.03, so debiting per bidang and
    // crediting the pool produce identical numbers. The defect only exists for
    // a bidang carrying its OWN expense account, which is what `bidangLain` is
    // for.
    //
    // Under the old mapping this grant's own account would read the full
    // 40 juta while the pooled account carried -10 juta, both journals
    // balancing to the sen and every closing check passing.
    const f = await d.siapkanProposal("MENUNGGU_LPJ", { bidang: d.bidangLain });
    await engine.ajukanLpj(lpjInput(f.proposalId, REALISASI_BAKU), d.ctx.maker);
    const lpj = await engine.verifikasiLpj(
      { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: d.akun.kas.id },
      d.ctx.checker,
    );

    const baris = await d.bacaBarisJurnal(lpj.jurnalIdPengembalian as string);
    const kredit = baris.find((b) => b.kredit !== "0.00");
    expect(kredit?.akun_id).toBe(d.bidangLain.akunBeban.id);
    expect(kredit?.akun_id).not.toBe(d.akun.bebanNonPumk.id);
    // The refund is the reversal of a specific disbursement, so it carries the
    // same bidang dimension the disbursement did.
    expect(kredit?.dimensi_json?.bidangId).toBe(d.bidangLain.id);

    // And the number in the per-bidang report: this bidang's own account nets
    // to exactly the realisation.
    const sendiri = await d.db.query<{ nilai: string }>(
      `select coalesce(sum(b.debit - b.kredit), 0)::numeric(20,2)::text as nilai
         from jurnal_baris b
         join jurnal j on j.id = b.jurnal_id
        where b.akun_id = $1 and j.status = 'POSTED'
          and j.deleted_at is null and b.deleted_at is null
          and j.referensi_id in (
                select id from nonpumk_penyaluran where proposal_id = $2
                union
                select id from nonpumk_lpj where proposal_id = $2)`,
      [d.bidangLain.akunBeban.id, f.proposalId],
    );
    expect(sendiri[0].nilai).toBe(REALISASI_BAKU);
    // The pooled account was never touched by this grant, in either direction.
    const kolektif = await d.db.query<{ n: number }>(
      `select count(*)::int as n from jurnal_baris b
         join jurnal j on j.id = b.jurnal_id
        where b.akun_id = $1 and b.deleted_at is null
          and j.referensi_id in (
                select id from nonpumk_penyaluran where proposal_id = $2
                union
                select id from nonpumk_lpj where proposal_id = $2)`,
      [d.akun.bebanNonPumk.id, f.proposalId],
    );
    expect(kolektif[0].n).toBe(0);
  }, 60_000);

  test("sisa nol tidak menghasilkan jurnal sama sekali", async () => {
    // A balanced pair of zero lines would be refused by validation 6.2.3 anyway,
    // and an empty journal in the buku besar is a row an auditor has to ask
    // about. So the correct number of journals here is zero, not one for
    // symmetry.
    const f = await d.siapkanProposal("LPJ_DIAJUKAN");
    expect(f.sisaDikembalikan).toBe("0.00");

    const lpj = await engine.verifikasiLpj(
      { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU },
      d.ctx.checker,
    );
    expect(lpj.status).toBe("DIVERIFIKASI");
    expect(lpj.jurnalIdPengembalian).toBeNull();
    expect(jurnal.panggilan).toHaveLength(0);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("SELESAI");
    // Expense stays at the full amount, because the full amount was spent.
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe(DISETUJUI_BAKU);
  }, 30_000);

  test("verifikasi dengan sisa tapi tanpa akun kas ditolak: uangnya mendarat di suatu tempat", async () => {
    // The cash leg of the return is a real bank credit, and which account it
    // landed in is not something the module may guess.
    const f = await d.siapkanProposal("LPJ_DIAJUKAN", { jumlahRealisasi: REALISASI_BAKU });
    await tolakDengan(
      () =>
        engine.verifikasiLpj(
          { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: null },
          d.ctx.checker,
        ),
      KODE_NONPUMK.AKUN_KAS_TIDAK_VALID,
    );
    expect((await d.bacaLpj(f.proposalId))[0].status).toBe("DIAJUKAN");
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("jurnal pengembalian gagal membatalkan verifikasi seluruhnya", async () => {
    // Half of this on disk is an LPJ marked DIVERIFIKASI and a grant marked
    // SELESAI while the remainder is still sitting in the recipient's account
    // as far as the books are concerned.
    const f = await d.siapkanProposal("LPJ_DIAJUKAN", { jumlahRealisasi: REALISASI_BAKU });
    jurnal.gagalkan();

    const err = await tolakDengan(
      () =>
        engine.verifikasiLpj(
          { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: d.akun.kas.id },
          d.ctx.checker,
        ),
      KODE_NONPUMK.JURNAL_GAGAL,
    );
    expect(err.message).not.toContain(PESAN_JURNAL_GAGAL);

    const lpj = await d.bacaLpj(f.proposalId);
    expect(lpj[0].status).toBe("DIAJUKAN");
    expect(lpj[0].verified_by).toBeNull();
    expect(lpj[0].jurnal_id_pengembalian).toBeNull();
    expect((await d.bacaProposal(f.proposalId)).status).toBe("LPJ_DIAJUKAN");
    expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
    // The expense is still the full disbursement, untouched.
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe(DISETUJUI_BAKU);
  }, 30_000);

  test("penolakan LPJ mengembalikan ke LPJ_DITOLAK dengan catatan wajib, tanpa jurnal", async () => {
    const f = await d.siapkanProposal("LPJ_DIAJUKAN", { jumlahRealisasi: REALISASI_BAKU });

    // The note is the entire content of a rejection: without it the recipient
    // has nothing to correct.
    for (const kosong of ["", "   "]) {
      await tolakDengan(
        () =>
          engine.tolakLpj(
            { proposalId: f.proposalId, tanggal: TANGGAL_LPJ_BAKU, catatan: kosong },
            d.ctx.checker,
          ),
        KODE_NONPUMK.CATATAN_WAJIB,
      );
    }

    const p = await engine.tolakLpj(
      {
        proposalId: f.proposalId,
        tanggal: TANGGAL_LPJ_BAKU,
        catatan: "Bukti pengeluaran tiga kegiatan belum dilampirkan",
      },
      d.ctx.checker,
    );
    expect(p.status).toBe("LPJ_DITOLAK");

    const lpj = await d.bacaLpj(f.proposalId);
    expect(lpj[0].status).toBe("DITOLAK");
    expect(lpj[0].verified_by).toBeNull();
    // A rejection moves no money, so the remainder stays where it is and the
    // expense stays at the full disbursement.
    expect(jurnal.panggilan).toHaveLength(0);
    expect(lpj[0].jurnal_id_pengembalian).toBeNull();
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe(DISETUJUI_BAKU);

    const transisi = await d.bacaTransisi(f.proposalId);
    expect(transisi).toHaveLength(1);
    expect(transisi[0].aksi).toBe("TOLAK_LPJ");
    expect(transisi[0].oleh_user_id).toBe(d.userId.checker);
    expect(transisi[0].catatan).toBe("Bukti pengeluaran tiga kegiatan belum dilampirkan");
  }, 60_000);

  test("LPJ yang sudah diverifikasi tidak bisa diverifikasi lagi: SELESAI itu terminal", async () => {
    // Otherwise a second verification posts a second return journal for a
    // remainder that already came back.
    const f = await d.siapkanProposal("SELESAI", { jumlahRealisasi: REALISASI_BAKU });
    await tolakDengan(
      () =>
        engine.verifikasiLpj(
          { proposalId: f.proposalId, tanggalVerifikasi: TANGGAL_LPJ_BAKU, akunKasId: d.akun.kas.id },
          d.ctx.checker,
        ),
      KODE_NONPUMK.STATUS_TERMINAL,
    );
    expect(jurnal.panggilan).toHaveLength(0);
    // Still exactly one return journal, from the fixture's own verification.
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe(REALISASI_BAKU);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Scenario 9, end to end
// ---------------------------------------------------------------------------

describe("skenario 9 dari ujung ke ujung", () => {
  test("proposal, penilaian, review, setuju, salurkan, LPJ lebih kecil, verifikasi, jurnal pengembalian", async () => {
    // "Input proposal Non PUMK, jalankan sampai disalurkan, submit LPJ dengan
    // realisasi lebih kecil, konfirmasi jurnal pengembalian sisa terbentuk."
    // Driven entirely through the engine, with the SHIPPED permission matrix and
    // the REAL ledger, because a walkthrough assembled from fixture rows would
    // prove only that the fixture can build the end state.
    const p = await engine.buatProposal(
      {
        cabangId: d.cabangId,
        tanggalProposal: "2026-03-05",
        namaPemohon: "Yayasan Tunas Bangsa",
        bidangId: d.bidang.id,
        sdg: [{ sdgId: d.sdg[1].id }],
        judulProgram: "Beasiswa dan sarana belajar",
        jumlahDiajukan: rp(50_000_000),
        penerimaManfaatEstimasi: 200,
      },
      d.ctx.maker,
    );
    await engine.ajukanPenilaian(p.id, null, d.ctx.maker);
    await engine.inputPenilaian(
      {
        proposalId: p.id,
        tanggal: "2026-03-10",
        petugasKaryawanId: d.karyawanId,
        hasil: { kelayakan: 85, urgensi: 85, dampak: 85, kesesuaian_bidang: 90, kesesuaian_sdg: 90 },
        skorTotal: "87.000000",
        nilaiRekomendasi: rp(40_000_000),
        catatan: null,
      },
      d.ctx.maker,
    );
    await engine.review(
      { proposalId: p.id, tanggal: "2026-03-18", keputusan: "REKOMENDASI", catatan: null },
      d.ctx.checker,
    );
    await engine.putuskanPersetujuan(
      { proposalId: p.id, tanggal: "2026-04-01", keputusan: "SETUJU", jumlahDisetujui: rp(40_000_000) },
      d.ctx.approver,
    );

    // Disbursed in two termin, which is what "bertahap" means in practice.
    await engine.catatPenyaluran(
      {
        proposalId: p.id,
        tanggalPenyaluran: TANGGAL_PENYALURAN_BAKU,
        jumlah: rp(25_000_000),
        akunKasId: d.akun.kas.id,
        akunBebanId: d.bidang.akunBeban.id,
      },
      d.ctx.maker,
    );
    await engine.catatPenyaluran(
      {
        proposalId: p.id,
        tanggalPenyaluran: "2026-05-12",
        jumlah: rp(15_000_000),
        akunKasId: d.akun.kas.id,
        akunBebanId: d.bidang.akunBeban.id,
      },
      d.ctx.maker,
    );
    await engine.tutupPenyaluran(p.id, "Penyaluran selesai", d.ctx.maker);

    // The LPJ reports LESS than what went out.
    const lpj = await engine.ajukanLpj(
      {
        proposalId: p.id,
        tanggalLpj: "2026-06-20",
        jumlahRealisasi: rp(31_500_000),
        penerimaManfaatAktual: 180,
        uraianRealisasi: "Beasiswa 180 siswa, sisa dana dikembalikan",
      },
      d.ctx.maker,
    );
    expect(lpj.jumlahSisaDikembalikan).toBe(rp(8_500_000));

    jurnal.reset();
    const terverifikasi = await engine.verifikasiLpj(
      { proposalId: p.id, tanggalVerifikasi: "2026-06-25", akunKasId: d.akun.bank.id },
      d.ctx.checker,
    );

    // "Konfirmasi jurnal pengembalian sisa terbentuk."
    expect(terverifikasi.jurnalIdPengembalian).toBeTruthy();
    expect(jurnal.panggilan.map((x) => x.eventCode)).toEqual(["PENGEMBALIAN_SISA_NON_PUMK"]);
    const baris = await d.bacaBarisJurnal(terverifikasi.jurnalIdPengembalian as string);
    // Returned into BANK, because that is the account the form named.
    expect(baris.find((b) => b.debit !== "0.00")?.akun_id).toBe(d.akun.bank.id);
    expect(baris.find((b) => b.debit !== "0.00")?.debit).toBe(rp(8_500_000));

    // And the books say the programme cost what it actually cost.
    const efek = await d.efekBukuBesar(p.id);
    expect(efek.beban).toBe(rp(31_500_000));
    expect(keSen(efek.kas)).toBe(-keSen(rp(31_500_000)));

    const r = await engine.ringkasan(p.id, d.ctx.adminPusat);
    expect(r.proposal.status).toBe("SELESAI");
    expect(r.totalDisalurkan).toBe(rp(40_000_000));
    expect(r.sisaPagu).toBe("0.00");
    expect(r.proposal.penerimaManfaatEstimasi).toBe(200);
    expect(r.lpj?.penerimaManfaatAktual).toBe(180);

    // The whole life of the grant is one readable chain.
    const timeline = await engine.timeline(p.id, d.ctx.adminPusat);
    expect(timeline.map((t) => t.aksi)).toEqual([
      "AJUKAN_PENILAIAN",
      "INPUT_PENILAIAN",
      "REKOMENDASI",
      "SETUJU",
      "PENYALURAN",
      "PENYALURAN",
      "TUTUP_PENYALURAN",
      "AJUKAN_LPJ",
      "VERIFIKASI_LPJ",
    ]);
    expect(timeline[timeline.length - 1].statusKe).toBe("SELESAI");
  }, 120_000);
});
