// Spec 8.4 check 10, the piutang sub-ledger reconciliation:
//   SUM(outstanding_pokok of every active akad) = balance of the
//   "Piutang Pinjaman Mitra Binaan" account.
// The spec calls it "rekonsiliasi paling penting di seluruh sistem", and if it
// does not hold, period closing is blocked.
//
// WHY IT IS TESTED HERE, IN THE JOURNAL MODULE.
// The reconciliation has two sides. The sub-ledger side (akad.outstanding_pokok)
// belongs to the PUMK module, which does not exist yet. The general-ledger side
// is produced entirely by this engine, and it can only ever add up if the
// engine puts `akad_id` on the receivable leg of every journal that moves a
// receivable. That is the part specified below. The tests set the sub-ledger
// side by hand and say so; the line marked INTEGRATION POINT is where the PUMK
// module takes over.
//
// The view under test is v_rekonsiliasi_piutang (migrations/0015), which reads
// the receivable account from event_jurnal_mapping rather than hardcoding it,
// so this test does not hardcode it either.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJurnalEngine, type JurnalEngine } from "./contract";
import { bacaBarisDb, buatDunia, jumlahUang, keSen, rp, sen, type DuniaJurnal } from "./test-support";

let d: DuniaJurnal;
let engine: JurnalEngine;

beforeAll(async () => {
  d = await buatDunia();
  engine = createJurnalEngine({ db: d.db, jam: d.jam });
});

afterAll(async () => {
  if (d) await d.tutup();
});

async function rekonsiliasi(): Promise<{
  saldo_sub_ledger: string;
  saldo_buku_besar: string;
  selisih: string;
}> {
  const r = await d.db.query<{
    saldo_sub_ledger: string;
    saldo_buku_besar: string;
    selisih: string;
  }>(
    `select saldo_sub_ledger::text as saldo_sub_ledger,
            saldo_buku_besar::text as saldo_buku_besar,
            selisih::text as selisih
       from v_rekonsiliasi_piutang where akad_id = $1`,
    [d.akadId],
  );
  return r[0];
}

/** Stand-in for what the PUMK module will do; see the header. */
async function setelSubLedger(outstanding: string): Promise<void> {
  await d.db.query(
    `update pumk_akad set outstanding_pokok = $2, status = 'AKTIF' where id = $1`,
    [d.akadId, outstanding],
  );
}

describe("spec 8.4 check 10 rekonsiliasi sub ledger piutang", () => {
  test("spec 8.4.10 pencairan lalu angsuran meninggalkan saldo buku besar yang sama dengan outstanding akad", async () => {
    const pokok = rp(50_000_000);
    const angsuran = rp(5_000_000);

    // Baseline first. Later tests in this file post more journals against the
    // same akad in the same shared world, so an absolute 45.000.000 here would
    // be an assertion about test ordering rather than about the engine.
    const awal = await rekonsiliasi();

    // General ledger side: produced only by this engine, through the one
    // central path (invariant 11).
    await engine.postingEvent(
      "PENCAIRAN_PUMK",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: pokok,
        mitraId: d.mitraId,
        akadId: d.akadId,
        referensiTipe: "pumk_pencairan",
      },
      d.ctx.approver,
    );
    await engine.postingEvent(
      "ANGSURAN_POKOK",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: angsuran,
        mitraId: d.mitraId,
        akadId: d.akadId,
        referensiTipe: "pumk_angsuran",
      },
      d.ctx.approver,
    );

    // INTEGRATION POINT: the PUMK module owns this write. Until it exists the
    // test performs it, so the engine's half of the reconciliation is still
    // provable today. The figure is derived the way the business module would
    // derive it, from the akad's own arithmetic (disbursed minus repaid), NOT
    // by reading the ledger back, which would make the assertion tautological.
    const outstandingDiharapkan = jumlahUang(
      awal.saldo_sub_ledger,
      sen(keSen(pokok) - keSen(angsuran)),
    );
    await setelSubLedger(outstandingDiharapkan);

    const rek = await rekonsiliasi();
    // The ledger moved by exactly the net principal, to the sen.
    expect(keSen(rek.saldo_buku_besar) - keSen(awal.saldo_buku_besar)).toBe(
      keSen(pokok) - keSen(angsuran),
    );
    expect(rek.saldo_sub_ledger).toBe(outstandingDiharapkan);
    // The reconciliation itself: both sides agree, so closing is not blocked.
    expect(rek.selisih).toBe(rp(0));
  });

  test("spec 8.4.10 selisih terdeteksi kalau sub ledger dan buku besar berbeda", async () => {
    // Negative control on the reconciliation itself: without it, a view that
    // always returned zero would look like a permanently balanced ledger.
    // Deliberately written against whatever the ledger currently holds rather
    // than against a fixed number, so it neither depends on the test before it
    // nor changes meaning once the engine starts posting. It exercises
    // migrations/0015_view_integritas.sql rather than the engine, which is why
    // it was the one test in this folder that passed before the engine existed.
    const awal = await rekonsiliasi();
    await setelSubLedger(jumlahUang(awal.saldo_buku_besar, rp(1_000_000)));
    const rek = await rekonsiliasi();
    expect(rek.selisih).toBe(rp(1_000_000));
  });

  test("spec 8.4.10 dimensi akad hanya ditulis di kaki piutang, bukan di kaki kas", async () => {
    // This is the mechanic the whole reconciliation rests on: if the cash leg
    // also carried akad_id, the view's SUM(debit - kredit) per akad would net
    // the two legs of every journal to zero and the reconciliation would be
    // permanently, silently "balanced".
    const jurnal = await engine.postingEvent(
      "PENCAIRAN_PUMK",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: rp(1_000_000),
        mitraId: d.mitraId,
        akadId: d.akadId,
      },
      d.ctx.approver,
    );

    const baris = await bacaBarisDb(d.db, jurnal.id);
    const piutang = baris.find((b) => b.akun_id === d.akun.piutangPokok.id);
    const kas = baris.find((b) => b.akun_id === d.akun.kas.id);
    expect(piutang?.akad_id).toBe(d.akadId);
    expect(piutang?.mitra_id).toBe(d.mitraId);
    expect(kas?.akad_id).toBeNull();
    expect(kas?.mitra_id).toBeNull();
  });

  test("spec 8.4.10 reversal pencairan mengembalikan saldo buku besar akad ke nol", async () => {
    // A reversal that forgot the sub-ledger dimensions would leave the
    // receivable inflated for this akad forever, which is precisely the
    // "sumber data korup nomor satu" spec 6.3 warns about.
    const jurnal = await engine.postingEvent(
      "PENCAIRAN_PUMK",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: rp(2_000_000),
        mitraId: d.mitraId,
        akadId: d.akadId,
      },
      d.ctx.approver,
    );
    const sebelum = await rekonsiliasi();

    const mesin = createJurnalEngine({
      db: d.db,
      jam: d.jam,
      pembalikStateBisnis: [],
    });
    await mesin.reversalJurnal(jurnal.id, "pencairan dobel", d.ctx.approver);

    const sesudah = await rekonsiliasi();
    // Ledger side dropped by exactly the reversed amount, to the sen.
    const turun =
      BigInt(sebelum.saldo_buku_besar.replace(".", "")) -
      BigInt(sesudah.saldo_buku_besar.replace(".", ""));
    expect(turun).toBe(200_000_000n);
  });
});
