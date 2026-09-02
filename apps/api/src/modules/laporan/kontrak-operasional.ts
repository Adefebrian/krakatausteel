// apps/api/src/modules/laporan/kontrak-operasional.ts
//
// TYPE CONTRACT FOR THE REMAINING TWENTY-THREE REPORTS OF SPEC 10: the eleven
// PUMK reports (10.1, numbers 1 to 11), the four Non PUMK reports (10.2,
// numbers 12 to 15), Rekap Jurnal (10.3 number 21) and the seven of 10.4
// (numbers 25 to 31).
//
// ./contract.ts covers the seven ACCOUNTING statements (16 to 20, 22, 23) and
// modules/rka covers report 24. Together the three files are spec 10's
// complete catalogue, and ./baca.ts's `katalog()` is the one list that says so.
//
// WRITTEN BEFORE THE IMPLEMENTATION, like ./contract.ts, and for the same
// reason: the tests in this folder are the specification and this file is the
// shape they were written against.
//
// ---------------------------------------------------------------------------
// THE FOUR RULES CARRIED OVER FROM ./contract.ts, UNCHANGED
// ---------------------------------------------------------------------------
// 1. MONEY IS `Angka`: a two-decimal signed string plus the string that
//    prints. Never a JS number. Spec 10's zero rule ("Nilai nol ditampilkan
//    sebagai `0,00` bukan kosong") is a property of the report, so it is
//    applied here and not in a screen.
// 2. EVERY REPORT CARRIES `HeaderLaporan`, the same type the accounting
//    statements and report 24 carry. Two structurally identical header types
//    are two types, and the screen ends up with two renderers that disagree
//    about what a printed page states.
// 3. BRANCH SCOPE IS DECIDED BY THE SESSION AND REFUSED, NEVER NARROWED.
//    Spec 16 scenario 24. Every filter below carries `cabangId` where absent
//    means Semua Cabang, which requires a scope covering every branch.
// 4. A REFUSAL IS THE PRODUCT. `LaporanError` with a stable `kode`, never a
//    plausible page assembled from an incomplete source.
//
// ---------------------------------------------------------------------------
// AND THE THREE READINGS THIS FILE TAKES WHERE SPEC 10 IS SILENT
// ---------------------------------------------------------------------------
// These are decisions, not derivations. They are stated here so a reviewer can
// disagree with the decision rather than discover it in a join.
//
// A. WHERE A DISBURSEMENT FIGURE COMES FROM (reports 1, 2, 3, 7).
//    From `v_ledger_baris`, restricted to `jurnal.referensi_tipe =
//    'pumk_pencairan'` and to lines carrying an `akad_id`, summed
//    debit-positive. NOT from `pumk_pencairan` itself.
//
//    Two reasons, and the second is the one that matters. A reversing journal
//    inherits `referensi_tipe`, `mitra_id` and `akad_id` (modules/jurnal), so
//    a reversed disbursement NETS TO ZERO in the ledger while it still sits in
//    `pumk_pencairan` as a row; ADR 0010 is the same argument one level up.
//    And it is the EXACT source modules/rka reads for report 24's PUMK
//    realisation, so spec 16 scenario 18 ("angka realisasi cocok dengan total
//    di laporan penyaluran") becomes an equality this repository can assert
//    instead of a coincidence between two implementations.
//
// B. WHERE THE SECTOR AND THE GEOGRAPHY COME FROM (reports 1, 2, 3).
//    The sector is `pumk_proposal.sektor_id`, which is what modules/rka joins
//    for the same figure. The geography is the CURRENT address of the mitra
//    (`mitra.kota_id -> kota -> provinsi`).
//
//    ADR 0016 names this exact question and declines to settle it: "report 3
//    reaches its geography through `mitra`, whose address is mutable and,
//    unlike a sector classification, legitimately changes when a partner
//    moves. This is a different question with a different answer, and it
//    should be decided (report the address at disbursement, or the current
//    one) rather than inherited from whichever join someone writes first."
//    There is no address history in the schema, so "the address at
//    disbursement" is not implementable today; the reading taken is THE
//    CURRENT ADDRESS, and every geography report SAYS SO in
//    `dasarWilayah`, so a reader knows a partner who moved carries their whole
//    history to the new province. That field exists to be replaced, not to be
//    decoration: the day a `mitra_alamat_histori` table lands, it gains a
//    second member and the reports that can offer both say which they used.
//
// C. WHERE CLASSIFICATION, DAYS OVERDUE AND PROVISION COME FROM (reports 8,
//    10, 11, 28).
//    `kolektibilitas_snapshot`, ALWAYS, for the period being reported, whether
//    that period is OPEN or CLOSED, and a period with no snapshot is a REFUSAL
//    (`SNAPSHOT_KOLEKTIBILITAS_BELUM_ADA`) rather than a live recomputation.
//
//    This departs from the OPEN/CLOSED rule the accounting statements follow,
//    deliberately. Those three figures are produced by ONE run (spec 8.1,
//    Closing Kolektibilitas) and recorded per akad with the rate and the basis
//    that produced them (ADR 0014, migrations/0024). Recomputing them at print
//    time would be a second implementation of the provisioning engine, it
//    would disagree with the journal the period actually posted, and spec 16
//    scenario 17 asks for the opposite: "Buka Laporan Perhitungan Penyisihan,
//    konfirmasi totalnya merekonstruksi nilai jurnal penyisihan periode itu."
//    A report that recomputed could not fail that check even when the ledger
//    was wrong, which makes the check worthless. So the refusal is the
//    feature: "Closing Kolektibilitas belum dijalankan untuk periode ini" is a
//    thing an operator fixes in one click.
import type {
  Angka,
  HeaderLaporan,
  KlasifikasiArusKas,
  LaporanContext,
  StatusPeriode,
  TanggalIso,
  Uang,
} from "./contract";

// ---------------------------------------------------------------------------
// Scalars this file adds
// ---------------------------------------------------------------------------

/**
 * A percentage as a two-decimal signed string, e.g. `"87.50"`.
 *
 * RE-DECLARED RATHER THAN IMPORTED FROM modules/rka, which has the identical
 * type and the identical `persenCapaian` arithmetic. Not laziness and not
 * duplication by accident: modules/rka ALREADY imports `HeaderLaporan` from
 * this module's index, so an import in this direction would close a module
 * cycle. ./uang.ts records the same trade for the money helpers. The
 * arithmetic must not drift; when a shared money package appears, both
 * collapse into it.
 */
export type Persen = string;

export const POLA_PERSEN = /^-?\d{1,10}\.\d{2}$/;

/**
 * BULANAN is the reported month alone. KUMULATIF_YTD is the first day of the
 * financial year (spec 5.6, never a hardcoded January) to the reported month's
 * end.
 *
 * The same vocabulary report 24 uses, on purpose: spec 10.3 report 24 asks for
 * "versi bulanan dan kumulatif year to date", and a second word for the same
 * idea would make a screen that offers both reports offer two different
 * controls for one concept.
 */
export type ModeLaporan = "BULANAN" | "KUMULATIF_YTD";

/**
 * WHICH ADDRESS A GEOGRAPHY REPORT USED. See reading B in this file's header.
 * One member today, because one is implementable today; the field exists so
 * that a page printed now can be told apart from a page printed after a
 * historical-address table lands.
 */
export type DasarWilayah = "ALAMAT_MITRA_SAAT_INI";

/**
 * The vocabulary of `pumk_jadwal_angsuran.status` and `pumk_akad.status`,
 * mirrored from migrations/0008 rather than re-invented.
 */
