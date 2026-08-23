// The report catalog, spec section 10, all 31 reports.
//
// This is the single inventory the Laporan module is built from: the catalog
// pages list from it, the router builds a route per entry from it, and Fase 6
// will hang the real query behind each `slug` without moving anything.
//
// Every entry carries the spec's own column list, so the placeholder page can
// state exactly which columns the report will have instead of an empty promise.

export type ReportGroupId = "pumk" | "nonpumk" | "akuntansi" | "lainnya";

export interface ReportGroup {
  id: ReportGroupId;
  /** Nav and page label. */
  label: string;
  /** Route of the catalog page for this group. */
  path: string;
  description: string;
}

export interface ReportMeta {
  /** Catalog number from spec section 10. Kept so a reviewer can cross check. */
  no: number;
  group: ReportGroupId;
  slug: string;
  nama: string;
  /** Key columns, taken verbatim from the spec. */
  kolomKunci: string;
  /** Grouping or format note from the spec. */
  pengelompokan: string;
}

export const REPORT_GROUPS: readonly ReportGroup[] = [
  {
    id: "pumk",
    label: "Laporan Pendanaan UMK",
    path: "/laporan/pendanaan-umk",
    description:
      "Sebelas laporan penyaluran, angsuran, dan kualitas piutang Mitra Binaan.",
  },
  {
    id: "nonpumk",
    label: "Laporan Non PUMK",
    path: "/laporan/non-pumk",
    description: "Empat laporan penyaluran hibah, pemetaan SDG, dan monitoring LPJ.",
  },
  {
    id: "akuntansi",
    label: "Laporan Akuntansi",
    path: "/laporan/akuntansi",
    description:
      "Sembilan laporan keuangan entitas nirlaba, dari Bagan Akun sampai RKA versus Realisasi.",
  },
  {
    id: "lainnya",
    label: "Laporan Lainnya",
    path: "/laporan/lainnya",
    description: "Tujuh laporan portal, demografi, penyisihan, akrual, dan audit trail.",
  },
];

