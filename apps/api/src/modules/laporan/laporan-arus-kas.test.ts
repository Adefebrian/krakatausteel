// LAPORAN ARUS KAS (spec 10.3 report 18), metode langsung, and the second
// assertion the specification asks for by name.
//
//   "Kas Akhir wajib sama dengan saldo akun berflag `is_kas` di Laporan Posisi
//    Keuangan. Buat test untuk ini."                 -- spec 10.3, report 18
//   "Buka Laporan Arus Kas, konfirmasi Kas Akhir = saldo Kas dan Setara Kas di
//    Laporan Posisi Keuangan."                       -- spec 16, scenario 15
//
// THE TEST IS ACROSS TWO REPORTS, NOT INSIDE ONE. Asking the cash-flow
// statement whether it agrees with itself proves nothing; both figures are
// taken from the two engine calls a user would actually make, for the same
// period and the same branch scope, and compared.
//
// WHY NON-ZERO COMES FIRST, EVERY TIME. An empty ledger has Kas Akhir 0 and
// Kas dan Setara Kas 0, and passes scenario 15. So does a report that
// classified nothing, and a report whose branch filter excluded everything.
// The fixture's world has 1.285.000.000 of cash, movement in all three
// sections and an opening balance of 1.180.000.000, and every assertion here
// names those before claiming any equality.
//
// THE HARD PART OF THE DIRECT METHOD, AND THE ONE PLACE IT GOES WRONG.
// A direct-method statement is not the income statement rearranged. It is
// built from movements ON the cash accounts, classified by the
// `klasifikasi_arus_kas` of the COUNTER-ACCOUNT in the same journal. Two
// consequences the fixture is built to expose:
//   - a non-cash journal (the allowance: debit Beban Penyisihan, credit
//     Penyisihan) must appear NOWHERE in this report, though it is 6.000.000
//     of expense in report 17. A statement derived from the income statement
//     would include it and Kas Akhir would be wrong by that amount;
//   - a counter-account with NO classification cannot be bucketed, and
//     silently dropping it breaks Kas Akhir. So it is a refusal, and the
//     refusal names the account.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  HARAPAN,
  TAHUN_INI,
  TAHUN_LALU,
  buatDunia,
  headerSah,
  jumlahUang,
  keSen,
  kurangUang,
  rp,
  semuaAngkaSah,
  tolakDengan,
  type DuniaLaporan,
} from "./test-support";
import { KODE_LAPORAN, NAMA_LAPORAN, type LaporanArusKas } from "./contract";

let d: DuniaLaporan;

beforeAll(async () => {
  d = await buatDunia();
  await d.postingBukuStandar();
});
afterAll(async () => {
  await d?.tutup();
});

function arusKas(cabangId: string | null = null): Promise<LaporanArusKas> {
  return d.engine.laporanArusKas(
    { periodeId: d.periodeLaporan().id, cabangId: cabangId ?? d.cabangId },
    d.ctx.adminPusat,
  );
}

