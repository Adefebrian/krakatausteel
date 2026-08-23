// The parameter catalogue: every configurable value this system reads, with
// its shape and its validation, declared in ONE place.
//
// WHY A CATALOGUE AND NOT `parseFloat(row.nilai)` AT THE CALL SITE
// Spec rule 3 requires every parameter in spec 5 to be changeable through the
// Konfigurasi menu without a deploy, which means the value reaching a
// financial calculation came from a text column an operator can type into. The
// two failure modes that follow are:
//
//   - MISSING. `?? 0.03` looks harmless and silently produces a plausible but
//     wrong journal for months. Every getter here throws instead. A financial
//     calculation must stop, loudly, rather than invent a rate.
//   - MALFORMED. "3%" or "0,03" or "" in a NUMBER column becomes NaN, and NaN
//     propagates through arithmetic without raising anything until it reaches
//     a report as "NaN". Every value is validated against its declared shape
//     on read, not only on write, because a row can also arrive by psql or by
//     migration.
//
// MONEY AND RATES ARE DECIMAL STRINGS, never JS numbers: invariant 7 bans
// float for amounts, and apps/api/src/modules/jurnal/contract.ts fixes the
// same convention for the ledger. Only genuinely countable values (tenor in
// months, a score, a month number) are `INTEGER` and become `number`.

export type BentukNilai = "INTEGER" | "DESIMAL" | "BOOLEAN" | "STRING" | "ENUM" | "JSON_ARRAY";

export interface KatalogEntri {
  grup: string;
  kunci: string;
  bentuk: BentukNilai;
  /** Allowed values for ENUM, and for JSON_ARRAY the allowed member values. */
  pilihan?: readonly string[];
  /** Inclusive bounds for INTEGER and DESIMAL (as strings for DESIMAL). */
  min?: string;
  max?: string;
  deskripsi: string;
  /**
   * true when the row is expected to already exist (shipped by
   * migrations/0004). false marks a capability key added by the Fase 0 seed
   * because it came out of the regulation review in docs/BUILD-PLAN.md rather
   * than out of spec 5, and therefore has no migration of its own yet.
   */
  dariMigrasi: boolean;
  /** Default the seed writes when the row is absent. */
  nilaiDefault: string;
}

const DESIMAL_RE = /^\d{1,18}(\.\d{1,6})?$/;
const INTEGER_RE = /^-?\d{1,9}$/;

function entri(e: KatalogEntri): KatalogEntri {
  return e;
}

/**
 * Keyed `grup.kunci`, which is exactly how a getter is called, so a typo in a
 * key is a lookup failure with a readable message instead of a silent miss.
 */
