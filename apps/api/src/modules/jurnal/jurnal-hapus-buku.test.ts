// Penghapusbukuan when the allowance does NOT cover the outstanding.
//
// THE DEFECT THIS FILE EXISTS FOR IS IN THE SPECIFICATION, NOT IN THE CODE.
// Spec 6.4's `HAPUS_BUKU_PIUTANG` debits Penyisihan Penurunan Nilai Piutang
// for the FULL outstanding. That is correct only while the allowance covers
// the outstanding, which holds at a 100 percent Macet rate and does NOT hold
// under the collective-impairment basis docs/REGULASI.md found to be the basis
// actually in force. With a smaller allowance the spec's own journal drives a
// contra-ASSET account into a debit balance, and a negative deduction from
// receivables reads as receivables OVERSTATED by exactly the amount that was
// supposed to leave the balance sheet. It balances, and it is wrong: an
// invariant that only checks debit = credit will never see it.
//
// So the tests below assert three things at once on every case, because any
// one of them alone can be satisfied by a wrong journal:
//   1. the two legs sum EXACTLY to the outstanding written off (nothing
//      vanishes into rounding, nothing is written off twice);
//   2. the allowance account is never driven negative (it may reach zero);
//   3. the whole ledger still balances to 0.00.
//
// WHAT IS ASSERTED AND WHAT IS NOT. The arithmetic of the split is the
// engine's and is pinned here. WHICH accounts each leg touches is a row in
// `event_jurnal_mapping` and an assumption awaiting the client's finance team
// and their KAP (ASSUMPTIONS.md A-38), so it is asserted only as a MECHANIC:
// the balance read follows the mapping row, so a corrected row corrects this
// path with no redeploy.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createJurnalEngine,
  type HapusBukuPiutangInput,
  type JurnalEngine,
  type Uang,
} from "./contract";
import {
  acak,
  bacaBarisDb,
  buatDunia,
  keSen,
  rp,
  selisihLedger,
  sen,
  tolakDengan,
  type DuniaJurnal,
} from "./test-support";

let d: DuniaJurnal;
let engine: JurnalEngine;

beforeAll(async () => {
  d = await buatDunia();
  engine = createJurnalEngine({ db: d.db, jam: d.jam });
});

afterAll(async () => {
  if (d) await d.tutup();
});

/**
 * The allowance balance as the BUSINESS reads it: credit-positive, because a
 * contra-asset carrying a normal balance is a credit. POSTED and REVERSED
 * both count, for the reason the engine's own read gives: a reversed
 * journal's lines are still in the ledger, offset by its reversal.
 */
async function saldoPenyisihan(): Promise<bigint> {
  const r = await d.db.query<{ saldo: string }>(
    `select coalesce(sum(b.kredit) - sum(b.debit), 0)::numeric(20,2)::text as saldo
       from jurnal_baris b join jurnal j on j.id = b.jurnal_id
      where b.akun_id = $1::uuid
        and j.status in ('POSTED', 'REVERSED')
        and j.deleted_at is null
        and b.deleted_at is null`,
    [d.akun.penyisihan.id],
  );
  return keSen(r[0].saldo as Uang);
}

/** Debit-positive balance of any account, optionally for one akad only. */
async function saldoDebit(akunId: string, akadId?: string): Promise<bigint> {
  const r = await d.db.query<{ saldo: string }>(
    `select coalesce(sum(b.debit) - sum(b.kredit), 0)::numeric(20,2)::text as saldo
       from jurnal_baris b join jurnal j on j.id = b.jurnal_id
      where b.akun_id = $1::uuid
        and j.status in ('POSTED', 'REVERSED')
        and j.deleted_at is null
        and b.deleted_at is null
        and ($2::uuid is null or b.akad_id = $2::uuid)`,
    [akunId, akadId ?? null],
  );
  return keSen(r[0].saldo as Uang);
}

