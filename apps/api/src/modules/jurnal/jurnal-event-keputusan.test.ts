// The three event codes that are NOT in spec 6.4.
//
// The spec's table has nineteen rows and three real movements of money have no
// code in it: a write-off the allowance does not cover, and a reschedule that
// moves the principal up or down. Fase 3 to 5 cannot record any of them. The
// owner ruled on all three (docs/BUILD-PLAN.md, "Keputusan sementara: event
// yang tidak ada di spesifikasi Bagian 6.4"; ASSUMPTIONS.md A-38 to A-40), and
// they are seeded rows like the other nineteen.
//
// WHAT THESE TESTS ASSERT, AND WHAT THEY DELIBERATELY DO NOT
// They assert the MECHANIC: the accounts come from `event_jurnal_mapping`, a
// mid-run edit to a row changes the journal with no redeploy, and the
// allowance-shortfall sequence leaves a balanced ledger with a contra-asset
// that never goes negative. They do NOT assert that debiting Piutang Jasa
// Administrasi is the correct treatment for a principal increase: that is a
// policy question for the client's finance team and their KAP, and a test that
// pinned it would be dressing up an assumption as a verified rule. If the
// answer changes, one row changes and these tests still pass.
//
// The per-event "produces the journal its mapping row describes" coverage is
// in jurnal-event.test.ts, whose loop iterates the whole catalogue and so
// covers these three too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createJurnalEngine, type JurnalEngine } from "./contract";
import {
  bacaBarisDb,
  buatDunia,
  keSen,
  rp,
  selisihLedger,
  sen,
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
 * Debit-positive balance of one account across POSTED journals, in minor units.
 * A contra-asset like Penyisihan is credit-normal, so its balance below is
 * NEGATIVE when the allowance is positive; the tests negate where that reads
 * better. Deltas everywhere: the world is shared with the other tests in this
 * file, and an absolute balance would be asserting their arithmetic too.
 */
async function saldoAkun(dunia: DuniaJurnal, akunId: string, akadId?: string): Promise<bigint> {
  const r = await dunia.db.query<{ saldo: string }>(
    `select coalesce(sum(b.debit) - sum(b.kredit), 0)::numeric(20,2)::text as saldo
       from jurnal_baris b join jurnal j on j.id = b.jurnal_id
      where b.akun_id = $1::uuid
        and j.status = 'POSTED'
        and j.deleted_at is null
        and b.deleted_at is null
        and ($2::uuid is null or b.akad_id = $2::uuid)`,
    [akunId, akadId ?? null],
  );
  return keSen(r[0].saldo);
}

/** Credit-positive, which is how an allowance account is actually read. */
async function saldoPenyisihan(dunia: DuniaJurnal): Promise<bigint> {
  return -(await saldoAkun(dunia, dunia.akun.penyisihan.id));
}

describe("keputusan pemilik: tiga event di luar spec 6.4", () => {
  test("ketiganya adalah jurnal buku, tidak ada kaki kas", async () => {
    // A restructure and a write-off move no money. A cash leg appearing on any
    // of them would mean the caller reached for the wrong event, so this is
    // asserted on the produced journal and not only on the seeded row.
    for (const eventCode of [
      "HAPUS_BUKU_KEKURANGAN_PENYISIHAN",
      "RESTRUKTUR_POKOK_NAIK",
      "RESTRUKTUR_POKOK_TURUN",
    ]) {
      const jurnal = await engine.postingEvent(
        eventCode,
        {
          cabangId: d.cabangId,
          tanggalTransaksi: d.tanggalKini,
          nilai: rp(100_000),
          keterangan: `uji tanpa kas ${eventCode}`,
        },
        d.ctx.approver,
      );
      const baris = await bacaBarisDb(d.db, jurnal.id);
      expect(baris).toHaveLength(2);
      for (const b of baris) {
        expect(b.akun_id).not.toBe(d.akun.kas.id);
        expect(b.akun_id).not.toBe(d.akun.kasKedua.id);
      }
      expect(jurnal.status).toBe("POSTED");
    }
    expect(await selisihLedger(d.db)).toBe("0.00");
  });

  test("HAPUS_BUKU_KEKURANGAN_PENYISIHAN membebani periode berjalan, bukan akun kontra", async () => {
    const bebanSebelum = await saldoAkun(d, d.akun.bebanPenyisihan.id);
    const penyisihanSebelum = await saldoPenyisihan(d);

    const jurnal = await engine.postingEvent(
      "HAPUS_BUKU_KEKURANGAN_PENYISIHAN",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: rp(750_000),
        mitraId: d.mitraId,
        akadId: d.akadId,
      },
      d.ctx.approver,
    );

    const baris = await bacaBarisDb(d.db, jurnal.id);
    const beban = baris.find((b) => b.akun_id === d.akun.bebanPenyisihan.id);
    const piutang = baris.find((b) => b.akun_id === d.akun.piutangPokok.id);
    expect(beban?.debit).toBe(rp(750_000));
    expect(piutang?.kredit).toBe(rp(750_000));
    // The sub-ledger dimension rides the receivable leg, never the expense leg,
    // or v_rekonsiliasi_piutang would net this journal to zero for the akad.
    expect(piutang?.akad_id).toBe(d.akadId);
    expect(beban?.akad_id).toBeNull();

    // The whole point of the event: the allowance is untouched.
    expect((await saldoAkun(d, d.akun.bebanPenyisihan.id)) - bebanSebelum).toBe(75_000_000n);
    expect(await saldoPenyisihan(d)).toBe(penyisihanSebelum);
  });

  test("RESTRUKTUR_POKOK_NAIK memindahkan tagihan yang sudah diakui ke pokok", async () => {
    const pokokSebelum = await saldoAkun(d, d.akun.piutangPokok.id);
    const jasaSebelum = await saldoAkun(d, d.akun.piutangJasa.id);

    const jurnal = await engine.postingEvent(
      "RESTRUKTUR_POKOK_NAIK",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: rp(1_200_000),
        mitraId: d.mitraId,
        akadId: d.akadId,
      },
      d.ctx.approver,
    );

    const baris = await bacaBarisDb(d.db, jurnal.id);
    expect(baris.find((b) => b.akun_id === d.akun.piutangPokok.id)?.debit).toBe(rp(1_200_000));
    expect(baris.find((b) => b.akun_id === d.akun.piutangJasa.id)?.kredit).toBe(rp(1_200_000));

    // Total receivables are unchanged: this reclassifies a claim, it does not
    // create one. That is the property that makes it a book entry.
    const pokokNaik = (await saldoAkun(d, d.akun.piutangPokok.id)) - pokokSebelum;
    const jasaTurun = jasaSebelum - (await saldoAkun(d, d.akun.piutangJasa.id));
    expect(pokokNaik).toBe(120_000_000n);
    expect(jasaTurun).toBe(120_000_000n);

    // Only the pokok leg is the piutang mitra binaan account, so only it
    // carries the akad. Piutang Jasa Administrasi is a different account and
    // is not part of that sub-ledger.
    expect(baris.find((b) => b.akun_id === d.akun.piutangPokok.id)?.akad_id).toBe(d.akadId);
    expect(baris.find((b) => b.akun_id === d.akun.piutangJasa.id)?.akad_id).toBeNull();
  });

  test("RESTRUKTUR_POKOK_TURUN diserap penyisihan lebih dulu", async () => {
    const penyisihanSebelum = await saldoPenyisihan(d);
    const jurnal = await engine.postingEvent(
      "RESTRUKTUR_POKOK_TURUN",
      {
        cabangId: d.cabangId,
        tanggalTransaksi: d.tanggalKini,
        nilai: rp(400_000),
        mitraId: d.mitraId,
        akadId: d.akadId,
      },
      d.ctx.approver,
    );
    const baris = await bacaBarisDb(d.db, jurnal.id);
    expect(baris.find((b) => b.akun_id === d.akun.penyisihan.id)?.debit).toBe(rp(400_000));
    expect(baris.find((b) => b.akun_id === d.akun.piutangPokok.id)?.kredit).toBe(rp(400_000));
    // Debiting a credit-normal contra account REDUCES the allowance.
    expect(penyisihanSebelum - (await saldoPenyisihan(d))).toBe(40_000_000n);
  });
});

