// WHICH ACCOUNT A RECEIPT'S JASA LEG HITS, and why it is not a configuration
// question (migrations/0030).
//
// THE DEFECT THESE TESTS PIN. `alokasikanSetoran` used to pick the jasa event
// from one config cell, `akuntansi.metode_pengakuan_jasa_adm`. That cell ships
// as ACCRUAL, so EVERY receipt posted ANGSURAN_JASA_ADM_AKRUAL, which CREDITS
// Piutang Jasa Administrasi (1.1.04) on the assumption the receivable already
// exists. It very often did not: `modules/closing` accrues
// `jasa_jatuh_tempo_periode - jasa_diterima_periode`, so an instalment PAID IN
// THE MONTH IT FALLS DUE nets to zero and is never accrued, and nothing ever
// DEBITED 1.1.04 for it. On the twenty four month demo world that drove 1.1.04
// to about MINUS Rp 87,5 juta while Pendapatan Jasa Administrasi showed only
// Rp 6,9 juta on a Rp 2,1 miliar portfolio. Every integrity check passed,
// because the income was missing too and the balance sheet still balanced. The
// arithmetic was never wrong; the CLASSIFICATION was.
//
// THE RULE THESE TESTS ASSERT. The event follows whether THAT jasa was
// actually accrued, read from the schedule row's own
// `jasa_akrual_belum_tertagih`, per rupiah. Nothing here asserts which
// recognition method is correct; the config cell is exercised only to prove it
// no longer decides this, which is the opposite of a policy claim.
//
// THE ACCRUED BALANCE IS PUT ON THE ROW BY HAND HERE. This world has no
// closing engine in it, so a red test in this file means "the receipt
// classified its jasa wrongly" and cannot mean "the accrual engine is also
// involved". The end-to-end proof, where the real close writes the column, the
// real journal debits 1.1.04, and a later receipt clears it to exactly zero,
// lives in modules/closing/closing-akrual.test.ts.
//
// NO LEDGER BALANCE IS ASSERTED FOR AN ACCRUED ROW IN THIS FILE, deliberately.
// Setting the column by hand does not post the accrual journal, so 1.1.04
// starts at zero here and a correct receipt drives it NEGATIVE in this world.
// Asserting "0.00" would need the accrual journal, which needs the closing
// engine, which is the other file. What is asserted here is the classification
// itself: which event, for how much.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createAngsuranEngine, type AngsuranEngine } from "./contract";
import {
  buatDunia,
  porterJurnalUji,
  rp,
  tambahBulan,
  tolakDengan,
  type AkadFixture,
  type DuniaAngsuran,
  type PorterUji,
} from "./test-support";

let d: DuniaAngsuran;
let engine: AngsuranEngine;
let porter: PorterUji;

// The same twelve-row fixture the allocation tests use: 12.000.000 over 12
// months, FLAT 3 percent, rounding 0, first due 10 March 2026. Twelve identical
// rows of pokok 1.000.000,00 + jasa 30.000,00.
const POKOK_BARIS = rp(1_000_000);
const JASA_BARIS = rp(30_000);
const ANGSURAN_BARIS = rp(1_030_000);
const POKOK_AKAD = rp(12_000_000);
const JASA_AKAD = rp(360_000);
const MULAI = "2026-03-10";

beforeAll(async () => {
  d = await buatDunia();
  porter = porterJurnalUji(d.db, d.jam);
  engine = createAngsuranEngine({ db: d.db, jurnal: porter, jam: d.jam });
  await d.setelKonfigurasi("angsuran", "urutan_alokasi_setoran_preset", "DEFAULT");
});

beforeEach(() => {
  porter.reset();
});

afterAll(async () => {
  if (d) await d.tutup();
});

async function akadSiapAngsur(): Promise<AkadFixture> {
  const akad = await d.buatAkad({
    pokok: POKOK_AKAD,
    rate: "0.030000",
    metode: "FLAT",
    tenorBulan: 12,
    tanggalMulaiAngsuran: MULAI,
  });
  await d.cairkan(akad.id, POKOK_AKAD, JASA_AKAD);
  await d.pasangJadwal(
    akad.id,
    1,
    Array.from({ length: 12 }, (_, i) => ({
      angsuranKe: i + 1,
      tanggalJatuhTempo: tambahBulan(MULAI, i),
      pokok: POKOK_BARIS,
      jasaAdm: JASA_BARIS,
      saldoPokokSetelah: rp(12_000_000 - 1_000_000 * (i + 1)),
    })),
  );
  return akad;
}