export type StatusJadwal =
  | "BELUM_JATUH_TEMPO"
  | "JATUH_TEMPO"
  | "LUNAS"
  | "SEBAGIAN"
  | "DIRESCHEDULE";

export type StatusAkad =
  | "BELUM_CAIR"
  | "AKTIF"
  | "LUNAS"
  | "RESCHEDULED"
  | "MACET"
  | "HAPUS_BUKU";

/** Mirrors the CHECK on `portal_submission.status` (migrations/0013). */
export type StatusPortal = "BARU" | "DIPROSES" | "DIKONVERSI" | "DITOLAK";

/** Mirrors the CHECK on `nonpumk_lpj.status` (migrations/0009). */
export type StatusLpj = "BELUM" | "DIAJUKAN" | "DIVERIFIKASI" | "DITOLAK";

/** Mirrors the CHECK on `audit_log.hasil` (migrations/0014). */
export type HasilAudit = "SUKSES" | "DITOLAK";

// ---------------------------------------------------------------------------
// The printed titles, VERBATIM from the spec 10 catalogue
// ---------------------------------------------------------------------------

/**
 * Same rule as `NAMA_LAPORAN` in ./contract.ts: the header, a screen title and
 * a later export must not drift apart, and a test should name a report the way
 * the contract does. Numbering is the specification's own.
 */
export const NAMA_LAPORAN_OPERASIONAL = {
  /** 1 */ REALISASI_WILAYAH: "Laporan Realisasi Penyaluran berdasarkan Provinsi, Kota, Kabupaten",
  /** 2 */ REALISASI_SEKTOR: "Laporan Realisasi Penyaluran berdasarkan Sektor",
  /** 3 */ PENYALURAN_NASIONAL: "Laporan Penyaluran Nasional",
  /** 4 */ PENERIMAAN_ANGSURAN: "Laporan Penerimaan Angsuran",
  /** 5 */ JATUH_TEMPO: "Laporan Jatuh Tempo",
  /** 6 */ REKAP_PERMOHONAN_PUMK: "Rekap Permohonan PUMK",
  /** 7 */ REKAP_REALISASI_PUMK: "Rekap Realisasi PUMK",
  /** 8 */ AGING_PIUTANG: "Laporan Aging Piutang",
  /** 9 */ KARTU_PIUTANG: "Kartu Piutang Mitra Binaan",
  /** 10 */ KOLEKTIBILITAS: "Laporan Kolektibilitas",
  /** 11 */ PERPINDAHAN_KOLEKTIBILITAS: "Laporan Perpindahan Kolektibilitas",
  /** 12 */ PENYALURAN_NON_PUMK: "Laporan Penyaluran Non PUMK",
  /** 13 */ REKAP_BIDANG: "Rekap Penyaluran Non PUMK per Bidang",
  /** 14 */ PEMETAAN_SDG: "Laporan Pemetaan SDGs",
  /** 15 */ MONITORING_LPJ: "Laporan Monitoring LPJ",
  /** 21 */ REKAP_JURNAL: "Rekap Jurnal",
  /** 25 */ PORTAL_PUMK: "Laporan Portal PUMK",
  /** 26 */ PORTAL_NON_PUMK: "Laporan Portal Non PUMK",
  /** 27 */ DEMOGRAFI_MITRA: "Laporan Demografi Mitra Binaan",
  /** 28 */ PERHITUNGAN_PENYISIHAN: "Laporan Perhitungan Penyisihan",
  /** 29 */ BEBAN_PENYISIHAN: "Laporan Beban Penyisihan",
  /** 30 */ AKRUAL_JASA: "Laporan Akrual Piutang Jasa Administrasi",
  /** 31 */ AUDIT_TRAIL: "Laporan Audit Trail",
} as const;

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface FilterPeriodeLaporan {
  periodeId: string;
  /** null or absent = Semua Cabang, which requires cross-branch scope. */
  cabangId?: string | null;
  /** Default BULANAN. */
  mode?: ModeLaporan;
}

/**
 * Spec 10.1 report 5: "Butuh filter rentang tanggal jatuh tempo ke depan". A
 * due-date window, not a period, because the whole point of the report is what
 * has not happened yet.
 */
export interface FilterJatuhTempo {
  dariTanggal: TanggalIso;
  sampaiTanggal: TanggalIso;
  cabangId?: string | null;
}

/** Report 9 is per partner, and the card is cumulative to the period end. */
export interface FilterKartuPiutang {
  periodeId: string;
  cabangId?: string | null;
  mitraId: string;
}

/**
 * Report 31: "Filter user, tanggal, entitas, aksi." Paged, because an audit
 * log is unbounded by construction and a report that tried to return all of it
 * would be a denial of service against the reader's own browser.
 */
export interface FilterAuditTrail {
  dariTanggal: TanggalIso;
  sampaiTanggal: TanggalIso;
  userId?: string | null;
  entitas?: string | null;
  aksi?: string | null;
  hasil?: HasilAudit | null;
  /** Default 100, capped at `BATAS_AUDIT_TRAIL_MAKS`. */
  batas?: number | null;
  offset?: number | null;
}

export const BATAS_AUDIT_TRAIL_BAWAAN = 100;
export const BATAS_AUDIT_TRAIL_MAKS = 500;

// ---------------------------------------------------------------------------
// 1. Laporan Realisasi Penyaluran berdasarkan Provinsi, Kota, Kabupaten
// ---------------------------------------------------------------------------

/**
 * A FLAT LIST IN TREE ORDER, the same shape report 16 uses, rather than nested
 * children arrays: both the screen and a later export print rows, and a flat
 * list cannot disagree with itself about ordering the way a nested structure
 * plus a sort can. `tipeBaris` says which level a row is.
 *
 * A PARTNER WITH NO `kota_id` IS NOT DROPPED. `mitra.kota_id` is nullable, so
 * this is reachable on real data, and dropping such a disbursement would make
 * the report's own total disagree with reports 2, 3 and 24 by exactly that
 * amount, silently. It lands in a row whose `provinsiId` and `kotaId` are
 * null, named `WILAYAH_TIDAK_DIKETAHUI`, so the total still ties and the gap
 * is visible as a line an operator can act on.
 */
export const WILAYAH_TIDAK_DIKETAHUI = "(Wilayah belum diisi)";

export interface BarisWilayah {
  tipeBaris: "PROVINSI" | "KOTA";
  provinsiId: string | null;
  provinsiNama: string;
  kotaId: string | null;
  kotaNama: string | null;
  /** DISTINCT partners funded in the window. A second tranche to the same
   *  partner is not a second partner (spec 9.3's own rule for report 24). */
  jumlahMitra: number;
  jumlahPenyaluran: Angka;
  /** Share of `total.jumlahPenyaluran`. Null when the total is zero, which is
   *  not "0 percent of nothing" but a question with no answer. */
  persenDariTotal: Persen | null;
}

export interface TotalWilayah {
  jumlahMitra: number;
  jumlahPenyaluran: Angka;
}

export interface LaporanRealisasiWilayah {
  header: HeaderLaporan;
  mode: ModeLaporan;
  dasarWilayah: DasarWilayah;
  /** Province rows in name order, each immediately followed by its cities. */
  baris: BarisWilayah[];
  total: TotalWilayah;
}

// ---------------------------------------------------------------------------
// 2. Laporan Realisasi Penyaluran berdasarkan Sektor
// ---------------------------------------------------------------------------

