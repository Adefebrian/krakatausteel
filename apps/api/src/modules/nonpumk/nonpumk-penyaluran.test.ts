// SPEC 9.2 STAGED DISBURSEMENT, AND THE PENYALURAN_NON_PUMK JOURNAL.
//
//   "Penyaluran bisa BERTAHAP (multi termin). Satu proposal bisa punya
//    beberapa `nonpumk_penyaluran`. TOTAL PENYALURAN TIDAK BOLEH MELEBIHI
//    NILAI DISETUJUI."
//   spec 6.4: PENYALURAN_NON_PUMK debits "Beban Penyaluran Non PUMK (per
//    bidang)" and credits "Kas dan Setara Kas".
//
// WHY THE CEILING IS TESTED AT THE BOUNDARY AND NOT MERELY BELOW IT.
// `> jumlah_disetujui` and `>= jumlah_disetujui` differ by exactly one value,
// and that value is the last termin of every fully disbursed grant. An engine
// that used the wrong comparator would pass every "two small termin" test and
// refuse the final instalment of every real grant, or accept one rupiah too
// much on every one. So both sides are asserted: the termin that lands exactly
// on the ceiling SUCCEEDS, and the one that exceeds it by 0.01 is REFUSED.
//
// AND WHY THE MODULE HAS TO REFUSE FIRST.
// trg_nonpumk_penyaluran_50_plafon is a DEFERRED constraint trigger: it fires
// at COMMIT, with a message naming a plpgsql error code, after the journal has
// already been written inside the same transaction. Letting it be the guard
// means the caller gets `TJSL-NPK-002` instead of "this termin exceeds the
// approved amount by Rp 500.000", and the ledger engine has done a full posting
// for nothing. The trigger stays as the serialisation point for two concurrent
// termin; the module owns the ordinary case.
//
// THE JOURNAL IS WRITTEN BY THE REAL LEDGER ENGINE. `porterJurnalUji` records
// the call and delegates; it never answers in the engine's place.
// `nonpumk_penyaluran.jurnal_id` carries a real NON-DEFERRABLE foreign key
// (migrations/0010), so a double returning a synthetic uuid would raise 23503
// and roll the whole disbursement back in production while every test stayed
// green. modules/angsuran/test-support.ts records that exact incident.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createNonPumkEngine, KODE_NONPUMK, type NonPumkEngine } from "./contract";
import {
  buatDunia,
  jumlahUang,
  keSen,
  kurangUang,
  porterJurnalUji,
  rp,
  tolakDengan,
  DISETUJUI_BAKU,
  PESAN_JURNAL_GAGAL,
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

/** The account pair `event_jurnal_mapping` names for an event, read from the
 *  database rather than typed here. ADR 0004: the mapping is DATA, so a test
 *  that hardcoded "5.1.03" would stop being a test of the mapping and start
 *  being a second, silently diverging copy of it. */
async function pemetaan(eventCode: string): Promise<{
  debit: string | null;
  kredit: string | null;
  debit_dari_payload: boolean;
}> {
  const baris = await d.db.query<{
    debit: string | null;
    kredit: string | null;
    debit_dari_payload: boolean;
  }>(
    `select akun_debit_id::text as debit, akun_kredit_id::text as kredit, debit_dari_payload
       from event_jurnal_mapping
      where bumn_id = $1 and event_code = $2 and aktif and deleted_at is null`,
    [d.bumnId, eventCode],
  );
  expect(baris).toHaveLength(1);
  return baris[0];
}

function penyaluran(proposalId: string, jumlah: string, akunBebanId: string, tanggal = TANGGAL_PENYALURAN_BAKU) {
  return {
    proposalId,
    tanggalPenyaluran: tanggal,
    jumlah,
    akunKasId: d.akun.kas.id,
    akunBebanId,
  };
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

describe("penyaluran bertahap (spec 9.2)", () => {
  test("tiga termin di bawah pagu semuanya tersimpan, bernomor 1..3, dengan jurnal masing masing", async () => {
    const f = await d.siapkanProposal("DISETUJUI");
    const nilai = [rp(15_000_000), rp(15_000_000), rp(5_000_000)];
    for (const [i, n] of nilai.entries()) {
      const hasil = await engine.catatPenyaluran(
        penyaluran(f.proposalId, n, f.akunBebanId, `2026-04-${String(10 + i).padStart(2, "0")}`),
        d.ctx.maker,
      );
      expect(hasil.termin).toBe(i + 1);
      expect(hasil.jumlah).toBe(n);
      // Every termin is its own cash movement, so every termin is its own
      // journal. Pooling them would make the buku besar disagree with the bank
      // statement by date.
      expect(hasil.jurnalId).toBeTruthy();
    }

    const baris = await d.bacaPenyaluran(f.proposalId);
    expect(baris.map((b) => b.termin)).toEqual([1, 2, 3]);
    expect(baris.map((b) => b.jumlah)).toEqual(nilai);
    expect(new Set(baris.map((b) => b.jurnal_id)).size).toBe(3);
    expect(baris.every((b) => b.created_by === d.userId.maker)).toBe(true);

    // ONE journal per termin, three in total, in order.
    expect(jurnal.panggilan).toHaveLength(3);
    expect(jurnal.panggilan.map((p) => p.eventCode)).toEqual([
      "PENYALURAN_NON_PUMK",
      "PENYALURAN_NON_PUMK",
      "PENYALURAN_NON_PUMK",
    ]);
    expect(jurnal.panggilan.map((p) => p.nilai)).toEqual(nilai);

    const r = await engine.ringkasan(f.proposalId, d.ctx.maker);
    expect(r.totalDisalurkan).toBe(jumlahUang(...nilai));
    expect(r.sisaPagu).toBe(kurangUang(DISETUJUI_BAKU, jumlahUang(...nilai)));
    expect(r.penyaluran).toHaveLength(3);
  }, 60_000);

  test("termin yang PERSIS menghabiskan pagu diterima: batasnya inklusif", async () => {
    // THE BOUNDARY, on the permissive side. `total > disetujui` is the rule;
    // `total >= disetujui` would refuse the final instalment of every fully
    // disbursed grant, which is most of them.
    const f = await d.siapkanProposal("DISETUJUI");
    await engine.catatPenyaluran(
      penyaluran(f.proposalId, rp(30_000_000), f.akunBebanId),
      d.ctx.maker,
    );
    const terakhir = await engine.catatPenyaluran(
      penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId, "2026-04-20"),
      d.ctx.maker,
    );
    expect(terakhir.termin).toBe(2);

    const r = await engine.ringkasan(f.proposalId, d.ctx.maker);
    expect(r.totalDisalurkan).toBe(DISETUJUI_BAKU);
    expect(r.sisaPagu).toBe("0.00");
    // The whole approved amount really left the building.
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe(DISETUJUI_BAKU);
  }, 60_000);

  test("termin yang MELEBIHI pagu satu sen ditolak, dan tidak menulis apa apa", async () => {
    // THE BOUNDARY, on the refusing side, one minor unit past it. A test that
    // only exceeded the ceiling by a million would pass against an engine
    // comparing rupiah instead of sen.
    const f = await d.siapkanProposal("DISETUJUI");
    await engine.catatPenyaluran(
      penyaluran(f.proposalId, rp(39_000_000), f.akunBebanId),
      d.ctx.maker,
    );
    jurnal.reset();

    const err = await tolakDengan(
      () =>
        engine.catatPenyaluran(
          penyaluran(f.proposalId, "1000000.01", f.akunBebanId, "2026-04-20"),
          d.ctx.maker,
        ),
      KODE_NONPUMK.PLAFON_PENYALURAN_TERLAMPAUI,
    );
    // The module refused AHEAD of the DEFERRED trigger, so the raw text never
    // reached the caller. `tolakDengan` already fails on any TJSL-xxx-nnn; this
    // pins the specific one.
    expect(err.message).not.toContain("TJSL-NPK-002");

    // Nothing was written and, crucially, NOTHING WAS POSTED. A refusal that
    // arrives after the ledger call leaves the transaction to roll back a real
    // posting, which is only invisible while the rollback works.
    expect(await d.bacaPenyaluran(f.proposalId)).toHaveLength(1);
    expect(jurnal.panggilan).toHaveLength(0);
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe(rp(39_000_000));
  }, 60_000);

  test("satu termin yang sendirian melebihi pagu ditolak sebelum termin pertama pun ada", async () => {
    const f = await d.siapkanProposal("DISETUJUI");
    await tolakDengan(
      () =>
        engine.catatPenyaluran(
          penyaluran(f.proposalId, rp(40_000_001), f.akunBebanId),
          d.ctx.maker,
        ),
      KODE_NONPUMK.PLAFON_PENYALURAN_TERLAMPAUI,
    );
    expect(await d.bacaPenyaluran(f.proposalId)).toHaveLength(0);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("DISETUJUI");
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("pagu yang dipakai adalah nilai DISETUJUI, bukan nilai diajukan", async () => {
    // The whole reason `jumlah_disetujui` is denormalised onto the proposal
    // (ASSUMPTIONS.md A-15). An engine that read `jumlah_diajukan` would let a
    // grant that was deliberately cut be disbursed in full, and the cut would be
    // recorded in nonpumk_approval where nobody looks again.
    const f = await d.siapkanProposal("DISETUJUI", {
      jumlahDiajukan: rp(50_000_000),
      jumlahDisetujui: rp(20_000_000),
    });
    await tolakDengan(
      () =>
        engine.catatPenyaluran(
          penyaluran(f.proposalId, rp(20_000_001), f.akunBebanId),
          d.ctx.maker,
        ),
      KODE_NONPUMK.PLAFON_PENYALURAN_TERLAMPAUI,
    );
    const tepat = await engine.catatPenyaluran(
      penyaluran(f.proposalId, rp(20_000_000), f.akunBebanId),
      d.ctx.maker,
    );
    expect(tepat.jumlah).toBe(rp(20_000_000));
  }, 30_000);

  test("nilai termin nol atau negatif ditolak sebelum CHECK jumlah > 0", async () => {
    const f = await d.siapkanProposal("DISETUJUI");
    for (const nilai of ["0.00", "-1000000.00"]) {
      const err = await tolakDengan(
        () => engine.catatPenyaluran(penyaluran(f.proposalId, nilai, f.akunBebanId), d.ctx.maker),
        KODE_NONPUMK.NILAI_DILUAR_BATAS,
      );
      expect(err.message).not.toContain("nonpumk_penyaluran_jumlah_check");
    }
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("nomor termin dialokasikan oleh engine dan tidak pernah bertabrakan", async () => {
    // nonpumk_penyaluran_termin_uq is UNIQUE (proposal_id, termin), so an engine
    // that hardcoded 1, or that recomputed the number from a stale read, raises
    // 23505 on the second termin. The caller must never see that.
    const f = await d.siapkanProposal("DISALURKAN", { terminPenyaluran: [rp(10_000_000), rp(10_000_000)] });
    const berikut = await engine.catatPenyaluran(
      penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId, "2026-05-01"),
      d.ctx.maker,
    );
    expect(berikut.termin).toBe(3);
    expect((await d.bacaPenyaluran(f.proposalId)).map((b) => b.termin)).toEqual([1, 2, 3]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The journal (spec 6.4, invariant 11)
// ---------------------------------------------------------------------------

describe("jurnal PENYALURAN_NON_PUMK lewat engine, tidak pernah ditulis modul ini", () => {
  test("SATU jurnal per termin, akun dari pemetaan, beban dari form, dimensi bidang terpasang", async () => {
    // Invariant 11 and ADR 0004: this module names NO account pair of its own;
    // it names an EVENT, and the mapping row decides the accounts. The DEBIT is
    // the exception the mapping itself asks for (`debit_dari_payload`), because
    // spec 6.4 says the expense account is per bidang.
    const f = await d.siapkanProposal("DISETUJUI");
    const hasil = await engine.catatPenyaluran(
      {
        ...penyaluran(f.proposalId, rp(25_000_000), f.akunBebanId),
        noBukti: "BKK-NPK-2026-0007",
        keterangan: "Termin 1 renovasi",
      },
      d.ctx.maker,
    );

    expect(jurnal.panggilan).toHaveLength(1);
    const panggilan = jurnal.panggilan[0];
    expect(panggilan.eventCode).toBe("PENYALURAN_NON_PUMK");
    expect(panggilan.nilai).toBe(rp(25_000_000));
    expect(panggilan.cabangId).toBe(f.cabangId);
    expect(panggilan.tanggalTransaksi).toBe(TANGGAL_PENYALURAN_BAKU);
    expect(panggilan.akunDebitId).toBe(f.akunBebanId);
    expect(panggilan.akunKasId).toBe(d.akun.kas.id);
    // The analytic dimension spec 4.6 asks for on jurnal_baris.dimensi_json.
    // Without it, "Laporan Penyaluran per Bidang" has to reconstruct the bidang
    // by joining back through the business tables, which stops being possible
    // the moment a proposal's bidang is corrected.
    expect(panggilan.dimensi?.bidangId).toBe(f.bidangId);
    // The reference that lets the buku besar drill down to the termin, not just
    // to the proposal.
    expect(panggilan.referensiTipe).toBe("nonpumk_penyaluran");
    expect(panggilan.referensiId).toBe(hasil.id);

    const header = await d.bacaJurnal(hasil.jurnalId);
    expect(header.status).toBe("POSTED");
    expect(header.total_debit).toBe(rp(25_000_000));
    expect(header.total_kredit).toBe(rp(25_000_000));
    expect(header.tanggal_transaksi).toBe(TANGGAL_PENYALURAN_BAKU);
    // migrations/0020: only the engine's path may stamp ENGINE.
    expect(header.jalur_posting).toBe("ENGINE");

    const map = await pemetaan("PENYALURAN_NON_PUMK");
    expect(map.debit_dari_payload).toBe(true);
    const baris = await d.bacaBarisJurnal(hasil.jurnalId);
    expect(baris).toHaveLength(2);
    const debit = baris.find((b) => b.debit !== "0.00");
    const kredit = baris.find((b) => b.kredit !== "0.00");
    expect(debit?.akun_id).toBe(f.akunBebanId);
    expect(debit?.debit).toBe(rp(25_000_000));
    // The cash leg comes from the mapping and is overridden by the form's cash
    // account, exactly as PENCAIRAN_PUMK does.
    expect(kredit?.akun_id).toBe(d.akun.kas.id);
    expect(kredit?.kredit).toBe(rp(25_000_000));
    // The dimension belongs on the leg that carries the economics, not on the
    // cash movement.
    expect(debit?.dimensi_json?.bidangId).toBe(f.bidangId);

    // The FK is real and non-deferrable: this id had to come from the engine.
    expect((await d.bacaPenyaluran(f.proposalId))[0].jurnal_id).toBe(hasil.jurnalId);
  }, 60_000);

  test("akun beban benar benar PER BIDANG: dua bidang, dua akun debit", async () => {
    // The half of spec 6.4 that the mapping cannot express on its own. If the
    // engine ignored `akunBebanId` and used the mapping's own account, both
    // grants would land on the pooled 5.1.03 and "per bidang" would be a column
    // in a form that changes nothing.
    const a = await d.siapkanProposal("DISETUJUI", { bidang: d.bidang });
    const b = await d.siapkanProposal("DISETUJUI", { bidang: d.bidangLain });

    const ha = await engine.catatPenyaluran(
      penyaluran(a.proposalId, rp(10_000_000), d.bidang.akunBeban.id),
      d.ctx.maker,
    );
    const hb = await engine.catatPenyaluran(
      penyaluran(b.proposalId, rp(10_000_000), d.bidangLain.akunBeban.id),
      d.ctx.maker,
    );

    const debitA = (await d.bacaBarisJurnal(ha.jurnalId)).find((x) => x.debit !== "0.00");
    const debitB = (await d.bacaBarisJurnal(hb.jurnalId)).find((x) => x.debit !== "0.00");
    expect(debitA?.akun_id).toBe(d.bidang.akunBeban.id);
    expect(debitB?.akun_id).toBe(d.bidangLain.akunBeban.id);
    expect(debitA?.akun_id).not.toBe(debitB?.akun_id);
    expect(debitA?.dimensi_json?.bidangId).toBe(d.bidang.id);
    expect(debitB?.dimensi_json?.bidangId).toBe(d.bidangLain.id);
  }, 60_000);

  test("akun kas dari form dipakai sebagai kaki kredit, menggantikan kas default pemetaan", async () => {
    // The mapping binds the cash leg to 1.1.01 and the form overrides it per
    // posting. A grant paid out of Bank that posts to Kas makes the cash
    // reconciliation wrong in two accounts at once.
    const f = await d.siapkanProposal("DISETUJUI");
    const hasil = await engine.catatPenyaluran(
      { ...penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId), akunKasId: d.akun.bank.id },
      d.ctx.maker,
    );
    const kredit = (await d.bacaBarisJurnal(hasil.jurnalId)).find((b) => b.kredit !== "0.00");
    expect(kredit?.akun_id).toBe(d.akun.bank.id);
    expect(kredit?.akun_kode).toBe(d.akun.bank.kode);
  }, 30_000);

  test("akun beban yang bukan akun beban ditolak: sebuah hibah tidak boleh mendebit kas", async () => {
    // The expense account arrives from the form, so the form can send anything.
    // Debiting a cash account here would produce a balanced journal that moves
    // money between two cash accounts and records no expense at all, which no
    // balance check can catch.
    const f = await d.siapkanProposal("DISETUJUI");
    await tolakDengan(
      () =>
        engine.catatPenyaluran(
          penyaluran(f.proposalId, rp(10_000_000), d.akun.kas.id),
          d.ctx.maker,
        ),
      KODE_NONPUMK.AKUN_BEBAN_TIDAK_VALID,
    );
    expect(jurnal.panggilan).toHaveLength(0);
    expect(await d.bacaPenyaluran(f.proposalId)).toHaveLength(0);
  }, 30_000);

  test("akun kas yang bukan akun kas ditolak", async () => {
    const f = await d.siapkanProposal("DISETUJUI");
    await tolakDengan(
      () =>
        engine.catatPenyaluran(
          { ...penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId), akunKasId: d.akun.bebanPinbuk.id },
          d.ctx.maker,
        ),
      KODE_NONPUMK.AKUN_KAS_TIDAK_VALID,
    );
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);

  test("modul ini tidak pernah menulis baris jurnal sendiri (invarian 11)", async () => {
    // The static half of the rule is tools/check-boundaries.ts, which greps for
    // raw ledger SQL outside modules/jurnal. The runtime half is
    // migrations/0020's tripwire, gated on a transaction-scoped
    // `SET LOCAL tjsl.jalur_posting`, which is what `jalur_posting = 'ENGINE'`
    // records. Every journal this module causes must carry that stamp; a row
    // written by any other path is either refused outright or stamped
    // differently, and both are visible here.
    const f = await d.siapkanProposal("DISETUJUI");
    await engine.catatPenyaluran(penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId), d.ctx.maker);
    await engine.catatPenyaluran(
      penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId, "2026-04-15"),
      d.ctx.maker,
    );

    const jalur = await d.db.query<{ jalur_posting: string; is_auto_generated: boolean }>(
      `select j.jalur_posting, j.is_auto_generated
         from jurnal j
        where j.referensi_tipe = 'nonpumk_penyaluran'
          and j.referensi_id in (select id from nonpumk_penyaluran where proposal_id = $1)
          and j.deleted_at is null`,
      [f.proposalId],
    );
    expect(jalur).toHaveLength(2);
    for (const j of jalur) {
      expect(j.jalur_posting).toBe("ENGINE");
      // An event posting is automatic by definition (spec 4.6), which is what
      // keeps it out of the manual-journal screens.
      expect(j.is_auto_generated).toBe(true);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe("penyaluran bersifat semua atau tidak sama sekali", () => {
  test("jurnal gagal membatalkan baris penyaluran DAN status proposal sekaligus", async () => {
    // The reason `NonPumkDbPort.transaction` is not optional. Half of this on
    // disk is a grant expense in the ledger with no business record behind it,
    // or a termin that counts against the ceiling and never reached the bank.
    const f = await d.siapkanProposal("DISETUJUI");
    jurnal.gagalkan();

    const err = await tolakDengan(
      () => engine.catatPenyaluran(penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId), d.ctx.maker),
      KODE_NONPUMK.JURNAL_GAGAL,
    );
    // The armed message is deliberately shaped like a raw trigger string, so
    // this asserts BOTH that the rollback happened AND that the raw text stayed
    // out of the user-facing message.
    expect(err.message).not.toContain(PESAN_JURNAL_GAGAL);
    expect(err.penyebabDb ?? "").toContain("TJSL-JRN-031");

    expect(await d.bacaPenyaluran(f.proposalId)).toHaveLength(0);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("DISETUJUI");
    expect(await d.bacaTransisi(f.proposalId)).toHaveLength(0);
    expect((await d.efekBukuBesar(f.proposalId)).beban).toBe("0.00");
  }, 30_000);

  test("setelah rollback, termin yang sama bisa diulang dan nomornya tetap 1", async () => {
    // A burnt termin number after a failed posting would leave a permanent gap
    // in an official series, which is a question an auditor asks. And a retry
    // that could not proceed at all would mean one ledger hiccup freezes a
    // grant.
    const f = await d.siapkanProposal("DISETUJUI");
    jurnal.gagalkan();
    await tolakDengan(
      () => engine.catatPenyaluran(penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId), d.ctx.maker),
      KODE_NONPUMK.JURNAL_GAGAL,
    );
    jurnal.reset();

    const lagi = await engine.catatPenyaluran(
      penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId),
      d.ctx.maker,
    );
    expect(lagi.termin).toBe(1);
    expect((await d.bacaPenyaluran(f.proposalId)).map((b) => b.termin)).toEqual([1]);
    expect((await d.bacaProposal(f.proposalId)).status).toBe("DISALURKAN");
  }, 30_000);

  test("penyaluran atas proposal yang belum disetujui ditolak dengan status, bukan dengan TJSL-NPK-001", async () => {
    // TJSL-NPK-001 fires when jumlah_disetujui is NULL, and its message names a
    // proposal uuid. The state machine gets there first and says something a
    // human can act on.
    const f = await d.siapkanProposal("MENUNGGU_PERSETUJUAN");
    const err = await tolakDengan(
      () => engine.catatPenyaluran(penyaluran(f.proposalId, rp(10_000_000), f.akunBebanId), d.ctx.maker),
      KODE_NONPUMK.TRANSISI_TIDAK_VALID,
    );
    expect(err.message).not.toContain("TJSL-NPK-001");
    expect(jurnal.panggilan).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The ledger effect, per proposal
// ---------------------------------------------------------------------------

describe("efek buku besar dari penyaluran", () => {
  test("beban bersih dan kas bersih sama dengan total yang benar benar keluar", async () => {
    // Not "a row exists": the actual arithmetic in the general ledger. A grant
    // of 40 juta disbursed in three termin must show 40 juta of expense and 40
    // juta of cash out, no more and no less, whatever the number of termin.
    const f = await d.siapkanProposal("DISETUJUI");
    for (const [i, n] of [rp(12_000_000), rp(18_000_000), rp(10_000_000)].entries()) {
      await engine.catatPenyaluran(
        penyaluran(f.proposalId, n, f.akunBebanId, `2026-04-${String(10 + i).padStart(2, "0")}`),
        d.ctx.maker,
      );
    }
    const efek = await d.efekBukuBesar(f.proposalId);
    expect(efek.beban).toBe(DISETUJUI_BAKU);
    expect(keSen(efek.kas)).toBe(-keSen(DISETUJUI_BAKU));

    // And the read model agrees with the ledger, which is the only assertion
    // that would catch a sub-ledger drifting from the buku besar.
    const r = await engine.ringkasan(f.proposalId, d.ctx.maker);
    expect(r.totalDisalurkan).toBe(DISETUJUI_BAKU);
    expect(r.bebanBersihBukuBesar).toBe(DISETUJUI_BAKU);
    expect(keSen(r.kasBersihBukuBesar)).toBe(-keSen(DISETUJUI_BAKU));
  }, 60_000);

  test("dua proposal di dunia yang sama tidak saling mencemari", async () => {
    // An engine that posted without the reference, or that summed by bidang
    // instead of by proposal, would pool the two and this is where that shows.
    const a = await d.siapkanProposal("DISETUJUI");
    const b = await d.siapkanProposal("DISETUJUI");
    await engine.catatPenyaluran(penyaluran(a.proposalId, rp(11_000_000), a.akunBebanId), d.ctx.maker);
    await engine.catatPenyaluran(penyaluran(b.proposalId, rp(22_000_000), b.akunBebanId), d.ctx.maker);

    expect((await d.efekBukuBesar(a.proposalId)).beban).toBe(rp(11_000_000));
    expect((await d.efekBukuBesar(b.proposalId)).beban).toBe(rp(22_000_000));
  }, 60_000);
});