/** The jasa components of the single journal the receipt posted, by event. */
function kakiJasa(): Map<string, string> {
  expect(porter.panggilan).toHaveLength(1);
  const komponen = porter.panggilan[0].komponen.filter((k) =>
    k.eventCode.startsWith("ANGSURAN_JASA_ADM"),
  );
  return new Map(komponen.map((k) => [k.eventCode, k.nilai]));
}

describe("kasus 1: jatuh tempo dan dibayar di bulan yang sama, belum pernah diakrual", () => {
  test("setoran mengakui pendapatan langsung, dan tidak menyentuh Piutang Jasa Administrasi", async () => {
    // ACCRUAL is the shipped default and stays on for this test ON PURPOSE:
    // this exact combination (config says ACCRUAL, the row says nothing was
    // accrued) is the defect, so a regression here is what turns this red.
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    const akad = await akadSiapAngsur();
    const sebelumPiutang = await d.saldoLedger(d.akun.piutangJasa.id);
    const sebelumPendapatan = await d.saldoLedger(d.akun.pendapatanJasaAdm.id);

    // Row 1 falls due 2026-03-10 and is paid 2026-03-10, before any close.
    // Nothing accrued it, so `jasa_akrual_belum_tertagih` is 0,00.
    const jadwalSebelum = await d.bacaJadwal(akad.id, 1);
    expect(jadwalSebelum[0].jasa_akrual_belum_tertagih).toBe("0.00");

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiJasa).toBe(JASA_BARIS);
    expect(hasil.alokasiJasaAkrual).toBe("0.00");
    expect(hasil.alokasiJasaLangsung).toBe(JASA_BARIS);

    const jasa = kakiJasa();
    expect([...jasa.keys()]).toEqual(["ANGSURAN_JASA_ADM"]);
    expect(jasa.get("ANGSURAN_JASA_ADM")).toBe(JASA_BARIS);

    // The two halves of the defect, stated as ledger movements. Before the
    // fix, 1.1.04 moved by -30.000,00 and income did not move at all.
    expect(await d.saldoLedger(d.akun.piutangJasa.id)).toBe(sebelumPiutang);
    expect(await d.saldoLedger(d.akun.pendapatanJasaAdm.id)).toBe(
      geser(sebelumPendapatan, "-30000.00"),
    );
  });
});

describe("kasus 2: diakrual saat closing, dibayar bulan berikutnya", () => {
  test("setoran menghapus piutang jasa yang memang ada, bukan mengakui pendapatan lagi", async () => {
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    const akad = await akadSiapAngsur();
    // What the 31 March close leaves behind: row 1 fell due 10 March, was
    // still unpaid, so Dr 1.1.04 30.000,00 / Cr pendapatan 30.000,00.
    await d.setelAkrualBaris(akad.id, 1, 1, JASA_BARIS);
    const sebelumPendapatan = await d.saldoLedger(d.akun.pendapatanJasaAdm.id);

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2026-04-05", jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiJasa).toBe(JASA_BARIS);
    expect(hasil.alokasiJasaAkrual).toBe(JASA_BARIS);
    expect(hasil.alokasiJasaLangsung).toBe("0.00");

    const jasa = kakiJasa();
    expect([...jasa.keys()]).toEqual(["ANGSURAN_JASA_ADM_AKRUAL"]);
    expect(jasa.get("ANGSURAN_JASA_ADM_AKRUAL")).toBe(JASA_BARIS);

    // Income was recognised by the CLOSE, so the receipt must not recognise it
    // a second time. This is the assertion that stops "always use the direct
    // event" from being a valid fix.
    expect(await d.saldoLedger(d.akun.pendapatanJasaAdm.id)).toBe(sebelumPendapatan);

    // The receivable the row was carrying is now collected.
    const jadwal = await d.bacaJadwal(akad.id, 1);
    expect(jadwal[0].jasa_terbayar).toBe(JASA_BARIS);
    expect(jadwal[0].jasa_akrual_belum_tertagih).toBe("0.00");
  });
});

