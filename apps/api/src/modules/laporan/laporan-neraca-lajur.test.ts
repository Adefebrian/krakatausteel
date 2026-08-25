// NERACA LAJUR (spec 10.3 report 23), and the third assertion the
// specification asks for by name.
//
//   "Per akun: Saldo Awal (D, K), Mutasi (D, K), Saldo Akhir (D, K). Baris
//    total di bawah wajib balance di ketiga pasang kolom."
//                                                    -- spec 10.3, report 23
//   "Buka Neraca Lajur, konfirmasi ketiga pasang kolom balance."
//                                                    -- spec 16, scenario 16
//
// WHY NON-ZERO COMES FIRST. All three pairs balance at 0 = 0. They also
// balance for a report that returned one account, for a report whose date
// window caught nothing, and for a report whose branch filter excluded
// everything. The fixture's world has 1.726.000.000 of opening balances,
// 93.000.000 of movement and 1.761.000.000 of closing balances in the
// reporting month across ten accounts, and each of the six totals is asserted
// non-zero before any pair is compared.
//
// AND: A POSTED-ONLY NERACA LAJUR ALSO BALANCES. That is the whole reason
// ADR 0010 is dangerous. A reversal adds two balanced journals and marks one
// REVERSED; a POSTED-only reading drops one and keeps the other, and the
// worksheet still foots perfectly with an account-level error in it. The
// balance checks in this file therefore cannot detect that defect, and are not
// asked to; ./laporan-sumber-periode.test.ts detects it per account.
//
// THE PERIOD IS THE MONTH, NOT YEAR TO DATE. Saldo Awal is the balance the day
// before the period starts and Mutasi is that month alone, which is exactly
// the shape `saldo_akun_periode` freezes. Any other window makes the CLOSED
// path and the OPEN path structurally incapable of producing the same six
// numbers, and spec 10 requires them to.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HARAPAN,
  buatDunia,
  headerSah,
  jumlahUang,
  keSen,
  kurangUang,
  negasiUang,
  rp,
  semuaAngkaSah,
  tambahHari,
  type DuniaLaporan,
} from "./test-support";
import { NAMA_LAPORAN, NOL_TAMPIL, type LaporanNeracaLajur } from "./contract";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterAll(async () => {
  await d?.tutup();
});

function neraca(cabangId: string | null = null): Promise<LaporanNeracaLajur> {
  return d.engine.neracaLajur(
    { periodeId: d.periodeLaporan().id, cabangId: cabangId ?? d.cabangId },
    d.ctx.adminPusat,
  );
}

describe("skenario 16: ketiga pasang kolom balance", () => {
  test("keenam total bukan nol, lalu ketiga pasangnya sama", async () => {
    const l = await neraca();

    // NON-VACUOUS FIRST, all six.
    const t = l.total;
    for (const [nama, sel] of Object.entries(t)) {
      expect(keSen(sel.nilai), `total ${nama} nol`).toBeGreaterThan(0n);
    }
    expect(l.baris.length).toBeGreaterThanOrEqual(8);

    expect(t.saldoAwalDebit.nilai).toBe(HARAPAN.neracaSaldoAwal);
    expect(t.mutasiDebit.nilai).toBe(HARAPAN.neracaMutasi);
    expect(t.saldoAkhirDebit.nilai).toBe(HARAPAN.neracaSaldoAkhir);

    // The three pairs.
    expect(t.saldoAwalDebit.nilai).toBe(t.saldoAwalKredit.nilai);
    expect(t.mutasiDebit.nilai).toBe(t.mutasiKredit.nilai);
    expect(t.saldoAkhirDebit.nilai).toBe(t.saldoAkhirKredit.nilai);
  });

  test("juga balance untuk Semua Cabang, dengan angka yang lebih besar", async () => {
    const l = await d.engine.neracaLajur(
      { periodeId: d.periodeLaporan().id, cabangId: null },
      d.ctx.adminPusat,
    );
    expect(keSen(l.total.saldoAwalDebit.nilai)).toBeGreaterThan(keSen(HARAPAN.neracaSaldoAwal));
    expect(l.total.saldoAwalDebit.nilai).toBe(l.total.saldoAwalKredit.nilai);
    expect(l.total.mutasiDebit.nilai).toBe(l.total.mutasiKredit.nilai);
    expect(l.total.saldoAkhirDebit.nilai).toBe(l.total.saldoAkhirKredit.nilai);
  });

  test("total baris sama dengan penjumlahan kolom per akun, bukan hitungan terpisah", async () => {
    // A footing computed independently of the rows can agree with a wrong set
    // of rows. Summing the printed rows is what ties the total to what a
    // reader actually sees.
    const l = await neraca();
    const kolom = [
      "saldoAwalDebit",
      "saldoAwalKredit",
      "mutasiDebit",
      "mutasiKredit",
      "saldoAkhirDebit",
      "saldoAkhirKredit",
    ] as const;
    for (const k of kolom) {
      const dijumlah = l.baris.reduce((acc, b) => jumlahUang(acc, b[k].nilai), rp(0));
      expect(dijumlah, `total ${k} tidak sama dengan jumlah barisnya`).toBe(l.total[k].nilai);
    }
  });
});

