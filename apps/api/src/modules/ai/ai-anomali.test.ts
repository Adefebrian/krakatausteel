// Spec 12 priority 2, the RULES, with explicit fixtures and no database.
//
// The eight rules are arithmetic, so they are tested as arithmetic: every
// number below is written out, and every assertion names the figure it expects.
// A rule that fired for the wrong reason would still pass a test that only
// counted findings, so each case asserts the CODE and the `dasar` that goes
// with it -- spec 12 requires every suggestion to show "dasar perhitungan atau
// sumber data secara eksplisit", and that requirement is only real if something
// checks it.
//
// TWO PROPERTIES ARE CHECKED THAT ARE NOT ABOUT ANY ONE RULE:
//   - the output is ORDERED, worst first, and the order is total, so a rerun
//     over unchanged books produces the same queue;
//   - no float appears anywhere. `keSen`/`dariSen` round-trip exact rupiah, and
//     the z-score is assembled from integers.
import { describe, expect, test } from "bun:test";
import {
  akhirPekan,
  dariSen,
  hariDalamMinggu,
  keSen,
  kelompokkanJurnal,
  keteranganTidakBermakna,
  nilaiJurnal,
  type JurnalScan,
  type KonteksAnomali,
} from "./anomali";
import { mundurBulan } from "./service";
import type { BarisJurnalScan, RiwayatAkun } from "./repo";

const AKUN_KAS = "11111111-1111-1111-1111-111111111111";
const AKUN_BEBAN = "22222222-2222-2222-2222-222222222222";
const AKUN_LAIN = "33333333-3333-3333-3333-333333333333";
const MITRA = "44444444-4444-4444-4444-444444444444";
const CABANG = "55555555-5555-5555-5555-555555555555";

function baris(over: Partial<BarisJurnalScan> = {}): BarisJurnalScan {
  return {
    jurnalId: "j1",
    noJurnal: "JU/2026/09/0001",
    cabangId: CABANG,
    tanggalTransaksi: "2026-09-02",
    jenis: "UMUM",
    keterangan: "Pembayaran listrik kantor September",
    totalDebit: "1234567.00",
    urutan: 1,
    akunId: AKUN_BEBAN,
    kodeAkun: "5.1.01",
    debit: "1234567.00",
    kredit: "0.00",
    mitraId: null,
    ...over,
  };
}

/** One balanced journal: debit on `akunDebit`, credit on `akunKredit`. */
function jurnal(over: {
  id?: string;
  no?: string;
  tanggal?: string;
  keterangan?: string | null;
  jumlah?: string;
  akunDebit?: string;
  kodeDebit?: string;
  akunKredit?: string;
  kodeKredit?: string;
  mitraId?: string | null;
}): JurnalScan {
  const id = over.id ?? "j1";
  // NOT A ROUND NUMBER, deliberately. The default fixture has to be a journal
  // that fires NOTHING, and Rp 1.000.000 is an exact multiple of the roundness
  // rule's threshold: a "quiet books" baseline built on it would have been
  // flagged, and every count below would have been one too high.
  const jumlah = over.jumlah ?? "1234567.00";
  const b = kelompokkanJurnal([
    baris({
      jurnalId: id,
      noJurnal: over.no ?? "JU/2026/09/0001",
      tanggalTransaksi: over.tanggal ?? "2026-09-02",
      keterangan: over.keterangan === undefined ? "Pembayaran listrik kantor" : over.keterangan,
      totalDebit: jumlah,
      urutan: 1,
      akunId: over.akunDebit ?? AKUN_BEBAN,
      kodeAkun: over.kodeDebit ?? "5.1.01",
      debit: jumlah,
      kredit: "0.00",
      mitraId: over.mitraId ?? null,
    }),
    baris({
      jurnalId: id,
      noJurnal: over.no ?? "JU/2026/09/0001",
      tanggalTransaksi: over.tanggal ?? "2026-09-02",
      keterangan: over.keterangan === undefined ? "Pembayaran listrik kantor" : over.keterangan,
      totalDebit: jumlah,
      urutan: 2,
      akunId: over.akunKredit ?? AKUN_KAS,
      kodeAkun: over.kodeKredit ?? "1.1.01",
      debit: "0.00",
      kredit: jumlah,
      mitraId: null,
    }),
  ]);
  return b[0]!;
}

