// THE ZERO RULE, AT THE REPORT BOUNDARY.
//
// Spec 10, "Aturan teknis laporan", verbatim:
//   "Nilai nol ditampilkan sebagai `0,00` bukan kosong, karena tim akuntansi
//    memakainya untuk cross check."
//
// WHY THIS IS A CONTRACT OF THE REPORT AND NOT A DETAIL OF ONE SCREEN.
// Spec 10 also requires an Excel export and a PDF export of every report, and
// says the Excel "harus rapi dan siap pakai, bukan dump tabel". Three
// consumers, one rule. If the rule lives in a UI helper, the spreadsheet gets
// a second implementation of it, the PDF gets a third, and the first blank
// cell an accountant finds in an export is a defect nobody can locate. So the
// engine renders, every monetary field in every result carries both the exact
// decimal and the string that prints, and the two must agree.
//
// WHY EVERY CELL, NOT THE THREE A TEST NAMES.
// The cell that breaks the cross-check is the one nobody thought about: a
// prior-year comparative on a category that did not exist, the credit column
// of an account with only debits, an empty section's total. `semuaAngkaSah`
// walks the whole payload and asserts every `Angka` in it, so a new field
// added to a report is covered on the day it is added.
//
// THE FORMAT ITSELF IS PINNED HERE, not merely "non-empty": two decimals with
// a comma, thousands grouped with a dot, negatives in parentheses, and zero
// exactly `0,00`. ./test-support.ts states the rule as a reference
// implementation and its inverse, so every cell is also required to read back
// to its own value. A report that prints "1,285,000,000.00" satisfies
// "non-empty" and is wrong in an Indonesian statement.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  KODE_BARIS,
  angkaSah,
  bacaTampil,
  buatDunia,
  formatTampil,
  keSen,
  rp,
  semuaAngkaSah,
  setiapAngka,
  type DuniaLaporan,
} from "./test-support";
import { NOL_TAMPIL, POLA_TAMPIL, POLA_UANG } from "./contract";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterAll(async () => {
  await d?.tutup();
});

async function semuaLaporan() {
  const f = { periodeId: d.periodeLaporan().id, cabangId: d.cabangId };
  return {
    baganAkun: await d.engine.baganAkun({}, d.ctx.adminPusat),
    aktivitas: await d.engine.laporanAktivitas(f, d.ctx.adminPusat),
    arusKas: await d.engine.laporanArusKas(f, d.ctx.adminPusat),
    posisiKeuangan: await d.engine.laporanPosisiKeuangan(f, d.ctx.adminPusat),
    perubahanAsetNeto: await d.engine.laporanPerubahanAsetNeto(f, d.ctx.adminPusat),
    neracaLajur: await d.engine.neracaLajur(f, d.ctx.adminPusat),
    bukuBesar: await d.engine.bukuBesar({ ...f, akunId: d.akun.kas.id }, d.ctx.adminPusat),
  };
}

describe("setiap sel uang di ketujuh laporan", () => {
  test("punya nilai desimal dua angka dan tampilan yang bisa dibaca balik", async () => {
    const semua = await semuaLaporan();
    let total = 0;
    for (const [nama, laporan] of Object.entries(semua)) {
      total += semuaAngkaSah(laporan, nama);
    }
    // NON-VACUOUS: a walker that found nothing would pass silently.
    expect(total).toBeGreaterThan(100);
  });

  test("tidak ada satu pun tampilan yang kosong atau tanda hubung", async () => {
    const semua = await semuaLaporan();
    for (const [nama, laporan] of Object.entries(semua)) {
      for (const [jalur, a] of setiapAngka(laporan, nama)) {
        expect(a.tampil, `${jalur} kosong`).not.toBe("");
        expect(a.tampil, `${jalur} tanda hubung`).not.toBe("-");
        expect(a.tampil, `${jalur} spasi`).not.toMatch(/^\s*$/);
        expect(a.tampil, `${jalur} format`).toMatch(POLA_TAMPIL);
        expect(a.nilai, `${jalur} nilai`).toMatch(POLA_UANG);
      }
    }
  });

  test("setiap sel bernilai nol tampil persis 0,00", async () => {
    const semua = await semuaLaporan();
    let jumlahNol = 0;
    for (const [nama, laporan] of Object.entries(semua)) {
      for (const [jalur, a] of setiapAngka(laporan, nama)) {
        if (keSen(a.nilai) !== 0n) continue;
        jumlahNol += 1;
        expect(a.tampil, jalur).toBe(NOL_TAMPIL);
      }
    }
    // NON-VACUOUS: the world is built so that genuine zeros exist (an is_kas
    // account with no balance, a prior-year comparative on a category that did
    // not exist, the credit column of a debit-only account). If none did, this
    // whole file would be asserting nothing.
    expect(jumlahNol).toBeGreaterThan(10);
  });
});

describe("sel nol yang sudah pasti ada, disebut satu per satu", () => {
  test("akun kas tanpa saldo di Laporan Arus Kas", async () => {
    const arus = await d.engine.laporanArusKas(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    const bank = arus.akunKas.find((a) => a.kode === d.akun.bank.kode)!;
    expect(bank.saldo.nilai).toBe(rp(0));
    expect(bank.saldo.tampil).toBe(NOL_TAMPIL);
  });

  test("kolom pembanding untuk kategori yang belum ada setahun lalu", async () => {
    const l = await d.engine.laporanPosisiKeuangan(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    const terikat = l.baris.find((b) => b.kode === KODE_BARIS.asetNetoTerikat)!;
    expect(terikat.nilaiTahunLalu.tampil).toBe(NOL_TAMPIL);
    expect(l.totalLiabilitasTahunLalu.tampil).toBe(NOL_TAMPIL);
  });

  test("kolom kredit pada akun yang hanya bergerak debit di Buku Besar", async () => {
    const buku = await d.engine.bukuBesar(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId, akunId: d.akun.bebanOperasional.id },
      d.ctx.adminPusat,
    );
    expect(buku.mutasi.length).toBeGreaterThan(0);
    for (const m of buku.mutasi) expect(m.kredit.tampil).toBe(NOL_TAMPIL);
    expect(buku.totalKredit.tampil).toBe(NOL_TAMPIL);
  });
});

describe("aturan format Indonesia, bukan sekadar tidak kosong", () => {
  test("pemisah ribuan titik, desimal koma, negatif dalam kurung", async () => {
    const l = await d.engine.laporanPosisiKeuangan(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    // 1.677.000.000,00, not 1,677,000,000.00. Both are "non-empty"; only one
    // is readable in an Indonesian statement.
    expect(l.totalAsetTahunIni.tampil).toBe("1.677.000.000,00");
    expect(l.totalAsetTahunIni.tampil).not.toContain(",00.");
    const kontra = l.baris.find((b) => b.kode === KODE_BARIS.penyisihanKontra)!;
    expect(kontra.nilaiTahunIni.tampil).toBe("(18.000.000,00)");
    expect(bacaTampil(kontra.nilaiTahunIni.tampil)).toBe(kontra.nilaiTahunIni.nilai);
  });

  test("tampilan selalu turunan dari nilai, tidak pernah dihitung terpisah", async () => {
    // A `tampil` computed from anything but `nilai` is a page whose printed
    // figures and whose exported figures can disagree.
    const semua = await semuaLaporan();
    for (const [nama, laporan] of Object.entries(semua)) {
      for (const [jalur, a] of setiapAngka(laporan, nama)) {
        expect(a.tampil, jalur).toBe(formatTampil(a.nilai));
        angkaSah(a, jalur);
      }
    }
  });
});
