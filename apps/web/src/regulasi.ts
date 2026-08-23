// Dasar hukum dan template baris laporan, sebagai data.
//
// Dua hal di file ini pernah ditulis sebagai literal di dalam halaman, dan
// keduanya terbukti berubah:
//
//   1. Nomor peraturan. Rezim TJSL berganti tiga kali dalam lima tahun (2015,
//      2021, 2023), dan PER-05/MBU/04/2021 yang dipakai spec sudah dicabut
//      oleh PER-1/MBU/03/2023 Pasal 41 (lihat docs/REGULASI.md). Nomor
//      peraturan muncul di header setiap laporan yang dibaca auditor, jadi ia
//      adalah nilai konfigurasi, bukan string di dalam komponen.
//   2. Istilah klasifikasi aset neto. Spec memakai istilah PSAK 45 ("Tidak
//      Terikat" dan "Terikat Temporer"), sedangkan yang berlaku sejak
//      1 Januari 2024 adalah ISAK 335 ("tanpa pembatasan" dan "dengan
//      pembatasan"). Keduanya harus bisa hidup bersamaan: laporan periode
//      lampau tetap memakai template yang berlaku saat itu.
//
// Sampai tabel `konfigurasi` dan `template_baris_laporan` tersedia dari API,
// nilai di bawah adalah default yang bisa didemokan. Halaman tidak pernah
// menulis ulang istilah ini sendiri, selalu membacanya dari sini.

export interface DasarHukum {
  nomor: string;
  judul: string;
  status: "BERLAKU" | "DICABUT";
  catatan: string;
}

/** Peraturan yang dipakai sebagai dasar, dan pendahulunya yang sudah dicabut. */
export const DASAR_HUKUM: DasarHukum = {
  nomor: "PER-1/MBU/03/2023",
  judul:
    "Peraturan Menteri BUMN tentang Penugasan Khusus dan Program Tanggung Jawab Sosial dan Lingkungan Badan Usaha Milik Negara",
  status: "BERLAKU",
  catatan:
    "Mencabut PER-05/MBU/04/2021 beserta perubahannya PER-6/MBU/09/2022. Nomor peraturan dibaca dari Parameter Sistem, bukan ditulis di halaman.",
};

export type TemplateLaporanId = "PSAK_45" | "ISAK_335";

export interface TemplateLaporan {
  id: TemplateLaporanId;
  label: string;
  dasar: string;
  berlaku: string;
  /** Bagian Laporan Aktivitas, spec 10.3 nomor 17. */
  barisAktivitas: readonly string[];
  /** Kelompok Aset Neto pada Laporan Posisi Keuangan, nomor 19. */
  barisAsetNeto: readonly string[];
  /** Kategori pada Laporan Perubahan Aset Neto, nomor 20. */
  kategoriPerubahan: readonly string[];
}

export const TEMPLATE_LAPORAN: readonly TemplateLaporan[] = [
  {
    id: "PSAK_45",
    label: "Istilah PSAK 45",
    dasar: "PSAK 45, istilah yang dipakai spesifikasi dan Pedoman Akuntansi PKBL",
    berlaku: "Dipakai sebagai default demo",
    barisAktivitas: [
      "Perubahan Aset Neto Tidak Terikat",
      "Perubahan Aset Neto Terikat Temporer",
    ],
    barisAsetNeto: ["Aset Neto Tidak Terikat", "Aset Neto Terikat Temporer"],
    kategoriPerubahan: ["Aset Neto Tidak Terikat", "Aset Neto Terikat Temporer"],
  },
  {
    id: "ISAK_335",
    label: "Istilah ISAK 335",
    dasar: "ISAK 335, penomoran ulang ISAK 35",
    berlaku: "Berlaku sejak 1 Januari 2024, amendemen berlaku 1 Januari 2027",
    barisAktivitas: [
      "Perubahan Aset Neto Tanpa Pembatasan dari Pemberi Sumber Daya",
      "Perubahan Aset Neto Dengan Pembatasan dari Pemberi Sumber Daya",
    ],
    barisAsetNeto: [
      "Aset Neto Tanpa Pembatasan dari Pemberi Sumber Daya",
      "Aset Neto Dengan Pembatasan dari Pemberi Sumber Daya",
    ],
    kategoriPerubahan: [
      "Aset Neto Tanpa Pembatasan dari Pemberi Sumber Daya",
      "Aset Neto Dengan Pembatasan dari Pemberi Sumber Daya",
    ],
  },
];

export const TEMPLATE_DEFAULT: TemplateLaporanId = "PSAK_45";

export function templateById(id: TemplateLaporanId): TemplateLaporan {
  const hit = TEMPLATE_LAPORAN.find((template) => template.id === id);
  if (!hit) throw new Error(`Template laporan tidak dikenal: ${id}`);
  return hit;
}

/** Which part of a template a given report renders. */
export type BagianTemplate = "barisAktivitas" | "barisAsetNeto" | "kategoriPerubahan";

/**
 * Report slugs whose line labels come from a template instead of being fixed.
 * Any report listed here renders its labels through `templateById`, so seeding
 * a third template later needs no page change.
 */
export const REPORT_TEMPLATE_BAGIAN: Record<string, BagianTemplate> = {
  "laporan-aktivitas": "barisAktivitas",
  "laporan-posisi-keuangan": "barisAsetNeto",
  "perubahan-aset-neto": "kategoriPerubahan",
};

export function barisTemplate(slug: string, id: TemplateLaporanId): readonly string[] | null {
  const bagian = REPORT_TEMPLATE_BAGIAN[slug];
  if (!bagian) return null;
  return templateById(id)[bagian];
}