function riwayat(over: Partial<RiwayatAkun> & { akunId: string }): RiwayatAkun {
  return {
    jumlahBaris: 100,
    median: "1234567.00",
    mad: "50000.00",
    jumlahBulat: 0,
    ...over,
  };
}

/** A context in which nothing is new and every account has a settled history. */
function konteks(over: Partial<KonteksAnomali> = {}): KonteksAnomali {
  return {
    periodeMulai: "2026-09-01",
    periodeAkhir: "2026-09-30",
    riwayatAkun: new Map([
      [AKUN_BEBAN, riwayat({ akunId: AKUN_BEBAN })],
      [AKUN_KAS, riwayat({ akunId: AKUN_KAS })],
    ]),
    pasanganAkunHistoris: new Set([
      `${AKUN_BEBAN}>${AKUN_KAS}`,
      `${AKUN_LAIN}>${AKUN_KAS}`,
    ]),
    pasanganMitraHistoris: new Set([`${MITRA}@${AKUN_BEBAN}`, `${MITRA}@${AKUN_KAS}`]),
    ...over,
  };
}

describe("ai: uang sebagai bilangan bulat", () => {
  test("keSen dan dariSen bolak-balik tanpa float", () => {
    expect(keSen("1000000.00")).toBe(100_000_000n);
    expect(keSen("0.01")).toBe(1n);
    expect(keSen("12345678901234.99")).toBe(1_234_567_890_123_499n);
    expect(dariSen(100_000_000n)).toBe("1000000.00");
    expect(dariSen(1n)).toBe("0.01");
    // 0.1 + 0.2 as rupiah: the case a float gets wrong.
    expect(dariSen(keSen("0.10") + keSen("0.20"))).toBe("0.30");
  });

  test("teks yang bukan numeric(20,2) menghasilkan nol, bukan tebakan", () => {
    expect(keSen("satu juta")).toBe(0n);
    expect(keSen(null)).toBe(0n);
    expect(keSen("1e6")).toBe(0n);
  });
});

describe("ai: tanggal tanpa zona waktu", () => {
  test("Zeller memberi hari yang benar, apa pun zona waktu mesin", () => {
    // 2026-09-05 is a Saturday, 2026-09-06 a Sunday, 2026-09-07 a Monday.
    expect(hariDalamMinggu("2026-09-05")).toBe(0);
    expect(hariDalamMinggu("2026-09-06")).toBe(1);
    expect(hariDalamMinggu("2026-09-07")).toBe(2);
    expect(akhirPekan("2026-09-05")).toBe(true);
    expect(akhirPekan("2026-09-06")).toBe(true);
    expect(akhirPekan("2026-09-04")).toBe(false);
  });

  test("mundurBulan menjepit tanggal ke panjang bulan tujuan", () => {
    expect(mundurBulan("2026-09-01", 24)).toBe("2024-09-01");
    expect(mundurBulan("2026-03-31", 1)).toBe("2026-02-28");
    expect(mundurBulan("2024-03-31", 1)).toBe("2024-02-29");
    expect(mundurBulan("2026-01-15", 24)).toBe("2024-01-15");
  });
});

