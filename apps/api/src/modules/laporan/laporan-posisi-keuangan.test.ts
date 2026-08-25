// LAPORAN POSISI KEUANGAN (spec 10.3 report 19), and the assertion the
// specification asks for by name.
//
//   "Total Aset wajib sama dengan Total Liabilitas plus Aset Neto. Buat test
//    untuk ini."                                     -- spec 10.3, report 19
//   "Buka Laporan Posisi Keuangan, konfirmasi Total Aset = Total Liabilitas +
//    Aset Neto."                                     -- spec 16, scenario 14
//
// WHY THE FIRST HALF OF EVERY TEST HERE IS "IS IT NON-ZERO".
// 0 = 0 + 0. A report built from an empty ledger, a report that filtered every
// journal out by branch, a report that returned no lines at all: each of them
// satisfies scenario 14 perfectly. So the fixture posts fifteen journals across
// two years, three branches-worth of scope and ten accounts BEFORE any of this
// runs, and every identity below is claimed only after its two sides have been
// shown to carry money. ./laporan-fixture.test.ts proves the world itself.
//
// WHY TOTAL ASET NETO IS NOT THE SUM OF THE ASET_NETO ACCOUNTS.
// This system posts no year-end closing entry: nothing ever moves a period's
// surplus out of PENDAPATAN and BEBAN and into net assets. An implementation
// that adds up the ASET_NETO accounts alone therefore under-states net assets
// by the whole cumulative surplus, and scenario 14 fails by exactly that
// amount. The fixture's world makes that failure loud: net assets are
// 1.668.000.000 of which only 1.000.000.000 sits in an ASET_NETO account.
//
// WHY THE STRUCTURE IS NOT ASSERTED AS CAPTIONS.
// Lines come from `baris_laporan` (spec 4.2). docs/REGULASI.md finding 1 says
// the specification's PSAK 45 wording was superseded by ISAK 335 and that the
// choice is the client accounting team's, and docs/BUILD-PLAN.md records that
// the question is open. So nothing here asserts that "Aset Neto Tidak Terikat"
// is the right caption. What is asserted is that the lines printed ARE the
// rows in the table, in the table's order, with the table's signs; the
// mechanic is in ./laporan-struktur-data.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HARAPAN,
  KODE_BARIS,
  SEKSI,
  TAHUN_INI,
  TAHUN_LALU,
  buatDunia,
  jumlahUang,
  keSen,
  negasiUang,
  rp,
  semuaAngkaSah,
  headerSah,
  type DuniaLaporan,
} from "./test-support";
import { NAMA_LAPORAN, NOL_TAMPIL, type LaporanPosisiKeuangan } from "./contract";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterAll(async () => {
  await d?.tutup();
});

function laporan(cabangId: string | null = null): Promise<LaporanPosisiKeuangan> {
  const p = d.periodeLaporan();
  return d.engine.laporanPosisiKeuangan(
    { periodeId: p.id, cabangId: cabangId ?? d.cabangId },
    d.ctx.adminPusat,
  );
}