/**
 * Spec 10.1 report 2 asks for a "versus RKA" column, which is the same
 * comparison report 24 makes for jenis PUMK.
 *
 * THE BUDGET IS A NULLABLE COLUMN, NOT A PRECONDITION. An entity with no
 * approved RKA PUMK for the year still needs its disbursement report; refusing
 * the whole page because nobody approved a budget would be this module
 * deciding that a budget is mandatory, which the specification does not say.
 * `rkaId` is null when no approved baseline was found, every `anggaran` is
 * null with it, and `persenCapaian` is null in both that case and the case of
 * a zero budget line (realisation against a zero budget is not "0 percent" and
 * it is not infinity; it is money spent that nobody budgeted).
 */
export interface BarisSektor {
  sektorId: string | null;
  kode: string;
  nama: string;
  jumlahMitra: number;
  jumlahPenyaluran: Angka;
  persenDariTotal: Persen | null;
  anggaran: Angka | null;
  /** `anggaran - jumlahPenyaluran`. Negative means over budget. Null with it. */
  selisih: Angka | null;
  persenCapaian: Persen | null;
}

export interface TotalSektor {
  jumlahMitra: number;
  jumlahPenyaluran: Angka;
  anggaran: Angka | null;
  selisih: Angka | null;
  persenCapaian: Persen | null;
}

export interface LaporanRealisasiSektor {
  header: HeaderLaporan;
  mode: ModeLaporan;
  /** The approved RKA the `anggaran` column came from, or null. */
  rkaId: string | null;
  rkaVersi: number | null;
  baris: BarisSektor[];
  total: TotalSektor;
}

// ---------------------------------------------------------------------------
// 3. Laporan Penyaluran Nasional (matriks Provinsi x Sektor)
// ---------------------------------------------------------------------------

/**
 * "Provinsi, jumlah mitra dan nilai per sektor (matriks), total".
 *
 * DENSE, NOT SPARSE. Every province row carries a cell for every sector
 * column, including the zero ones, because spec 10's zero rule exists so the
 * accounting team can cross-check by eye and a missing cell is not a zero, it
 * is a hole. `kolom` is the column order; `baris[i].sel[j]` lines up with
 * `kolom[j]` by index, which is what makes the matrix printable without a
 * lookup per cell.
 */
export interface SelMatriks {
  jumlahMitra: number;
  nilai: Angka;
}

export interface KolomMatriks {
  sektorId: string | null;
  kode: string;
  nama: string;
}

export interface BarisMatriks {
  provinsiId: string | null;
  provinsiNama: string;
  sel: SelMatriks[];
  total: SelMatriks;
}

export interface LaporanPenyaluranNasional {
  header: HeaderLaporan;
  mode: ModeLaporan;
  dasarWilayah: DasarWilayah;
  kolom: KolomMatriks[];
  baris: BarisMatriks[];
  /** Column footings, index-aligned with `kolom`. */
  totalKolom: SelMatriks[];
  totalKeseluruhan: SelMatriks;
}

// ---------------------------------------------------------------------------
// 4. Laporan Penerimaan Angsuran
// ---------------------------------------------------------------------------

/**
 * "Tanggal, Kode Mitra, Nama, No Akad, Pokok, Jasa Adm, Total, No Bukti".
 *
 * `kelebihan` IS A COLUMN THE SPEC DOES NOT LIST, AND IT HAS TO BE.
 * `pumk_angsuran_alokasi_ck` makes `jumlah_diterima = alokasi_pokok +
 * alokasi_jasa + alokasi_kelebihan` a database-enforced identity. Printing
 * "Total" as `jumlah_diterima` next to only Pokok and Jasa would produce rows
 * that visibly do not add up on exactly the case spec 16 scenario 6 asks to be
 * demonstrated (an overpayment), so the third component prints.
 */
export interface BarisPenerimaanAngsuran {
  angsuranId: string;
  tanggalTerima: TanggalIso;
  tanggalValuta: TanggalIso | null;
  mitraId: string;
  kodeMitra: string;
  namaMitra: string;
  akadId: string;
  noAkad: string;
  pokok: Angka;
  jasaAdm: Angka;
  kelebihan: Angka;
  /** `= pokok + jasaAdm + kelebihan`, enforced by the table's own CHECK. */
  total: Angka;
  noBukti: string | null;
  /** Drill-down, spec 11: an amount whose origin cannot be traced is not
   *  trusted. Null only for a receipt whose journal has not been posted. */
  jurnalId: string | null;
  cabangId: string;
}

export interface TotalPenerimaanAngsuran {
  jumlahSetoran: number;
  pokok: Angka;
  jasaAdm: Angka;
  kelebihan: Angka;
  total: Angka;
}

export interface LaporanPenerimaanAngsuran {
  header: HeaderLaporan;
  mode: ModeLaporan;
  /** Ordered (tanggal_terima, no_akad, id): stable and reproducible. */
  baris: BarisPenerimaanAngsuran[];
  total: TotalPenerimaanAngsuran;
}

// ---------------------------------------------------------------------------
// 5. Laporan Jatuh Tempo
// ---------------------------------------------------------------------------

/**
 * "Angsuran ke, Tanggal Jatuh Tempo, Pokok, Jasa, Total, Hari sampai jatuh
 * tempo", over a forward due-date window.
 *
 * THE ACTIVE SCHEDULE VERSION ONLY (`pumk_jadwal_angsuran.is_active_version`),
 * because a rescheduled akad has a superseded version whose rows are history
 * (invariant 8). Listing both would double every instalment of every
 * rescheduled loan in a collections worksheet.
 *
 * ROWS ALREADY SETTLED ARE EXCLUDED (`status` LUNAS or DIRESCHEDULE). The
 * amounts printed are what is STILL OWED on the instalment (`pokok -
 * pokok_terbayar`), not the original instalment, so a partially paid row
 * shows the collectable remainder.
 *
 * `hariSampaiJatuhTempo` is counted from `header.tanggalCetak`, the injected
 * clock, so a printed page is reproducible in a test rather than carrying
 * whatever today happens to be. Negative means already overdue, which a
 * forward window can legitimately contain when it starts in the past.
 */
export interface BarisJatuhTempo {
  jadwalId: string;
  mitraId: string;
  kodeMitra: string;
  namaMitra: string;
  akadId: string;
  noAkad: string;
  angsuranKe: number;
  tanggalJatuhTempo: TanggalIso;
  status: StatusJadwal;
  pokok: Angka;
  jasaAdm: Angka;
  total: Angka;
  hariSampaiJatuhTempo: number;
  cabangId: string;
}

export interface LaporanJatuhTempo {
  header: HeaderLaporan;
  /** The date `hariSampaiJatuhTempo` is counted from. */
  tanggalAcuan: TanggalIso;
  /** Ordered by (tanggal_jatuh_tempo, no_akad, angsuran_ke). */
  baris: BarisJatuhTempo[];
  total: { jumlahAngsuran: number; pokok: Angka; jasaAdm: Angka; total: Angka };
}

// ---------------------------------------------------------------------------
// 6. Rekap Permohonan PUMK
// ---------------------------------------------------------------------------

/**
 * "Status, Jumlah Proposal, Nilai Diajukan, Nilai Disetujui, rasio
 * persetujuan", grouped by "Status dan Sektor" -- which is TWO groupings of
 * one population, not one grouping on a composite key. Both are returned, both
 * foot to the same total, and a test asserts that they do: two groupings that
 * disagree about the population are the failure this shape exists to make
 * visible.
 *
 * NILAI DISETUJUI COMES FROM `pumk_approval`, not from the proposal, because
 * `pumk_proposal` has no approved-amount column: spec 16 scenario 3 requires
 * the approver to change the plafond, and the changed figure lives on the
 * approval row (`plafon_disetujui`, mandatory when `keputusan = 'SETUJU'`).
 * A proposal with several approval rows takes the LATEST SETUJU by
 * `(tanggal, created_at)`.
 */