/**
 * Moves the allowance to an exact balance, through the ordinary events, so
 * every case starts from a stated premise instead of from whatever the
 * previous case left behind. `BEBAN_PENYISIHAN` forms, `PEMULIHAN_PENYISIHAN`
 * releases; neither is invented for the test.
 */
async function setelSaldoPenyisihan(targetSen: bigint): Promise<void> {
  const sekarang = await saldoPenyisihan();
  const selisih = targetSen - sekarang;
  if (selisih === 0n) return;
  await engine.postingEvent(
    selisih > 0n ? "BEBAN_PENYISIHAN" : "PEMULIHAN_PENYISIHAN",
    {
      cabangId: d.cabangId,
      tanggalTransaksi: d.tanggalKini,
      nilai: sen(selisih > 0n ? selisih : -selisih),
      keterangan: "setel saldo penyisihan (fixture)",
    },
    d.ctx.approver,
  );
  expect(await saldoPenyisihan()).toBe(targetSen);
}

/** One write-off, in its own transaction, the way a business module runs it. */
function hapusBuku(outstanding: Uang, tambahan: Partial<HapusBukuPiutangInput> = {}) {
  return d.db.transaction((tx) =>
    engine.postingHapusBukuPiutang(
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        outstanding,
        mitraId: d.mitraId,
        akadId: d.akadId,
        referensiTipe: "pumk_hapus_buku",
        referensiId: d.akadId,
        ...tambahan,
      },
      tx,
      d.ctx.maker,
    ),
  );
}