describe("skenario 14: Total Aset = Total Liabilitas + Aset Neto", () => {
  test("identitas berlaku, dan ketiga sisinya bukan nol", async () => {
    const l = await laporan();

    // NON-VACUOUS FIRST. Without these four lines the identity below is
    // satisfied by a report that returns nothing at all.
    expect(keSen(l.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
    expect(keSen(l.totalLiabilitasTahunIni.nilai)).toBeGreaterThan(0n);
    expect(keSen(l.totalAsetNetoTahunIni.nilai)).toBeGreaterThan(0n);
    expect(l.baris.length).toBeGreaterThan(3);

    expect(l.totalAsetTahunIni.nilai).toBe(HARAPAN.totalAset);
    expect(l.totalLiabilitasTahunIni.nilai).toBe(HARAPAN.totalLiabilitas);
    expect(l.totalAsetNetoTahunIni.nilai).toBe(HARAPAN.totalAsetNeto);

    expect(l.totalAsetTahunIni.nilai).toBe(
      jumlahUang(l.totalLiabilitasTahunIni.nilai, l.totalAsetNetoTahunIni.nilai),
    );
    // The footing an accountant reads next to Total Aset must be the same
    // number, not a second computation the caller has to trust.
    expect(l.totalLiabilitasDanAsetNetoTahunIni.nilai).toBe(l.totalAsetTahunIni.nilai);
  });

  test("identitas juga berlaku di kolom tahun lalu, yang bukan nol", async () => {
    const l = await laporan();
    expect(keSen(l.totalAsetTahunLalu.nilai)).toBeGreaterThan(0n);
    expect(l.totalAsetTahunLalu.nilai).toBe(HARAPAN.totalAsetTahunLalu);
    expect(l.totalAsetNetoTahunLalu.nilai).toBe(HARAPAN.totalAsetNetoTahunLalu);
    expect(l.totalAsetTahunLalu.nilai).toBe(
      jumlahUang(l.totalLiabilitasTahunLalu.nilai, l.totalAsetNetoTahunLalu.nilai),
    );
    // A genuine zero in the comparative column. Spec 10 says it prints.
    expect(l.totalLiabilitasTahunLalu.nilai).toBe(rp(0));
    expect(l.totalLiabilitasTahunLalu.tampil).toBe(NOL_TAMPIL);
  });

  test("identitas berlaku untuk Semua Cabang, bukan hanya satu cabang", async () => {
    // Spec 10 gives Admin Pusat a "Semua Cabang" option, and a report that
    // only balanced per branch would be a report that balanced by accident.
    const l = await d.engine.laporanPosisiKeuangan(
      { periodeId: d.periodeLaporan().id, cabangId: null },
      d.ctx.adminPusat,
    );
    expect(l.header.cabangId).toBeNull();
    expect(l.totalAsetTahunIni.nilai).toBe(jumlahUang(HARAPAN.totalAset, rp(50_000_000)));
    expect(keSen(l.totalAsetTahunIni.nilai)).toBeGreaterThan(0n);
    expect(l.totalAsetTahunIni.nilai).toBe(
      jumlahUang(l.totalLiabilitasTahunIni.nilai, l.totalAsetNetoTahunIni.nilai),
    );
  });

  test("aset neto memuat surplus berjalan, bukan hanya saldo akun ASET_NETO", async () => {
    // THE FAILURE THIS CATCHES: summing the ASET_NETO accounts alone. In this
    // world that answers 1.000.000.000 against a required 1.668.000.000, and
    // scenario 14 then fails by the cumulative surplus. Asserting the gap
    // explicitly means the diagnosis is in the test output.
    const l = await laporan();
    const saldoAkunAsetNeto = negasiUang(
      jumlahUang(
        await d.saldoLedger(d.akun.asetNetoTidakTerikat.id, `${TAHUN_INI}-03-31`, d.cabangId),
        await d.saldoLedger(d.akun.asetNetoTerikat.id, `${TAHUN_INI}-03-31`, d.cabangId),
      ),
    );
    expect(saldoAkunAsetNeto).toBe(rp(1_000_000_000));
    expect(l.totalAsetNetoTahunIni.nilai).not.toBe(saldoAkunAsetNeto);
    expect(keSen(l.totalAsetNetoTahunIni.nilai)).toBeGreaterThan(keSen(saldoAkunAsetNeto));
    // And the current financial year's slice of it is report 17's bottom line.
    expect(l.kenaikanAsetNetoPeriodeBerjalanTahunIni.nilai).toBe(
      HARAPAN.kenaikanAsetNetoTahunIni,
    );
  });
});

describe("kas dan setara kas: angka yang Laporan Arus Kas harus cocoki", () => {
  test("kasDanSetaraKas adalah jumlah akun berflag is_kas, dan bukan nol", async () => {
    const l = await laporan();
    expect(l.kasDanSetaraKasTahunIni.nilai).toBe(HARAPAN.kasAkhir);
    expect(keSen(l.kasDanSetaraKasTahunIni.nilai)).toBeGreaterThan(0n);
    expect(l.kasDanSetaraKasTahunLalu.nilai).toBe(HARAPAN.kasAkhirTahunLalu);
    // It is a PART of total assets, never the whole of it: a report that
    // confused the two would still tie to report 18 and still be wrong.
    expect(keSen(l.kasDanSetaraKasTahunIni.nilai)).toBeLessThan(
      keSen(l.totalAsetTahunIni.nilai),
    );
  });
});

describe("struktur baris: dari baris_laporan, dengan tanda dan seksi tabel itu", () => {
  test("baris dicetak dalam urutan tabel, dan setiap baris berasal dari satu row", async () => {
    const l = await laporan();
    const tabel = (await d.bacaBarisLaporan("POSISI_KEUANGAN")).filter((b) => b.aktif);
    expect(l.baris.map((b) => b.kode)).toEqual(tabel.map((b) => b.kode));
    for (const b of l.baris) {
      const row = tabel.find((t) => t.kode === b.kode);
      expect(row, `baris ${b.kode} tidak ada di baris_laporan`).toBeDefined();
      expect(b.barisLaporanId).toBe(row!.id);
      expect(b.nama).toBe(row!.nama);
      expect(b.urutan).toBe(row!.urutan);
      expect(b.seksi).toBe(row!.seksi);
      expect(b.tanda).toBe(row!.tanda as 1 | -1);
    }
  });

  test("seksi memisahkan aset, liabilitas dan aset neto, dan totalnya menjumlah seksinya", async () => {
    const l = await laporan();
    expect(l.barisAset.every((b) => b.seksi === SEKSI.aset)).toBe(true);
    expect(l.barisLiabilitas.every((b) => b.seksi === SEKSI.liabilitas)).toBe(true);
    expect(l.barisAsetNeto.every((b) => b.seksi === SEKSI.asetNeto)).toBe(true);
    expect(l.barisAset.length).toBeGreaterThan(1);

    const jumlahSeksi = (baris: typeof l.barisAset) =>
      baris
        .filter((b) => b.tipeBaris === "DETAIL")
        .reduce((t, b) => jumlahUang(t, b.nilaiTahunIni.nilai), rp(0));
    expect(jumlahSeksi(l.barisAset)).toBe(l.totalAsetTahunIni.nilai);
    expect(jumlahSeksi(l.barisLiabilitas)).toBe(l.totalLiabilitasTahunIni.nilai);
    // AND THE ASET NETO SECTION FOOTS TO ITS OWN TOTAL. This is the one that
    // catches the surplus being carried as a total the printed lines do not
    // add up to: the ASET_NETO accounts alone are 1.000.000.000 against a
    // total of 1.668.000.000, so a section printed straight from the accounts
    // is short by the cumulative surplus and no reader can tie the page.
    expect(jumlahSeksi(l.barisAsetNeto)).toBe(l.totalAsetNetoTahunIni.nilai);
  });

  test("setiap baris aset neto sama dengan saldo akhir kategori itu di laporan 20", async () => {
    const l = await laporan();
    const perubahan = await d.engine.laporanPerubahanAsetNeto(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    const detail = l.barisAsetNeto.filter((b) => b.tipeBaris === "DETAIL");
    expect(detail.length).toBe(perubahan.baris.length);
    for (const b of detail) {
      const kategori = perubahan.baris.find((k) => k.kategoriKode === b.kode);
      expect(kategori, `kategori ${b.kode} tidak ada di laporan 20`).toBeDefined();
      expect(b.nilaiTahunIni.nilai).toBe(kategori!.saldoAkhirTahunIni.nilai);
      expect(b.nilaiTahunLalu.nilai).toBe(kategori!.saldoAwalTahunIni.nilai);
    }
  });

  test("akun kontra dicetak sebagai pengurang: baris PENYISIHAN_KONTRA sudah bertanda -1", async () => {
    // migrations/0005 exists partly for this: the allowance is an ASSET
    // account with a CREDIT normal balance and `baris_laporan.tanda = -1`. A
    // report that ignored `tanda` would ADD 18 juta to total assets instead of
    // deducting it, a 36 juta error that still balances if the same mistake is
    // made consistently.
    const l = await laporan();
    const kontra = l.baris.find((b) => b.kode === KODE_BARIS.penyisihanKontra);
    expect(kontra).toBeDefined();
    expect(kontra!.tanda).toBe(-1);
    expect(kontra!.nilaiTahunIni.nilai).toBe(negasiUang(HARAPAN.penyisihan));
    expect(kontra!.akunKode).toContain("1.1.05");
  });

  test("baris tanpa saldo tetap dicetak, dengan 0,00 (spec 10)", async () => {
    const l = await laporan();
    // The restricted category did not exist a year ago. Spec 10: the cell
    // still prints, as 0,00, "karena tim akuntansi memakainya untuk cross
    // check". A blank here and a blank in the exported spreadsheet are the
    // same defect.
    const terikat = l.baris.find((b) => b.kode === KODE_BARIS.asetNetoTerikat);
    expect(terikat).toBeDefined();
    expect(terikat!.nilaiTahunLalu.nilai).toBe(rp(0));
    expect(terikat!.nilaiTahunLalu.tampil).toBe(NOL_TAMPIL);
    expect(terikat!.nilaiTahunIni.nilai).toBe(rp(25_000_000));

    // The section caption is a HEADER row: it prints, and its cells are 0,00
    // rather than absent, so a printer never has to special-case a row.
    const caption = l.baris.find((b) => b.kode === KODE_BARIS.asetNeto)!;
    expect(caption.tipeBaris).toBe("HEADER");
    expect(caption.nilaiTahunIni.tampil).toBe(NOL_TAMPIL);
    // The two categories nest under it, which is `baris_laporan.parent_id`.
    expect(terikat!.parentKode).toBe(KODE_BARIS.asetNeto);
    expect(terikat!.level).toBe(2);
  });
});

describe("kolom pembanding (spec 10.3 laporan 19: kolom tahun ini dan tahun lalu)", () => {
  test("tahun ini adalah akhir periode; tahun lalu adalah akhir tahun buku sebelumnya", async () => {
    const l = await laporan();
    expect(l.kolom.sampaiTahunIni).toBe(`${TAHUN_INI}-03-31`);
    // A statement of financial position compares against the preceding annual
    // period end, not the same month a year ago. Both dates are RETURNED so a
    // caller never has to infer which convention was used.
    expect(l.kolom.sampaiTahunLalu).toBe(`${TAHUN_LALU}-12-31`);
    expect(l.kolom.labelTahunIni.length).toBeGreaterThan(3);
    expect(l.kolom.labelTahunLalu.length).toBeGreaterThan(3);
    // The comparative figure is the ledger at that cut-off, which is what pins
    // the cut-off rather than merely labelling it.
    expect(l.kasDanSetaraKasTahunLalu.nilai).toBe(
      await d.saldoLedger(d.akun.kas.id, l.kolom.sampaiTahunLalu, d.cabangId),
    );
  });
});

describe("header dan format (spec 10 preamble, dan aturan nol)", () => {
  test("header memuat keenam hal yang diminta spec 10", async () => {
    const l = await laporan();
    headerSah(l.header as unknown as Record<string, unknown>, d, {
      namaLaporan: NAMA_LAPORAN.POSISI_KEUANGAN,
      cabangId: d.cabangId,
      sumberData: "LEDGER_LIVE",
    });
    expect(l.header.namaCabang).toBe(d.namaCabang);
    expect(l.header.dicetakOleh).toBe(d.namaUser.adminPusat);
    expect(l.header.statusPeriode).toBe("OPEN");
  });

  test("setiap sel uang di seluruh laporan punya tampilan, dan nol tampil 0,00", async () => {
    const l = await laporan();
    const jumlahSel = semuaAngkaSah(l, "posisiKeuangan");
    expect(jumlahSel).toBeGreaterThan(20);
  });
});