describe("ai: aturan deteksi anomali", () => {
  test("buku yang tenang tidak menghasilkan satu pun temuan", () => {
    const hasil = nilaiJurnal([jurnal({})], konteks());
    expect(hasil).toEqual([]);
  });

  test("NOMINAL_OUTLIER: jauh dari median, dengan z-score sebagai bilangan", () => {
    // median 1.234.567, MAD 50.000, nilai 900.000.000.
    // z = 0.6745 * (900.000.000 - 1.234.567) / 50.000
    const hasil = nilaiJurnal([jurnal({ jumlah: "900000000.00" })], konteks());
    expect(hasil).toHaveLength(1);
    const temuan = hasil[0]!.temuan.find((t) => t.kode === "NOMINAL_OUTLIER")!;
    expect(temuan).toBeDefined();
    expect(temuan.dasar.medianHistoris).toBe("1234567.00");
    expect(temuan.dasar.madHistoris).toBe("50000.00");
    expect(temuan.dasar.nilai).toBe("900000000.00");
    expect(temuan.dasar.ambangZScore).toBe("3.500");
    // Assembled from integers; the exact value is checkable by hand.
    expect(temuan.dasar.zScore).toBe("12124.345");
  });

  test("NOMINAL_OUTLIER diam ketika riwayat akun terlalu tipis", () => {
    // Eleven lines is below MIN_RIWAYAT_OUTLIER (12): a median over eleven
    // entries is not a description of how the account behaves.
    const hasil = nilaiJurnal(
      [jurnal({ jumlah: "900000000.00" })],
      konteks({
        riwayatAkun: new Map([
          [AKUN_BEBAN, riwayat({ akunId: AKUN_BEBAN, jumlahBaris: 11 })],
          [AKUN_KAS, riwayat({ akunId: AKUN_KAS, jumlahBaris: 11 })],
        ]),
      }),
    );
    expect(hasil.flatMap((h) => h.temuan.map((t) => t.kode))).not.toContain(
      "NOMINAL_OUTLIER",
    );
  });

  test("NOMINAL_OUTLIER diam ketika MAD nol, bukan membagi dengan nol", () => {
    // An account whose history never varies has MAD 0, and 0.6745 * x / 0 is
    // not an outlier score, it is a crash. The rule declines to fire.
    //
    // The assertion names the RULE rather than the whole result on purpose:
    // Rp 900.000.000 is also an exact multiple of Rp 1.000.000, so the
    // roundness rule fires on this same journal and is supposed to. A blanket
    // `toEqual([])` here would be asserting something this fixture does not
    // mean, and would break the day an unrelated rule was added.
    const hasil = nilaiJurnal(
      [jurnal({ jumlah: "900000000.00" })],
      konteks({
        riwayatAkun: new Map([
          [AKUN_BEBAN, riwayat({ akunId: AKUN_BEBAN, mad: "0.00" })],
          [AKUN_KAS, riwayat({ akunId: AKUN_KAS, mad: "0.00" })],
        ]),
      }),
    );
    expect(hasil.flatMap((h) => h.temuan.map((t) => t.kode))).not.toContain(
      "NOMINAL_OUTLIER",
    );
  });

  test("NOMINAL_BULAT_TIDAK_LAZIM: bulat di akun yang riwayatnya tidak pernah bulat", () => {
    // 5.000.000 is an exact multiple of 1.000.000; the account's history is 100
    // lines with 3 round ones, i.e. 3% < 10%.
    const hasil = nilaiJurnal(
      [jurnal({ jumlah: "5000000.00" })],
      konteks({
        riwayatAkun: new Map([
          [
            AKUN_BEBAN,
            riwayat({ akunId: AKUN_BEBAN, median: "5000000.00", mad: "4000000.00", jumlahBulat: 3 }),
          ],
          [
            AKUN_KAS,
            riwayat({ akunId: AKUN_KAS, median: "5000000.00", mad: "4000000.00", jumlahBulat: 3 }),
          ],
        ]),
      }),
    );
    const temuan = hasil[0]!.temuan.find((t) => t.kode === "NOMINAL_BULAT_TIDAK_LAZIM")!;
    expect(temuan).toBeDefined();
    expect(temuan.dasar.barisBulatHistoris).toBe("3");
    expect(temuan.dasar.jumlahBarisHistoris).toBe("100");
    expect(temuan.dasar.kelipatan).toBe("1000000.00");
  });

  test("NOMINAL_BULAT_TIDAK_LAZIM diam ketika akun memang sering bulat", () => {
    const hasil = nilaiJurnal(
      [jurnal({ jumlah: "5000000.00" })],
      konteks({
        riwayatAkun: new Map([
          [
            AKUN_BEBAN,
            riwayat({ akunId: AKUN_BEBAN, median: "5000000.00", mad: "4000000.00", jumlahBulat: 60 }),
          ],
          [
            AKUN_KAS,
            riwayat({ akunId: AKUN_KAS, median: "5000000.00", mad: "4000000.00", jumlahBulat: 60 }),
          ],
        ]),
      }),
    );
    expect(hasil).toEqual([]);
  });

  test("TANGGAL_AKHIR_PEKAN", () => {
    const hasil = nilaiJurnal([jurnal({ tanggal: "2026-09-05" })], konteks());
    expect(hasil[0]!.temuan.map((t) => t.kode)).toContain("TANGGAL_AKHIR_PEKAN");
    expect(hasil[0]!.temuan[0]!.dasar.tanggalTransaksi).toBe("2026-09-05");
  });

  test("TANGGAL_LUAR_PERIODE menyebut rentang yang dilanggar", () => {
    const hasil = nilaiJurnal([jurnal({ tanggal: "2026-08-30" })], konteks());
    const temuan = hasil[0]!.temuan.find((t) => t.kode === "TANGGAL_LUAR_PERIODE")!;
    expect(temuan.dasar.periodeMulai).toBe("2026-09-01");
    expect(temuan.dasar.periodeAkhir).toBe("2026-09-30");
  });

  test("PASANGAN_AKUN_BARU memakai KODE akun, bukan UUID", () => {
    const hasil = nilaiJurnal(
      [jurnal({ akunDebit: AKUN_LAIN, kodeDebit: "6.9.99", akunKredit: AKUN_BEBAN, kodeKredit: "5.1.01" })],
      konteks(),
    );
    const temuan = hasil[0]!.temuan.find((t) => t.kode === "PASANGAN_AKUN_BARU")!;
    expect(temuan.dasar.pasangan).toBe("6.9.99 > 5.1.01");
    expect(temuan.dasar.jumlahPasanganBaru).toBe("1");
  });

  test("KETERANGAN_TIDAK_BERMAKNA menangkap kosong, pendek dan berulang", () => {
    expect(keteranganTidakBermakna(null)).toBe(true);
    expect(keteranganTidakBermakna("   ")).toBe(true);
    expect(keteranganTidakBermakna("-")).toBe(true);
    expect(keteranganTidakBermakna("xxxxxxxxxxxx")).toBe(true);
    expect(keteranganTidakBermakna("111111111111")).toBe(true);
    expect(keteranganTidakBermakna("Bayar listrik")).toBe(false);
  });

  test("JURNAL_KEMBAR: dua entri identik, keduanya ditandai", () => {
    const a = jurnal({ id: "j1", no: "JU/2026/09/0001" });
    const b = jurnal({ id: "j2", no: "JU/2026/09/0002" });
    const hasil = nilaiJurnal([a, b], konteks());
    expect(hasil).toHaveLength(2);
    for (const h of hasil) {
      const temuan = h.temuan.find((t) => t.kode === "JURNAL_KEMBAR")!;
      expect(temuan.dasar.jumlahKembar).toBe("2");
    }
  });

  test("JURNAL_KEMBAR diam ketika nominalnya berbeda satu rupiah", () => {
    const a = jurnal({ id: "j1", no: "JU/2026/09/0001", jumlah: "1234567.00" });
    const b = jurnal({ id: "j2", no: "JU/2026/09/0002", jumlah: "1234568.00" });
    expect(nilaiJurnal([a, b], konteks())).toEqual([]);
  });

  test("MITRA_AKUN_BARU", () => {
    const lain = "99999999-9999-9999-9999-999999999999";
    const hasil = nilaiJurnal([jurnal({ mitraId: lain })], konteks());
    const temuan = hasil[0]!.temuan.find((t) => t.kode === "MITRA_AKUN_BARU")!;
    expect(temuan.dasar.mitraId).toBe(lain);
    expect(temuan.dasar.akun).toBe("5.1.01");
  });

  test("skor menjumlahkan bobot dan mengurutkan antrean, terberat dulu", () => {
    // Two findings (weekend 10 + meaningless description 15) versus one (10).
    const buruk = jurnal({
      id: "j1",
      no: "JU/2026/09/0002",
      tanggal: "2026-09-05",
      keterangan: "-",
    });
    const ringan = jurnal({ id: "j2", no: "JU/2026/09/0001", tanggal: "2026-09-06" });
    const hasil = nilaiJurnal([ringan, buruk], konteks());
    expect(hasil.map((h) => h.noJurnal)).toEqual(["JU/2026/09/0002", "JU/2026/09/0001"]);
    expect(hasil[0]!.skor).toBe(25);
    expect(hasil[1]!.skor).toBe(10);
  });

  test("urutannya total: dua skor sama diurut per nomor jurnal", () => {
    const a = jurnal({ id: "j1", no: "JU/2026/09/0009", tanggal: "2026-09-05", jumlah: "7.00" });
    const b = jurnal({ id: "j2", no: "JU/2026/09/0002", tanggal: "2026-09-06", jumlah: "9.00" });
    const sekali = nilaiJurnal([a, b], konteks());
    const lagi = nilaiJurnal([b, a], konteks());
    expect(sekali.map((h) => h.noJurnal)).toEqual(lagi.map((h) => h.noJurnal));
    expect(sekali.map((h) => h.noJurnal)).toEqual(["JU/2026/09/0002", "JU/2026/09/0009"]);
  });
});