describe("kolom per akun: satu sisi saja, dan identitas per baris", () => {
  test("saldo debit dan kredit tidak pernah terisi bersamaan", async () => {
    // This is what makes the three pairs comparable at all. The frozen table
    // stores one debit-positive figure per account (migrations/0011 sign
    // convention); splitting it at the report boundary is this report's job,
    // and putting a number on both sides double counts the footing.
    const l = await neraca();
    for (const b of l.baris) {
      const pasangan: Array<[string, string, string]> = [
        ["saldoAwal", b.saldoAwalDebit.nilai, b.saldoAwalKredit.nilai],
        ["mutasi", b.mutasiDebit.nilai, b.mutasiKredit.nilai],
        ["saldoAkhir", b.saldoAkhirDebit.nilai, b.saldoAkhirKredit.nilai],
      ];
      for (const [nama, debit, kredit] of pasangan) {
        expect(keSen(debit) >= 0n, `${b.kode} ${nama} debit negatif`).toBe(true);
        expect(keSen(kredit) >= 0n, `${b.kode} ${nama} kredit negatif`).toBe(true);
        if (nama !== "mutasi") {
          expect(
            keSen(debit) === 0n || keSen(kredit) === 0n,
            `${b.kode} ${nama} terisi di kedua sisi`,
          ).toBe(true);
        }
      }
    }
  });

  test("saldo akhir setiap akun = saldo awal + mutasi debit - mutasi kredit", async () => {
    const l = await neraca();
    for (const b of l.baris) {
      const awal = kurangUang(b.saldoAwalDebit.nilai, b.saldoAwalKredit.nilai);
      const akhir = kurangUang(b.saldoAkhirDebit.nilai, b.saldoAkhirKredit.nilai);
      const gerak = kurangUang(b.mutasiDebit.nilai, b.mutasiKredit.nilai);
      expect(jumlahUang(awal, gerak), `identitas akun ${b.kode}`).toBe(akhir);
    }
  });

  test("angka per akun cocok dengan ledger, per akun, bukan hanya di total", async () => {
    // The footing can be right while two rows are wrong by offsetting amounts.
    const p = d.periodeLaporan();
    const sebelum = tambahHari(p.tanggalMulai, -1);
    const l = await neraca();
    for (const b of l.baris) {
      const awal = await d.saldoLedger(b.akunId, sebelum, d.cabangId);
      const akhir = await d.saldoLedger(b.akunId, p.tanggalAkhir, d.cabangId);
      const m = await d.mutasiLedger(b.akunId, p.tanggalMulai, p.tanggalAkhir, d.cabangId);
      expect(kurangUang(b.saldoAwalDebit.nilai, b.saldoAwalKredit.nilai), `awal ${b.kode}`).toBe(
        awal,
      );
      expect(kurangUang(b.saldoAkhirDebit.nilai, b.saldoAkhirKredit.nilai), `akhir ${b.kode}`).toBe(
        akhir,
      );
      expect(b.mutasiDebit.nilai, `mutasi debit ${b.kode}`).toBe(m.debit);
      expect(b.mutasiKredit.nilai, `mutasi kredit ${b.kode}`).toBe(m.kredit);
    }
  });

  test("akun bersaldo kredit muncul di kolom kredit, bukan sebagai debit negatif", async () => {
    const l = await neraca();
    const kelebihan = l.baris.find((b) => b.kode === d.akun.kelebihanAngsuran.kode);
    expect(kelebihan).toBeDefined();
    expect(kelebihan!.saldoNormal).toBe("K");
    expect(kelebihan!.saldoAkhirKredit.nilai).toBe(HARAPAN.totalLiabilitas);
    expect(kelebihan!.saldoAkhirDebit.nilai).toBe(rp(0));
    expect(kelebihan!.saldoAkhirDebit.tampil).toBe(NOL_TAMPIL);
    // The allowance is an ASSET with a CREDIT normal balance, and the
    // worksheet must follow the balance rather than the type.
    const penyisihan = l.baris.find((b) => b.kode === d.akun.penyisihan.kode)!;
    expect(penyisihan.tipe).toBe("ASET");
    expect(penyisihan.saldoNormal).toBe("K");
    expect(penyisihan.saldoAkhirKredit.nilai).toBe(HARAPAN.penyisihan);
    expect(penyisihan.saldoAkhirDebit.nilai).toBe(rp(0));
  });
});

