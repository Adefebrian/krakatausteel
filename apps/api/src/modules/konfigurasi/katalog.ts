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

/** Provenance of a shipped default. See `KatalogEntri.asalNilaiDefault`. */
export type AsalNilai = "SPEC" | "KEPUTUSAN" | "ASUMSI";

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
   * true when the row is expected to already exist (shipped by a migration:
   * 0004 for spec 5, 0016 for the integration switches, 0019 for the fixed due
   * day, 0022 for the Non PUMK limits). false marks a capability key added by
   * the Fase 0 seed because it came out of the regulation review in
   * docs/BUILD-PLAN.md rather than out of a migration.
   */
  dariMigrasi: boolean;
  /**
   * WHERE THE SHIPPED DEFAULT CAME FROM. Not the same question as "may it be
   * changed" (everything here may) and not the same as
   * `konfigurasi.perlu_konfirmasi` (which is per ROW and per entity, and which
   * `insertOverride` turns off the moment an operator types a value, because an
   * explicit override IS the confirmation).
   *
   *   SPEC       the number is written in the specification.
   *   KEPUTUSAN  chosen in a recorded decision: docs/BUILD-PLAN.md, an ADR, or
   *              the regulation review in docs/REGULASI.md.
   *   ASUMSI     INVENTED. Nothing in the spec or the regulations proposes it;
   *              it is our proposal, logged in ASSUMPTIONS.md and awaiting the
   *              client's written confirmation.
   *
   * The Konfigurasi screen needs this to stop presenting an invented number as
   * settled policy, which is the whole risk of shipping a default for a
   * parameter the contract says is undecided. A row that carries no catalogue
   * entry reports null, because "we do not know where this came from" is not
   * the same claim as "the spec says so".
   */
  asalNilaiDefault: AsalNilai;
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
    asalNilaiDefault: "SPEC",
    nilaiDefault: "0.030000",
  }),
  "jasa_adm.jasa_adm_metode_default": entri({
    grup: "jasa_adm",
    kunci: "jasa_adm_metode_default",
    bentuk: "ENUM",
    pilihan: ["FLAT", "EFEKTIF", "ANUITAS"],
    deskripsi: "Metode perhitungan jasa administrasi default (spec 7.1)",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
    nilaiDefault: "FLAT",
  }),
  "jasa_adm.jasa_adm_basis_hari": entri({
    grup: "jasa_adm",
    kunci: "jasa_adm_basis_hari",
    bentuk: "ENUM",
    pilihan: ["360", "365"],
    deskripsi: "Basis hari setahun untuk perhitungan jasa administrasi",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
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
    asalNilaiDefault: "KEPUTUSAN",
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
    asalNilaiDefault: "KEPUTUSAN",
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
    asalNilaiDefault: "SPEC",
    nilaiDefault: "0",
  }),
  "angsuran.urutan_alokasi_setoran_preset": entri({
    grup: "angsuran",
    kunci: "urutan_alokasi_setoran_preset",
    bentuk: "ENUM",
    pilihan: ["DEFAULT", "POKOK_DULU"],
    deskripsi: "Kode preset di alokasi_setoran_preset yang dipakai engine alokasi setoran (spec 5.4)",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
    nilaiDefault: "DEFAULT",
  }),
  // Spec 7.1's fixed-due-day option ("Sediakan opsi konfigurasi hari jatuh
  // tempo tetap, misal selalu tanggal 25"). SHIPPED BY migrations/0019 and
  // absent from this catalogue until now, which is the same gap as the four
  // Non PUMK keys further down: the row existed and the engine read it, but
  // GET / reported it as `diLuarKatalog` and PUT refused it with a 400, so the
  // one option spec 7.1 names by hand could only be changed with psql. That is
  // spec rule 3 broken for that parameter.
  //
  // THE CEILING IS THE ENGINE'S, NOT THE MIGRATION COMMENT'S. 0019's comment
  // claims values above 28 are "refused here"; nothing enforces that, and the
  // schedule generator deliberately supports 29..31 by clamping to the last
  // day of a short month and returning to the anchor afterwards (31 Jan,
  // 28 Feb, 31 Mar), which modules/angsuran/angsuran-jadwal.test.ts pins with
  // hariTetap = 31. modules/angsuran/service.ts refuses only above 31. A
  // catalogue that stopped at 28 would make the config screen disagree with
  // the engine about a supported, tested setting, so this matches the engine.
  "angsuran.hari_jatuh_tempo_tetap": entri({
    grup: "angsuran",
    kunci: "hari_jatuh_tempo_tetap",
    bentuk: "INTEGER",
    min: "0",
    max: "31",
    deskripsi:
      "Hari jatuh tempo tetap setiap bulan (spec 7.1). 0 = mengikuti tanggal mulai angsuran akad; " +
      "1 sampai 31 = selalu tanggal itu, dengan pemotongan ke hari terakhir untuk bulan pendek",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
    nilaiDefault: "0",
  }),

  // --- spec 5.5 batasan program -------------------------------------------
  "batasan.plafon_min_pumk": entri({
    grup: "batasan",
    kunci: "plafon_min_pumk",
    bentuk: "DESIMAL",
    min: "0",
    deskripsi: "Plafon minimum pinjaman PUMK",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
    nilaiDefault: "5000000.00",
  }),
  "batasan.plafon_max_pumk": entri({
    grup: "batasan",
    kunci: "plafon_max_pumk",
    bentuk: "DESIMAL",
    min: "0",
    deskripsi: "Plafon maksimum pinjaman PUMK",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
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
    asalNilaiDefault: "SPEC",
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
    asalNilaiDefault: "SPEC",
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
    asalNilaiDefault: "SPEC",
    nilaiDefault: "6",
  }),
  "batasan.wajib_jaminan_di_atas_plafon": entri({
    grup: "batasan",
    kunci: "wajib_jaminan_di_atas_plafon",
    bentuk: "DESIMAL",
    min: "0",
    deskripsi: "Ambang plafon yang mewajibkan jaminan",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
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
    asalNilaiDefault: "SPEC",
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
    asalNilaiDefault: "SPEC",
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
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "false",
  }),
  "batasan.plafon_topup_jangka_pendek": entri({
    grup: "batasan",
    kunci: "plafon_topup_jangka_pendek",
    bentuk: "DESIMAL",
    min: "0",
    deskripsi: "Plafon maksimum pinjaman tambahan jangka pendek",
    dariMigrasi: false,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "100000000.00",
  }),

  // --- batasan program Non PUMK (TIDAK ADA di spec 5.5) --------------------
  //
  // Spec 5.5 "Batasan Program" lists PUMK limits ONLY, while spec 9.2 makes the
  // Non PUMK engine enforce an amount range, an assessment pass mark and an LPJ
  // deadline. The rows are shipped by migrations/0022 and every VALUE in them is
  // INVENTED, not transcribed: ASSUMPTIONS.md A-41 to A-44 record them as
  // assumptions awaiting the client's written confirmation, and the shipped rows
  // carry `perlu_konfirmasi = true` so the Konfigurasi screen says so per row.
  //
  // THIS CATALOGUE DELIBERATELY DOES NOT KEEP ITS OWN "needs confirmation" FLAG.
  // That state is per ROW and it changes: `insertOverride` writes
  // perlu_konfirmasi = false when an operator sets a value, because an explicit
  // override IS the confirmation. A second copy of the flag in code could only
  // ever go stale against the row, so the provenance lives in `deskripsi` (which
  // travels onto the override row) and the live flag stays in the database.
  //
  // The bounds below are NOT policy. They are the range outside which a value
  // could only be a typo, so that a mistyped limit fails at the boundary instead
  // of silently disabling a check the engine believes it is performing.
  "batasan.nilai_min_non_pumk": entri({
    grup: "batasan",
    kunci: "nilai_min_non_pumk",
    bentuk: "DESIMAL",
    min: "0",
    // A minimum grant of a billion rupiah is not a policy, it is a slipped
    // digit; the shipped ceiling for one grant is 500 juta (A-42).
    max: "1000000000.00",
    deskripsi:
      "Nilai bantuan Non PUMK minimum yang boleh diajukan. TIDAK ADA di spec 5.5; " +
      "nilai asumsi, lihat ASSUMPTIONS.md A-41. 0 = tanpa batas bawah",
    dariMigrasi: true,
    asalNilaiDefault: "ASUMSI",
    nilaiDefault: "1000000.00",
  }),
  "batasan.nilai_max_non_pumk": entri({
    grup: "batasan",
    kunci: "nilai_max_non_pumk",
    bentuk: "DESIMAL",
    // Not 0: an upper limit of zero would reject every proposal ever filed,
    // and "no ceiling" is not expressible here on purpose (a TJSL grant
    // programme with no ceiling is a decision, not a parameter).
    min: "1.00",
    max: "100000000000.00",
    deskripsi:
      "Nilai bantuan Non PUMK maksimum yang boleh diajukan. TIDAK ADA di spec 5.5; " +
      "nilai asumsi, lihat ASSUMPTIONS.md A-42",
    dariMigrasi: true,
    asalNilaiDefault: "ASUMSI",
    nilaiDefault: "500000000.00",
  }),
  "batasan.skor_penilaian_minimum_lolos_non_pumk": entri({
    grup: "batasan",
    kunci: "skor_penilaian_minimum_lolos_non_pumk",
    bentuk: "INTEGER",
    // `nonpumk_penilaian.skor_total` is a weighted average of the five spec 4.5
    // components on a 0..100 scale, so a pass mark outside that range would be
    // unreachable in one direction and vacuous in the other. Same bounds as
    // batasan.skor_survey_minimum_lolos, which measures the same kind of thing.
    min: "0",
    max: "100",
    deskripsi:
      "Skor penilaian minimum agar proposal Non PUMK bisa direkomendasikan. TIDAK ADA di spec 5.5; " +
      "nilai asumsi, lihat ASSUMPTIONS.md A-43",
    dariMigrasi: true,
    asalNilaiDefault: "ASUMSI",
    nilaiDefault: "70",
  }),
  "batasan.batas_hari_lpj_non_pumk": entri({
    grup: "batasan",
    kunci: "batas_hari_lpj_non_pumk",
    bentuk: "INTEGER",
    // 1 at the bottom: a deadline of 0 days makes every LPJ late on the day the
    // money moves, which is a broken dashboard rather than a strict policy.
    // 365 at the top: a deadline longer than the reporting year would mean an
    // LPJ that is never late inside the period it belongs to.
    min: "1",
    max: "365",
    deskripsi:
      "Batas hari penyampaian LPJ dihitung dari penyaluran TERAKHIR; menentukan flag terlambat di " +
      "monitoring spec 9.2. Ember aging 30/60/90 adalah konstanta spesifikasi dan bukan parameter. " +
      "TIDAK ADA di spec 5.5; nilai asumsi, lihat ASSUMPTIONS.md A-44",
    dariMigrasi: true,
    asalNilaiDefault: "ASUMSI",
    nilaiDefault: "60",
  }),

  // --- spec 5.6 akuntansi --------------------------------------------------
  "akuntansi.metode_pengakuan_jasa_adm": entri({
    grup: "akuntansi",
    kunci: "metode_pengakuan_jasa_adm",
    bentuk: "ENUM",
    pilihan: ["CASH_BASIS", "ACCRUAL"],
    deskripsi: "Metode pengakuan pendapatan jasa administrasi",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
    nilaiDefault: "ACCRUAL",
  }),
  "akuntansi.akrual_hanya_untuk_kolektibilitas": entri({
    grup: "akuntansi",
    kunci: "akrual_hanya_untuk_kolektibilitas",
    bentuk: "JSON_ARRAY",
    pilihan: ["LANCAR", "KURANG_LANCAR", "DIRAGUKAN", "MACET"],
    deskripsi: "Kelas kolektibilitas yang jasa administrasinya diakrual",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
    nilaiDefault: '["LANCAR"]',
  }),
  "akuntansi.jasa_grace_period": entri({
    grup: "akuntansi",
    kunci: "jasa_grace_period",
    bentuk: "ENUM",
    pilihan: ["TIDAK_DIHITUNG", "DIHITUNG_DITANGGUHKAN", "DIHITUNG_DIBAYAR"],
    deskripsi: "Perlakuan jasa administrasi selama grace period (ASSUMPTIONS.md A-05)",
    dariMigrasi: true,
    asalNilaiDefault: "ASUMSI",
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
    asalNilaiDefault: "SPEC",
    nilaiDefault: "1",
  }),
  "akuntansi.izinkan_reopen_periode": entri({
    grup: "akuntansi",
    kunci: "izinkan_reopen_periode",
    bentuk: "BOOLEAN",
    deskripsi: "Boleh reopen periode CLOSED; tetap butuh role Admin Pusat + alasan tertulis",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
    nilaiDefault: "true",
  }),
  "akuntansi.dasar_perhitungan_penyisihan": entri({
    grup: "akuntansi",
    kunci: "dasar_perhitungan_penyisihan",
    bentuk: "ENUM",
    pilihan: ["OUTSTANDING_POKOK", "OUTSTANDING_POKOK_PLUS_JASA"],
    deskripsi: "Dasar perhitungan nilai penyisihan (spec 5.2)",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
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
    asalNilaiDefault: "KEPUTUSAN",
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
    asalNilaiDefault: "KEPUTUSAN",
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
    asalNilaiDefault: "KEPUTUSAN",
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
    asalNilaiDefault: "KEPUTUSAN",
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
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "PSAK45",
  }),

  // --- kolektibilitas dan kas ---------------------------------------------
  "kolektibilitas.tandai_mitra_bermasalah_saat_macet": entri({
    grup: "kolektibilitas",
    kunci: "tandai_mitra_bermasalah_saat_macet",
    bentuk: "BOOLEAN",
    deskripsi: "Set status mitra BERMASALAH saat kolektibilitas masuk kelas bermasalah",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
    nilaiDefault: "true",
  }),
  "kas.izinkan_saldo_kas_negatif": entri({
    grup: "kas",
    kunci: "izinkan_saldo_kas_negatif",
    bentuk: "BOOLEAN",
    deskripsi: "Saldo kas negatif hanya warning saat closing (spec 8.4 butir 8), bukan blocker",
    dariMigrasi: true,
    asalNilaiDefault: "SPEC",
    nilaiDefault: "false",
  }),

  // --- integrasi akuntansi eksternal (shipped by migrations/0016) ----------
  //
  // TWELVE ROWS THAT WERE SHIPPED AND NEVER CATALOGUED, found by the same
  // sweep that found the four Non PUMK keys: every global row in `konfigurasi`
  // compared against this object. They are the settings behind ADR 0008 and
  // spec 12 (push jurnal ke sistem akuntansi eksternal), they have existed
  // since 0016, and until now GET / reported all twelve as `diLuarKatalog` and
  // PUT refused every one of them with a 400. The integration layer is inert by
  // default, so nobody had noticed that the master switch that turns it on
  // could only be turned on with psql.
  //
  // NO ENGINE READS THESE YET (Fase 8). Cataloguing them now is deliberate: the
  // rows are already in every database, so the only thing missing was the
  // ability to see and change them, and a key that is catalogued before its
  // reader exists cannot be read with a `?? "default"` at the call site later.
  "integrasi.integrasi_akuntansi_aktif": entri({
    grup: "integrasi",
    kunci: "integrasi_akuntansi_aktif",
    bentuk: "BOOLEAN",
    deskripsi:
      "Master switch push jurnal ke sistem akuntansi eksternal. false = seluruh lapisan integrasi inert",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "false",
  }),
  "integrasi.sistem_akuntansi_target": entri({
    grup: "integrasi",
    kunci: "sistem_akuntansi_target",
    bentuk: "STRING",
    deskripsi: "Kode baris sistem_eksternal yang menjadi tujuan push jurnal",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "ACCURATE_ONLINE",
  }),
  // BELUM DIPUTUSKAN, and the default is the conservative reading of spec 1
  // (the TJSL unit is its own reporting entity). Moving it to EKSTERNAL is an
  // owner decision, not a technical setting: ADR 0008, OPEN-QUESTIONS item 11.
  "integrasi.pemegang_buku_resmi": entri({
    grup: "integrasi",
    kunci: "pemegang_buku_resmi",
    bentuk: "ENUM",
    pilihan: ["SISTEM_INI", "EKSTERNAL"],
    deskripsi:
      "Siapa pemegang buku resmi. BELUM DIPUTUSKAN; default SISTEM_INI sesuai spec Bagian 1. " +
      "Mengubah ke EKSTERNAL adalah keputusan pemilik, lihat ADR 0008 dan OPEN-QUESTIONS butir 11",
    dariMigrasi: true,
    asalNilaiDefault: "ASUMSI",
    nilaiDefault: "SISTEM_INI",
  }),
  "integrasi.adapter_ekspor": entri({
    grup: "integrasi",
    kunci: "adapter_ekspor",
    bentuk: "ENUM",
    pilihan: ["API", "FILE"],
    deskripsi: "Adapter di belakang port ekspor; jalur FILE tetap tersedia kalau API membatasi",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "FILE",
  }),
  "integrasi.granularitas_push": entri({
    grup: "integrasi",
    kunci: "granularitas_push",
    bentuk: "ENUM",
    pilihan: ["PER_JURNAL", "REKAP_PERIODE"],
    deskripsi:
      "REKAP_PERIODE mengirim jurnal ringkas per periode, PER_JURNAL mengirim satu per satu. " +
      "Default REKAP_PERIODE selama sistem ini masih pemegang buku (ADR 0008)",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "REKAP_PERIODE",
  }),
  // 0 = unknown, which is the honest state: the research found no published
  // per-document line limit for the target system, only advice to split large
  // imports. Measure it against a test database before switching the push on.
  "integrasi.maks_baris_per_dokumen": entri({
    grup: "integrasi",
    kunci: "maks_baris_per_dokumen",
    bentuk: "INTEGER",
    min: "0",
    max: "100000",
    deskripsi:
      "Batas baris per dokumen di sistem tujuan. 0 = belum diketahui dan tidak dipakai memecah; " +
      "ukur empiris sebelum push otomatis",
    dariMigrasi: true,
    asalNilaiDefault: "ASUMSI",
    nilaiDefault: "0",
  }),
  // 0 is allowed and means "never retry automatically", which is a legitimate
  // operating stance for a ledger push. The ceiling is a guard against a typo
  // turning a retry budget into an unbounded loop against someone else's API.
  "integrasi.maks_percobaan_kirim": entri({
    grup: "integrasi",
    kunci: "maks_percobaan_kirim",
    bentuk: "INTEGER",
    min: "0",
    max: "20",
    deskripsi:
      "Batas percobaan kirim otomatis untuk kegagalan yang PASTI (GAGAL). " +
      "Status AMBIGU tidak pernah dicoba ulang otomatis. 0 = tidak pernah otomatis",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "5",
  }),
  // At least 1: a zero here would mark a row AMBIGU the instant it starts
  // sending, which is every push declared ambiguous. At most one day, because
  // a row stuck in SEDANG_DIKIRIM longer than that is an incident, not a wait.
  "integrasi.batas_menit_anggap_ambigu": entri({
    grup: "integrasi",
    kunci: "batas_menit_anggap_ambigu",
    bentuk: "INTEGER",
    min: "1",
    max: "1440",
    deskripsi:
      "Umur maksimum baris SEDANG_DIKIRIM (menit) sebelum sweeper menandainya AMBIGU, " +
      "yaitu proses mati di tengah panggilan",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "5",
  }),
  "integrasi.wajib_pemetaan_lengkap_sebelum_push": entri({
    grup: "integrasi",
    kunci: "wajib_pemetaan_lengkap_sebelum_push",
    bentuk: "BOOLEAN",
    deskripsi:
      "Tolak mulai push kalau masih ada akun terpakai yang belum dipetakan " +
      "(v_akun_belum_dipetakan tidak kosong)",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "true",
  }),
  "integrasi.wajib_pihak_valid_sebelum_push": entri({
    grup: "integrasi",
    kunci: "wajib_pihak_valid_sebelum_push",
    bentuk: "BOOLEAN",
    deskripsi:
      "Tolak mulai push kalau ada baris jurnal yang pihak sub-ledgernya tidak cocok dengan akunnya. " +
      "Mismatch di sisi tujuan gagal SENYAP, jadi validasinya wajib di sisi kita",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "true",
  }),
  // At least 1: journals in the target system can be edited or deleted without
  // telling us, so "never re-verify" is not an option the switch offers; turn
  // the integration off instead. 366 covers a yearly check.
  "integrasi.verifikasi_remote_setiap_hari": entri({
    grup: "integrasi",
    kunci: "verifikasi_remote_setiap_hari",
    bentuk: "INTEGER",
    min: "1",
    max: "366",
    deskripsi:
      "Interval hari untuk memeriksa ulang jurnal TERKIRIM terhadap sistem tujuan, " +
      "karena jurnal di sana bisa diedit atau dihapus tanpa memberi tahu kita",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
    nilaiDefault: "7",
  }),
  "integrasi.kirim_dimensi_program": entri({
    grup: "integrasi",
    kunci: "kirim_dimensi_program",
    bentuk: "BOOLEAN",
    deskripsi:
      "Ikutkan dimensi program/sektor pada payload ekspor. Default mati: dimensi di sistem tujuan " +
      "tergantung edisi, jadi ekspor wajib tetap valid tanpanya",
    dariMigrasi: true,
    asalNilaiDefault: "KEPUTUSAN",
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
 * Entries whose shipped default we INVENTED, so a screen can say so.
 *
 * Deliberately derived from `asalNilaiDefault` rather than stored twice, and
 * deliberately NOT a copy of `konfigurasi.perlu_konfirmasi`: that column is per
 * row, per entity, and is turned off by `insertOverride` the moment an operator
 * sets a value, because an explicit override IS the confirmation. This function
 * answers the other question, the one that never changes: was there ever a
 * source for this number, or did we make it up?
 */
export function entriPerluKonfirmasiKlien(): KatalogEntri[] {
  return Object.values(KATALOG).filter((e) => e.asalNilaiDefault === "ASUMSI");
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
