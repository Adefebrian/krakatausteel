// Spec 6.6 "Test wajib untuk engine jurnal", items 1-7 and 10.
// Items 8 and 9 (batch atomicity, concurrent posting) live in
// jurnal-konkurensi.test.ts because they need parallel calls.
//
// Written BEFORE the engine exists (spec rule 5). Every test here is expected
// to fail against ./contract.ts's stubs, and to fail at the engine call or at
// a real assertion, never in the fixture.
//
// Each test name starts with its spec item, so a failure line names the
// requirement that broke without anyone opening the file.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createJurnalEngine,
  KODE_JURNAL,
  POLA_NO_JURNAL,
  type BuatJurnalInput,
  type JurnalEngine,
} from "./contract";
import {
  acak,
  bacaBarisDb,
  bacaJurnalDb,
  buatDunia,
  jumlahUang,
  rp,
  selisihLedger,
  sen,
  tolakDengan,
  type DuniaJurnal,
  type KunciAkun,
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

/** A balanced two-line UMUM journal in the current OPEN period. */
function jurnalSeimbang(nilai = rp(1_000_000), tanggal?: string): BuatJurnalInput {
  return {
    cabangId: d.cabangId,
    jenis: "UMUM",
    tanggalTransaksi: tanggal ?? d.tanggalKini,
    keterangan: "fixture jurnal seimbang",
    baris: [
      { akunId: d.akun.kas.id, debit: nilai, keterangan: "sisi debit" },
      { akunId: d.akun.pendapatanAlokasi.id, kredit: nilai, keterangan: "sisi kredit" },
    ],
  };
}

async function jumlahJurnal(): Promise<number> {
  const r = await d.db.query<{ n: number }>(
    `select count(*)::int as n from jurnal where bumn_id = $1`,
    [d.bumnId],
  );
  return r[0].n;
}

describe("spec 6.6 engine jurnal", () => {
  test("spec 6.6.1 jurnal tidak balance ditolak, dan tidak menyisakan baris di ledger", async () => {
    const sebelum = await jumlahJurnal();
    await tolakDengan(
      engine.buatJurnal(
        {
          cabangId: d.cabangId,
          jenis: "UMUM",
          tanggalTransaksi: d.tanggalKini,
          keterangan: "debit 1.000.000 vs kredit 900.000",
          baris: [
            { akunId: d.akun.kas.id, debit: rp(1_000_000) },
            { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(900_000) },
          ],
        },
        d.ctx.maker,
      ),
      KODE_JURNAL.TIDAK_BALANCE,
    );
    // A rejected create must not leave a half-written header behind.
    expect(await jumlahJurnal()).toBe(sebelum);
  });

  test("spec 6.6.2 jurnal 1 baris ditolak", async () => {
    await tolakDengan(
      engine.buatJurnal(
        {
          cabangId: d.cabangId,
          jenis: "UMUM",
          tanggalTransaksi: d.tanggalKini,
          keterangan: "hanya satu baris",
          baris: [{ akunId: d.akun.kas.id, debit: rp(250_000) }],
        },
        d.ctx.maker,
      ),
      KODE_JURNAL.MINIMAL_DUA_BARIS,
    );
  });

  test("spec 6.6.3 baris dengan debit dan kredit terisi keduanya ditolak", async () => {
    await tolakDengan(
      engine.buatJurnal(
        {
          cabangId: d.cabangId,
          jenis: "UMUM",
          tanggalTransaksi: d.tanggalKini,
          keterangan: "baris 1 mengisi debit dan kredit sekaligus",
          baris: [
            { akunId: d.akun.kas.id, debit: rp(500_000), kredit: rp(500_000) },
            { akunId: d.akun.pendapatanAlokasi.id, kredit: rp(500_000) },
          ],
        },
        d.ctx.maker,
      ),
      KODE_JURNAL.SATU_SISI_PER_BARIS,
    );
  });

  test("spec 6.6.4 posting ke periode CLOSED ditolak, jurnal tetap DRAFT", async () => {
    // The DRAFT is created while 2026-01 is still OPEN, which is the only way
    // to reach the posting guard rather than the create guard.
    const draft = await engine.buatJurnal(jurnalSeimbang(rp(750_000), d.tanggalAwal), d.ctx.approver);
    await d.tutupPeriode(d.periodeAwal);

    await tolakDengan(engine.postingJurnal(draft.id, d.ctx.approver), KODE_JURNAL.PERIODE_TIDAK_OPEN);

    const db = await bacaJurnalDb(d.db, draft.id);
    expect(db?.status).toBe("DRAFT");
    expect(db?.posted_by).toBeNull();
  });

  test("spec 6.6.5 edit jurnal POSTED ditolak, tidak ada kolom yang berubah", async () => {
    const draft = await engine.buatJurnal(jurnalSeimbang(rp(1_200_000)), d.ctx.approver);
    const posted = await engine.postingJurnal(draft.id, d.ctx.approver);
    const sebelum = await bacaJurnalDb(d.db, posted.id);

    await tolakDengan(
      engine.ubahJurnalDraft(posted.id, jurnalSeimbang(rp(9_999_999)), d.ctx.approver),
      KODE_JURNAL.JURNAL_TIDAK_DRAFT,
    );

    const sesudah = await bacaJurnalDb(d.db, posted.id);
    expect(sesudah?.total_debit).toBe(sebelum?.total_debit);
    expect(sesudah?.total_kredit).toBe(sebelum?.total_kredit);
    expect(sesudah?.version).toBe(sebelum?.version);
    expect(sesudah?.status).toBe("POSTED");
  });

  test("spec 6.6.6 reversal jurnal POSTED menukar debit dan kredit dengan total yang sama", async () => {
    const nilai = rp(3_450_000);
    const draft = await engine.buatJurnal(jurnalSeimbang(nilai), d.ctx.approver);
    const asli = await engine.postingJurnal(draft.id, d.ctx.approver);

    const rev = await engine.reversalJurnal(asli.id, "koreksi salah akun", d.ctx.approver);

    expect(rev.jenis).toBe("REVERSAL");
    expect(rev.status).toBe("POSTED");
    expect(rev.totalDebit).toBe(asli.totalDebit);
    expect(rev.totalKredit).toBe(asli.totalKredit);

    const barisAsli = await bacaBarisDb(d.db, asli.id);
    const barisRev = await bacaBarisDb(d.db, rev.id);
    expect(barisRev).toHaveLength(barisAsli.length);

    // Same accounts, sides swapped, amounts identical to the sen.
    for (const b of barisAsli) {
      const pasangan = barisRev.find((r) => r.akun_id === b.akun_id);
      expect(pasangan).toBeDefined();
      expect(pasangan!.debit).toBe(b.kredit);
      expect(pasangan!.kredit).toBe(b.debit);
    }
    // Kas was debited 3.450.000 in the original, so it is credited here.
    const kasRev = barisRev.find((r) => r.akun_id === d.akun.kas.id);
    expect(kasRev?.kredit).toBe(nilai);
    expect(kasRev?.debit).toBe(rp(0));
  });

  test("spec 6.6.7 reversal atas jurnal yang sudah REVERSED ditolak", async () => {
    const draft = await engine.buatJurnal(jurnalSeimbang(rp(600_000)), d.ctx.approver);
    const asli = await engine.postingJurnal(draft.id, d.ctx.approver);
    const rev = await engine.reversalJurnal(asli.id, "reversal pertama", d.ctx.approver);
    expect(rev.reversalOfJurnalId).toBe(asli.id);

    await tolakDengan(
      engine.reversalJurnal(asli.id, "reversal kedua", d.ctx.approver),
      KODE_JURNAL.JURNAL_SUDAH_REVERSED,
    );

    // Exactly one reversal exists for the original; the DB has a unique index
    // on reversal_of_jurnal_id, and the engine must not rely on hitting it.
    const r = await d.db.query<{ n: number }>(
      `select count(*)::int as n from jurnal where reversal_of_jurnal_id = $1`,
      [asli.id],
    );
    expect(r[0].n).toBe(1);
  });

  test(
    "spec 6.6.10 setelah 100 jurnal random balance di-posting, SUM(debit) - SUM(kredit) seluruh ledger tetap nol (seed 20260823)",
    async () => {
      const SEED = 20260823;
      const rnd = acak(SEED);
      const kunciAkun: KunciAkun[] = [
        "kas",
        "kasKedua",
        "piutangJasa",
        "bebanOperasional",
        "bebanPinbuk",
        "pendapatanAlokasi",
        "pendapatanJasaGiro",
        "kelebihanAngsuran",
      ];
      const pilih = (): KunciAkun => kunciAkun[Math.floor(rnd() * kunciAkun.length)];

      const dibuat: string[] = [];
      for (let i = 0; i < 100; i += 1) {
        const jumlahBarisDebit = 1 + Math.floor(rnd() * 3); // 1..3 debit lines
        const nilaiDebit = Array.from({ length: jumlahBarisDebit }, () =>
          // 1 sen .. 9.999.999,99, kept in BigInt minor units end to end.
          sen(BigInt(1 + Math.floor(rnd() * 999_999_999))),
        );
        const total = jumlahUang(...nilaiDebit);
        const baris = [
          ...nilaiDebit.map((nilai) => ({ akunId: d.akun[pilih()].id, debit: nilai })),
          { akunId: d.akun[pilih()].id, kredit: total },
        ];
        const draft = await engine.buatJurnal(
          {
            cabangId: d.cabangId,
            jenis: "UMUM",
            tanggalTransaksi: d.tanggalKini,
            keterangan: `properti seed ${SEED} iterasi ${i}`,
            baris,
          },
          d.ctx.approver,
        );
        const posted = await engine.postingJurnal(draft.id, d.ctx.approver);
        expect(posted.status).toBe("POSTED");
        expect(posted.noJurnal).toMatch(POLA_NO_JURNAL);
        expect(posted.totalDebit).toBe(posted.totalKredit);
        dibuat.push(posted.id);
      }

      expect(dibuat).toHaveLength(100);
      expect(new Set(dibuat).size).toBe(100);

      // The whole ledger, computed from the lines, never from the header
      // totals (spec 8.4 check 3 says do not trust that column).
      expect(await selisihLedger(d.db)).toBe("0.00");
    },
    120_000,
  );
});