export const KATALOG: Readonly<Record<string, KatalogEntri>> = Object.freeze({
  // --- spec 5.3 jasa administrasi -----------------------------------------
  "jasa_adm.jasa_adm_rate_default": entri({
    grup: "jasa_adm",
    kunci: "jasa_adm_rate_default",
    bentuk: "DESIMAL",
    min: "0",
    max: "1",
    deskripsi: "Rate jasa administrasi default per tahun (0.030000 = 3 persen)",
    dariMigrasi: true,
    nilaiDefault: "0.030000",
  }),
  "jasa_adm.jasa_adm_metode_default": entri({
    grup: "jasa_adm",
    kunci: "jasa_adm_metode_default",
    bentuk: "ENUM",
    pilihan: ["FLAT", "EFEKTIF", "ANUITAS"],
    deskripsi: "Metode perhitungan jasa administrasi default (spec 7.1)",
    dariMigrasi: true,
    nilaiDefault: "FLAT",
  }),
  "jasa_adm.jasa_adm_basis_hari": entri({
    grup: "jasa_adm",
    kunci: "jasa_adm_basis_hari",
    bentuk: "ENUM",
    pilihan: ["360", "365"],
    deskripsi: "Basis hari setahun untuk perhitungan jasa administrasi",
    dariMigrasi: true,
    nilaiDefault: "360",
  }),
  // BUILD-PLAN: PER-1/MBU/03/2023 pasal 22(2) is 3 percent EFEKTIF, or a flat
  // rate equivalent to it. The engine must be able to DERIVE the flat rate
  // instead of having it typed in, so both the switch and the reference
  // effective rate are parameters.
  "jasa_adm.turunkan_flat_dari_efektif": entri({
    grup: "jasa_adm",
    kunci: "turunkan_flat_dari_efektif",
    bentuk: "BOOLEAN",
    deskripsi:
      "Hitung rate FLAT sebagai ekuivalen dari rate efektif acuan, bukan memakai rate flat yang diketik manual",
    dariMigrasi: false,
    nilaiDefault: "false",
  }),
  "jasa_adm.rate_efektif_acuan": entri({
    grup: "jasa_adm",
    kunci: "rate_efektif_acuan",
    bentuk: "DESIMAL",
    min: "0",
    max: "1",
    deskripsi: "Rate efektif per tahun yang dipakai sebagai acuan konversi ke FLAT (0.030000 = 3 persen)",
    dariMigrasi: false,
    nilaiDefault: "0.030000",
  }),

  // --- spec 5.3/5.4 angsuran ----------------------------------------------
  "angsuran.pembulatan_angsuran": entri({
    grup: "angsuran",
    kunci: "pembulatan_angsuran",
    bentuk: "ENUM",
    pilihan: ["0", "100", "1000"],
    deskripsi: "Pembulatan angsuran dalam rupiah; selisih dibebankan ke angsuran terakhir",
    dariMigrasi: true,
    nilaiDefault: "0",
  }),
  "angsuran.urutan_alokasi_setoran_preset": entri({
    grup: "angsuran",
    kunci: "urutan_alokasi_setoran_preset",
    bentuk: "ENUM",
    pilihan: ["DEFAULT", "POKOK_DULU"],
    deskripsi: "Kode preset di alokasi_setoran_preset yang dipakai engine alokasi setoran (spec 5.4)",
    dariMigrasi: true,
    nilaiDefault: "DEFAULT",
  }),

  // --- spec 5.5 batasan program -------------------------------------------
  "batasan.plafon_min_pumk": entri({
    grup: "batasan",
    kunci: "plafon_min_pumk",
    bentuk: "DESIMAL",
    min: "0",
    deskripsi: "Plafon minimum pinjaman PUMK",
    dariMigrasi: true,
    nilaiDefault: "5000000.00",
  }),
  "batasan.plafon_max_pumk": entri({
    grup: "batasan",
    kunci: "plafon_max_pumk",
    bentuk: "DESIMAL",
    min: "0",
    deskripsi: "Plafon maksimum pinjaman PUMK",
    dariMigrasi: true,
    nilaiDefault: "250000000.00",
  }),
  "batasan.tenor_min_bulan": entri({
    grup: "batasan",
    kunci: "tenor_min_bulan",
    bentuk: "INTEGER",
    min: "1",
    max: "120",
    deskripsi: "Tenor minimum dalam bulan",
    dariMigrasi: true,
    nilaiDefault: "6",
  }),
  "batasan.tenor_max_bulan": entri({
    grup: "batasan",
    kunci: "tenor_max_bulan",
    bentuk: "INTEGER",
    min: "1",
    max: "120",
    deskripsi: "Tenor maksimum dalam bulan (BUILD-PLAN: maksimum 3 tahun)",
    dariMigrasi: true,
    nilaiDefault: "36",
  }),
  "batasan.grace_period_max_bulan": entri({
    grup: "batasan",
    kunci: "grace_period_max_bulan",
    bentuk: "INTEGER",
    min: "0",
    max: "24",
    deskripsi: "Grace period maksimum dalam bulan",
    dariMigrasi: true,
    nilaiDefault: "6",
  }),
  "batasan.wajib_jaminan_di_atas_plafon": entri({
    grup: "batasan",
    kunci: "wajib_jaminan_di_atas_plafon",
    bentuk: "DESIMAL",
    min: "0",
    deskripsi: "Ambang plafon yang mewajibkan jaminan",
    dariMigrasi: true,
    nilaiDefault: "50000000.00",
  }),
  "batasan.maks_pinjaman_aktif_per_mitra": entri({
    grup: "batasan",
    kunci: "maks_pinjaman_aktif_per_mitra",
    bentuk: "INTEGER",
    min: "1",
    max: "10",
    deskripsi: "Jumlah maksimum akad aktif per mitra binaan",
    dariMigrasi: true,
    nilaiDefault: "1",
  }),
  "batasan.skor_survey_minimum_lolos": entri({
    grup: "batasan",
    kunci: "skor_survey_minimum_lolos",
    bentuk: "INTEGER",
    min: "0",
    max: "100",
    deskripsi: "Skor survey minimum agar proposal bisa direkomendasikan",
    dariMigrasi: true,
    nilaiDefault: "70",
  }),
  // BUILD-PLAN: plafon Rp250 juta plus tambahan jangka pendek Rp100 juta.
  // Default OFF, because spec 5.5 says maks_pinjaman_aktif_per_mitra = 1.
  "batasan.izinkan_topup_jangka_pendek": entri({
    grup: "batasan",
    kunci: "izinkan_topup_jangka_pendek",
    bentuk: "BOOLEAN",
    deskripsi: "Izinkan pinjaman tambahan jangka pendek di atas akad aktif (default mati)",
    dariMigrasi: false,
    nilaiDefault: "false",
  }),
  "batasan.plafon_topup_jangka_pendek": entri({
    grup: "batasan",
    kunci: "plafon_topup_jangka_pendek",
    bentuk: "DESIMAL",
    min: "0",
    deskripsi: "Plafon maksimum pinjaman tambahan jangka pendek",
    dariMigrasi: false,
    nilaiDefault: "100000000.00",
  }),

  // --- spec 5.6 akuntansi --------------------------------------------------
  "akuntansi.metode_pengakuan_jasa_adm": entri({
    grup: "akuntansi",
    kunci: "metode_pengakuan_jasa_adm",
    bentuk: "ENUM",
    pilihan: ["CASH_BASIS", "ACCRUAL"],
    deskripsi: "Metode pengakuan pendapatan jasa administrasi",
    dariMigrasi: true,
    nilaiDefault: "ACCRUAL",
  }),
  "akuntansi.akrual_hanya_untuk_kolektibilitas": entri({
    grup: "akuntansi",
    kunci: "akrual_hanya_untuk_kolektibilitas",
    bentuk: "JSON_ARRAY",
    pilihan: ["LANCAR", "KURANG_LANCAR", "DIRAGUKAN", "MACET"],
    deskripsi: "Kelas kolektibilitas yang jasa administrasinya diakrual",
    dariMigrasi: true,
    nilaiDefault: '["LANCAR"]',
  }),
  "akuntansi.jasa_grace_period": entri({
    grup: "akuntansi",
    kunci: "jasa_grace_period",
    bentuk: "ENUM",
    pilihan: ["TIDAK_DIHITUNG", "DIHITUNG_DITANGGUHKAN", "DIHITUNG_DIBAYAR"],
    deskripsi: "Perlakuan jasa administrasi selama grace period (ASSUMPTIONS.md A-05)",
    dariMigrasi: true,
    nilaiDefault: "TIDAK_DIHITUNG",
  }),
  "akuntansi.tahun_buku_mulai_bulan": entri({
    grup: "akuntansi",
    kunci: "tahun_buku_mulai_bulan",
    bentuk: "INTEGER",
    min: "1",
    max: "12",
    deskripsi: "Bulan awal tahun buku",
    dariMigrasi: true,
    nilaiDefault: "1",
  }),
  "akuntansi.izinkan_reopen_periode": entri({
    grup: "akuntansi",
    kunci: "izinkan_reopen_periode",
    bentuk: "BOOLEAN",
    deskripsi: "Boleh reopen periode CLOSED; tetap butuh role Admin Pusat + alasan tertulis",
    dariMigrasi: true,
    nilaiDefault: "true",
  }),
  "akuntansi.dasar_perhitungan_penyisihan": entri({
    grup: "akuntansi",
    kunci: "dasar_perhitungan_penyisihan",
    bentuk: "ENUM",
    pilihan: ["OUTSTANDING_POKOK", "OUTSTANDING_POKOK_PLUS_JASA"],
    deskripsi: "Dasar perhitungan nilai penyisihan (spec 5.2)",
    dariMigrasi: true,
    nilaiDefault: "OUTSTANDING_POKOK",
  }),
  // BUILD-PLAN: two penyisihan modes must both exist, selected by config.
  "akuntansi.mode_penyisihan": entri({
    grup: "akuntansi",
    kunci: "mode_penyisihan",
    bentuk: "ENUM",
    pilihan: ["RATE_TABLE", "KOLEKTIF_HISTORIS"],
    deskripsi:
      "RATE_TABLE memakai tabel penyisihan_rate (default, sesuai spec 5.2). " +
      "KOLEKTIF_HISTORIS menghitung rate dari histori penerimaan per bucket kolektibilitas",
    dariMigrasi: false,
    nilaiDefault: "RATE_TABLE",
  }),
  "akuntansi.penyisihan_min_bulan_histori": entri({
    grup: "akuntansi",
    kunci: "penyisihan_min_bulan_histori",
    bentuk: "INTEGER",
    min: "1",
    max: "120",
    deskripsi: "Minimum bulan histori penerimaan sebelum mode KOLEKTIF_HISTORIS boleh dipakai",
    dariMigrasi: false,
    nilaiDefault: "24",
  }),
  // BUILD-PLAN: SK-277/MBU/10/2023 separates penghapusbukuan from
  // penghapustagihan, and a write-off larger than the allowance must not push
  // the allowance negative.
  "akuntansi.pisahkan_penghapustagihan": entri({
    grup: "akuntansi",
    kunci: "pisahkan_penghapustagihan",
    bentuk: "BOOLEAN",
    deskripsi: "Perlakukan penghapusbukuan dan penghapustagihan sebagai dua peristiwa terpisah",
    dariMigrasi: false,
    nilaiDefault: "true",
  }),
  "akuntansi.kekurangan_penyisihan_hapus_buku": entri({
    grup: "akuntansi",
    kunci: "kekurangan_penyisihan_hapus_buku",
    bentuk: "ENUM",
    pilihan: ["BEBAN_PERIODE", "TOLAK"],
    deskripsi:
      "Kalau saldo penyisihan lebih kecil dari outstanding yang dihapus buku: " +
      "BEBAN_PERIODE membebankan sisanya ke periode itu, TOLAK menolak transaksinya",
    dariMigrasi: false,
    nilaiDefault: "BEBAN_PERIODE",
  }),
  // BUILD-PLAN: ISAK 335 renumbering means more than one live report template.
  "laporan.template_laporan_aktif": entri({
    grup: "laporan",
    kunci: "template_laporan_aktif",
    bentuk: "ENUM",
    pilihan: ["PSAK45", "ISAK335"],
    deskripsi:
      "Template baris laporan yang aktif. PSAK45 mengikuti istilah spec (Aset Neto Tidak Terikat/Terikat Temporer), " +
      "ISAK335 memakai tanpa pembatasan/dengan pembatasan",
    dariMigrasi: false,
    nilaiDefault: "PSAK45",
  }),

  // --- kolektibilitas dan kas ---------------------------------------------
  "kolektibilitas.tandai_mitra_bermasalah_saat_macet": entri({
    grup: "kolektibilitas",
    kunci: "tandai_mitra_bermasalah_saat_macet",
    bentuk: "BOOLEAN",
    deskripsi: "Set status mitra BERMASALAH saat kolektibilitas masuk kelas bermasalah",
    dariMigrasi: true,
    nilaiDefault: "true",
  }),
  "kas.izinkan_saldo_kas_negatif": entri({
    grup: "kas",
    kunci: "izinkan_saldo_kas_negatif",
    bentuk: "BOOLEAN",
    deskripsi: "Saldo kas negatif hanya warning saat closing (spec 8.4 butir 8), bukan blocker",
    dariMigrasi: true,
    nilaiDefault: "false",
  }),
});