export interface BarisRekapPermohonan {
  kunci: string;
  nama: string;
  jumlahProposal: number;
  jumlahDisetujui: number;
  nilaiDiajukan: Angka;
  nilaiDisetujui: Angka;
  /** `nilaiDisetujui / nilaiDiajukan * 100`. Null when nothing was applied for. */
  rasioPersetujuan: Persen | null;
}

export interface LaporanRekapPermohonan {
  header: HeaderLaporan;
  mode: ModeLaporan;
  perStatus: BarisRekapPermohonan[];
  perSektor: BarisRekapPermohonan[];
  total: Omit<BarisRekapPermohonan, "kunci" | "nama">;
}

// ---------------------------------------------------------------------------
// 7. Rekap Realisasi PUMK
// ---------------------------------------------------------------------------

/**
 * "Bulan, Jumlah Akad, Nilai Akad, Nilai Dicairkan, Jumlah Mitra Baru versus
 * Lama", one row per month.
 *
 * ALWAYS THE WHOLE FINANCIAL YEAR TO THE REPORTED MONTH, so `mode` is not a
 * parameter here: a table whose first column is "Bulan" and which contains one
 * month is not the report spec 10.1 describes. The footing is therefore the
 * year-to-date figure, and it equals reports 1, 2 and 3 run in KUMULATIF_YTD
 * for the same month, which the tests assert.
 *
 * MITRA BARU VERSUS LAMA IS COMPUTED, NOT READ. `mitra.is_mitra_lama` means
 * "migrated from the legacy system", which is a different question. A partner
 * counts as BARU in the month their FIRST akad (`min(tanggal_akad)` across
 * every non-deleted akad they hold, unbounded by the report window) falls, and
 * LAMA in any later month they take one. The two are disjoint and sum to the
 * distinct partners contracting in the month.
 */
export interface BarisRekapRealisasi {
  tahun: number;
  bulan: number;
  label: string;
  jumlahAkad: number;
  nilaiAkad: Angka;
  nilaiDicairkan: Angka;
  mitraBaru: number;
  mitraLama: number;
}

export interface LaporanRekapRealisasi {
  header: HeaderLaporan;
  baris: BarisRekapRealisasi[];
  total: {
    jumlahAkad: number;
    nilaiAkad: Angka;
    nilaiDicairkan: Angka;
    mitraBaru: number;
    mitraLama: number;
  };
}

// ---------------------------------------------------------------------------
// 8. Laporan Aging Piutang
// ---------------------------------------------------------------------------

/**
 * The five buckets spec 10.1 report 8 names, in its own order. Compiled in
 * BECAUSE THE SPECIFICATION FIXES THEM: unlike the kolektibilitas ladder
 * (`kolektibilitas_range`, configurable per client), these bands are part of
 * the report definition. `hariMaks` null is the open-ended top bucket.
 */
export const BUCKET_AGING = [
  { kode: "B_0_30", nama: "0 - 30 hari", hariMin: 0, hariMaks: 30 },
  { kode: "B_31_90", nama: "31 - 90 hari", hariMin: 31, hariMaks: 90 },
  { kode: "B_91_180", nama: "91 - 180 hari", hariMin: 91, hariMaks: 180 },
  { kode: "B_181_270", nama: "181 - 270 hari", hariMin: 181, hariMaks: 270 },
  { kode: "B_270_PLUS", nama: "Di atas 270 hari", hariMin: 271, hariMaks: null },
] as const;

export type KodeBucketAging = (typeof BUCKET_AGING)[number]["kode"];

/**
 * One partner's outstanding, split across the buckets. Exactly one bucket is
 * non-zero per akad row, because an akad has one `hari_tunggakan`; a partner
 * holding several akads can therefore legitimately show two.
 *
 * `outstanding` IS THE PRINCIPAL (`outstanding_pokok`), not principal plus
 * fee. Spec 10.1 report 8 names one Outstanding column, and the receivable
 * this report ages is the one `v_rekonsiliasi_piutang` reconciles to the
 * general ledger. The fee is carried separately so nothing is hidden.
 */
export interface BarisAging {
  mitraId: string;
  kodeMitra: string;
  namaMitra: string;
  cabangId: string;
  namaCabang: string;
  outstanding: Angka;
  outstandingJasa: Angka;
  bucket: Record<KodeBucketAging, Angka>;
}

export interface RingkasanBucket {
  kode: KodeBucketAging;
  nama: string;
  jumlahMitra: number;
  outstanding: Angka;
  persenDariTotal: Persen | null;
}

export interface LaporanAgingPiutang {
  header: HeaderLaporan;
  /** Per partner, by `kode_mitra`. */
  baris: BarisAging[];
  /** "Bucket dan Cabang": the two groupings spec 10.1 report 8 asks for. */
  perBucket: RingkasanBucket[];
  perCabang: Array<{
    cabangId: string;
    namaCabang: string;
    jumlahMitra: number;
    outstanding: Angka;
    bucket: Record<KodeBucketAging, Angka>;
  }>;
  total: { jumlahMitra: number; outstanding: Angka; outstandingJasa: Angka };
}

// ---------------------------------------------------------------------------
// 9. Kartu Piutang Mitra Binaan
// ---------------------------------------------------------------------------

/**
 * "Jadwal, setoran, saldo berjalan per mitra", and spec 16 scenario 7: "Buka
 * Kartu Piutang mitra tersebut, konfirmasi jadwal, setoran, dan outstanding
 * konsisten."
 *
 * ONE CARD PER AKAD, AND ONE MOVEMENT LIST PER CARD. The two things a card
 * shows are different in kind and are kept apart rather than interleaved into
 * one ambiguous column: `jadwal` is what is OWED and when, `setoran` is what
 * was RECEIVED and when, and `saldoPokokBerjalan` on a receipt row is the
 * principal still outstanding after it.
 *
 * THE CONSISTENCY CLAIM IS A FIELD, NOT A COMMENT. `selisihOutstandingPokok`
 * is `pumk_akad.outstanding_pokok` minus the card's own running balance. It is
 * returned rather than asserted internally because a non-zero value is a real
 * condition an operator must see (`v_rekonsiliasi_piutang` exists for the
 * general-ledger half of the same question), and a report that refused would
 * hide the one thing scenario 7 asks the demo to look at.
 */
export interface BarisJadwalKartu {
  jadwalId: string;
  angsuranKe: number;
  tanggalJatuhTempo: TanggalIso;
  pokok: Angka;
  jasaAdm: Angka;
  total: Angka;
  pokokTerbayar: Angka;
  jasaTerbayar: Angka;
  status: StatusJadwal;
  tanggalLunas: TanggalIso | null;
}

export interface BarisSetoranKartu {
  angsuranId: string;
  tanggalTerima: TanggalIso;
  jumlahDiterima: Angka;
  pokok: Angka;
  jasaAdm: Angka;
  kelebihan: Angka;
  noBukti: string | null;
  jurnalId: string | null;
  /** Principal still outstanding after this receipt, running from the
   *  disbursed principal. */
  saldoPokokBerjalan: Angka;
}