describe("keputusan pemilik: akunnya tetap data, bukan kode", () => {
  // Same proof the other nineteen get: repoint the row, and the journal moves
  // with it in the same process, with no redeploy. If any of the three account
  // choices turns out to be wrong, this is the cost of fixing it.
  const kasus: Array<{
    eventCode: string;
    kolom: "akun_debit_id" | "akun_kredit_id";
    asalKunci: "bebanPenyisihan" | "piutangJasa" | "penyisihan";
    baruKunci: "bebanOperasional" | "piutangAlternatif";
  }> = [
    {
      eventCode: "HAPUS_BUKU_KEKURANGAN_PENYISIHAN",
      kolom: "akun_debit_id",
      asalKunci: "bebanPenyisihan",
      baruKunci: "bebanOperasional",
    },
    {
      eventCode: "RESTRUKTUR_POKOK_NAIK",
      kolom: "akun_kredit_id",
      asalKunci: "piutangJasa",
      baruKunci: "piutangAlternatif",
    },
    {
      eventCode: "RESTRUKTUR_POKOK_TURUN",
      kolom: "akun_debit_id",
      asalKunci: "penyisihan",
      baruKunci: "bebanOperasional",
    },
  ];

  for (const k of kasus) {
    test(`${k.eventCode} mengikuti perubahan baris mapping tanpa perubahan kode`, async () => {
      const asal = d.akun[k.asalKunci].id;
      const baru = d.akun[k.baruKunci].id;
      const sisi = k.kolom === "akun_debit_id" ? "debit" : "kredit";

      const sebelum = await engine.postingEvent(
        k.eventCode,
        { cabangId: d.cabangId, tanggalTransaksi: d.tanggalKini, nilai: rp(50_000) },
        d.ctx.approver,
      );
      const barisSebelum = await bacaBarisDb(d.db, sebelum.id);
      expect(barisSebelum.find((b) => b[sisi] !== rp(0))?.akun_id).toBe(asal);

      await d.gantiAkunMapping(k.eventCode, k.kolom, baru);
      try {
        const sesudah = await engine.postingEvent(
          k.eventCode,
          { cabangId: d.cabangId, tanggalTransaksi: d.tanggalKini, nilai: rp(50_000) },
          d.ctx.approver,
        );
        const barisSesudah = await bacaBarisDb(d.db, sesudah.id);
        expect(barisSesudah.find((b) => b[sisi] !== rp(0))?.akun_id).toBe(baru);
      } finally {
        await d.gantiAkunMapping(k.eventCode, k.kolom, asal);
      }
    });
  }
});