export const REPORTS: readonly ReportMeta[] = [
  {
    no: 1,
    group: "pumk",
    slug: "realisasi-penyaluran-wilayah",
    nama: "Laporan Realisasi Penyaluran berdasarkan Provinsi, Kota, Kabupaten",
    kolomKunci: "Provinsi, Kota, Jumlah Mitra, Jumlah Penyaluran, persen dari total",
    pengelompokan: "Provinsi lalu Kota",
  },
  {
    no: 2,
    group: "pumk",
    slug: "realisasi-penyaluran-sektor",
    nama: "Laporan Realisasi Penyaluran berdasarkan Sektor",
    kolomKunci: "Sektor, Jumlah Mitra, Jumlah Penyaluran, persen dari total, versus RKA",
    pengelompokan: "Sektor",
  },
  {
    no: 3,
    group: "pumk",
    slug: "penyaluran-nasional",
    nama: "Laporan Penyaluran Nasional",
    kolomKunci: "Provinsi, jumlah mitra dan nilai per sektor, total",
    pengelompokan: "Matriks Provinsi kali Sektor",
  },
  {
    no: 4,
    group: "pumk",
    slug: "penerimaan-angsuran",
    nama: "Laporan Penerimaan Angsuran",
    kolomKunci:
      "Tanggal, Kode Mitra, Nama, No Akad, Pokok, Jasa Administrasi, Total, No Bukti",
    pengelompokan: "Tanggal atau Mitra",
  },
  {
    no: 5,
    group: "pumk",
    slug: "jatuh-tempo",
    nama: "Laporan Jatuh Tempo",
    kolomKunci:
      "Kode Mitra, Nama, No Akad, Angsuran ke, Tanggal Jatuh Tempo, Pokok, Jasa, Total, Hari sampai jatuh tempo",
    pengelompokan: "Tanggal jatuh tempo, dengan filter rentang ke depan",
  },
  {
    no: 6,
    group: "pumk",
    slug: "rekap-permohonan-pumk",
    nama: "Rekap Permohonan PUMK",
    kolomKunci: "Status, Jumlah Proposal, Nilai Diajukan, Nilai Disetujui, rasio persetujuan",
    pengelompokan: "Status dan Sektor",
  },
  {
    no: 7,
    group: "pumk",
    slug: "rekap-realisasi-pumk",
    nama: "Rekap Realisasi PUMK",
    kolomKunci:
      "Bulan, Jumlah Akad, Nilai Akad, Nilai Dicairkan, Jumlah Mitra Baru versus Lama",
    pengelompokan: "Bulan",
  },
  {
    no: 8,
    group: "pumk",
    slug: "aging-piutang",
    nama: "Laporan Aging Piutang",
    kolomKunci:
      "Kode Mitra, Nama, Outstanding, bucket 0 sampai 30, 31 sampai 90, 91 sampai 180, 181 sampai 270, di atas 270",
    pengelompokan: "Bucket dan Cabang",
  },
  {
    no: 9,
    group: "pumk",
    slug: "kartu-piutang-mitra",
    nama: "Kartu Piutang Mitra Binaan",
    kolomKunci: "Jadwal, setoran, saldo berjalan per mitra",
    pengelompokan: "Per Mitra",
  },
  {
    no: 10,
    group: "pumk",
    slug: "kolektibilitas",
    nama: "Laporan Kolektibilitas",
    kolomKunci: "Klasifikasi, Jumlah Mitra, Outstanding, Nilai Penyisihan, persen",
    pengelompokan: "Klasifikasi dan Sektor",
  },
  {
    no: 11,
    group: "pumk",
    slug: "perpindahan-kolektibilitas",
    nama: "Laporan Perpindahan Kolektibilitas",
    kolomKunci: "Matriks klasifikasi periode lalu versus periode ini",
    pengelompokan: "Matriks",
  },

  {
    no: 12,
    group: "nonpumk",
    slug: "penyaluran-non-pumk",
    nama: "Laporan Penyaluran Non PUMK",
    kolomKunci:
      "No Proposal, Pemohon, Bidang, SDG, Nilai Disetujui, Nilai Disalurkan, Tanggal, Status LPJ, Penerima Manfaat",
    pengelompokan: "Bidang dan Tanggal",
  },
  {
    no: 13,
    group: "nonpumk",
    slug: "rekap-penyaluran-bidang",
    nama: "Rekap Penyaluran Non PUMK per Bidang",
    kolomKunci: "Bidang, Jumlah Program, Nilai, persen dari total, versus RKA",
    pengelompokan: "Bidang",
  },
  {
    no: 14,
    group: "nonpumk",
    slug: "pemetaan-sdgs",
    nama: "Laporan Pemetaan SDGs",
    kolomKunci: "SDG nomor dan nama, Jumlah Program, Nilai, Penerima Manfaat",
    pengelompokan: "SDG",
  },
  {
    no: 15,
    group: "nonpumk",
    slug: "monitoring-lpj",
    nama: "Laporan Monitoring LPJ",
    kolomKunci: "Proposal, Tanggal Salur, Umur hari, Status LPJ, Selisih realisasi",
    pengelompokan: "Aging 30, 60, 90 hari",
  },

  {
    no: 16,
    group: "akuntansi",
    slug: "bagan-akun",
    nama: "Bagan Akun",
    kolomKunci: "Kode, Nama, Tipe, Saldo Normal, Status",
    pengelompokan: "Tree hierarki COA",
  },
  {
    no: 17,
    group: "akuntansi",
    slug: "laporan-aktivitas",
    nama: "Laporan Aktivitas",
    kolomKunci:
      "Perubahan Aset Neto Tidak Terikat (Pendapatan lalu Beban), Perubahan Aset Neto Terikat Temporer",
    pengelompokan: "Format entitas nirlaba, kolom tahun ini dan tahun lalu bersebelahan",
  },
  {
    no: 18,
    group: "akuntansi",
    slug: "laporan-arus-kas",
    nama: "Laporan Arus Kas",
    kolomKunci: "Aktivitas Operasi, Investasi, Pendanaan, Kenaikan Kas, Kas Awal, Kas Akhir",
    pengelompokan:
      "Metode langsung. Kas Akhir wajib sama dengan saldo akun berflag kas di Laporan Posisi Keuangan",
  },
  {
    no: 19,
    group: "akuntansi",
    slug: "laporan-posisi-keuangan",
    nama: "Laporan Posisi Keuangan",
    kolomKunci: "Aset Lancar, Aset Tidak Lancar, Liabilitas, Aset Neto",
    pengelompokan:
      "Kolom tahun ini dan tahun lalu. Total Aset wajib sama dengan Liabilitas plus Aset Neto",
  },
  {
    no: 20,
    group: "akuntansi",
    slug: "perubahan-aset-neto",
    nama: "Laporan Perubahan Aset Neto",
    kolomKunci: "Saldo awal, kenaikan atau penurunan, saldo akhir",
    pengelompokan: "Per kategori aset neto",
  },
  {
    no: 21,
    group: "akuntansi",
    slug: "rekap-jurnal",
    nama: "Rekap Jurnal",
    kolomKunci: "Jenis Jurnal, Jumlah Dokumen, Total Debit, Total Kredit, Status",
    pengelompokan: "Per jenis jurnal per periode",
  },
  {
    no: 22,
    group: "akuntansi",
    slug: "buku-besar",
    nama: "Buku Besar",
    kolomKunci:
      "Saldo awal, Tanggal, No Jurnal, Keterangan, Debit, Kredit, Saldo berjalan, Saldo akhir",
    pengelompokan: "Per akun, wajib bisa drill down ke jurnal",
  },
  {
    no: 23,
    group: "akuntansi",
    slug: "neraca-lajur",
    nama: "Neraca Lajur",
    kolomKunci: "Saldo Awal D dan K, Mutasi D dan K, Saldo Akhir D dan K",
    pengelompokan: "Per akun, baris total wajib balance di ketiga pasang kolom",
  },
  {
    no: 24,
    group: "akuntansi",
    slug: "rka-vs-realisasi",
    nama: "Laporan RKA versus Realisasi",
    kolomKunci: "Uraian, Anggaran, Realisasi, Selisih, persen Capaian",
    pengelompokan: "Per akun, sektor, atau bidang. Versi bulanan dan kumulatif year to date",
  },

  {
    no: 25,
    group: "lainnya",
    slug: "portal-pumk",
    nama: "Laporan Portal PUMK",
    kolomKunci:
      "Nomor Tiket, Tanggal, Pemohon, Nilai Diajukan, Status, sudah dikonversi atau belum",
    pengelompokan: "Tanggal submission",
  },
  {
    no: 26,
    group: "lainnya",
    slug: "portal-non-pumk",
    nama: "Laporan Portal Non PUMK",
    kolomKunci:
      "Nomor Tiket, Tanggal, Pemohon, Nilai Diajukan, Status, sudah dikonversi atau belum",
    pengelompokan: "Tanggal submission",
  },
  {
    no: 27,
    group: "lainnya",
    slug: "demografi-mitra",
    nama: "Laporan Demografi Mitra Binaan",
    kolomKunci:
      "Jenis kelamin, kelompok usia, sektor, wilayah, lama usaha, jumlah tenaga kerja, kelompok omzet",
    pengelompokan: "Laporan analitik, disertai visualisasi",
  },
  {
    no: 28,
    group: "lainnya",
    slug: "perhitungan-penyisihan",
    nama: "Laporan Perhitungan Penyisihan",
    kolomKunci:
      "Outstanding, Hari Tunggakan, Klasifikasi, Rate, Nilai Penyisihan, total per klasifikasi",
    pengelompokan: "Per akad, harus merekonstruksi angka jurnal penyisihan periode itu",
  },
  {
    no: 29,
    group: "lainnya",
    slug: "beban-penyisihan",
    nama: "Laporan Beban Penyisihan",
    kolomKunci:
      "Saldo penyisihan awal, kebutuhan penyisihan, beban atau pemulihan periode, saldo akhir",
    pengelompokan: "Per periode, dengan tautan ke jurnal",
  },
  {
    no: 30,
    group: "lainnya",
    slug: "akrual-jasa-administrasi",
    nama: "Laporan Akrual Piutang Jasa Administrasi",
    kolomKunci: "Jasa Administrasi jatuh tempo, sudah diterima, akrual outstanding",
    pengelompokan: "Per akad",
  },
  {
    no: 31,
    group: "lainnya",
    slug: "audit-trail",
    nama: "Laporan Audit Trail",
    kolomKunci: "User, Tanggal, Entitas, Aksi, Nilai sebelum dan sesudah",
    pengelompokan: "Read only, tidak bisa dihapus siapa pun",
  },
];

export function reportPath(slug: string): string {
  return `/laporan/${slug}`;
}

export function reportsInGroup(group: ReportGroupId): readonly ReportMeta[] {
  return REPORTS.filter((report) => report.group === group);
}