export interface KartuAkad {
  akadId: string;
  noAkad: string;
  tanggalAkad: TanggalIso;
  status: StatusAkad;
  pokokPinjaman: Angka;
  /** Principal actually paid out (`pumk_pencairan`), which is what the card
   *  runs down from; an akad still BELUM_CAIR has none. */
  pokokDicairkan: Angka;
  jadwal: BarisJadwalKartu[];
  setoran: BarisSetoranKartu[];
  totalPokokDibayar: Angka;
  totalJasaDibayar: Angka;
  totalKelebihan: Angka;
  /** From the akad row: the sub-ledger's own answer. */
  outstandingPokokAkad: Angka;
  outstandingJasaAkad: Angka;
  /** Card's own answer: `pokokDicairkan - totalPokokDibayar`. */
  outstandingPokokKartu: Angka;
  /** `outstandingPokokAkad - outstandingPokokKartu`. Zero on healthy data. */
  selisihOutstandingPokok: Angka;
}

export interface LaporanKartuPiutang {
  header: HeaderLaporan;
  mitraId: string;
  kodeMitra: string;
  namaMitra: string;
  cabangId: string;
  /** Every akad of this partner up to the period end, newest contract last. */
  akad: KartuAkad[];
  total: {
    pokokDicairkan: Angka;
    totalPokokDibayar: Angka;
    outstandingPokokAkad: Angka;
    outstandingPokokKartu: Angka;
    selisihOutstandingPokok: Angka;
  };
}

// ---------------------------------------------------------------------------
// 10. Laporan Kolektibilitas
// ---------------------------------------------------------------------------

/**
 * "Klasifikasi, Jumlah Mitra, Outstanding, Nilai Penyisihan, persen", grouped
 * by "Klasifikasi dan Sektor". Read from `kolektibilitas_snapshot`; see
 * reading C in this file's header for why that is not negotiable.
 *
 * THE CLASS ORDER IS `kolektibilitas_kelas.urutan`, which is data, not a
 * constant here: a client that adds a fifth class gets it in the right place
 * without a deploy. Every class in the ladder prints, including the ones with
 * no akad in them, because spec 10's zero rule is what the accounting team
 * cross-checks against.
 */
export interface BarisKolektibilitas {
  klasifikasi: string;
  nama: string;
  urutan: number;
  jumlahMitra: number;
  jumlahAkad: number;
  outstandingPokok: Angka;
  outstandingJasa: Angka;
  nilaiPenyisihan: Angka;
  /** Share of total outstanding principal. */
  persenDariTotal: Persen | null;
}

export interface BarisKolektibilitasSektor {
  sektorId: string | null;
  kode: string;
  nama: string;
  jumlahMitra: number;
  outstandingPokok: Angka;
  nilaiPenyisihan: Angka;
  /** Per class, index-aligned with `LaporanKolektibilitas.baris`. */
  perKlasifikasi: Angka[];
}

export interface LaporanKolektibilitas {
  header: HeaderLaporan;
  baris: BarisKolektibilitas[];
  perSektor: BarisKolektibilitasSektor[];
  total: {
    jumlahMitra: number;
    jumlahAkad: number;
    outstandingPokok: Angka;
    outstandingJasa: Angka;
    nilaiPenyisihan: Angka;
  };
}

// ---------------------------------------------------------------------------
// 11. Laporan Perpindahan Kolektibilitas
// ---------------------------------------------------------------------------

/**
 * "Matriks klasifikasi periode lalu versus periode ini".
 *
 * FROM `kolektibilitas_snapshot.kolektibilitas_periode_lalu`, the column the
 * run itself wrote, NOT from joining this period's snapshot to last period's.
 * The join would silently drop every akad that did not exist last period and
 * would answer differently after a reopen; the column is the run's own record
 * of where each akad came from, which is what makes the matrix reproducible.
 *
 * A null `kolektibilitas_periode_lalu` is a NEW akad, and it gets its own row
 * keyed `BARU`, because "moved from nothing" is a real and interesting
 * movement rather than an absence.
 */
export const KELAS_BARU = "BARU";

export interface SelPerpindahan {
  jumlahAkad: number;
  outstandingPokok: Angka;
}

export interface LaporanPerpindahanKolektibilitas {
  header: HeaderLaporan;
  /** Column order = `kolektibilitas_kelas.urutan` (this period). */
  kolom: Array<{ kode: string; nama: string }>;
  /** Row order = the same, prefixed by `BARU`. */
  baris: Array<{
    kode: string;
    nama: string;
    sel: SelPerpindahan[];
    total: SelPerpindahan;
  }>;
  totalKolom: SelPerpindahan[];
  totalKeseluruhan: SelPerpindahan;
}

// ---------------------------------------------------------------------------
// 12. Laporan Penyaluran Non PUMK
// ---------------------------------------------------------------------------

/**
 * "No Proposal, Pemohon, Bidang, SDG, Nilai Disetujui, Nilai Disalurkan,
 * Tanggal, Status LPJ, Penerima Manfaat".
 *
 * ONE ROW PER DISBURSEMENT (`nonpumk_penyaluran`), not per proposal, because
 * spec 9.2 makes disbursement multi-termin and the "Tanggal" column has no
 * single value for a proposal paid in three instalments. `nilaiDisetujui` and
 * `penerimaManfaat` are the proposal's, repeated on each termin the way a
 * printed statement repeats them, and the report carries the per-proposal
 * rollup separately so nothing has to be de-duplicated by the reader.
 */
export interface BarisPenyaluranNonPumk {
  penyaluranId: string;
  proposalId: string;
  noProposal: string;
  namaPemohon: string;
  bidangId: string;
  bidangKode: string;
  bidangNama: string;
  /** Every SDG the programme is mapped to, in `sdg.nomor` order. */
  sdg: Array<{ sdgId: string; nomor: number; nama: string }>;
  judulProgram: string;
  termin: number;
  tanggalPenyaluran: TanggalIso;
  nilaiDisetujui: Angka;
  nilaiDisalurkan: Angka;
  statusLpj: StatusLpj;
  penerimaManfaat: number | null;
  noBukti: string | null;
  jurnalId: string | null;
  cabangId: string;
}

export interface LaporanPenyaluranNonPumk {
  header: HeaderLaporan;
  mode: ModeLaporan;
  baris: BarisPenyaluranNonPumk[];
  total: {
    jumlahPenyaluran: number;
    jumlahProposal: number;
    nilaiDisalurkan: Angka;
    penerimaManfaat: number;
  };
}

// ---------------------------------------------------------------------------
// 13. Rekap Penyaluran Non PUMK per Bidang
// ---------------------------------------------------------------------------

/** Same "versus RKA" treatment as report 2, on the bidang axis. */
export interface BarisBidang {
  bidangId: string | null;
  kode: string;
  nama: string;
  jumlahProgram: number;
  nilai: Angka;
  persenDariTotal: Persen | null;
  anggaran: Angka | null;
  selisih: Angka | null;
  persenCapaian: Persen | null;
}

export interface LaporanRekapBidang {
  header: HeaderLaporan;
  mode: ModeLaporan;
  rkaId: string | null;
  rkaVersi: number | null;
  baris: BarisBidang[];
  total: {
    jumlahProgram: number;
    nilai: Angka;
    anggaran: Angka | null;
    selisih: Angka | null;
    persenCapaian: Persen | null;
  };
}

// ---------------------------------------------------------------------------
// 14. Laporan Pemetaan SDGs
// ---------------------------------------------------------------------------