describe("hapus buku dengan penyisihan yang KURANG", () => {
  test("penyisihan dihabiskan lebih dulu, sisanya jadi beban, dan akun kontra tidak pernah negatif", async () => {
    // The case the shortfall event exists for. The spec's HAPUS_BUKU_PIUTANG
    // debits the allowance for the FULL outstanding, which only works when the
    // allowance covers it; under a collective-impairment basis it can be
    // smaller. This test states the SHAPE the split has to produce, with the
    // amounts written out by hand: ONE journal, the allowance consumed
    // exactly, the remainder as expense of the current period. Computing that
    // split from the ledger is `postingHapusBukuPiutang`, and
    // ./jurnal-hapus-buku.test.ts is where the arithmetic and the boundaries
    // are pinned. Both are worth having: this one would still fail if the
    // combined-posting mechanics broke under an engine that split correctly.
    const dunia = await buatDunia();
    try {
      const mesin = createJurnalEngine({ db: dunia.db, jam: dunia.jam });
      const outstanding = rp(5_000_000);
      const penyisihanTersedia = rp(3_000_000);
      const kekurangan = rp(2_000_000);

      // The receivable exists first, for a real akad, so the sub-ledger side
      // is real rather than implied.
      await mesin.postingEvent(
        "PENCAIRAN_PUMK",
        {
          cabangId: dunia.cabangId,
          tanggalTransaksi: dunia.tanggalKini,
          nilai: outstanding,
          mitraId: dunia.mitraId,
          akadId: dunia.akadId,
        },
        dunia.ctx.approver,
      );
      // An allowance smaller than the outstanding: the whole premise.
      await mesin.postingEvent(
        "BEBAN_PENYISIHAN",
        { cabangId: dunia.cabangId, tanggalTransaksi: dunia.tanggalKini, nilai: penyisihanTersedia },
        dunia.ctx.approver,
      );

      expect(await saldoPenyisihan(dunia)).toBe(keSen(penyisihanTersedia));
      expect(await saldoAkun(dunia, dunia.akun.piutangPokok.id, dunia.akadId)).toBe(
        keSen(outstanding),
      );
      const bebanSebelum = await saldoAkun(dunia, dunia.akun.bebanPenyisihan.id);

      // ONE journal: allowance first, remainder to expense. Both legs credit
      // the same receivable for the same akad, so they merge into a single
      // credit line of the full outstanding, which is what a write-off is.
      const hapusBuku = await dunia.db.transaction((tx) =>
        mesin.postingEventGabungan(
          {
            cabangId: dunia.cabangId,
            tanggalTransaksi: dunia.tanggalKini,
            keterangan: "hapus buku, penyisihan tidak menutup seluruh outstanding",
            referensiTipe: "pumk_hapus_buku",
            referensiId: dunia.akadId,
            komponen: [
              {
                eventCode: "HAPUS_BUKU_PIUTANG",
                nilai: penyisihanTersedia,
                mitraId: dunia.mitraId,
                akadId: dunia.akadId,
              },
              {
                eventCode: "HAPUS_BUKU_KEKURANGAN_PENYISIHAN",
                nilai: kekurangan,
                mitraId: dunia.mitraId,
                akadId: dunia.akadId,
              },
            ],
          },
          tx,
          dunia.ctx.maker,
        ),
      );

      expect(hapusBuku.jumlahBaris).toBe(3);
      const baris = await bacaBarisDb(dunia.db, hapusBuku.id);
      expect(baris).toHaveLength(3);

      // One receivable line, for the FULL outstanding, carrying the akad.
      const kakiPiutang = baris.filter((b) => b.akun_id === dunia.akun.piutangPokok.id);
      expect(kakiPiutang).toHaveLength(1);
      expect(kakiPiutang[0].kredit).toBe(outstanding);
      expect(kakiPiutang[0].akad_id).toBe(dunia.akadId);

      // The allowance absorbed exactly what it had, and the rest is expense.
      expect(baris.find((b) => b.akun_id === dunia.akun.penyisihan.id)?.debit).toBe(
        penyisihanTersedia,
      );
      expect(baris.find((b) => b.akun_id === dunia.akun.bebanPenyisihan.id)?.debit).toBe(
        kekurangan,
      );

      // THE INVARIANT THIS EVENT EXISTS TO PROTECT: a contra-ASSET account
      // driven negative would present as a negative deduction, i.e. as an
      // inflated receivable, in the Laporan Posisi Keuangan.
      const penyisihanSesudah = await saldoPenyisihan(dunia);
      expect(penyisihanSesudah).toBe(0n);
      expect(penyisihanSesudah >= 0n).toBe(true);

      // The receivable for the akad is gone, and the shortfall hit expense.
      expect(await saldoAkun(dunia, dunia.akun.piutangPokok.id, dunia.akadId)).toBe(0n);
      expect((await saldoAkun(dunia, dunia.akun.bebanPenyisihan.id)) - bebanSebelum).toBe(
        keSen(kekurangan),
      );

      // Totals and the ledger as a whole.
      expect(hapusBuku.totalDebit).toBe(outstanding);
      expect(hapusBuku.totalKredit).toBe(outstanding);
      expect(await selisihLedger(dunia.db)).toBe("0.00");
    } finally {
      await dunia.tutup();
    }
  });

  test("kalau penyisihan menutup seluruhnya, event kekurangan tidak dipakai sama sekali", async () => {
    // The boundary. Nothing about the shortfall event changes the ordinary
    // case, and a caller that reaches for it when the allowance covers the
    // write-off would be overstating the period's expense.
    const dunia = await buatDunia();
    try {
      const mesin = createJurnalEngine({ db: dunia.db, jam: dunia.jam });
      const outstanding = rp(2_000_000);
      await mesin.postingEvent(
        "PENCAIRAN_PUMK",
        {
          cabangId: dunia.cabangId,
          tanggalTransaksi: dunia.tanggalKini,
          nilai: outstanding,
          mitraId: dunia.mitraId,
          akadId: dunia.akadId,
        },
        dunia.ctx.approver,
      );
      await mesin.postingEvent(
        "BEBAN_PENYISIHAN",
        { cabangId: dunia.cabangId, tanggalTransaksi: dunia.tanggalKini, nilai: rp(2_500_000) },
        dunia.ctx.approver,
      );
      const bebanSebelum = await saldoAkun(dunia, dunia.akun.bebanPenyisihan.id);

      const jurnal = await mesin.postingEvent(
        "HAPUS_BUKU_PIUTANG",
        {
          cabangId: dunia.cabangId,
          tanggalTransaksi: dunia.tanggalKini,
          nilai: outstanding,
          mitraId: dunia.mitraId,
          akadId: dunia.akadId,
        },
        dunia.ctx.approver,
      );
      const baris = await bacaBarisDb(dunia.db, jurnal.id);
      expect(baris).toHaveLength(2);
      expect(baris.some((b) => b.akun_id === dunia.akun.bebanPenyisihan.id)).toBe(false);
      // Allowance still positive, receivable gone, no expense recognised.
      expect(await saldoPenyisihan(dunia)).toBe(keSen(rp(500_000)));
      expect(await saldoAkun(dunia, dunia.akun.piutangPokok.id, dunia.akadId)).toBe(0n);
      expect(await saldoAkun(dunia, dunia.akun.bebanPenyisihan.id)).toBe(bebanSebelum);
    } finally {
      await dunia.tutup();
    }
  });

  test("engine tidak menebak: memakai HAPUS_BUKU_PIUTANG untuk seluruh outstanding memang membuat penyisihan negatif", async () => {
    // Stated as a test rather than as a comment, because it is the reason the
    // shortfall event exists. `postingEvent` stays what it is: it posts what
    // the mapping row says, for the amount it is handed, with no opinion about
    // whether an allowance is sufficient. That is why a write-off must NOT go
    // through this method; `postingHapusBukuPiutang` is the path that reads
    // the allowance and splits, and this test is what it is protecting
    // against. If it ever goes green for a new reason, the naive journal has
    // stopped being possible and the guard can be re-examined.
    const dunia = await buatDunia();
    try {
      const mesin = createJurnalEngine({ db: dunia.db, jam: dunia.jam });
      await mesin.postingEvent(
        "BEBAN_PENYISIHAN",
        { cabangId: dunia.cabangId, tanggalTransaksi: dunia.tanggalKini, nilai: rp(1_000_000) },
        dunia.ctx.approver,
      );
      await mesin.postingEvent(
        "HAPUS_BUKU_PIUTANG",
        {
          cabangId: dunia.cabangId,
          tanggalTransaksi: dunia.tanggalKini,
          nilai: rp(4_000_000),
          mitraId: dunia.mitraId,
          akadId: dunia.akadId,
        },
        dunia.ctx.approver,
      );
      // Negative allowance: presented as a NEGATIVE deduction, i.e. an
      // overstated receivable. Balanced, and wrong.
      expect(await saldoPenyisihan(dunia)).toBe(-keSen(rp(3_000_000)));
      expect(await selisihLedger(dunia.db)).toBe("0.00");
      // And this is the amount that should have gone through the shortfall
      // event instead, which the test above does.
      expect(sen(keSen(rp(4_000_000)) - keSen(rp(1_000_000)))).toBe(rp(3_000_000));
    } finally {
      await dunia.tutup();
    }
  });
});