describe("periode adalah bulan itu, bukan year to date", () => {
  test("saldo awal Maret adalah saldo akhir Februari", async () => {
    const l = await neraca();
    const kas = l.baris.find((b) => b.kode === d.akun.kas.kode)!;
    expect(kas.saldoAwalDebit.nilai).toBe(HARAPAN.kasSaldoAwalMaret);
    expect(kas.mutasiDebit.nilai).toBe(HARAPAN.kasMutasiDebitMaret);
    expect(kas.mutasiKredit.nilai).toBe(HARAPAN.kasMutasiKreditMaret);
    expect(kas.saldoAkhirDebit.nilai).toBe(HARAPAN.kasAkhir);

    const februari = await d.engine.neracaLajur(
      { periodeId: d.periode(2026, 2).id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    const kasFebruari = februari.baris.find((b) => b.kode === d.akun.kas.kode)!;
    // The two months chain: a year-to-date reading would not.
    expect(kasFebruari.saldoAkhirDebit.nilai).toBe(kas.saldoAwalDebit.nilai);
    expect(februari.total.mutasiDebit.nilai).not.toBe(l.total.mutasiDebit.nilai);
  });
});

describe("cakupan baris", () => {
  test("hanya akun postable, dan hanya yang punya saldo awal atau mutasi", async () => {
    const l = await neraca();
    for (const b of l.baris) {
      const bergerak =
        keSen(b.saldoAwalDebit.nilai) !== 0n ||
        keSen(b.saldoAwalKredit.nilai) !== 0n ||
        keSen(b.mutasiDebit.nilai) !== 0n ||
        keSen(b.mutasiKredit.nilai) !== 0n;
      expect(bergerak, `akun ${b.kode} tidak bergerak tapi dicetak`).toBe(true);
    }
    // Header accounts are not postable and can never carry a balance.
    expect(l.baris.map((b) => b.kode)).not.toContain("1");
    expect(l.baris.map((b) => b.kode)).not.toContain("5");
    // The account with no activity at all is absent, not a zero row.
    expect(l.baris.map((b) => b.kode)).not.toContain(d.akun.bank.kode);
  });

  test("diurutkan menurut kode akun, stabil dan bisa direproduksi", async () => {
    const l = await neraca();
    const kode = l.baris.map((b) => b.kode);
    expect(kode).toEqual([...kode].sort());
    const lagi = await neraca();
    expect(lagi.baris.map((b) => b.kode)).toEqual(kode);
  });
});

describe("mengapa balance saja tidak cukup (ADR 0010, dinyatakan di sini)", () => {
  test("neraca lajur POSTED saja pun tetap balance, jadi test ini tidak bisa mendeteksinya", async () => {
    // Both readings of the whole ledger foot to zero. That is the reason ADR
    // 0010's defect survives every check in this file and is caught only by
    // comparing per account against the ledger predicate, which
    // ./laporan-sumber-periode.test.ts does.
    expect(await d.selisihLedger()).toBe(rp(0));
    expect(await d.selisihLedgerNaifPostedSaja()).toBe(rp(0));
    expect(negasiUang(rp(0))).toBe(rp(0));
  });
});

describe("header dan format", () => {
  test("header spec 10 lengkap, dan setiap sel punya tampilan", async () => {
    const l = await neraca();
    headerSah(l.header as unknown as Record<string, unknown>, d, {
      namaLaporan: NAMA_LAPORAN.NERACA_LAJUR,
      cabangId: d.cabangId,
      sumberData: "LEDGER_LIVE",
    });
    expect(semuaAngkaSah(l, "neracaLajur")).toBeGreaterThan(40);
  });
});