describe("kasus 3: sebagian jasa pernah diakrual, sebagian belum", () => {
  test("SATU setoran memakai DUA kaki jasa, terbelah tepat di batas akrualnya", async () => {
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    const akad = await akadSiapAngsur();
    // 12.000,00 of row 1's 30.000,00 jasa is already a receivable; the other
    // 18.000,00 has never been recognised anywhere.
    await d.setelAkrualBaris(akad.id, 1, 1, rp(12_000));
    const sebelumPendapatan = await d.saldoLedger(d.akun.pendapatanJasaAdm.id);

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2026-04-05", jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiJasa).toBe(JASA_BARIS);
    expect(hasil.alokasiJasaAkrual).toBe(rp(12_000));
    expect(hasil.alokasiJasaLangsung).toBe(rp(18_000));

    // ONE journal, TWO jasa components. Spec 7.2 step 8 forbids a second
    // JOURNAL, not a second line, and these two lines land on two different
    // accounts, so collapsing them would be the misclassification again.
    const jasa = kakiJasa();
    expect(jasa.size).toBe(2);
    expect(jasa.get("ANGSURAN_JASA_ADM_AKRUAL")).toBe(rp(12_000));
    expect(jasa.get("ANGSURAN_JASA_ADM")).toBe(rp(18_000));

    expect(await d.saldoLedger(d.akun.pendapatanJasaAdm.id)).toBe(
      geser(sebelumPendapatan, "-18000.00"),
    );

    const jadwal = await d.bacaJadwal(akad.id, 1);
    expect(jadwal[0].jasa_akrual_belum_tertagih).toBe("0.00");
  });

  test("satu setoran atas dua baris: baris yang diakrual dan baris yang tidak", async () => {
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    const akad = await akadSiapAngsur();
    // Row 1 (due 10 March) was accrued at the 31 March close. Row 2 (due
    // 10 April) is being paid in its own month and never was.
    await d.setelAkrualBaris(akad.id, 1, 1, JASA_BARIS);

    // 2.060.000,00 on 10 April clears both rows entirely: the DEFAULT preset
    // takes TUNGGAKAN_JASA across every overdue row first (60.000,00), then
    // TUNGGAKAN_POKOK (2.000.000,00).
    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2026-04-10", jumlah: rp(2_060_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiPokok).toBe(rp(2_000_000));
    expect(hasil.alokasiJasa).toBe(rp(60_000));
    expect(hasil.alokasiJasaAkrual).toBe(JASA_BARIS);
    expect(hasil.alokasiJasaLangsung).toBe(JASA_BARIS);

    const jasa = kakiJasa();
    expect(jasa.size).toBe(2);
    expect(jasa.get("ANGSURAN_JASA_ADM_AKRUAL")).toBe(JASA_BARIS);
    expect(jasa.get("ANGSURAN_JASA_ADM")).toBe(JASA_BARIS);
  });
});

describe("kasus 4: akad di luar kelas yang diakrual", () => {
  test("jasanya selalu pendapatan langsung, karena tidak ada yang pernah mengakrualnya", async () => {
    // The non-performing treatment falls out of the SAME rule rather than
    // needing one of its own: `akrual_hanya_untuk_kolektibilitas` never let the
    // close touch this akad, so every row reads 0,00 and every rupiah of jasa
    // collected is income now. Which akads are in the population is decided in
    // modules/closing and tested there; what is proven here is that this engine
    // needs no separate branch for them.
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    await d.setelKonfigurasi("akuntansi", "akrual_hanya_untuk_kolektibilitas", '["LANCAR"]');
    const akad = await akadSiapAngsur();

    const jadwal = await d.bacaJadwal(akad.id, 1);
    expect(jadwal.every((b) => b.jasa_akrual_belum_tertagih === "0.00")).toBe(true);

    // Paid in arrears on 20 August, exactly the profile of a non-performing
    // akad catching up. Six rows are overdue by then (10 March to 10 August)
    // and the DEFAULT preset takes TUNGGAKAN_JASA across every one of them
    // first, so 180.000,00 pays the jasa of all six and nothing else.
    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2026-08-20", jumlah: rp(180_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiPokok).toBe("0.00");
    expect(hasil.alokasiJasa).toBe(rp(180_000));
    expect(hasil.alokasiJasaAkrual).toBe("0.00");
    expect(hasil.alokasiJasaLangsung).toBe(rp(180_000));
    expect([...kakiJasa().keys()]).toEqual(["ANGSURAN_JASA_ADM"]);
  });
});

