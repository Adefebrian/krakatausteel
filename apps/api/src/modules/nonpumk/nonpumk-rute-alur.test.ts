// SPEC 16 SCENARIO 9, WALKED THROUGH HTTP.
//
//   "Input proposal Non PUMK, jalankan sampai disalurkan, submit LPJ dengan
//    realisasi lebih kecil, konfirmasi jurnal pengembalian sisa terbentuk."
//
// One grant, from a Maker's first form to a verified LPJ, with every step made
// by a REAL LOGIN of the role that owns it, over the real app from core/app.ts.
// Nothing here calls a service directly and nothing here writes a business row
// in SQL: if a status moves, a route moved it.
//
//   1  Maker files the proposal, with the mandatory bidang and TWO weighted
//      SDG that spec 9.2 requires.
//   2  Maker records the penilaian and its score; the Checker recommends.
//   3  Approver approves WITH A CUT amount, and a raise above what was asked
//      for is refused.
//   4  Two termin, the second landing EXACTLY on the approved amount, and a
//      third of ONE SEN refused BEFORE the ledger is called.
//   5  Staging is closed, the LPJ is filed with a realisation SMALLER than
//      what went out, and filing posts NOTHING.
//   6  The Checker verifies it, and the return journal appears.
//
// AND THE LEDGER, which is the assertion the scenario is really asking for.
// After a grant of X disbursed in full, realised at Y and X - Y returned:
//
//      net expense  ==  Y          net cash  ==  -Y
//
// read from the POSTED ledger through the detail page an officer actually
// opens, not recomputed from the business rows. The `nonpumk_lpj` row on its
// own proves nothing: it is a claim about money, and only the buku besar can
// confirm it.
//
// AND WHICH ACCOUNT THE RETURN CREDITS. Spec 6.4 makes the disbursement's
// expense account PER BIDANG, so the refund's must be the same one. The
// mapping row for PENGEMBALIAN_SISA_NON_PUMK carries `kredit_dari_payload`
// with NO stored default precisely so that account cannot be guessed; the
// engine reads it off the termin. Asserted here on the journal lines, because
// a refund credited to a pooled account balances perfectly and leaves the
// bidang overstated forever.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buatDuniaRuteNonPumk, rp, type DuniaRuteNonPumk, tutupSemuaFixture } from "./rute-test-support";

// Fixture teardown, one call for the whole file. Every `createFixture` in here
// registers itself; this closes them all. Nothing else in this file changed.
// See the FIXTURE LEAK note in apps/api/src/testing/harness.ts.
afterAll(tutupSemuaFixture);

let d: DuniaRuteNonPumk;

// Dates inside the fixture's OPEN periods (2026-01 .. 2028-12).
const TANGGAL_PROPOSAL = "2026-01-05";
const TANGGAL_PENILAIAN = "2026-01-12";
const TANGGAL_REVIEW = "2026-01-15";
const TANGGAL_APPROVAL = "2026-01-20";
const TANGGAL_TERMIN_1 = "2026-02-10";
const TANGGAL_TERMIN_2 = "2026-03-10";
const TANGGAL_LPJ = "2026-05-05";
const TANGGAL_VERIFIKASI = "2026-05-12";

// What the applicant asks for, and what the approver actually grants. They are
// DIFFERENT on purpose: spec 9.2 lets the approver cut, and the ceiling every
// later termin is measured against is the APPROVED figure.
const DIAJUKAN = rp(50_000_000);
const DISETUJUI = rp(40_000_000);
const TERMIN_1 = rp(25_000_000);
// Lands EXACTLY on the ceiling: 25.000.000 + 15.000.000 = 40.000.000. This is
// the final instalment of every fully disbursed grant, and it must succeed.
const TERMIN_2 = rp(15_000_000);
// The realisation, SMALLER than what went out. 8.000.000 comes back.
const REALISASI = rp(32_000_000);
const SISA = rp(8_000_000);

interface Proposal {
  id: string;
  noProposal: string;
  status: string;
  currentStep: number;
  jumlahDiajukan: string;
  jumlahDisetujui: string | null;
}
interface Penyaluran {
  id: string;
  termin: number;
  jumlah: string;
  akunKasId: string;
  akunBebanId: string;
  jurnalId: string;
}
interface Lpj {
  id: string;
  jumlahRealisasi: string;
  jumlahSisaDikembalikan: string;
  status: string;
  verifiedBy: string | null;
  verifiedAt: string | null;
  jurnalIdPengembalian: string | null;
}
interface Detail {
  proposal: Proposal;
  sdg: Array<{ sdgId: string; nomor: number; nama: string; bobot: string }>;
  penilaian: { skorTotal: string | null; nilaiRekomendasi: string | null } | null;
  penyaluran: Penyaluran[];
  totalDisalurkan: string;
  sisaPagu: string;
  lpj: Lpj | null;
  bebanBersihBukuBesar: string;
  kasBersihBukuBesar: string;
  bidangKode: string;
  bidangNama: string;
  cabangNama: string;
}