/**
 * "SDG nomor dan nama, Jumlah Program, Nilai, Penerima Manfaat".
 *
 * THERE IS NO MONEY COLUMN HERE, AND THAT IS A DECISION TAKEN UPSTREAM RATHER
 * THAN A GAP. ADR 0016, in terms: "Report 14, SDGs, cannot be a journal
 * dimension at all. `nonpumk_proposal_sdg` is many to many, so one
 * disbursement maps to several SDGs and a single `sdgId` on a line would
 * either lose all but one or triple count the amount... Report 14 needs an
 * explicit allocation rule from the client, or it reports counts and
 * beneficiaries rather than money split by SDG", and its consequences say
 * plainly: "Report 14 stays unbuilt as a money report until the client
 * supplies an allocation rule."
 *
 * `nonpumk_proposal_sdg.bobot` EXISTS and would make an apportionment easy to
 * write. It is not used, deliberately: a weight somebody typed into a form is
 * not an accounting allocation basis, and a rupiah figure split by it would be
 * read as one. So this report counts programmes and beneficiaries, and it
 * states the overlap rather than hiding it -- `jumlahProgram` summed across
 * SDGs EXCEEDS `totalProgramUnik` whenever a programme serves more than one
 * goal, which is correct and is exactly why the money column is absent.
 */
export interface BarisSdg {
  sdgId: string | null;
  nomor: number | null;
  nama: string;
  jumlahProgram: number;
  penerimaManfaat: number;
}

export interface LaporanPemetaanSdg {
  header: HeaderLaporan;
  mode: ModeLaporan;
  /** In `sdg.nomor` order, with the unmapped bucket last. */
  baris: BarisSdg[];
  /** DISTINCT programmes behind the rows. Deliberately NOT the sum of
   *  `jumlahProgram`: the buckets overlap. */
  totalProgramUnik: number;
  /** DISTINCT beneficiaries, counted once per programme. Same reasoning. */
  totalPenerimaManfaatUnik: number;
}

/** The bucket for a programme mapped to no SDG at all. */
export const SDG_TIDAK_DIPETAKAN = "(Belum dipetakan ke SDG)";

// ---------------------------------------------------------------------------
// 15. Laporan Monitoring LPJ
// ---------------------------------------------------------------------------

/**
 * "Proposal, Tanggal Salur, Umur (hari), Status LPJ, Selisih realisasi".
 *
 * `umurHari` is counted from the LAST disbursement termin to the LPJ date when
 * one exists, and to `header.tanggalCetak` when it does not: the age of an
 * outstanding obligation is measured to today, the age of a settled one to the
 * day it settled, and using today for both would make a programme that
 * reported on time look worse every day afterwards.
 *
 * `selisihRealisasi` is `nilaiDisalurkan - jumlahRealisasi -
 * jumlahSisaDikembalikan`. `tjsl_nonpumk_cek_lpj` makes that zero for every
 * verified LPJ, so a non-zero value on a row with an LPJ is a defect the
 * report SHOWS rather than refuses on; on a row with no LPJ it is the whole
 * disbursed amount, which is the point of the report.
 */
export interface BarisMonitoringLpj {
  proposalId: string;
  noProposal: string;
  namaPemohon: string;
  judulProgram: string;
  bidangNama: string;
  tanggalSalurTerakhir: TanggalIso | null;
  nilaiDisalurkan: Angka;
  statusLpj: StatusLpj;
  tanggalLpj: TanggalIso | null;
  jumlahRealisasi: Angka;
  jumlahSisaDikembalikan: Angka;
  selisihRealisasi: Angka;
  umurHari: number | null;
  penerimaManfaatEstimasi: number | null;
  penerimaManfaatAktual: number | null;
  cabangId: string;
}

export interface LaporanMonitoringLpj {
  header: HeaderLaporan;
  mode: ModeLaporan;
  /** Oldest obligation first, so the worklist reads top down. */
  baris: BarisMonitoringLpj[];
  perStatus: Array<{ status: StatusLpj; jumlah: number; nilaiDisalurkan: Angka }>;
  total: {
    jumlahProposal: number;
    nilaiDisalurkan: Angka;
    jumlahRealisasi: Angka;
    selisihRealisasi: Angka;
  };
}

// ---------------------------------------------------------------------------
// 21. Rekap Jurnal
// ---------------------------------------------------------------------------

/**
 * "Per jenis jurnal per periode: jumlah dokumen, total debit, total kredit,
 * status".
 *
 * ONE ROW PER (jenis, status), INCLUDING DRAFT AND VOID. A recap that showed
 * only posted entries would be unable to answer the question closing check 1
 * exists for ("is there a DRAFT left in this month"), which is the main
 * operational use of this page.
 *
 * THE WINDOW IS `tanggal_transaksi`, NOT `periode_id`. Every other report in
 * this module cuts on the transaction date, and the two must agree or report
 * 21's posted footing would stop matching report 23's Mutasi columns, which is
 * the cross-check the tests assert.
 */
export interface BarisRekapJurnal {
  jenis: string;
  status: string;
  jumlahDokumen: number;
  totalDebit: Angka;
  totalKredit: Angka;
}

export interface LaporanRekapJurnal {
  header: HeaderLaporan;
  mode: ModeLaporan;
  baris: BarisRekapJurnal[];
  /** Rolled up per `jenis`, across every status. */
  perJenis: Array<{ jenis: string; jumlahDokumen: number; totalDebit: Angka; totalKredit: Angka }>;
  /**
   * The subtotal over the statuses the LEDGER consists of, POSTED and
   * REVERSED (ADR 0010). This is the figure that must equal Neraca Lajur's
   * Mutasi columns for the same window, and it is carried explicitly so that
   * identity is a field comparison rather than arithmetic the caller performs.
   */
  totalTerbukukan: { jumlahDokumen: number; totalDebit: Angka; totalKredit: Angka };
  total: { jumlahDokumen: number; totalDebit: Angka; totalKredit: Angka };
}

// ---------------------------------------------------------------------------
// 25 and 26. Laporan Portal PUMK / Non PUMK
// ---------------------------------------------------------------------------

/**
 * "Submission online: nomor tiket, tanggal, pemohon, nilai diajukan, status,
 * apakah sudah dikonversi".
 *
 * BRANCH SCOPE ON A TABLE THAT HAS NO BRANCH. `portal_submission` is keyed by
 * `bumn_id` and nothing else: a submission arrives before anybody decides
 * which branch will handle it. So the rule is: a CONVERTED submission belongs
 * to the branch of the proposal it became, and an UNCONVERTED one belongs to
 * no branch and is therefore visible only to a caller asking for Semua Cabang.
 * Stated here because the alternative -- showing every branch user every
 * unconverted submission -- is the thing spec 16 scenario 24 is about, and the
 * other alternative, hiding them from everybody, would make the report useless
 * for its one job.
 *
 * `nilaiDiajukan` PREFERS THE CONVERTED PROPOSAL over `data_json`.
 * `portal_submission.data_json` is the form exactly as submitted and is never
 * trusted (migrations/0013 says so on the column); it is read only when there
 * is no proposal yet, it is accepted only if it parses as a two-decimal
 * amount, and it is null otherwise rather than zero. Zero would print as a
 * real application for nothing.
 */
export interface BarisPortal {
  submissionId: string;
  noTiket: string;
  tanggalSubmit: TanggalIso;
  pemohon: string;
  nilaiDiajukan: Angka | null;
  /** Which of the two sources answered `nilaiDiajukan`. */
  sumberNilai: "PROPOSAL" | "DATA_JSON" | "TIDAK_ADA";
  status: StatusPortal;
  sudahDikonversi: boolean;
  proposalId: string | null;
  noProposal: string | null;
  cabangId: string | null;
}

export interface LaporanPortal {
  header: HeaderLaporan;
  jenis: "PUMK" | "NON_PUMK";
  mode: ModeLaporan;
  baris: BarisPortal[];
  perStatus: Array<{ status: StatusPortal; jumlah: number }>;
  total: { jumlahSubmission: number; jumlahDikonversi: number; nilaiDiajukan: Angka };
}

// ---------------------------------------------------------------------------
// 27. Laporan Demografi Mitra Binaan
// ---------------------------------------------------------------------------