describe("hapus buku: penyisihan KURANG dari outstanding", () => {
  test("penyisihan dihabiskan lebih dulu, sisanya lewat HAPUS_BUKU_KEKURANGAN_PENYISIHAN", async () => {
    const outstanding = rp(5_000_000);
    const tersedia = rp(3_000_000);
    await setelSaldoPenyisihan(keSen(tersedia));

    // A real receivable for a real akad, so the sub-ledger side is not implied.
    await engine.postingEvent(
      "PENCAIRAN_PUMK",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: outstanding,
        mitraId: d.mitraId,
        akadId: d.akadId,
      },
      d.ctx.approver,
    );
    const piutangSebelum = await saldoDebit(d.akun.piutangPokok.id, d.akadId);
    const bebanSebelum = await saldoDebit(d.akun.bebanPenyisihan.id);

    const hasil = await hapusBuku(outstanding);

    // THE SPLIT. Computed by the engine from the ledger, not handed to it.
    expect(hasil.penyisihanTersedia).toBe(tersedia);
    expect(hasil.dariPenyisihan).toBe(tersedia);
    expect(hasil.kekurangan).toBe(rp(2_000_000));
    // The two legs sum EXACTLY to what left the balance sheet.
    expect(keSen(hasil.dariPenyisihan) + keSen(hasil.kekurangan)).toBe(keSen(outstanding));

    // ONE journal, three lines: both components credit the same receivable for
    // the same akad and merge into a single credit of the full outstanding.
    expect(hasil.jumlahBaris).toBe(3);
    const baris = await bacaBarisDb(d.db, hasil.id);
    const kakiPiutang = baris.filter((b) => b.akun_id === d.akun.piutangPokok.id);
    expect(kakiPiutang).toHaveLength(1);
    expect(kakiPiutang[0].kredit).toBe(outstanding);
    expect(kakiPiutang[0].akad_id).toBe(d.akadId);
    expect(baris.find((b) => b.akun_id === d.akun.penyisihan.id)?.debit).toBe(tersedia);
    expect(baris.find((b) => b.akun_id === d.akun.bebanPenyisihan.id)?.debit).toBe(rp(2_000_000));
    // The sub-ledger dimension rides the receivable leg only, or
    // v_rekonsiliasi_piutang would net this journal to zero for the akad.
    expect(baris.find((b) => b.akun_id === d.akun.bebanPenyisihan.id)?.akad_id).toBeNull();
    expect(baris.find((b) => b.akun_id === d.akun.penyisihan.id)?.akad_id).toBeNull();

    // THE INVARIANT THE WHOLE EVENT EXISTS FOR: the contra-asset lands on zero
    // and never crosses it.
    const sesudah = await saldoPenyisihan();
    expect(sesudah).toBe(0n);
    expect(sesudah >= 0n).toBe(true);

    // The receivable for this akad is gone and the shortfall is this period's
    // expense, not a negative deduction hiding in the balance sheet.
    expect(piutangSebelum - (await saldoDebit(d.akun.piutangPokok.id, d.akadId))).toBe(
      keSen(outstanding),
    );
    expect((await saldoDebit(d.akun.bebanPenyisihan.id)) - bebanSebelum).toBe(keSen(rp(2_000_000)));

    expect(hasil.totalDebit).toBe(outstanding);
    expect(hasil.totalKredit).toBe(outstanding);
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("batas: penyisihan PERSIS sama dengan outstanding, tidak ada event kekurangan sama sekali", async () => {
    const outstanding = rp(4_000_000);
    await setelSaldoPenyisihan(keSen(outstanding));
    const bebanSebelum = await saldoDebit(d.akun.bebanPenyisihan.id);

    const hasil = await hapusBuku(outstanding);

    expect(hasil.dariPenyisihan).toBe(outstanding);
    expect(hasil.kekurangan).toBe("0.00");
    // Exactly the spec's own two-line journal. A "0.00" shortfall line would
    // both fail validation 6.2.3 and overstate the period's expense by
    // existing at all, so the component is not emitted.
    expect(hasil.jumlahBaris).toBe(2);
    const baris = await bacaBarisDb(d.db, hasil.id);
    expect(baris.some((b) => b.akun_id === d.akun.bebanPenyisihan.id)).toBe(false);
    expect(baris.find((b) => b.akun_id === d.akun.penyisihan.id)?.debit).toBe(outstanding);
    expect(baris.find((b) => b.akun_id === d.akun.piutangPokok.id)?.kredit).toBe(outstanding);

    expect(await saldoPenyisihan()).toBe(0n);
    expect(await saldoDebit(d.akun.bebanPenyisihan.id)).toBe(bebanSebelum);
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("batas: penyisihan NOL, seluruh outstanding lewat event kekurangan", async () => {
    await setelSaldoPenyisihan(0n);
    const outstanding = rp(1_750_000);
    const bebanSebelum = await saldoDebit(d.akun.bebanPenyisihan.id);

    const hasil = await hapusBuku(outstanding);

    expect(hasil.penyisihanTersedia).toBe("0.00");
    expect(hasil.dariPenyisihan).toBe("0.00");
    expect(hasil.kekurangan).toBe(outstanding);
    // Two lines, and NOT the allowance's: an allowance leg of "0.00" would be
    // the exact journal that puts a contra-asset into a debit balance the
    // moment anyone rounds it.
    expect(hasil.jumlahBaris).toBe(2);
    const baris = await bacaBarisDb(d.db, hasil.id);
    expect(baris.some((b) => b.akun_id === d.akun.penyisihan.id)).toBe(false);
    expect(baris.find((b) => b.akun_id === d.akun.bebanPenyisihan.id)?.debit).toBe(outstanding);
    expect(baris.find((b) => b.akun_id === d.akun.piutangPokok.id)?.kredit).toBe(outstanding);

    expect(await saldoPenyisihan()).toBe(0n);
    expect((await saldoDebit(d.akun.bebanPenyisihan.id)) - bebanSebelum).toBe(keSen(outstanding));
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("penyisihan LEBIH dari outstanding hanya terpakai sebesar yang dihapus", async () => {
    await setelSaldoPenyisihan(keSen(rp(9_000_000)));
    const outstanding = rp(2_500_000);
    const bebanSebelum = await saldoDebit(d.akun.bebanPenyisihan.id);

    const hasil = await hapusBuku(outstanding);

    expect(hasil.penyisihanTersedia).toBe(rp(9_000_000));
    expect(hasil.dariPenyisihan).toBe(outstanding);
    expect(hasil.kekurangan).toBe("0.00");
    expect(hasil.jumlahBaris).toBe(2);
    // The surplus stays an allowance against the rest of the portfolio; it is
    // not released to income by a write-off of one akad.
    expect(await saldoPenyisihan()).toBe(keSen(rp(6_500_000)));
    expect(await saldoDebit(d.akun.bebanPenyisihan.id)).toBe(bebanSebelum);
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("penyisihan yang sudah DIREVERSAL tidak dihitung sebagai kapasitas", async () => {
    // Not a corner case: counting only POSTED would see the reversal (which
    // reduces the allowance) and not the reversed original (which formed it),
    // and the engine would then consume an allowance that no longer exists.
    await setelSaldoPenyisihan(0n);
    const pembentukan = await engine.postingEvent(
      "BEBAN_PENYISIHAN",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: rp(3_000_000),
        keterangan: "penyisihan yang akan dibatalkan",
      },
      d.ctx.approver,
    );
    await engine.reversalJurnal(pembentukan.id, "salah hitung, dibatalkan", d.ctx.approver);
    expect(await saldoPenyisihan()).toBe(0n);

    const outstanding = rp(1_000_000);
    const hasil = await hapusBuku(outstanding);

    expect(hasil.penyisihanTersedia).toBe("0.00");
    expect(hasil.kekurangan).toBe(outstanding);
    expect(await saldoPenyisihan()).toBe(0n);
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("penyisihanMaksimal hanya boleh MENURUNKAN konsumsi, tidak menaikkannya", async () => {
    // The RATE_TABLE mode computes an allowance per akad while the ledger
    // holds one pooled contra account, so a caller may cap what this write-off
    // takes from the pool. A cap ABOVE the pool must not conjure allowance.
    await setelSaldoPenyisihan(keSen(rp(2_000_000)));
    const dibatasi = await hapusBuku(rp(3_000_000), { penyisihanMaksimal: rp(500_000) });
    expect(dibatasi.dariPenyisihan).toBe(rp(500_000));
    expect(dibatasi.kekurangan).toBe(rp(2_500_000));
    expect(await saldoPenyisihan()).toBe(keSen(rp(1_500_000)));

    const takBerarti = await hapusBuku(rp(3_000_000), { penyisihanMaksimal: rp(99_000_000) });
    expect(takBerarti.dariPenyisihan).toBe(rp(1_500_000));
    expect(takBerarti.kekurangan).toBe(rp(1_500_000));
    expect(await saldoPenyisihan()).toBe(0n);
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("properti: untuk pasangan (penyisihan, outstanding) apa pun, dua kaki = outstanding dan kontra tidak negatif", async () => {
    // Sen-level amounts on purpose: a split implemented with a JS number would
    // pass every round-rupiah case above and lose a sen here.
    const rng = acak(20260825);
    for (let i = 0; i < 8; i += 1) {
      const tersedia = BigInt(Math.floor(rng() * 900_000_00)) + 1n;
      const outstanding = BigInt(Math.floor(rng() * 1_500_000_00)) + 1n;
      await setelSaldoPenyisihan(tersedia);

      const hasil = await hapusBuku(sen(outstanding));

      expect(keSen(hasil.dariPenyisihan) + keSen(hasil.kekurangan)).toBe(outstanding);
      expect(keSen(hasil.dariPenyisihan)).toBe(tersedia < outstanding ? tersedia : outstanding);
      const sisa = await saldoPenyisihan();
      expect(sisa >= 0n).toBe(true);
      expect(sisa).toBe(tersedia > outstanding ? tersedia - outstanding : 0n);
      expect(hasil.totalDebit).toBe(sen(outstanding));
      expect(hasil.totalKredit).toBe(sen(outstanding));
      expect(await selisihLedger(d.db)).toBe("0.00");
    }
  });
});

describe("hapus buku: yang tetap kebijakan, bukan kode", () => {
  test("kebijakan TOLAK menolak hapus buku yang kekurangan penyisihan, dan tidak memposting apa pun", async () => {
    // Whether a shortfall may be charged to the period at all is the client's
    // policy, held in `akuntansi.kekurangan_penyisihan_hapus_buku`. The engine
    // reads it; it does not own it.
    await setelSaldoPenyisihan(keSen(rp(1_000_000)));
    const sebelum = await d.db.query<{ n: string }>(
      `select count(*)::text as n from jurnal where bumn_id = $1::uuid`,
      [d.bumnId],
    );
    await d.setelKebijakanKekurangan("TOLAK");
    try {
      await tolakDengan(hapusBuku(rp(4_000_000)), "PENYISIHAN_TIDAK_CUKUP");
      // Nothing half-written: the caller's transaction took the refusal down
      // with it, so no journal, no consumed allowance.
      const sesudah = await d.db.query<{ n: string }>(
        `select count(*)::text as n from jurnal where bumn_id = $1::uuid`,
        [d.bumnId],
      );
      expect(sesudah[0].n).toBe(sebelum[0].n);
      expect(await saldoPenyisihan()).toBe(keSen(rp(1_000_000)));

      // A write-off the allowance DOES cover is unaffected by the policy:
      // there is no shortfall to refuse.
      const cukup = await hapusBuku(rp(1_000_000));
      expect(cukup.kekurangan).toBe("0.00");
      expect(await saldoPenyisihan()).toBe(0n);
    } finally {
      await d.setelKebijakanKekurangan("BEBAN_PERIODE");
    }
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("saldo penyisihan dibaca dari akun yang ditunjuk baris mapping, bukan dari kode akun", async () => {
    // The proof that a corrected mapping row corrects this path too: repoint
    // the debit leg of HAPUS_BUKU_PIUTANG at an account with no allowance
    // balance, and the engine finds nothing to consume, in the same process,
    // with no redeploy.
    await setelSaldoPenyisihan(keSen(rp(5_000_000)));
    const asal = d.akun.penyisihan.id;
    await d.gantiAkunMapping("HAPUS_BUKU_PIUTANG", "akun_debit_id", d.akun.piutangAlternatif.id);
    try {
      const hasil = await hapusBuku(rp(1_200_000));
      expect(hasil.penyisihanTersedia).toBe("0.00");
      expect(hasil.kekurangan).toBe(rp(1_200_000));
      // And the real allowance was left alone, because it is no longer the
      // account the row names.
      expect(await saldoPenyisihan()).toBe(keSen(rp(5_000_000)));
    } finally {
      await d.gantiAkunMapping("HAPUS_BUKU_PIUTANG", "akun_debit_id", asal);
    }
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("mapping event kekurangan yang hilang menolak hapus buku, bukan memposting separuh", async () => {
    // The failure mode worth naming: if the shortfall mapping is absent, the
    // temptation is to post the allowance leg alone and "handle the rest
    // later", which is a receivable that never left the balance sheet and an
    // allowance that did. The whole journal is refused instead.
    await setelSaldoPenyisihan(keSen(rp(1_000_000)));
    await d.db.query(
      `update event_jurnal_mapping set aktif = false
        where bumn_id = $1::uuid and event_code = 'HAPUS_BUKU_KEKURANGAN_PENYISIHAN'`,
      [d.bumnId],
    );
    try {
      await tolakDengan(hapusBuku(rp(3_000_000)), "EVENT_MAPPING_TIDAK_DITEMUKAN");
      expect(await saldoPenyisihan()).toBe(keSen(rp(1_000_000)));
    } finally {
      await d.db.query(
        `update event_jurnal_mapping set aktif = true
          where bumn_id = $1::uuid and event_code = 'HAPUS_BUKU_KEKURANGAN_PENYISIHAN'`,
        [d.bumnId],
      );
    }
    expect(await selisihLedger(d.db)).toBe("0.00");
  });
});