describe("kasus 5: CASH_BASIS", () => {
  test("tidak ada yang diakrual, jadi setiap setoran adalah pendapatan langsung", async () => {
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "CASH_BASIS");
    const akad = await akadSiapAngsur();
    const sebelumPiutang = await d.saldoLedger(d.akun.piutangJasa.id);

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiJasaAkrual).toBe("0.00");
    expect(hasil.alokasiJasaLangsung).toBe(JASA_BARIS);
    expect([...kakiJasa().keys()]).toEqual(["ANGSURAN_JASA_ADM"]);
    expect(await d.saldoLedger(d.akun.piutangJasa.id)).toBe(sebelumPiutang);

    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
  });

  test("piutang yang sudah terlanjur diakrual tetap ditagih, walau kebijakannya sudah CASH_BASIS", async () => {
    // A config cell can be edited at any time; a receivable already in the
    // ledger cannot be edited away with it. The old rule read the cell and
    // would have booked this collection as income on top of the income the
    // close already recognised.
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    const akad = await akadSiapAngsur();
    await d.setelAkrualBaris(akad.id, 1, 1, JASA_BARIS);
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "CASH_BASIS");

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2026-04-05", jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );

    expect(hasil.alokasiJasaAkrual).toBe(JASA_BARIS);
    expect([...kakiJasa().keys()]).toEqual(["ANGSURAN_JASA_ADM_AKRUAL"]);

    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
  });
});

describe("pembalikan: setoran mengembalikan persis akrual yang dipakainya", () => {
  test("pemulihan mengembalikan 12.000,00 ke baris asalnya dan bersifat idempoten", async () => {
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    const akad = await akadSiapAngsur();
    await d.setelAkrualBaris(akad.id, 1, 1, rp(12_000));

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2026-04-05", jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
    expect(hasil.alokasiJasaAkrual).toBe(rp(12_000));
    expect((await d.bacaJadwal(akad.id, 1))[0].jasa_akrual_belum_tertagih).toBe("0.00");

    // THE OTHER HALF OF THE REVERSAL, DONE BY HAND, because this repository
    // does not have it yet: no `PembalikStateBisnis` is registered for
    // `referensi_tipe = 'pumk_angsuran'`, so `reversalJurnal` REFUSES such a
    // journal outright rather than reversing the accounting alone, and
    // `pumk_angsuran` stores no per-row allocation to un-apply. Un-applying
    // the payment columns first is not incidental to this test, it is the
    // CONTRACT: `pumk_jadwal_akrual_ck` says a row may never claim more
    // accrued jasa than it still owes, so a row whose jasa is recorded as
    // collected has no room for the receivable back. A future receipt reverser
    // must restore the payment columns and then call
    // `pulihkanAkrualSetoran`, in that order, inside one transaction.
    await d.db.query(
      `update pumk_jadwal_angsuran
          set pokok_terbayar = 0, jasa_terbayar = 0, status = 'JATUH_TEMPO', tanggal_lunas = null
        where akad_id = $1::uuid and versi = 1 and angsuran_ke = 1`,
      [akad.id],
    );

    const pulih = await engine.pulihkanAkrualSetoran(hasil.angsuranId, d.ctx.maker);
    expect(pulih.totalDipulihkan).toBe(rp(12_000));
    expect(pulih.perBaris).toHaveLength(1);
    expect(pulih.perBaris[0].nilai).toBe(rp(12_000));

    // Back exactly where it was. Not "12.000,00 somewhere on the akad": on the
    // row the receipt took it from, so spec 8.4 check 10 still reconciles per
    // akad and the next receipt makes the same decision this one did.
    const jadwal = await d.bacaJadwal(akad.id, 1);
    expect(jadwal[0].jasa_akrual_belum_tertagih).toBe(rp(12_000));
    expect(jadwal[0].id).toBe(pulih.perBaris[0].jadwalId);

    // A reversal that ran twice must not double the receivable.
    const lagi = await engine.pulihkanAkrualSetoran(hasil.angsuranId, d.ctx.maker);
    expect(lagi.totalDipulihkan).toBe("0.00");
    expect(lagi.perBaris).toEqual([]);
    expect((await d.bacaJadwal(akad.id, 1))[0].jasa_akrual_belum_tertagih).toBe(rp(12_000));
  });

  test("setoran yang tidak memakai akrual sama sekali tidak mengembalikan apa pun", async () => {
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    const akad = await akadSiapAngsur();

    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: MULAI, jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
    expect(hasil.alokasiJasaAkrual).toBe("0.00");

    const pulih = await engine.pulihkanAkrualSetoran(hasil.angsuranId, d.ctx.maker);
    expect(pulih.totalDipulihkan).toBe("0.00");
    expect((await d.bacaJadwal(akad.id, 1))[0].jasa_akrual_belum_tertagih).toBe("0.00");
  });

  test("pengguna tanpa wewenang setoran ditolak, bukan sekadar tidak melihat tombolnya", async () => {
    const akad = await akadSiapAngsur();
    await d.setelAkrualBaris(akad.id, 1, 1, JASA_BARIS);
    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2026-04-05", jumlah: ANGSURAN_BARIS, akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
    await tolakDengan(
      engine.pulihkanAkrualSetoran(hasil.angsuranId, d.ctx.auditor),
      "TIDAK_BERWENANG",
    );
  });
});