/**
 * "Distribusi berdasarkan jenis kelamin, kelompok usia, sektor, wilayah, lama
 * usaha, jumlah tenaga kerja, kelompok omzet. Ini laporan analitik, bukan
 * keuangan."
 *
 * THE POPULATION IS "MITRA BINAAN", AND THAT IS A DECISION. It is every
 * partner holding at least one non-deleted `pumk_akad` dated on or before the
 * period end, scoped by that akad's branch. Not every `mitra` row: a CALON who
 * was never funded is an applicant, not a partner, and counting them would
 * make the demographic profile of the portfolio a profile of the pipeline.
 * `jumlahMitra` is stated on the report so the reader knows what the
 * percentages are of.
 *
 * EVERY DISTRIBUTION FOOTS TO THE SAME `jumlahMitra`, including the "belum
 * diisi" bucket each one carries. That is the report's own integrity check and
 * the tests assert it on all seven: a distribution that quietly dropped the
 * rows with a null column would show a different population per chart, and
 * nothing on the page would say so.
 */
export interface EmberDemografi {
  kode: string;
  nama: string;
  jumlah: number;
  persen: Persen | null;
}

export interface DistribusiDemografi {
  dimensi: string;
  nama: string;
  ember: EmberDemografi[];
}

export interface LaporanDemografiMitra {
  header: HeaderLaporan;
  dasarWilayah: DasarWilayah;
  jumlahMitra: number;
  /** Seven distributions, in the order spec 10.4 report 27 lists them. */
  distribusi: DistribusiDemografi[];
}

/** The age bands, in years, at the period end. `maks` null is open-ended. */
export const KELOMPOK_USIA = [
  { kode: "U_LT_25", nama: "Di bawah 25 tahun", min: 0, maks: 24 },
  { kode: "U_25_34", nama: "25 - 34 tahun", min: 25, maks: 34 },
  { kode: "U_35_44", nama: "35 - 44 tahun", min: 35, maks: 44 },
  { kode: "U_45_54", nama: "45 - 54 tahun", min: 45, maks: 54 },
  { kode: "U_55_PLUS", nama: "55 tahun ke atas", min: 55, maks: null },
] as const;

/** Years in business at the period end, from `mitra.tahun_mulai_usaha`. */
export const KELOMPOK_LAMA_USAHA = [
  { kode: "L_LT_2", nama: "Kurang dari 2 tahun", min: 0, maks: 1 },
  { kode: "L_2_5", nama: "2 - 5 tahun", min: 2, maks: 5 },
  { kode: "L_6_10", nama: "6 - 10 tahun", min: 6, maks: 10 },
  { kode: "L_GT_10", nama: "Lebih dari 10 tahun", min: 11, maks: null },
] as const;

export const KELOMPOK_TENAGA_KERJA = [
  { kode: "T_0", nama: "Tanpa tenaga kerja", min: 0, maks: 0 },
  { kode: "T_1_4", nama: "1 - 4 orang", min: 1, maks: 4 },
  { kode: "T_5_19", nama: "5 - 19 orang", min: 5, maks: 19 },
  { kode: "T_20_PLUS", nama: "20 orang atau lebih", min: 20, maks: null },
] as const;

/**
 * Monthly turnover bands in whole rupiah. Compiled in like the aging buckets
 * and for the same reason: they are part of this report's definition, not a
 * client parameter, and no `konfigurasi` key exists for them. If a client
 * needs different bands that is a configuration table, filed rather than
 * guessed at here.
 */
export const KELOMPOK_OMZET = [
  { kode: "O_LT_10JT", nama: "Di bawah 10 juta", min: 0, maks: 9_999_999 },
  { kode: "O_10_50JT", nama: "10 - 50 juta", min: 10_000_000, maks: 50_000_000 },
  { kode: "O_50_200JT", nama: "50 - 200 juta", min: 50_000_001, maks: 200_000_000 },
  { kode: "O_GT_200JT", nama: "Di atas 200 juta", min: 200_000_001, maks: null },
] as const;

/** Every distribution carries this bucket for rows whose column is null. */
export const EMBER_KOSONG = { kode: "BELUM_DIISI", nama: "Belum diisi" } as const;

// ---------------------------------------------------------------------------
// 28. Laporan Perhitungan Penyisihan
// ---------------------------------------------------------------------------

/**
 * "Per akad: outstanding, hari tunggakan, klasifikasi, rate, nilai penyisihan.
 * Total per klasifikasi. Harus bisa merekonstruksi angka jurnal penyisihan
 * periode itu persis."
 *
 * THE LAST SENTENCE IS THE REPORT. `total.nilaiPenyisihan` must equal
 * `penyisihan_periode.penyisihan_dibutuhkan` for the same period and branch
 * scope, which is report 29's `penyisihanDibutuhkan`, which is the closing
 * balance the provision journal drove the ledger to. `selisihTerhadapRun` is
 * that comparison, carried as a field, and a non-zero value means the snapshot
 * and the run disagree -- which is a finding, not a rounding artefact.
 *
 * `sumberRate` and the two `rateHistori` dates come from the snapshot row
 * (migrations/0024, ADR 0014): a provision computed against a rate that has
 * since been edited must still be able to say which rate produced it.
 */
export interface BarisPerhitunganPenyisihan {
  akadId: string;
  noAkad: string;
  mitraId: string;
  kodeMitra: string;
  namaMitra: string;
  sektorNama: string | null;
  cabangId: string;
  outstandingPokok: Angka;
  outstandingJasa: Angka;
  tunggakanPokok: Angka;
  tunggakanJasa: Angka;
  hariTunggakan: number;
  klasifikasi: string;
  /** Percent, from `kolektibilitas_snapshot.rate_penyisihan`. */
  ratePenyisihan: Persen;
  dasarPerhitungan: string;
  sumberRate: string | null;
  rateHistoriDari: TanggalIso | null;
  rateHistoriSampai: TanggalIso | null;
  nilaiPenyisihan: Angka;
}

export interface LaporanPerhitunganPenyisihan {
  header: HeaderLaporan;
  baris: BarisPerhitunganPenyisihan[];
  perKlasifikasi: Array<{
    klasifikasi: string;
    nama: string;
    urutan: number;
    jumlahAkad: number;
    outstandingPokok: Angka;
    nilaiPenyisihan: Angka;
  }>;
  total: { jumlahAkad: number; outstandingPokok: Angka; nilaiPenyisihan: Angka };
  /** The run this total is checked against, when one exists. */
  penyisihanDibutuhkanRun: Angka | null;
  selisihTerhadapRun: Angka | null;
}

// ---------------------------------------------------------------------------
// 29. Laporan Beban Penyisihan
// ---------------------------------------------------------------------------

/**
 * "Per periode: saldo penyisihan awal, kebutuhan penyisihan, beban atau
 * pemulihan periode, saldo akhir, dengan tautan ke jurnal".
 *
 * THE LINKS ARE A LIST, NOT A COLUMN. ADR 0015: a corrected re-run posts a
 * SECOND journal for the delta, so `penyisihan_periode_jurnal` is the record
 * and the dropped singular `jurnal_id` was the ambiguity. `jurnal` below is
 * that set, and `sum(nilai)` over it equals `bebanPeriode` because a deferred
 * constraint trigger refuses the transaction otherwise -- which makes the
 * "tautan ke jurnal" spec 10.4 asks for an assertion the database already
 * carries rather than a hyperlink.
 *
 * `saldoAkhir` is `saldoAwal + bebanPeriode` and must equal
 * `penyisihanDibutuhkan`; the run's own arithmetic. A negative `bebanPeriode`
 * is a RECOVERY, and it prints in parentheses like any other credit.
 */