export type KatalogKunci = keyof typeof KATALOG;

export function katalogKey(grup: string, kunci: string): string {
  return `${grup}.${kunci}`;
}

export function lookupKatalog(grup: string, kunci: string): KatalogEntri | null {
  return KATALOG[katalogKey(grup, kunci)] ?? null;
}

/** Entries the Fase 0 seed must create because no migration ships them. */
export function entriTambahan(): KatalogEntri[] {
  return Object.values(KATALOG).filter((e) => !e.dariMigrasi);
}

/**
 * Validates a raw text value against its declared shape. Returns a list of
 * problems, empty when the value is acceptable. Shared by the read path
 * (where a problem is a loud server error) and the write path (where it is a
 * 400 with the field detail), so the two can never disagree.
 */
export function periksaNilai(entri: KatalogEntri, nilai: string | null): string[] {
  const masalah: string[] = [];
  if (nilai === null || nilai.trim().length === 0) {
    return [`nilai wajib ada untuk ${katalogKey(entri.grup, entri.kunci)}`];
  }
  const value = nilai.trim();

  switch (entri.bentuk) {
    case "INTEGER": {
      if (!INTEGER_RE.test(value)) {
        masalah.push(`harus bilangan bulat, bukan "${value}"`);
        break;
      }
      const n = Number(value);
      if (entri.min !== undefined && n < Number(entri.min)) masalah.push(`minimal ${entri.min}`);
      if (entri.max !== undefined && n > Number(entri.max)) masalah.push(`maksimal ${entri.max}`);
      break;
    }
    case "DESIMAL": {
      // Deliberately not parseFloat: "3%" parses to 3 and "0,03" parses to 0.
      if (!DESIMAL_RE.test(value)) {
        masalah.push(`harus angka desimal dengan titik sebagai pemisah, bukan "${value}"`);
        break;
      }
      if (entri.min !== undefined && compareDesimal(value, entri.min) < 0) {
        masalah.push(`minimal ${entri.min}`);
      }
      if (entri.max !== undefined && compareDesimal(value, entri.max) > 0) {
        masalah.push(`maksimal ${entri.max}`);
      }
      break;
    }
    case "BOOLEAN":
      if (value !== "true" && value !== "false") masalah.push(`harus "true" atau "false", bukan "${value}"`);
      break;
    case "ENUM":
      if (!entri.pilihan?.includes(value)) {
        masalah.push(`harus salah satu dari ${entri.pilihan?.join(", ")}`);
      }
      break;
    case "JSON_ARRAY": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        masalah.push("harus JSON array yang valid");
        break;
      }
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
        masalah.push("harus JSON array berisi string");
        break;
      }
      if (entri.pilihan) {
        const asing = parsed.filter((item) => !entri.pilihan?.includes(item as string));
        if (asing.length > 0) masalah.push(`nilai tidak dikenal: ${asing.join(", ")}`);
      }
      break;
    }
    case "STRING":
      if (value.length > 200) masalah.push("maksimal 200 karakter");
      break;
  }
  return masalah;
}

/**
 * Compares two decimal strings without going through a float. Returns <0, 0
 * or >0. Only handles the non-negative, no-exponent form DESIMAL_RE accepts.
 */
export function compareDesimal(a: string, b: string): number {
  const [ai = "0", af = ""] = a.split(".");
  const [bi = "0", bf = ""] = b.split(".");
  const width = Math.max(af.length, bf.length);
  const an = BigInt(ai) * 10n ** BigInt(width) + BigInt((af + "0".repeat(width)).slice(0, width) || "0");
  const bn = BigInt(bi) * 10n ** BigInt(width) + BigInt((bf + "0".repeat(width)).slice(0, width) || "0");
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** The `tipe_data` value the konfigurasi table's CHECK constraint accepts. */
export function tipeDataUntuk(bentuk: BentukNilai): "STRING" | "NUMBER" | "BOOLEAN" | "JSON" | "ENUM" {
  switch (bentuk) {
    case "INTEGER":
    case "DESIMAL":
      return "NUMBER";
    case "BOOLEAN":
      return "BOOLEAN";
    case "JSON_ARRAY":
      return "JSON";
    case "ENUM":
      return "ENUM";
    default:
      return "STRING";
  }
}