describe("reschedule: akrual ikut pindah ke versi baru, tidak hilang", () => {
  test("sisa akrual versi lama muncul di baris paling awal versi baru", async () => {
    await d.setelKonfigurasi("akuntansi", "metode_pengakuan_jasa_adm", "ACCRUAL");
    const akad = await akadSiapAngsur();
    // Rows 1 and 2 were accrued at earlier closes and never collected:
    // 60.000,00 of Piutang Jasa Administrasi is in the ledger for this akad.
    await d.setelAkrualBaris(akad.id, 1, 1, JASA_BARIS);
    await d.setelAkrualBaris(akad.id, 1, 2, JASA_BARIS);

    const draf = await engine.ajukanReschedule(
      {
        akadId: akad.id,
        tanggalPengajuan: "2026-05-01",
        alasan: "Usaha mitra terdampak, tenor diperpanjang.",
        jenis: "PERPANJANG_TENOR",
        tenorBaru: 18,
      },
      d.ctx.maker,
    );
    await engine.setujuiReschedule(draf.id, d.ctx.approver);

    // The retired version keeps none of it...
    const versiLama = await d.bacaJadwal(akad.id, 1);
    expect(versiLama.every((b) => b.jasa_akrual_belum_tertagih === "0.00")).toBe(true);

    // ...and the new version carries the whole 60.000,00, oldest row first.
    const versiBaru = await d.bacaJadwal(akad.id, 2);
    const total = versiBaru.reduce((acc, b) => acc + BigInt(b.jasa_akrual_belum_tertagih.replace(".", "")), 0n);
    expect(total).toBe(6_000_000n);
    expect(versiBaru[0].jasa_akrual_belum_tertagih).toBe(versiBaru[0].jasa_adm);

    // And it is still collectible: the next receipt clears the receivable
    // rather than recognising the income a second time.
    // The new version is 12.000.000,00 FLAT 3 percent over 18 months, so its
    // total jasa is 540.000,00 across 18 rows of 30.000,00. Rows 1 and 2 (due
    // 10 March and 10 April) carry the 60.000,00 that was carried over, and a
    // deposit of exactly 60.000,00 on 20 June clears the jasa of both overdue
    // rows and nothing else.
    porter.reset();
    const hasil = await engine.alokasikanSetoran(
      { akadId: akad.id, tanggal: "2026-06-20", jumlah: rp(60_000), akunKasId: d.akun.kas.id },
      d.ctx.maker,
    );
    expect(hasil.alokasiJasa).toBe(rp(60_000));
    expect(hasil.alokasiJasaAkrual).toBe(rp(60_000));
    expect(hasil.alokasiJasaLangsung).toBe("0.00");
  });
});

/** Adds a signed decimal string to a signed decimal string, in sen. */
function geser(saldo: string, delta: string): string {
  const keSen = (x: string): bigint => {
    const m = /^(-?)(\d+)\.(\d{2})$/.exec(x);
    if (!m) throw new Error(`bukan desimal 2 angka: ${JSON.stringify(x)}`);
    return BigInt(`${m[1]}${m[2]}${m[3]}`);
  };
  const total = keSen(saldo) + keSen(delta);
  const negatif = total < 0n;
  const abs = (negatif ? -total : total).toString().padStart(3, "0");
  return `${negatif ? "-" : ""}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}