describe("skenario 15: Kas Akhir = saldo akun is_kas di Laporan Posisi Keuangan", () => {
  test("kedua laporan mendarat di angka yang sama, dan angka itu bukan nol", async () => {
    const p = d.periodeLaporan();
    const kas = await arusKas();
    const posisi = await d.engine.laporanPosisiKeuangan(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );

    // NON-VACUOUS FIRST.
    expect(keSen(kas.kasAkhirTahunIni.nilai)).toBeGreaterThan(0n);
    expect(keSen(posisi.kasDanSetaraKasTahunIni.nilai)).toBeGreaterThan(0n);

    expect(kas.kasAkhirTahunIni.nilai).toBe(HARAPAN.kasAkhir);
    expect(kas.kasAkhirTahunIni.nilai).toBe(posisi.kasDanSetaraKasTahunIni.nilai);
  });

  test("di kolom pembanding kedua laporan SENGAJA berbeda, karena konvensinya berbeda", async () => {
    // THE CONTRADICTION THIS FILE USED TO CONTAIN, RESOLVED AND WRITTEN DOWN.
    // The test above used to extend the tie to the comparative column as well,
    // while ./laporan-arus-kas.test.ts also required that column to advertise
    // a like-for-like span and to satisfy awal + kenaikan = akhir. Those three
    // cannot all hold: they describe two different columns.
    //
    // THE CONVENTION, DECIDED: the comparative column of a cash flow statement
    // is THE SAME SPAN ONE YEAR EARLIER, because a cash flow statement is a
    // FLOW statement and its comparative is a period. That is Laporan
    // Aktivitas's convention. Laporan Posisi Keuangan's comparative is the
    // preceding year END, because a position is a point. So the two reports'
    // comparative figures are cash at two different dates and are not equal,
    // and the difference is exactly the prior year's movements after March.
    //
    // WHAT THE SPECIFICATION ACTUALLY ASKS FOR IS UNAFFECTED. Spec 10.3 report
    // 18 and spec 16 scenario 15 both name Kas Akhir against the balance
    // sheet's cash FOR THE PERIOD BEING REPORTED, which is the current column,
    // asserted above and unchanged.
    const p = d.periodeLaporan();
    const kas = await arusKas();
    const posisi = await d.engine.laporanPosisiKeuangan(
      { periodeId: p.id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );

    // Cash at 2025-03-31, the end of the like-for-like comparative span.
    expect(kas.kasAkhirTahunLalu.nilai).toBe(HARAPAN.kasAkhirQ1TahunLalu);
    // Cash at 2025-12-31, the balance sheet's comparative cut-off.
    expect(posisi.kasDanSetaraKasTahunLalu.nilai).toBe(HARAPAN.kasAkhirTahunLalu);
    // NON-VACUOUS: they really are different, so a report that quietly used
    // the balance sheet's cut-off for both cannot pass this.
    expect(kas.kasAkhirTahunLalu.nilai).not.toBe(posisi.kasDanSetaraKasTahunLalu.nilai);
    // And the gap is the prior-year cash movement after the comparative span,
    // rather than an arbitrary difference.
    expect(
      kurangUang(kas.kasAkhirTahunLalu.nilai, posisi.kasDanSetaraKasTahunLalu.nilai),
    ).toBe(rp(220_000_000));
  });

  test("juga cocok untuk Semua Cabang", async () => {
    const p = d.periodeLaporan();
    const kas = await d.engine.laporanArusKas({ periodeId: p.id, cabangId: null }, d.ctx.adminPusat);
    const posisi = await d.engine.laporanPosisiKeuangan(
      { periodeId: p.id, cabangId: null },
      d.ctx.adminPusat,
    );
    expect(kas.kasAkhirTahunIni.nilai).toBe(jumlahUang(HARAPAN.kasAkhir, rp(50_000_000)));
    expect(kas.kasAkhirTahunIni.nilai).toBe(posisi.kasDanSetaraKasTahunIni.nilai);
  });

  test("kas akhir dirinci per akun is_kas, termasuk akun kas yang bersaldo nol", async () => {
    // The seed flags BOTH 1.1.01 and 1.1.02 as is_kas and only the first
    // carries a balance. A report that summed the first is_kas account it
    // found would still tie; listing them is what proves it summed the set.
    const kas = await arusKas();
    expect(kas.akunKas.map((a) => a.kode)).toEqual(["1.1.01", "1.1.02"]);
    expect(kas.akunKas.reduce((t, a) => jumlahUang(t, a.saldo.nilai), rp(0))).toBe(
      kas.kasAkhirTahunIni.nilai,
    );
    const bank = kas.akunKas.find((a) => a.kode === "1.1.02")!;
    expect(bank.saldo.nilai).toBe(rp(0));
    expect(bank.saldo.tampil).toBe("0,00");
  });
});

describe("aritmetika arus kas: awal + kenaikan = akhir, dan kenaikan = jumlah tiga seksi", () => {
  test("ketiga seksi ada, bergerak, dan menjumlah ke kenaikan kas", async () => {
    const kas = await arusKas();
    expect(kas.seksi.map((s) => s.klasifikasi)).toEqual(["OPERASI", "INVESTASI", "PENDANAAN"]);

    const [operasi, investasi, pendanaan] = kas.seksi;
    expect(operasi.totalTahunIni.nilai).toBe(HARAPAN.arusOperasi);
    expect(investasi.totalTahunIni.nilai).toBe(HARAPAN.arusInvestasi);
    expect(pendanaan.totalTahunIni.nilai).toBe(HARAPAN.arusPendanaan);
    // NON-VACUOUS: none of the three is empty, so a statement that classified
    // nothing cannot pass the sum below.
    for (const s of kas.seksi) {
      expect(keSen(s.totalTahunIni.nilai), `seksi ${s.klasifikasi} kosong`).not.toBe(0n);
      expect(s.baris.length).toBeGreaterThan(0);
    }
    expect(
      jumlahUang(
        operasi.totalTahunIni.nilai,
        investasi.totalTahunIni.nilai,
        pendanaan.totalTahunIni.nilai,
      ),
    ).toBe(kas.kenaikanKasTahunIni.nilai);
    expect(kas.kenaikanKasTahunIni.nilai).toBe(HARAPAN.kenaikanKas);
  });

  test("seksi juga menjumlah ke kenaikan kas DI KOLOM PEMBANDING, dengan span yang sama", async () => {
    // THE HALF THAT WAS LEFT UNSAID, AND THEREFORE WENT WRONG. Nothing used to
    // assert that the comparative section totals add up to the comparative
    // movement, so an implementation could compute the sections over the
    // advertised like-for-like span while computing `kenaikanKasTahunLalu`
    // over a different one, and every remaining assertion still passed. A
    // reader adding up the printed column would not reach the printed total.
    //
    // Both are the same span now, and this says so with absolute figures so
    // that agreeing wrongly is not available either.
    const kas = await arusKas();
    const [operasi, investasi, pendanaan] = kas.seksi;
    expect(operasi.totalTahunLalu.nilai).toBe(HARAPAN.arusOperasiTahunLalu);
    expect(investasi.totalTahunLalu.nilai).toBe(HARAPAN.arusInvestasiTahunLalu);
    expect(pendanaan.totalTahunLalu.nilai).toBe(HARAPAN.arusPendanaanTahunLalu);
    expect(
      jumlahUang(
        operasi.totalTahunLalu.nilai,
        investasi.totalTahunLalu.nilai,
        pendanaan.totalTahunLalu.nilai,
      ),
    ).toBe(kas.kenaikanKasTahunLalu.nilai);
    expect(kas.kenaikanKasTahunLalu.nilai).toBe(HARAPAN.kenaikanKasTahunLalu);
    // NON-VACUOUS: the comparative financing section is the opening funding of
    // the unit, so a column that classified nothing cannot pass.
    expect(keSen(pendanaan.totalTahunLalu.nilai)).toBeGreaterThan(0n);
  });

  test("kas awal plus kenaikan sama dengan kas akhir, di kedua kolom", async () => {
    const kas = await arusKas();
    expect(kas.kasAwalTahunIni.nilai).toBe(HARAPAN.kasAwal);
    expect(keSen(kas.kasAwalTahunIni.nilai)).toBeGreaterThan(0n);
    expect(jumlahUang(kas.kasAwalTahunIni.nilai, kas.kenaikanKasTahunIni.nilai)).toBe(
      kas.kasAkhirTahunIni.nilai,
    );
    expect(kas.kasAwalTahunLalu.nilai).toBe(HARAPAN.kasAwalTahunLalu);
    expect(jumlahUang(kas.kasAwalTahunLalu.nilai, kas.kenaikanKasTahunLalu.nilai)).toBe(
      kas.kasAkhirTahunLalu.nilai,
    );
    // The comparative year moved too: a report that returned 0,00 for the
    // whole prior-year column would satisfy the identity above.
    expect(keSen(kas.kenaikanKasTahunLalu.nilai)).not.toBe(0n);
  });

  test("kas awal adalah saldo ledger sehari sebelum awal tahun buku", async () => {
    const kas = await arusKas();
    expect(kas.kolom.dariTahunIni).toBe(`${TAHUN_INI}-01-01`);
    expect(kas.kolom.sampaiTahunIni).toBe(`${TAHUN_INI}-03-31`);
    expect(kas.kolom.dariTahunLalu).toBe(`${TAHUN_LALU}-01-01`);
    expect(kas.kolom.sampaiTahunLalu).toBe(`${TAHUN_LALU}-03-31`);
    expect(kas.kasAwalTahunIni.nilai).toBe(
      await d.saldoLedger(d.akun.kas.id, `${TAHUN_LALU}-12-31`, d.cabangId),
    );
  });
});

describe("metode langsung: dari mutasi kas, bukan dari laporan aktivitas", () => {
  test("jurnal non kas tidak muncul di mana pun, meski jadi beban di laporan aktivitas", async () => {
    // Allowance: debit Beban Penyisihan 6.000.000, credit Penyisihan. Touches
    // no is_kas account. It is 6.000.000 of expense in report 17 and must be
    // 0,00 of cash flow here. A statement derived from the income statement
    // gets this wrong and Kas Akhir misses by exactly that.
    const kas = await arusKas();
    const semuaAkun = kas.seksi.flatMap((s) => s.baris.map((b) => b.akunKode));
    expect(semuaAkun).not.toContain(d.akun.bebanPenyisihan.kode);
    expect(semuaAkun).not.toContain(d.akun.penyisihan.kode);

    const aktivitas = await d.engine.laporanAktivitas(
      { periodeId: d.periodeLaporan().id, cabangId: d.cabangId },
      d.ctx.adminPusat,
    );
    // The two bottom lines DIFFER, and by the non-cash items. If they were
    // equal the report would be the income statement in disguise.
    expect(aktivitas.kenaikanAsetNetoTahunIni.nilai).not.toBe(kas.kenaikanKasTahunIni.nilai);
    expect(
      kurangUang(aktivitas.kenaikanAsetNetoTahunIni.nilai, kas.kenaikanKasTahunIni.nilai),
    ).toBe(rp(200_000_000));
  });

  test("setiap baris seksi menamai akun lawan dan uraiannya, bukan caption hardcoded", async () => {
    const kas = await arusKas();
    const investasi = kas.seksi.find((s) => s.klasifikasi === "INVESTASI")!;
    expect(investasi.baris).toHaveLength(1);
    expect(investasi.baris[0].akunKode).toBe(d.akun.asetTetap.kode);
    expect(investasi.baris[0].akunId).toBe(d.akun.asetTetap.id);
    // The caption is the account's own name, which is data. Outflow is negative.
    expect(investasi.baris[0].uraian).toBe(d.akun.asetTetap.nama);
    expect(investasi.baris[0].nilaiTahunIni.nilai).toBe(rp(-75_000_000));
    expect(investasi.baris[0].nilaiTahunIni.tampil).toBe("(75.000.000,00)");

    const pendanaan = kas.seksi.find((s) => s.klasifikasi === "PENDANAAN")!;
    expect(pendanaan.baris.map((b) => b.akunKode)).toEqual([d.akun.pendapatanTerikat.kode]);
    expect(pendanaan.baris[0].nilaiTahunIni.nilai).toBe(rp(25_000_000));
  });

  test("satu jurnal dengan beberapa akun lawan dipecah menurut nilainya", async () => {
    // 2026-03-10: debit Kas 44 juta against credit Piutang 40 juta and credit
    // Pendapatan Jasa 4 juta. A report that attributed the whole 44 juta to
    // the first counter-account it saw would still balance the section total,
    // and would misstate two lines by 4 juta each.
    const kas = await arusKas();
    const operasi = kas.seksi.find((s) => s.klasifikasi === "OPERASI")!;
    const piutang = operasi.baris.find((b) => b.akunKode === d.akun.piutangPokok.kode);
    const jasa = operasi.baris.find((b) => b.akunKode === d.akun.pendapatanJasaAdm.kode);
    expect(piutang).toBeDefined();
    expect(jasa).toBeDefined();
    // Piutang nets a 180 juta disbursement in February against a 40 juta
    // collection in March.
    expect(piutang!.nilaiTahunIni.nilai).toBe(rp(-140_000_000));
    expect(jasa!.nilaiTahunIni.nilai).toBe(rp(4_000_000));
  });
});

describe("akun lawan tanpa klasifikasi arus kas: ditolak, tidak dibuang diam diam", () => {
  afterEach(async () => {
    await d.setelKlasifikasiArusKas(d.akun.pendapatanAlokasi.id, "OPERASI");
  });

  test("menolak dengan KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP dan menyebut akunnya", async () => {
    // The shipped seed leaves `klasifikasi_arus_kas` NULL on every account
    // outside 1.1.x, so this is not a hypothetical: it is the out-of-the-box
    // state (see ./test-support.ts header, finding 3). Dropping the movement
    // would understate Kas Akhir by 300.000.000 and still balance everywhere
    // else, which is why the answer is a refusal.
    await d.setelKlasifikasiArusKas(d.akun.pendapatanAlokasi.id, null);
    const err = await tolakDengan(
      () => arusKas(),
      KODE_LAPORAN.KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP,
    );
    expect(JSON.stringify(err.detail ?? "")).toContain(d.akun.pendapatanAlokasi.kode);
  });

  test("kelengkapan diperiksa DI KEDUA KOLOM, bukan hanya di tahun berjalan", async () => {
    // THE SILENT DROP, ONE COLUMN OVER. This whole describe exists because an
    // unclassified counter-account cannot be bucketed and dropping it breaks
    // Kas Akhir. If the check ran over the reporting year only, exactly the
    // same drop would happen unannounced in the comparative column, for any
    // counter-account that appears in the prior year and not in this one.
    //
    // `asetNetoTidakTerikat` IS such an account in this world: it is the
    // counter-side of the opening funding in 2025-01 and appears nowhere in
    // 2026. It carries PENDANAAN in the fixture for that reason; removing the
    // classification must therefore be refused even though the reporting year
    // is untouched by it.
    const asetNeto = d.akun.asetNetoTidakTerikat;
    await d.setelKlasifikasiArusKas(asetNeto.id, null);
    try {
      const err = await tolakDengan(
        () => arusKas(),
        KODE_LAPORAN.KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP,
      );
      expect(JSON.stringify(err.detail ?? "")).toContain(asetNeto.kode);
    } finally {
      await d.setelKlasifikasiArusKas(asetNeto.id, "PENDANAAN");
    }
    // And with it restored the report is produced again, so the refusal above
    // is about this account and not about the world being broken.
    expect((await arusKas()).kasAkhirTahunLalu.nilai).toBe(HARAPAN.kasAkhirQ1TahunLalu);
  });

  test("akun non kas yang tidak terklasifikasi TIDAK memicu penolakan", async () => {
    // 1.1.05 Penyisihan and 5.1.01 Beban Penyisihan are unclassified by the
    // seed and stay that way in the fixture: they never sit opposite cash, so
    // demanding a classification for them would be the report inventing work.
    const penyisihan = await d.db.query<{ k: string | null }>(
      `select klasifikasi_arus_kas as k from akun where id = $1`,
      [d.akun.penyisihan.id],
    );
    expect(penyisihan[0].k).toBeNull();
    const kas = await arusKas();
    expect(kas.kasAkhirTahunIni.nilai).toBe(HARAPAN.kasAkhir);
  });
});

describe("header dan format", () => {
  test("header spec 10 lengkap, dan setiap sel punya tampilan", async () => {
    const kas = await arusKas();
    headerSah(kas.header as unknown as Record<string, unknown>, d, {
      namaLaporan: NAMA_LAPORAN.ARUS_KAS,
      cabangId: d.cabangId,
      sumberData: "LEDGER_LIVE",
    });
    expect(semuaAngkaSah(kas, "arusKas")).toBeGreaterThan(15);
  });
});