export interface BarisBebanPenyisihan {
  periodeId: string;
  tahun: number;
  bulan: number;
  label: string;
  statusPeriode: StatusPeriode;
  cabangId: string;
  namaCabang: string;
  tanggalJalan: TanggalIso;
  saldoAwal: Angka;
  penyisihanDibutuhkan: Angka;
  bebanPeriode: Angka;
  saldoAkhir: Angka;
  jurnal: Array<{ jurnalId: string; noJurnal: string; tanggal: TanggalIso; nilai: Angka }>;
  /** `bebanPeriode - sum(jurnal.nilai)`. Zero, or the database is broken. */
  selisihTautanJurnal: Angka;
}

export interface LaporanBebanPenyisihan {
  header: HeaderLaporan;
  mode: ModeLaporan;
  baris: BarisBebanPenyisihan[];
  total: { saldoAwal: Angka; bebanPeriode: Angka; saldoAkhir: Angka };
}

// ---------------------------------------------------------------------------
// 30. Laporan Akrual Piutang Jasa Administrasi
// ---------------------------------------------------------------------------

/**
 * "Per akad: jasa administrasi jatuh tempo, sudah diterima, akrual
 * outstanding".
 *
 * `metode` AND `kelasDiakrual` ARE ON EVERY ROW, from migrations/0025. ADR
 * 0015: `akuntansi.metode_pengakuan_jasa_adm` and
 * `akuntansi.akrual_hanya_untuk_kolektibilitas` are mutated in place, so
 * without the per-row copy a closed period could not say why its population
 * was its population. The report prints them because that is the whole reason
 * the columns exist.
 *
 * A ROW WITH ZERO FEE DUE IS STILL A ROW. The accrual writes one per akad in
 * the configured classes including the zero ones, because with no run header a
 * period where the step ran and produced nothing was indistinguishable from a
 * period where it never ran. Filtering them out here would throw that away
 * again.
 */
export interface BarisAkrualJasa {
  akadId: string;
  noAkad: string;
  mitraId: string;
  kodeMitra: string;
  namaMitra: string;
  cabangId: string;
  kolektibilitas: string;
  jasaJatuhTempoPeriode: Angka;
  jasaDiterimaPeriode: Angka;
  jasaDiakrual: Angka;
  metode: string;
  kelasDiakrual: string[];
  jurnalId: string | null;
}

export interface LaporanAkrualJasa {
  header: HeaderLaporan;
  baris: BarisAkrualJasa[];
  total: { jumlahAkad: number; jatuhTempo: Angka; diterima: Angka; diakrual: Angka };
  /** The methods present in this period's rows. More than one is a finding. */
  metode: string[];
}

// ---------------------------------------------------------------------------
// 31. Laporan Audit Trail
// ---------------------------------------------------------------------------

/**
 * "Filter user, tanggal, entitas, aksi. Read only, tidak bisa dihapus siapa
 * pun."
 *
 * `audit_log` HAS NEITHER `bumn_id` NOR `cabang_id`, and both absences are
 * handled here rather than wished away:
 *
 *   THE ENTITY. Rows are restricted to actors belonging to this entity
 *   (`app_user -> cabang.bumn_id`). A row with a NULL `user_id` -- an
 *   unauthenticated refusal, a system action -- belongs to no entity and is
 *   therefore EXCLUDED. Excluding is the conservative direction: including
 *   would show one client's failed-login noise to another.
 *
 *   THE BRANCH. There is no branch on a log row and the actor's branch is not
 *   the branch of the row they touched, so a branch-scoped audit trail cannot
 *   be constructed honestly. This report therefore requires the SAME scope
 *   Semua Cabang requires and REFUSES anything narrower, rather than filtering
 *   by the actor's home branch and calling the result "Cabang A's audit
 *   trail", which would be a wrong answer presented as a right one.
 *
 * "Tidak bisa dihapus siapa pun" is enforced by
 * `trg_audit_log_90_append_only`, a BEFORE UPDATE OR DELETE trigger that
 * raises. This report reads; nothing in this module can write.
 */
export interface BarisAuditTrail {
  id: string;
  waktu: string;
  userId: string | null;
  namaUser: string | null;
  ip: string | null;
  aksi: string;
  entitas: string;
  entitasId: string | null;
  hasil: HasilAudit;
  keterangan: string | null;
}

export interface LaporanAuditTrail {
  header: HeaderLaporan;
  baris: BarisAuditTrail[];
  /** Matching rows BEFORE paging, so a screen can say "1-100 of 4.312". */
  jumlahTotal: number;
  batas: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * ONE ENGINE, NOT THREE, even though the implementation is split across
 * ./service-pumk.ts, ./service-nonpumk.ts and ./service-lainnya.ts. The split
 * is for readers of the code; a split at the boundary would make the
 * composition root wire three things and would let three copies of the branch
 * check drift apart.
 *
 * EVERY METHOD IS A READ. This engine, like `LaporanEngine`, is constructed
 * with a database and a clock and NOTHING ELSE: there is no journal port and
 * no audit port in this module, so spec 16 scenario 23 ("Auditor opens every
 * report and no control changes data") is a property of the module rather than
 * a promise about the screens.
 */
export interface LaporanOperasionalEngine {
  /** 1 */ realisasiWilayah(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRealisasiWilayah>;
  /** 2 */ realisasiSektor(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRealisasiSektor>;
  /** 3 */ penyaluranNasional(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPenyaluranNasional>;
  /** 4 */ penerimaanAngsuran(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPenerimaanAngsuran>;
  /** 5 */ jatuhTempo(
    filter: FilterJatuhTempo,
    ctx: LaporanContext,
  ): Promise<LaporanJatuhTempo>;
  /** 6 */ rekapPermohonanPumk(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRekapPermohonan>;
  /** 7 */ rekapRealisasiPumk(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRekapRealisasi>;
  /** 8 */ agingPiutang(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanAgingPiutang>;
  /** 9 */ kartuPiutang(
    filter: FilterKartuPiutang,
    ctx: LaporanContext,
  ): Promise<LaporanKartuPiutang>;
  /** 10 */ kolektibilitas(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanKolektibilitas>;
  /** 11 */ perpindahanKolektibilitas(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPerpindahanKolektibilitas>;
  /** 12 */ penyaluranNonPumk(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPenyaluranNonPumk>;
  /** 13 */ rekapBidang(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRekapBidang>;
  /** 14 */ pemetaanSdg(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPemetaanSdg>;
  /** 15 */ monitoringLpj(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanMonitoringLpj>;
  /** 21 */ rekapJurnal(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanRekapJurnal>;
  /** 25, 26 */ portal(
    filter: FilterPeriodeLaporan & { jenis: "PUMK" | "NON_PUMK" },
    ctx: LaporanContext,
  ): Promise<LaporanPortal>;
  /** 27 */ demografiMitra(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanDemografiMitra>;
  /** 28 */ perhitunganPenyisihan(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanPerhitunganPenyisihan>;
  /** 29 */ bebanPenyisihan(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanBebanPenyisihan>;
  /** 30 */ akrualJasa(
    filter: FilterPeriodeLaporan,
    ctx: LaporanContext,
  ): Promise<LaporanAkrualJasa>;
  /** 31 */ auditTrail(
    filter: FilterAuditTrail,
    ctx: LaporanContext,
  ): Promise<LaporanAuditTrail>;
}

/** Re-exported so a consumer needs one import for a report and its money. */
export type { Angka, HeaderLaporan, KlasifikasiArusKas, TanggalIso, Uang };