let proposalId = "";
let jurnalTermin1 = "";
let jurnalTermin2 = "";

const detail = () => d.ok<Detail>("MAKER", `/nonpumk/proposal/${proposalId}`);

beforeAll(async () => {
  d = await buatDuniaRuteNonPumk();
});

describe("spec 16 skenario 9, end to end over HTTP", () => {
  test("langkah 1: Maker mengajukan proposal dengan bidang dan dua SDG berbobot", async () => {
    const proposal = await d.ok<Proposal>("MAKER", "/nonpumk/proposal", {
      body: {
        cabangId: d.f.cabangA.id,
        tanggalProposal: TANGGAL_PROPOSAL,
        namaPemohon: "Yayasan Cahaya Ilmu",
        atasNama: "Yayasan Cahaya Ilmu",
        bidangId: d.bidangA,
        // Spec 9.2: MANDATORY, at least one. Two here, with different weights,
        // because a mapping that is only ever tested with one entry never
        // exercises the weight at all.
        sdg: [
          { sdgId: d.sdg1, bobot: "0.700000" },
          { sdgId: d.sdg2, bobot: "0.300000" },
        ],
        judulProgram: "Renovasi ruang kelas dan bantuan alat belajar",
        deskripsiProgram: "Perbaikan dua ruang kelas dan pengadaan alat belajar",
        jumlahDiajukan: DIAJUKAN,
        penerimaManfaatEstimasi: 180,
      },
    });
    proposalId = proposal.id;

    expect(proposal.status).toBe("DRAFT");
    expect(proposal.currentStep).toBe(1);
    expect(proposal.jumlahDiajukan).toBe(DIAJUKAN);
    // Nothing is approved yet, so there is no ceiling to disburse against.
    expect(proposal.jumlahDisetujui).toBeNull();
    // The document number is the module's, allocated inside the same
    // transaction, and carries this branch's code.
    expect(proposal.noProposal).toContain("PROPOSAL_NON_PUMK");
    expect(proposal.noProposal).toContain(d.f.cabangA.kode);

    const d1 = await detail();
    expect(d1.sdg.map((s) => s.bobot)).toEqual(["0.700000", "0.300000"]);
    // The detail page resolves the ids the form sent into the labels a human
    // reads. A screen showing a uuid where a bidang belongs is a screen nobody
    // can check the mapping on.
    expect(d1.bidangNama.length).toBeGreaterThan(0);
    expect(d1.cabangNama).toBe(d.f.cabangA.nama);
  });

  test("proposal tanpa SDG ditolak di batas, dengan nama medannya", async () => {
    // Spec 9.2 makes the mapping mandatory. Refused at the BOUNDARY as a
    // missing field, so the form can point at it, and again by the engine as
    // SDG_WAJIB for a caller that skips the form.
    const res = await d.panggil("MAKER", "/nonpumk/proposal", {
      body: {
        cabangId: d.f.cabangA.id,
        tanggalProposal: TANGGAL_PROPOSAL,
        namaPemohon: "Yayasan Tanpa SDG",
        bidangId: d.bidangA,
        sdg: [],
        judulProgram: "Program tanpa pemetaan",
        jumlahDiajukan: DIAJUKAN,
        penerimaManfaatEstimasi: 10,
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: Record<string, string[]> };
    expect(body.code).toBe("VALIDASI");
    expect(Object.keys(body.detail)).toContain("sdg");
  });

  test("langkah 2: penilaian dicatat dengan skornya, lalu Checker merekomendasi", async () => {
    await d.ok("MAKER", `/nonpumk/proposal/${proposalId}/ajukan-penilaian`, { body: {} });

    const dinilai = await d.ok<Proposal>("MAKER", `/nonpumk/proposal/${proposalId}/penilaian`, {
      body: {
        tanggal: TANGGAL_PENILAIAN,
        skorTotal: "82.500000",
        nilaiRekomendasi: rp(40_000_000),
        hasil: { kelayakan: 4, urgensi: 5, dampak: 4, kesesuaianBidang: 5, kesesuaianSdg: 4 },
        catatan: "Sekolah aktif, proposal lengkap",
      },
    });
    expect(dinilai.status).toBe("REVIEW_CHECKER");

    const d2 = await detail();
    // The score is TEXT all the way through. It is compared against a
    // configured pass mark in fixed precision, and a float round trip is how a
    // score of 82.5 becomes 82.49999999 and fails a check the operator watched
    // succeed.
    expect(d2.penilaian?.skorTotal).toBe("82.500000");
  });

  test("spec 2 rule 1: yang mengajukan tidak boleh mereview dokumennya sendiri", async () => {
    // PER DOCUMENT, NOT PER ROLE, which is why this needs its own proposal.
    // ADMIN_CABANG legitimately holds `nonpumk.create` AND `nonpumk.review`;
    // what it may not do is review the one file it filed itself. Refused ahead
    // of trg_nonpumk_review_10_sod, whose TJSL-SOD-001 names a user id and a
    // plpgsql function that no branch officer should ever be shown.
    const sendiri = await d.buatProposal({
      peran: "ADMIN_CABANG",
      nama: "Yayasan Diajukan Admin Cabang",
    });
    await d.ok("ADMIN_CABANG", `/nonpumk/proposal/${sendiri.id}/ajukan-penilaian`, { body: {} });
    await d.ok("ADMIN_CABANG", `/nonpumk/proposal/${sendiri.id}/penilaian`, {
      body: { tanggal: TANGGAL_PENILAIAN, skorTotal: "80", nilaiRekomendasi: rp(10_000_000) },
    });

    const res = await d.panggil("ADMIN_CABANG", `/nonpumk/proposal/${sendiri.id}/review`, {
      body: { tanggal: TANGGAL_REVIEW, keputusan: "REKOMENDASI" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; kodeDomain: string; error: string };
    expect(body.code).toBe("SEGREGASI_TUGAS");
    expect(body.kodeDomain).toBe("KONFLIK_MAKER_CHECKER");
    expect(body.error).not.toContain("TJSL-SOD-001");

    // Another holder of the same code is not blocked: the conflict is the
    // document's, not the permission's.
    const olehChecker = await d.panggil("CHECKER", `/nonpumk/proposal/${sendiri.id}/review`, {
      body: { tanggal: TANGGAL_REVIEW, keputusan: "REKOMENDASI" },
    });
    expect(olehChecker.status).toBe(200);
  });

  test("langkah 2b: Checker merekomendasi dan proposal menunggu persetujuan", async () => {
    const direview = await d.ok<Proposal>("CHECKER", `/nonpumk/proposal/${proposalId}/review`, {
      body: { tanggal: TANGGAL_REVIEW, keputusan: "REKOMENDASI", catatan: "Layak didanai" },
    });
    expect(direview.status).toBe("MENUNGGU_PERSETUJUAN");
  });

  test("langkah 3: Approver boleh MEMOTONG nilai, tidak boleh menaikkannya", async () => {
    // A raise is not a decision on THIS proposal: it exceeds what the
    // applicant documented and what the checker reviewed.
    const naik = await d.panggil("APPROVER", `/nonpumk/proposal/${proposalId}/persetujuan`, {
      body: {
        tanggal: TANGGAL_APPROVAL,
        keputusan: "SETUJU",
        jumlahDisetujui: rp(60_000_000),
      },
    });
    expect(naik.status).toBe(400);
    expect(((await naik.json()) as { kodeDomain: string }).kodeDomain).toBe(
      "NILAI_DISETUJUI_MELEBIHI_PENGAJUAN",
    );

    // A SETUJU with no amount at all leaves the staged guard with no ceiling
    // to read, so it is refused before nonpumk_approval_setuju_ck can.
    const kosong = await d.panggil("APPROVER", `/nonpumk/proposal/${proposalId}/persetujuan`, {
      body: { tanggal: TANGGAL_APPROVAL, keputusan: "SETUJU" },
    });
    expect(kosong.status).toBe(400);
    expect(((await kosong.json()) as { kodeDomain: string }).kodeDomain).toBe(
      "NILAI_DISETUJUI_WAJIB",
    );

    const disetujui = await d.ok<Proposal>(
      "APPROVER",
      `/nonpumk/proposal/${proposalId}/persetujuan`,
      {
        body: {
          tanggal: TANGGAL_APPROVAL,
          keputusan: "SETUJU",
          jumlahDisetujui: DISETUJUI,
          catatan: "Disetujui dengan penyesuaian nilai",
        },
      },
    );
    expect(disetujui.status).toBe("DISETUJUI");
    // The cut is copied onto the proposal, because that column is the SINGLE
    // ceiling the staged guard and the deferred TJSL-NPK-002 both read.
    expect(disetujui.jumlahDisetujui).toBe(DISETUJUI);

    const d3 = await detail();
    expect(d3.sisaPagu).toBe(DISETUJUI);
    expect(d3.totalDisalurkan).toBe("0.00");
    // Approving moves no money.
    expect(d3.bebanBersihBukuBesar).toBe("0.00");
    expect(d3.kasBersihBukuBesar).toBe("0.00");
  });

  test("langkah 4: termin pertama dicatat dan menjurnal beban per bidang", async () => {
    const t1 = await d.ok<Penyaluran>("MAKER", `/nonpumk/proposal/${proposalId}/penyaluran`, {
      body: {
        tanggalPenyaluran: TANGGAL_TERMIN_1,
        jumlah: TERMIN_1,
        akunKasId: d.akunKasId,
        // Spec 6.4: the expense account is per bidang and arrives on the form,
        // because the shipped mapping row carries `debit_dari_payload`.
        akunBebanId: d.akunBebanId,
        noBukti: "BKK-2026-0001",
      },
    });
    expect(t1.termin).toBe(1);
    expect(t1.jumlah).toBe(TERMIN_1);
    // A disbursement without a journal is not a disbursement.
    expect(t1.jurnalId).toMatch(/^[0-9a-f-]{36}$/);
    jurnalTermin1 = t1.jurnalId;

    const d4 = await detail();
    expect(d4.proposal.status).toBe("DISALURKAN");
    expect(d4.totalDisalurkan).toBe(TERMIN_1);
    expect(d4.sisaPagu).toBe(rp(15_000_000));
    expect(d4.bebanBersihBukuBesar).toBe(TERMIN_1);
    expect(d4.kasBersihBukuBesar).toBe(`-${TERMIN_1}`);
  });

  test("langkah 4b: termin yang PAS di plafon berhasil", async () => {
    const t2 = await d.ok<Penyaluran>("MAKER", `/nonpumk/proposal/${proposalId}/penyaluran`, {
      body: {
        tanggalPenyaluran: TANGGAL_TERMIN_2,
        jumlah: TERMIN_2,
        akunKasId: d.akunKasId,
        akunBebanId: d.akunBebanId,
        noBukti: "BKK-2026-0002",
      },
    });
    expect(t2.termin).toBe(2);
    jurnalTermin2 = t2.jurnalId;

    const d5 = await detail();
    // Exactly on the ceiling, and accepted: `>` and not `>=` in the guard is
    // the difference between a fully disbursed grant and one that can never
    // pay its last instalment.
    expect(d5.totalDisalurkan).toBe(DISETUJUI);
    expect(d5.sisaPagu).toBe("0.00");
    expect(d5.penyaluran.map((s) => s.termin)).toEqual([1, 2]);
  });

  test("langkah 4c: termin yang melebihi plafon SATU SEN ditolak SEBELUM buku besar disentuh", async () => {
    const sebelumJurnal = await hitungJurnalProposal();
    const sebelumTermin = (await detail()).penyaluran.length;

    const res = await d.panggil("MAKER", `/nonpumk/proposal/${proposalId}/penyaluran`, {
      body: {
        tanggalPenyaluran: TANGGAL_TERMIN_2,
        jumlah: "0.01",
        akunKasId: d.akunKasId,
        akunBebanId: d.akunBebanId,
      },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { kodeDomain: string; error: string };
    expect(body.kodeDomain).toBe("PLAFON_PENYALURAN_TERLAMPAUI");
    // The caller never sees the deferred trigger's own words. TJSL-NPK-002
    // fires at COMMIT and names a proposal uuid and a plpgsql function, which
    // is not something a branch officer can act on.
    expect(body.error).not.toContain("TJSL-NPK-002");

    // AND NOTHING WAS WRITTEN. The refusal happens before the ledger engine is
    // called, so there is no posting for a rollback to undo and no gap in the
    // journal numbering to explain.
    expect(await hitungJurnalProposal()).toBe(sebelumJurnal);
    const sesudah = await detail();
    expect(sesudah.penyaluran.length).toBe(sebelumTermin);
    expect(sesudah.totalDisalurkan).toBe(DISETUJUI);
    expect(sesudah.bebanBersihBukuBesar).toBe(DISETUJUI);
  });

  test("langkah 5: penyaluran ditutup dan LPJ diajukan dengan realisasi LEBIH KECIL", async () => {
    const ditutup = await d.ok<Proposal>(
      "MAKER",
      `/nonpumk/proposal/${proposalId}/tutup-penyaluran`,
      { body: { catatan: "Seluruh termin selesai" } },
    );
    expect(ditutup.status).toBe("MENUNGGU_LPJ");

    // A realisation LARGER than what actually left the account would force the
    // computed remainder negative. Refused ahead of the deferred TJSL-NPK-003.
    const kebesaran = await d.panggil("MAKER", `/nonpumk/proposal/${proposalId}/lpj`, {
      body: {
        tanggalLpj: TANGGAL_LPJ,
        jumlahRealisasi: rp(45_000_000),
        penerimaManfaatAktual: 175,
      },
    });
    expect(kebesaran.status).toBe(400);
    expect(((await kebesaran.json()) as { kodeDomain: string }).kodeDomain).toBe(
      "REALISASI_MELEBIHI_PENYALURAN",
    );

    const jurnalSebelumLpj = await hitungJurnalProposal();

    const lpj = await d.ok<Lpj>("MAKER", `/nonpumk/proposal/${proposalId}/lpj`, {
      body: {
        tanggalLpj: TANGGAL_LPJ,
        jumlahRealisasi: REALISASI,
        penerimaManfaatAktual: 175,
        uraianRealisasi: "Dua ruang kelas selesai, sisa dana dikembalikan",
      },
    });
    expect(lpj.jumlahRealisasi).toBe(REALISASI);
    // COMPUTED, never taken from the caller: the two figures cannot disagree,
    // so the deferred trigger has nothing left to catch.
    expect(lpj.jumlahSisaDikembalikan).toBe(SISA);
    expect(lpj.status).toBe("DIAJUKAN");
    expect(lpj.jurnalIdPengembalian).toBeNull();

    // FILING POSTS NOTHING. An LPJ that can still be rejected must not have
    // moved the ledger, or every rejection needs a reversal.
    expect(await hitungJurnalProposal()).toBe(jurnalSebelumLpj);
    const d6 = await detail();
    expect(d6.proposal.status).toBe("LPJ_DIAJUKAN");
    expect(d6.bebanBersihBukuBesar).toBe(DISETUJUI);
    expect(d6.kasBersihBukuBesar).toBe(`-${DISETUJUI}`);
  });

  test("Maker tidak boleh memverifikasi LPJ yang ia ajukan sendiri", async () => {
    // `nonpumk.lpj.verifikasi` is the Checker's code and not the Maker's, so
    // the person who wrote the accountability report cannot sign it off. This
    // is a PERMISSION refusal, not a state one: the request never reaches the
    // engine.
    const res = await d.panggil("MAKER", `/nonpumk/proposal/${proposalId}/lpj/verifikasi`, {
      body: { tanggalVerifikasi: TANGGAL_VERIFIKASI, akunKasId: d.akunKasId },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("TIDAK_BERWENANG");
  });

  test("langkah 6: Checker memverifikasi, dan JURNAL PENGEMBALIAN SISA terbentuk", async () => {
    const lpj = await d.ok<Lpj>("CHECKER", `/nonpumk/proposal/${proposalId}/lpj/verifikasi`, {
      body: {
        tanggalVerifikasi: TANGGAL_VERIFIKASI,
        // Where the returned money LANDED. Which expense account is credited
        // back is not sent, and must not be: the engine reads it off the
        // termin, because a refund is the reversal of a specific disbursement.
        akunKasId: d.akunKasId,
        catatan: "LPJ lengkap, sisa dana sudah masuk rekening",
      },
    });
    expect(lpj.status).toBe("DIVERIFIKASI");
    expect(lpj.verifiedBy).toBe(d.f.users.CHECKER.id);
    expect(lpj.verifiedAt).not.toBeNull();
    expect(lpj.jurnalIdPengembalian).toMatch(/^[0-9a-f-]{36}$/);

    const d7 = await detail();
    expect(d7.proposal.status).toBe("SELESAI");
    expect(d7.proposal.currentStep).toBe(9);
  });

  test("EFEK BUKU BESAR: beban bersih = realisasi, kas bersih = minus realisasi", async () => {
    const akhir = await detail();
    // THE ASSERTION SCENARIO 9 IS REALLY ASKING FOR. Read from the POSTED
    // ledger, not recomputed from the business rows: 40.000.000 went out,
    // 8.000.000 came back, and what the entity actually spent on this
    // programme is 32.000.000.
    expect(akhir.bebanBersihBukuBesar).toBe(REALISASI);
    expect(akhir.kasBersihBukuBesar).toBe(`-${REALISASI}`);
    // And the business rows agree with the ledger rather than replacing it.
    expect(akhir.totalDisalurkan).toBe(DISETUJUI);
    expect(akhir.lpj?.jumlahRealisasi).toBe(REALISASI);
    expect(akhir.lpj?.jumlahSisaDikembalikan).toBe(SISA);
  });

  test("jurnal pengembalian MENGKREDIT akun beban yang didebit penyaluran, per bidang", async () => {
    const lpjId = (await detail()).lpj!.id;
    const baris = await d.f.db.query<{
      akun_id: string;
      debit: string;
      kredit: string;
      dimensi_json: unknown;
      status: string;
      referensi_tipe: string;
    }>(
      `SELECT b.akun_id::text AS akun_id, b.debit::text AS debit, b.kredit::text AS kredit,
              b.dimensi_json, j.status, j.referensi_tipe
         FROM jurnal j JOIN jurnal_baris b ON b.jurnal_id = j.id
        WHERE j.referensi_tipe = 'nonpumk_lpj' AND j.referensi_id = $1
        ORDER BY b.urutan`,
      [lpjId],
    );
    expect(baris.length).toBe(2);
    for (const r of baris) expect(r.status).toBe("POSTED");

    const kredit = baris.find((r) => r.kredit !== "0.00");
    const debit = baris.find((r) => r.debit !== "0.00");
    // THE CREDIT IS THE ACCOUNT THE DISBURSEMENT DEBITED. Crediting a pooled
    // account instead would balance perfectly and leave this bidang's expense
    // overstated by 8.000.000 with the pooled account negative by the same
    // amount, which no balance check can catch.
    expect(kredit?.akun_id).toBe(d.akunBebanId);
    expect(kredit?.kredit).toBe(SISA);
    // The cash side is where the money landed, which the form did name.
    expect(debit?.akun_id).toBe(d.akunKasId);
    expect(debit?.debit).toBe(SISA);
    // The bidang travels with the return too, or the per-bidang report nets
    // the disbursement against nothing.
    //
    // ON THE EXPENSE LEG ONLY, and that is the ledger engine's rule rather
    // than an omission: an analytic dimension belongs on the leg that carries
    // the economics, not on the cash movement. Putting it on both would make
    // every per-bidang total net itself to zero.
    expect((kredit!.dimensi_json as { bidangId?: string }).bidangId).toBe(d.bidangA);
    expect(debit!.dimensi_json).toEqual({});
  });

  test("kedua jurnal penyaluran mendebit akun beban yang sama, dengan dimensi bidang", async () => {
    const baris = await d.f.db.query<{ akun_id: string; debit: string; dimensi_json: unknown }>(
      `SELECT b.akun_id::text AS akun_id, b.debit::text AS debit, b.dimensi_json
         FROM jurnal_baris b
        WHERE b.jurnal_id = ANY($1::uuid[]) AND b.debit <> 0
        ORDER BY b.urutan`,
      [[jurnalTermin1, jurnalTermin2]],
    );
    expect(baris.length).toBe(2);
    for (const r of baris) {
      expect(r.akun_id).toBe(d.akunBebanId);
      expect((r.dimensi_json as { bidangId?: string }).bidangId).toBe(d.bidangA);
    }
    expect(baris.map((r) => r.debit).sort()).toEqual([TERMIN_1, TERMIN_2].sort());
  });

  test("timeline mencatat setiap transisi dengan pelakunya", async () => {
    const { data } = await d.ok<{
      data: Array<{ statusDari: string | null; statusKe: string; aksi: string; olehUserId: string }>;
    }>("MAKER", `/nonpumk/proposal/${proposalId}/timeline`);

    expect(data.map((t) => t.aksi)).toEqual([
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
    // WHO did each one, so the segregation rules are auditable after the fact
    // and not only enforced at the moment of the click.
    expect(data[2]!.olehUserId).toBe(d.f.users.CHECKER.id);
    expect(data[3]!.olehUserId).toBe(d.f.users.APPROVER.id);
    expect(data[8]!.olehUserId).toBe(d.f.users.CHECKER.id);
    // A terminal state has no outgoing edge.
    expect(data[data.length - 1]!.statusKe).toBe("SELESAI");
  });
});

describe("layar yang dibuka lebih dulu", () => {
  test("GET /nonpumk/batasan membaca konfigurasi, bukan angka yang diketik di kode", async () => {
    const batasan = await d.ok<{
      nilaiMin: string;
      nilaiMax: string;
      skorPenilaianMinimumLolos: string;
      batasHariLpj: number;
      ambangUmurLpj: number[];
    }>("MAKER", "/nonpumk/batasan");

    // The VALUES are the client's decision (migration 0022 ships them as
    // unconfirmed assumptions), so this asserts the MECHANIC and not the
    // number: the row is read, parsed, and the shape is usable by a form.
    const baris = await d.f.db.query<{ kunci: string; nilai: string }>(
      `SELECT kunci, nilai FROM konfigurasi
        WHERE grup = 'batasan' AND bumn_id IS NULL AND deleted_at IS NULL
          AND kunci IN ('nilai_min_non_pumk','nilai_max_non_pumk',
                        'skor_penilaian_minimum_lolos_non_pumk','batas_hari_lpj_non_pumk')`,
    );
    const peta = new Map(baris.map((b) => [b.kunci, b.nilai]));
    expect(peta.size).toBe(4);
    expect(batasan.nilaiMin).toBe(peta.get("nilai_min_non_pumk")!);
    expect(batasan.nilaiMax).toBe(peta.get("nilai_max_non_pumk")!);
    expect(batasan.batasHariLpj).toBe(Number(peta.get("batas_hari_lpj_non_pumk")));
    // The three ageing thresholds are the SPEC's, not a parameter, so they are
    // reported separately from the configurable deadline.
    expect(batasan.ambangUmurLpj).toEqual([30, 60, 90]);
  });

  test("bidang dan SDG yang wajib dipetakan tersedia sebagai daftar", async () => {
    const bidang = await d.ok<{ data: Array<{ id: string; kode: string; nama: string }> }>(
      "MAKER",
      "/nonpumk/bidang",
    );
    // Spec 13 asks for exactly the seven bidang of spec 4.1.
    expect(bidang.data.length).toBe(7);
    expect(bidang.data.some((b) => b.id === d.bidangA)).toBe(true);

    const sdg = await d.ok<{ data: Array<{ id: string; nomor: number }> }>("MAKER", "/nonpumk/sdg");
    expect(sdg.data.length).toBe(17);
    expect(sdg.data.map((s) => s.nomor)).toEqual([...Array(17)].map((_, i) => i + 1));
  });

  test("akun beban yang ditawarkan adalah akun yang mesin memang terima", async () => {
    const { data } = await d.ok<{ data: Array<{ id: string; kode: string }> }>(
      "MAKER",
      "/nonpumk/akun-beban",
    );
    expect(data.some((a) => a.id === d.akunBebanId)).toBe(true);
    // No cash account is ever offered here. Debiting one would produce a
    // perfectly BALANCED journal that moves money between two cash accounts
    // and records no expense at all.
    expect(data.some((a) => a.id === d.akunKasId)).toBe(false);
  });

  test("daftar proposal membawa label bidang, SDG dan status LPJ", async () => {
    const { data } = await d.ok<{
      data: Array<{
        id: string;
        bidangNama: string;
        sdg: Array<{ nomor: number }>;
        totalDisalurkan: string;
        statusLpj: string | null;
        umurHari: number;
      }>;
    }>("MAKER", "/nonpumk/proposal");
    const baris = data.find((b) => b.id === proposalId);
    expect(baris).toBeDefined();
    expect(baris!.bidangNama.length).toBeGreaterThan(0);
    expect(baris!.sdg.length).toBe(2);
    expect(baris!.totalDisalurkan).toBe(DISETUJUI);
    expect(baris!.statusLpj).toBe("DIVERIFIKASI");
    expect(baris!.umurHari).toBeGreaterThanOrEqual(0);
  });

  test("filter bidang, status dan tanggal mempersempit daftar, bukan melebarkannya", async () => {
    const cocok = await d.ok<{ data: Array<{ id: string }> }>(
      "MAKER",
      `/nonpumk/proposal?bidangId=${d.bidangA}&status=SELESAI`,
    );
    expect(cocok.data.some((b) => b.id === proposalId)).toBe(true);

    const bidangLain = await d.ok<{ data: Array<{ id: string }> }>(
      "MAKER",
      `/nonpumk/proposal?bidangId=${d.bidangB}`,
    );
    expect(bidangLain.data.some((b) => b.id === proposalId)).toBe(false);

    const sdgCocok = await d.ok<{ data: Array<{ id: string }> }>(
      "MAKER",
      `/nonpumk/proposal?sdgId=${d.sdg2}`,
    );
    expect(sdgCocok.data.some((b) => b.id === proposalId)).toBe(true);

    const sebelum = await d.ok<{ data: Array<{ id: string }> }>(
      "MAKER",
      "/nonpumk/proposal?sampaiTanggal=2025-12-31",
    );
    expect(sebelum.data.some((b) => b.id === proposalId)).toBe(false);
  });

  test("proposal yang SELESAI tidak muncul di monitoring LPJ", async () => {
    // The dashboard covers the statuses where money is out and no accepted LPJ
    // exists. A finished grant is not a late one, and listing it would be a
    // false accusation in a report that goes to management.
    const { data } = await d.ok<{ data: Array<{ proposalId: string }> }>(
      "MAKER",
      "/nonpumk/monitoring-lpj",
    );
    expect(data.some((b) => b.proposalId === proposalId)).toBe(false);
  });

  test("monitoring LPJ menempatkan penyaluran berumur tepat 30 hari di ember 30_59", async () => {
    // The buckets are half-open on the left (AMBANG_UMUR_LPJ): exactly 30 days
    // old is UMUR_30_59, not UMUR_0_29. An off-by-one here is invisible in
    // every screenshot and wrong in every management report, so the date is
    // computed from today rather than written as a literal.
    const hari30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const p = await siapkanSampaiDisalurkan(rp(10_000_000), hari30, "Yayasan Umur 30 Hari");

    const { data } = await d.ok<{
      data: Array<{
        proposalId: string;
        umurHari: number;
        ember: string;
        terlambat: boolean;
        bidangNama: string;
      }>;
    }>("MAKER", "/nonpumk/monitoring-lpj");
    const baris = data.find((b) => b.proposalId === p);
    expect(baris).toBeDefined();
    expect(baris!.umurHari).toBe(30);
    expect(baris!.ember).toBe("UMUR_30_59");
    // The label the dashboard prints, next to the id the engine returns.
    expect(baris!.bidangNama.length).toBeGreaterThan(0);

    // `terlambat` is the CONFIGURED deadline, not the bucket: at the shipped
    // 60 days a 30 day old grant is not late yet.
    const batas = await d.ok<{ batasHariLpj: number }>("MAKER", "/nonpumk/batasan");
    expect(baris!.terlambat).toBe(30 > batas.batasHariLpj);

    // The bucket filter is a floor, not an equality.
    const dari60 = await d.ok<{ data: Array<{ proposalId: string }> }>(
      "MAKER",
      "/nonpumk/monitoring-lpj?emberMinimal=UMUR_60_89",
    );
    expect(dari60.data.some((b) => b.proposalId === p)).toBe(false);
  });
});

/** How many POSTED journals this proposal has produced, by either reference. */
async function hitungJurnalProposal(): Promise<number> {
  const rows = await d.f.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM jurnal
      WHERE (referensi_tipe = 'nonpumk_penyaluran'
             AND referensi_id IN (SELECT id FROM nonpumk_penyaluran WHERE proposal_id = $1))
         OR (referensi_tipe = 'nonpumk_lpj'
             AND referensi_id IN (SELECT id FROM nonpumk_lpj WHERE proposal_id = $1))`,
    [proposalId],
  );
  return Number(rows[0]!.n);
}

/** A second grant, carried to DISALURKAN over HTTP, for the ageing assertions. */
async function siapkanSampaiDisalurkan(
  jumlah: string,
  tanggalPenyaluran: string,
  nama: string,
): Promise<string> {
  const p = await d.buatProposal({ jumlah, nama, judul: "Program monitoring LPJ" });
  await d.ok("MAKER", `/nonpumk/proposal/${p.id}/ajukan-penilaian`, { body: {} });
  await d.ok("MAKER", `/nonpumk/proposal/${p.id}/penilaian`, {
    body: { tanggal: TANGGAL_PENILAIAN, skorTotal: "80", nilaiRekomendasi: jumlah },
  });
  await d.ok("CHECKER", `/nonpumk/proposal/${p.id}/review`, {
    body: { tanggal: TANGGAL_REVIEW, keputusan: "REKOMENDASI" },
  });
  await d.ok("APPROVER", `/nonpumk/proposal/${p.id}/persetujuan`, {
    body: { tanggal: TANGGAL_APPROVAL, keputusan: "SETUJU", jumlahDisetujui: jumlah },
  });
  await d.ok("MAKER", `/nonpumk/proposal/${p.id}/penyaluran`, {
    body: {
      tanggalPenyaluran,
      jumlah,
      akunKasId: d.akunKasId,
      akunBebanId: d.akunBebanId,
    },
  });
  return p.id;
}
