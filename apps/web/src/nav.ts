// Navigation and page inventory, spec section 9 module grouping plus the
// section 10 report catalog.
//
// One table drives three things: the left navigation, the mobile navigation
// sheet, and the router's route table. A page cannot exist without a nav entry
// and a permission, which is what keeps the nav honest as later phases land.
import type { IconName } from "@krakatausteel/ui";
import { hasPermission, type Permission } from "./permissions";
import { REPORTS, REPORT_GROUPS, reportPath, reportsInGroup } from "./reports";

export interface PageRoute {
  path: string;
  /** Label in the navigation. */
  label: string;
  /** Page heading. Usually the same as the label, spelled out in full. */
  title: string;
  permission?: Permission;
  /** One paragraph of what the page is for. */
  summary: string;
  /** Concrete list of what the page will hold once its phase lands. */
  willContain: readonly string[];
  /** Reachable by URL but not listed in the navigation. */
  hideFromNav?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: IconName;
  items: readonly PageRoute[];
}

const ATURAN_LAPORAN: readonly string[] = [
  "Filter periode bulan dan tahun, filter cabang dengan opsi Semua Cabang untuk Admin Pusat",
  "Tombol export Excel dan export PDF dengan format siap pakai, bukan dump tabel",
  "Header laporan berisi nama BUMN, nama laporan, periode, cabang, tanggal cetak, dan nama pencetak",
  "Nilai nol ditampilkan sebagai 0,00, tidak pernah dibiarkan kosong",
  "Periode CLOSED dibaca dari snapshot saldo akun dan kolektibilitas, periode OPEN dihitung dari ledger",
];

/** The 31 report pages, one route per catalog entry. */
const REPORT_ROUTES: readonly PageRoute[] = REPORTS.map((report) => ({
  path: reportPath(report.slug),
  label: report.nama,
  title: `${report.no}. ${report.nama}`,
  permission: "laporan.view" as Permission,
  summary: `Laporan nomor ${report.no} pada katalog. Pengelompokan: ${report.pengelompokan}.`,
  willContain: [`Kolom kunci: ${report.kolomKunci}`, ...ATURAN_LAPORAN],
  hideFromNav: true,
}));

/** The four catalog index pages, one per section 10 grouping. */
const REPORT_CATALOG_ROUTES: readonly PageRoute[] = REPORT_GROUPS.map((group) => ({
  path: group.path,
  label: group.label,
  title: group.label,
  permission: "laporan.view" as Permission,
  summary: group.description,
  willContain: reportsInGroup(group.id).map((report) => `${report.no}. ${report.nama}`),
}));

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "dashboard",
    items: [
      {
        path: "/",
        label: "Dashboard",
        title: "Dashboard",
        permission: "dashboard.view",
        summary:
          "KPI baris atas dan panel monitoring. Setiap angka bisa diklik untuk drill down ke laporan atau daftar data sumbernya.",
        willContain: [],
      },
    ],
  },
  {
    id: "pumk",
    label: "Pendanaan UMK",
    icon: "pumk",
    items: [
      {
        path: "/pumk/proposal",
        label: "Daftar Proposal",
        title: "Daftar Proposal Pendanaan UMK",
        permission: "pumk.view",
        summary:
          "Daftar seluruh proposal PUMK dengan tab pemisah Daftar Pemohon internal dan Daftar Pemohon Online dari portal.",
        willContain: [
          "Filter tanggal, cabang, sektor, status, dan pencarian nama atau NIK",
          "Tab Daftar Pemohon dan tab Daftar Pemohon Online yang terpisah",
          "Kolom nomor proposal, Mitra Binaan, sektor, nilai diajukan, status, dan umur dokumen",
          "Tautan ke halaman detail proposal beserta timeline persetujuannya",
        ],
      },
      {
        path: "/pumk/proposal/baru",
        label: "Input Proposal",
        title: "Input Proposal Pendanaan UMK",
        permission: "pumk.create",
        summary:
          "Form pengajuan proposal baru, termasuk pencarian mitra lama dan validasi batas pinjaman aktif per mitra.",
        willContain: [
          "Pencarian Mitra Binaan lama dengan isi otomatis bila mitra pernah meminjam",
          "Validasi maksimal pinjaman aktif per mitra dan batas plafon dari Parameter Sistem",
          "Data usaha, data wilayah, sektor, dan nilai yang diajukan",
          "Simpan sebagai DRAFT lalu ajukan ke tahap survey",
        ],
      },
      {
        path: "/pumk/proposal/:proposalId",
        label: "Detail Proposal",
        title: "Detail Proposal Pendanaan UMK",
        permission: "pumk.view",
        summary:
          "Satu proposal dengan seluruh datanya: identitas mitra, nilai yang diajukan, hasil survey, jaminan, dan timeline persetujuan.",
        willContain: [
          "Timeline persetujuan: siapa memindahkan dokumen ke status apa, kapan, dengan catatan apa",
          "Data proposal, data Mitra Binaan, dan hasil survey pada satu halaman",
          "Daftar jaminan yang tercatat pada proposal ini",
          "Aksi lanjutan sesuai status dan hak akses pengguna",
        ],
        hideFromNav: true,
      },
      {
        path: "/pumk/survey",
        label: "Hasil Survey",
        title: "Input Hasil Survey",
        permission: "pumk.survey",
        summary:
          "Perekaman hasil kunjungan lapangan dengan skoring dan lampiran foto, dasar rekomendasi Checker.",
        willContain: [
          "Form skoring survey beserta skor minimum lolos dari Parameter Sistem",
          "Unggah foto lokasi usaha dan dokumen pendukung",
          "Catatan surveyor, tanggal survey, dan nama petugas",
          "Transisi status dari SURVEY_PENDING ke SURVEY_SELESAI beserta catatannya",
        ],
      },
      {
        path: "/pumk/jaminan",
        label: "Profil Jaminan",
        title: "Profil Jaminan",
        permission: "pumk.create",
        summary:
          "Pencatatan satu atau lebih jaminan per proposal, termasuk ambang wajib jaminan di atas plafon tertentu.",
        willContain: [
          "Daftar jaminan per proposal dengan jenis, nilai taksasi, dan bukti kepemilikan",
          "Validasi wajib jaminan bila nilai pinjaman melewati ambang batas",
          "Unggah dokumen dan foto jaminan",
          "Riwayat perubahan data jaminan pada audit trail",
        ],
      },
      {
        path: "/pumk/review",
        label: "Review Checker",
        title: "Review Checker",
        permission: "pumk.review",
        summary:
          "Tampilan berdampingan data proposal dan hasil survey, dengan tiga keluaran: rekomendasi, tidak rekomendasi, atau minta perbaikan.",
        willContain: [
          "Perbandingan side by side data proposal dan hasil survey",
          "Tombol rekomendasi, tidak rekomendasi, dan minta perbaikan beserta catatan wajib",
          "Penolakan otomatis bila pengguna adalah Maker dokumen yang sama",
          "Timeline transisi yang menampilkan siapa, kapan, dan catatan apa",
        ],
      },
      {
        path: "/pumk/persetujuan",
        label: "Persetujuan Proposal",
        title: "Persetujuan Proposal Pendanaan UMK",
        permission: "pumk.approve",
        summary:
          "Keputusan Approver atas proposal yang direkomendasikan, termasuk kemampuan mengubah plafon dan tenor dari yang diajukan.",
        willContain: [
          "Ubah plafon dan tenor pada saat menyetujui, dengan pencatatan nilai asal dan nilai final",
          "Tombol setujui, tolak, dan kembalikan ke Checker",
          "Penolakan otomatis bila pengguna adalah Checker dokumen yang sama",
          "Timeline transisi lengkap sampai status DISETUJUI atau DITOLAK",
        ],
      },
      {
        path: "/pumk/akad",
        label: "Realisasi Akad",
        title: "Realisasi Akad",
        permission: "pumk.akad",
        summary:
          "Pembuatan akad atas proposal yang disetujui, dasar pengakuan piutang Mitra Binaan.",
        willContain: [
          "Nomor akad dari generator nomor dokumen, tanggal akad, dan nilai final",
          "Rate dan metode Jasa Administrasi yang berlaku pada akad tersebut",
          "Tenor, grace period, dan tanggal angsuran pertama",
          "Transisi status ke AKAD_DIBUAT lalu lanjut ke generate jadwal",
        ],
      },
      {
        path: "/pumk/jadwal",
        label: "Jadwal Angsuran",
        title: "Jadwal Angsuran",
        permission: "pumk.view",
        summary:
          "Jadwal angsuran per akad, menampilkan semua versi dengan penanda versi yang aktif.",
        willContain: [
          "Tabel jadwal per angsuran: jatuh tempo, pokok, Jasa Administrasi, total, sisa pokok",
          "Semua versi jadwal ditampilkan, versi lama bertanda SUPERSEDED",
          "Total angsuran pokok wajib sama persis dengan pokok pinjaman",
          "Jadwal yang sudah dibuat bersifat immutable, perubahan hanya melalui reschedule",
        ],
      },
      {
        path: "/pumk/pencairan",
        label: "Pencairan",
        title: "Pencairan Dana",
        permission: "pumk.pencairan",
        summary:
          "Pencatatan peristiwa dana keluar ke Mitra Binaan. Aplikasi mencatat, tidak memindahkan uang.",
        willContain: [
          "Tanggal pencairan, nilai, nomor bukti, dan akun kas atau bank sumber",
          "Jurnal pencairan terbentuk otomatis melalui event to journal mapping",
          "Transisi status ke DICAIRKAN dan akad menjadi AKTIF",
          "Tautan langsung ke jurnal yang terbentuk dan ke Buku Besar",
        ],
      },
      {
        path: "/pumk/angsuran",
        label: "Penerimaan Angsuran",
        title: "Penerimaan Angsuran",
        permission: "pumk.angsuran",
        summary:
          "Pencatatan setoran Mitra Binaan dan alokasinya ke tunggakan, pokok, dan Jasa Administrasi.",
        willContain: [
          "Alokasi setoran mengikuti urutan pada Parameter Sistem, dengan rincian per komponen",
          "Setoran melebihi kewajiban masuk ke Kelebihan Pembayaran Angsuran, piutang tidak pernah negatif",
          "Setoran tanpa identitas pemilik masuk ke Angsuran Belum Teridentifikasi",
          "Jurnal penerimaan terbentuk otomatis dengan nomor bukti setoran",
        ],
      },
      {
        path: "/pumk/simulasi",
        label: "Simulasi Angsuran",
        title: "Kalkulator Simulasi Angsuran",
        permission: "pumk.view",
        summary:
          "Perhitungan jadwal angsuran tanpa menyimpan apa pun, untuk menjawab pertanyaan calon Mitra Binaan.",
        willContain: [
          "Input plafon, tenor, rate Jasa Administrasi, metode, dan grace period",
          "Tabel jadwal hasil simulasi beserta total pokok dan total Jasa Administrasi",
          "Aturan pembulatan angsuran, selisih dibebankan ke angsuran terakhir",
          "Tidak menyimpan data dan tidak membuat jurnal",
        ],
      },
      {
        path: "/pumk/kartu-piutang",
        label: "Kartu Piutang Mitra",
        title: "Kartu Piutang Mitra Binaan",
        permission: "pumk.view",
        summary:
          "Halaman yang paling sering dibuka petugas: satu tampilan berisi seluruh riwayat piutang satu Mitra Binaan.",
        willContain: [
          "Data mitra dan seluruh akadnya, aktif maupun selesai",
          "Jadwal angsuran lengkap berikut semua setoran yang pernah masuk",
          "Riwayat kolektibilitas per periode dan outstanding terkini",
          "Konsistensi jadwal, setoran, dan outstanding bisa ditelusuri sampai jurnalnya",
        ],
      },
      {
        path: "/pumk/kartu-piutang/:akadId",
        label: "Kartu Piutang",
        title: "Kartu Piutang Mitra Binaan",
        permission: "pumk.view",
        summary:
          "Kartu piutang satu akad: data mitra, syarat akad, jadwal seluruh versi, setiap setoran, riwayat kolektibilitas, dan outstanding terkini.",
        willContain: [
          "Ringkasan outstanding pokok, outstanding Jasa Administrasi, dan rekonsiliasi terhadap Buku Besar",
          "Jadwal angsuran versi aktif beserta status tiap baris",
          "Seluruh setoran dengan rincian alokasi pokok, jasa, dan kelebihan",
          "Riwayat kolektibilitas per periode dan tautan ke jurnal terkait",
        ],
        hideFromNav: true,
      },
      {
        path: "/pumk/mitra",
        label: "Mitra Binaan",
        title: "Mitra Binaan",
        permission: "pumk.view",
        summary: "Master data pelaku UMK penerima pinjaman PUMK beserta profil usahanya.",
        willContain: [
          "Identitas, wilayah, sektor, data usaha, tenaga kerja, dan kelompok omzet",
          "Riwayat pinjaman dan status keanggotaan cluster",
          "Import massal dari Excel dan export ke Excel",
          "Soft delete dengan audit trail, tidak ada hard delete data keuangan",
        ],
      },
      {
        path: "/pumk/cluster",
        label: "Cluster Mitra",
        title: "Cluster Mitra Binaan",
        permission: "pumk.view",
        summary:
          "Pengelolaan kelompok Mitra Binaan dan pemantauan kualitas piutang per kelompok.",
        willContain: [
          "Tambah dan keluarkan anggota cluster beserta tanggal efektifnya",
          "Performa kolektibilitas per cluster",
          "Tautan ke Jurnal Pinbuk yang dibebankan ke cluster",
          "Riwayat perubahan keanggotaan pada audit trail",
        ],
      },
      {
        path: "/pumk/cluster/:clusterId",
        label: "Detail Cluster",
        title: "Detail Cluster Mitra Binaan",
        permission: "pumk.view",
        summary:
          "Satu cluster dengan daftar anggotanya, riwayat masuk dan keluar, serta performa kolektibilitas kelompok.",
        willContain: [
          "Daftar anggota aktif beserta tanggal masuk dan kolektibilitas terakhir",
          "Tambah anggota dan keluarkan anggota beserta tanggal efektif dan alasannya",
          "Komposisi kolektibilitas dan outstanding pokok kelompok",
          "Riwayat keanggotaan yang pernah tercatat, termasuk yang sudah keluar",
        ],
        hideFromNav: true,
      },
      {
        path: "/pumk/reschedule",
        label: "Reschedule",
        title: "Reschedule Angsuran",
        permission: "pumk.reschedule",
        summary:
          "Penjadwalan ulang angsuran dengan pratinjau jadwal baru sebelum disubmit.",
        willContain: [
          "Pratinjau jadwal baru berdampingan dengan jadwal berjalan",
          "Alasan reschedule wajib diisi dan tercatat pada audit trail",
          "Jadwal lama ditandai SUPERSEDED, riwayatnya tetap utuh",
          "Total pokok jadwal baru tetap sama dengan sisa pokok akad",
        ],
      },
      {
        path: "/pumk/pengakhiran",
        label: "Pengakhiran dan Hapus Buku",
        title: "Pengakhiran Akad dan Hapus Buku",
        permission: "pumk.hapusbuku",
        summary:
          "Penutupan akad yang lunas dan penghapusan buku piutang macet, yang tetap dicatat ekstrakomtabel.",
        willContain: [
          "Pengakhiran akad lunas beserta validasi outstanding nol",
          "Hapus buku piutang macet dengan alasan dan persetujuan wajib",
          "Piutang hapus buku tetap tercatat ekstrakomtabel, tidak hilang dari sistem",
          "Jurnal hapus buku terbentuk otomatis melalui event to journal mapping",
        ],
      },
      {
        path: "/pumk/mitra-bermasalah",
        label: "Mitra Bermasalah",
        title: "Pengaturan Mitra Bermasalah",
        permission: "pumk.penagihan",
        summary:
          "Daftar akad dengan kolektibilitas Diragukan dan Macet beserta catatan tindak lanjut penagihan.",
        willContain: [
          "Daftar akad Diragukan dan Macet dengan hari tunggakan dan outstanding",
          "Catatan tindak lanjut per jenis: kunjungan, telepon, surat peringatan, somasi",
          "Hasil tindak lanjut, petugas, dan lampiran bukti",
          "Tautan ke Kartu Piutang mitra yang bersangkutan",
        ],
      },
    ],
  },
  {
    id: "nonpumk",
    label: "Non PUMK",
    icon: "nonpumk",
    items: [
      {
        path: "/nonpumk/proposal",
        label: "Daftar Proposal",
        title: "Daftar Proposal Non PUMK",
        permission: "nonpumk.view",
        summary:
          "Daftar proposal hibah dan bantuan sosial atau lingkungan beserta status pertanggungjawabannya.",
        willContain: [
          "Filter tanggal, cabang, bidang Non PUMK, SDG, dan status",
          "Kolom nomor proposal, pemohon, bidang, nilai diajukan, nilai disetujui, status LPJ",
          "Tab pemisah pemohon internal dan pemohon dari portal online",
          "Tautan ke detail proposal beserta timeline persetujuannya",
        ],
      },
      {
        path: "/nonpumk/proposal/baru",
        label: "Input Proposal",
        title: "Input Proposal Non PUMK",
        permission: "nonpumk.create",
        summary:
          "Form pengajuan bantuan, wajib memetakan ke satu bidang Non PUMK dan minimal satu SDG.",
        willContain: [
          "Pemetaan wajib ke bidang Non PUMK dan minimal satu SDG",
          "Estimasi penerima manfaat pada tahap proposal",
          "Rencana anggaran kegiatan dan dokumen pendukung",
          "Simpan sebagai DRAFT lalu ajukan ke tahap penilaian",
        ],
      },
      {
        path: "/nonpumk/proposal/:proposalId",
        label: "Detail Proposal",
        title: "Detail Proposal Non PUMK",
        permission: "nonpumk.view",
        summary:
          "Satu program dengan seluruh datanya: pemetaan bidang dan SDG, penilaian, termin penyaluran, LPJ, dan timeline persetujuannya.",
        willContain: [
          "Timeline persetujuan: siapa memindahkan dokumen ke status apa, kapan, dengan catatan apa",
          "Pagu disetujui, total disalurkan, dan sisa pagu sebagai tiga angka terpisah",
          "Isi LPJ beserta sisa yang wajib dikembalikan dan jurnal pengembaliannya",
          "Kecocokan beban dan kas pada Buku Besar terhadap baris penyaluran dan realisasi LPJ",
        ],
        hideFromNav: true,
      },
      {
        path: "/nonpumk/penilaian",
        label: "Penilaian Proposal",
        title: "Penilaian Proposal Non PUMK",
        permission: "nonpumk.penilaian",
        summary: "Penilaian kelayakan program sebelum masuk review Checker.",
        willContain: [
          "Form penilaian kelayakan beserta catatan penilai",
          "Verifikasi kelengkapan dokumen dan kewajaran anggaran",
          "Unggah berita acara dan foto peninjauan",
          "Transisi status dari PENILAIAN ke REVIEW_CHECKER",
        ],
      },
      {
        path: "/nonpumk/review",
        label: "Review Checker",
        title: "Review Checker Non PUMK",
        permission: "nonpumk.review",
        summary: "Rekomendasi Checker atas hasil penilaian program.",
        willContain: [
          "Tampilan data proposal dan hasil penilaian secara berdampingan",
          "Tombol rekomendasi, tidak rekomendasi, dan minta perbaikan beserta catatan wajib",
          "Penolakan otomatis bila pengguna adalah Maker dokumen yang sama",
          "Timeline transisi yang menampilkan siapa, kapan, dan catatan apa",
        ],
      },
      {
        path: "/nonpumk/persetujuan",
        label: "Persetujuan Proposal",
        title: "Persetujuan Proposal Non PUMK",
        permission: "nonpumk.approve",
        summary: "Keputusan Approver atas program yang direkomendasikan.",
        willContain: [
          "Setujui dengan nilai yang bisa diubah dari nilai yang diajukan",
          "Tolak atau kembalikan ke Checker dengan alasan wajib",
          "Penolakan otomatis bila pengguna adalah Checker dokumen yang sama",
          "Transisi status ke DISETUJUI dan siap disalurkan",
        ],
      },
      {
        path: "/nonpumk/penyaluran",
        label: "Penyaluran",
        title: "Penyaluran Non PUMK",
        permission: "nonpumk.penyaluran",
        summary:
          "Pencatatan penyaluran, yang dapat dilakukan bertahap dalam beberapa termin.",
        willContain: [
          "Beberapa termin penyaluran per proposal dengan tanggal dan nomor bukti",
          "Validasi total penyaluran tidak boleh melebihi nilai disetujui",
          "Jurnal penyaluran terbentuk otomatis per termin",
          "Transisi status ke DISALURKAN lalu MENUNGGU_LPJ",
        ],
      },
      {
        path: "/nonpumk/lpj",
        label: "Laporan Pertanggungjawaban",
        title: "Laporan Pertanggungjawaban Non PUMK",
        permission: "nonpumk.lpj",
        summary:
          "Perekaman LPJ penerima bantuan, termasuk realisasi yang lebih kecil dari yang disalurkan.",
        willContain: [
          "Realisasi penggunaan dana dan penerima manfaat aktual",
          "Realisasi lebih kecil dari penyaluran memunculkan kewajiban pengembalian sisa",
          "Jurnal pengembalian sisa Non PUMK terbentuk otomatis atas selisih tersebut",
          "Keputusan terima atau tolak LPJ beserta catatan wajib",
        ],
      },
      {
        path: "/nonpumk/monitoring-lpj",
        label: "Monitoring LPJ",
        title: "Monitoring LPJ Terlambat",
        permission: "nonpumk.view",
        summary:
          "Pemantauan LPJ yang belum masuk, dengan aging 30, 60, dan 90 hari sejak penyaluran.",
        willContain: [
          "Bucket aging 30, 60, dan 90 hari sejak tanggal penyaluran",
          "Kolom proposal, penerima, nilai disalurkan, umur hari, dan status LPJ",
          "Penanda program yang sudah melewati batas waktu LPJ",
          "Tautan ke halaman LPJ program yang bersangkutan",
        ],
      },
    ],
  },
  {
    id: "jurnal",
    label: "Jurnal",
    icon: "jurnal",
    items: [
      {
        path: "/jurnal",
        label: "Daftar Jurnal",
        title: "Daftar Jurnal",
        permission: "jurnal.view",
        summary:
          "Seluruh dokumen jurnal beserta statusnya, dari DRAFT sampai POSTED dan REVERSED.",
        willContain: [
          "Filter periode, cabang, jenis jurnal, status, dan pencarian nomor dokumen",
          "Kolom nomor jurnal, tanggal transaksi, jenis, total debit, total kredit, status",
          "Penanda jurnal yang berasal dari event otomatis dan yang diinput manual",
          "Detail jurnal dengan baris debit dan kredit serta tautan ke dokumen sumber",
        ],
      },
      {
        path: "/jurnal/umum",
        label: "Jurnal Umum",
        title: "Input Jurnal Umum",
        permission: "jurnal.create",
        summary:
          "Jurnal manual bebas multi baris, dipakai untuk koreksi dan reklasifikasi.",
        willContain: [
          "Baris debit dan kredit bebas dengan pencarian akun dari Bagan Akun",
          "Validasi balance, minimal dua baris, dan satu baris hanya debit atau kredit",
          "Penolakan tanggal transaksi yang jatuh pada periode CLOSED",
          "Simpan sebagai DRAFT, verifikasi oleh Checker, posting oleh Approver",
        ],
      },
      {
        path: "/jurnal/kas-bank",
        label: "Jurnal Kas Bank",
        title: "Input Jurnal Kas Bank",
        permission: "jurnal.create",
        summary:
          "Form penerimaan atau pengeluaran kas, satu sisi wajib akun berflag kas.",
        willContain: [
          "Pilihan penerimaan atau pengeluaran kas dengan akun kas atau bank wajib",
          "Baris lawan bebas, dengan pencarian akun dari Bagan Akun",
          "Nomor bukti kas dan tanggal transaksi",
          "Engine jurnal yang sama dengan Jurnal Umum, hanya berbeda pada UX dan default akun",
        ],
      },
      {
        path: "/jurnal/pinbuk",
        label: "Jurnal Pinbuk",
        title: "Input Jurnal Pinbuk",
        permission: "jurnal.create",
        summary:
          "Pencatatan beban pembinaan, wajib bertaut ke Mitra Binaan atau cluster dan berkategori kegiatan.",
        willContain: [
          "Preset akun Beban Pembinaan Kemitraan",
          "Tautan wajib ke Mitra Binaan atau ke cluster",
          "Kategori kegiatan: pelatihan, pameran, sertifikasi, pendampingan, bantuan sarana",
          "Unggah bukti kegiatan dan daftar peserta",
        ],
      },
      {
        path: "/jurnal/verifikasi",
        label: "Verifikasi Jurnal",
        title: "Verifikasi Jurnal Draft",
        permission: "jurnal.verify",
        summary:
          "Antrean jurnal DRAFT yang menunggu verifikasi Checker sebelum bisa diposting.",
        willContain: [
          "Antrean jurnal DRAFT dengan pratinjau baris debit dan kredit",
          "Tombol verifikasi dan kembalikan ke Maker beserta catatan wajib",
          "Penolakan otomatis bila pengguna adalah Maker dokumen yang sama",
          "Riwayat verifikasi tercatat pada audit trail",
        ],
      },
      {
        path: "/jurnal/posting",
        label: "Posting Jurnal",
        title: "Posting Jurnal",
        permission: "jurnal.post",
        summary:
          "Posting jurnal terverifikasi ke ledger. Posting bersifat final dan tidak bisa diubah.",
        willContain: [
          "Posting satu dokumen atau batch, dengan seluruh batch gagal bila satu dokumen invalid",
          "Penolakan posting ke periode CLOSED berdasarkan tanggal transaksi",
          "Dua permintaan posting bersamaan hanya menghasilkan satu posting",
          "Jurnal POSTED tidak bisa diubah atau dihapus, koreksi hanya lewat jurnal pembalik",
        ],
      },
      {
        path: "/jurnal/pembalik",
        label: "Hapus Jurnal Transaksi",
        title: "Hapus Jurnal Transaksi melalui Jurnal Pembalik",
        permission: "jurnal.reversal",
        summary:
          "Koreksi jurnal POSTED. Yang terjadi adalah pembentukan jurnal pembalik, bukan penghapusan.",
        willContain: [
          "Pratinjau jurnal pembalik dengan debit dan kredit yang tertukar dan total yang sama",
          "Alasan pembalikan wajib diisi",
          "Penolakan pembalikan atas jurnal yang sudah pernah dibalik",
          "Dokumen asal tetap ada di ledger dengan status REVERSED",
        ],
      },
    ],
  },
  {
    id: "laporan",
    label: "Laporan",
    icon: "laporan",
    items: [...REPORT_CATALOG_ROUTES, ...REPORT_ROUTES],
  },
  {
    id: "admin",
    label: "Admin",
    icon: "admin",
    items: [
      // THE THREE CLOSING SCREENS ARE GATED ON `admin.closing.view`, NOT ON THE
      // CODES THAT RUN THINGS. That is deliberate and it mirrors the server:
      // the checklist, the run history, the stored snapshot and the frozen
      // balances are all registered under `admin.closing.view` in
      // modules/closing/routes.ts, which is the read only code an Auditor holds
      // and which can execute nothing. Gating the PAGE on
      // `admin.closing.periode` would have meant either handing a write code to
      // a role that must never write, or locking the Auditor out of the evidence
      // that spec 16 scenario 23 makes their primary object. The run controls
      // inside each page are gated separately, and the server checks every one
      // of them again.
      {
        path: "/admin/closing-kolektibilitas",
        label: "Closing Kolektibilitas",
        title: "Closing Kolektibilitas",
        permission: "admin.closing.view",
        summary:
          "Penetapan klasifikasi kualitas piutang per periode beserta perhitungan penyisihannya.",
        willContain: [
          "Pratinjau hasil sebelum commit, termasuk ringkasan perpindahan klasifikasi",
          "Riwayat closing kolektibilitas per periode dan per cabang",
          "Rate dan dasar perhitungan yang benar benar dipakai, dibaca dari barisnya sendiri",
          "Menjalankan butuh admin.closing.kolektibilitas, membacanya cukup admin.closing.view",
        ],
      },
      {
        path: "/admin/closing-periode",
        label: "Closing Periode",
        title: "Closing Periode",
        permission: "admin.closing.view",
        summary:
          "Penutupan periode akuntansi dengan checklist prasyarat yang harus hijau sebelum eksekusi.",
        willContain: [
          "Checklist prasyarat lengkap sepuluh butir, dengan alasan dan angka di baliknya",
          "Penolakan closing dengan alasan yang jelas bila satu prasyarat gagal",
          "Penyisihan dan akrual beserta jurnal yang terbentuk dari keduanya",
          "Eksekusi closing butuh admin.closing.periode dan konfirmasi tertulis lebih dulu",
        ],
      },
      {
        path: "/admin/periode",
        label: "Periode Akuntansi",
        title: "Periode Akuntansi",
        permission: "admin.closing.view",
        summary:
          "Daftar periode beserta statusnya, dan tempat reopen dilakukan bila memang diperlukan.",
        willContain: [
          "Daftar periode per tahun buku dengan status OPEN, CLOSING_IN_PROGRESS, atau CLOSED",
          "Reopen periode oleh Admin Pusat dengan alasan wajib dan konfirmasi tertulis",
          "Riwayat siapa menutup dan siapa membuka kembali beserta waktunya",
          "Saldo akun beku periode tertutup, terbaca sebagai bukti tanpa hak menulis apa pun",
        ],
      },
      {
        path: "/admin/rka-pumk",
        label: "RKA Pendanaan UMK",
        title: "Input RKA Pendanaan UMK",
        permission: "admin.rka",
        summary:
          "Rencana Kerja dan Anggaran penyaluran PUMK: target nilai dan jumlah mitra per sektor per bulan.",
        willContain: [
          "Target penyaluran per sektor per bulan beserta jumlah mitra target",
          "Versi dan status RKA: DRAFT, DISETUJUI, REVISI",
          "RKA DISETUJUI menjadi baseline pembanding pada Laporan RKA versus Realisasi",
          "Import dan export Excel untuk pengisian anggaran massal",
        ],
      },
      {
        path: "/admin/rka-nonpumk",
        label: "RKA Non PUMK",
        title: "Input RKA Non PUMK",
        permission: "admin.rka",
        summary: "Anggaran program Non PUMK per bidang per bulan.",
        willContain: [
          "Anggaran per bidang Non PUMK per bulan",
          "Versi dan status RKA, revisi membentuk versi baru",
          "Baseline pembanding untuk Rekap Penyaluran Non PUMK per Bidang",
          "Import dan export Excel",
        ],
      },
      {
        path: "/admin/rka-keuangan",
        label: "RKA Keuangan",
        title: "Input RKA Keuangan",
        permission: "admin.rka",
        summary: "Anggaran per akun beban dan target pendapatan per bulan.",
        willContain: [
          "Anggaran per akun beban dan target pendapatan per bulan",
          "Versi dan status RKA, laporan bisa memilih versi pembanding",
          "Perbandingan dengan agregat jurnal POSTED pada akun yang sama",
          "Import dan export Excel",
        ],
      },
    ],
  },
  {
    id: "konfigurasi",
    label: "Konfigurasi",
    icon: "konfigurasi",
    items: [
      {
        path: "/konfigurasi/coa",
        label: "Master Perkiraan",
        title: "Master Perkiraan (Bagan Akun)",
        permission: "konfigurasi.coa",
        summary:
          "Pengelolaan Bagan Akun dalam tampilan tree, dengan validasi hierarki dan saldo normal.",
        willContain: [
          "Tampilan tree kode akun dengan validasi hierarki induk dan anak",
          "Tipe akun, saldo normal, flag kas, dan status aktif",
          "Akun yang sudah pernah dipakai pada jurnal tidak bisa dihapus",
          "Import dari Excel dan export ke Excel",
        ],
      },
      {
        path: "/konfigurasi/wilayah",
        label: "Provinsi dan Kota",
        title: "Master Provinsi dan Kota",
        permission: "konfigurasi.master",
        summary: "Referensi wilayah yang dipakai pada Mitra Binaan dan laporan penyaluran.",
        willContain: [
          "Daftar provinsi dan kota atau kabupaten beserta kodenya",
          "Status aktif dan penanda wilayah kerja cabang",
          "Import dari Excel dan export ke Excel",
          "Dipakai sebagai dimensi pada Laporan Realisasi Penyaluran per wilayah",
        ],
      },
      {
        path: "/konfigurasi/sektor",
        label: "Sektor PUMK",
        title: "Master Sektor PUMK",
        permission: "konfigurasi.master",
        summary: "Klasifikasi sektor usaha Mitra Binaan, dimensi utama laporan PUMK dan RKA PUMK.",
        willContain: [
          "Kode dan nama sektor beserta status aktif",
          "Dipakai sebagai dimensi RKA PUMK dan laporan penyaluran per sektor",
          "Import dari Excel dan export ke Excel",
          "Sektor yang sudah terpakai tidak bisa dihapus, hanya dinonaktifkan",
        ],
      },
      {
        path: "/konfigurasi/bidang",
        label: "Bidang Non PUMK",
        title: "Master Bidang Non PUMK",
        permission: "konfigurasi.master",
        summary: "Klasifikasi bidang program hibah, dimensi utama laporan dan RKA Non PUMK.",
        willContain: [
          "Kode dan nama bidang beserta status aktif",
          "Dipakai sebagai dimensi RKA Non PUMK dan rekap penyaluran per bidang",
          "Import dari Excel dan export ke Excel",
          "Bidang yang sudah terpakai tidak bisa dihapus, hanya dinonaktifkan",
        ],
      },
      {
        path: "/konfigurasi/sdg",
        label: "SDGs",
        title: "Master SDGs",
        permission: "konfigurasi.master",
        summary: "Tujuan Pembangunan Berkelanjutan yang wajib dipetakan pada setiap program Non PUMK.",
        willContain: [
          "Nomor dan nama tujuan SDG beserta status aktif",
          "Satu program Non PUMK bisa dipetakan ke beberapa SDG",
          "Dipakai pada Laporan Pemetaan SDGs",
          "Import dari Excel dan export ke Excel",
        ],
      },
      {
        path: "/konfigurasi/cabang",
        label: "Cabang",
        title: "Master Cabang",
        permission: "konfigurasi.master",
        summary:
          "Unit kerja yang menjadi batas scope data setiap pengguna, kecuali Admin Pusat dan Auditor.",
        willContain: [
          "Kode, nama, wilayah kerja, dan status aktif cabang",
          "Scope data seluruh modul terikat cabang pengguna",
          "Dipakai sebagai filter pada semua laporan, dengan opsi Semua Cabang untuk Admin Pusat",
          "Import dari Excel dan export ke Excel",
        ],
      },
      {
        path: "/konfigurasi/karyawan",
        label: "Karyawan",
        title: "Master Karyawan",
        permission: "konfigurasi.master",
        summary: "Data karyawan yang menjadi surveyor, petugas penagihan, dan penanggung jawab dokumen.",
        willContain: [
          "Identitas karyawan, jabatan, dan cabang penempatan",
          "Tautan ke akun pengguna aplikasi bila ada",
          "Dipakai sebagai petugas pada hasil survey dan tindak lanjut penagihan",
          "Import dari Excel dan export ke Excel",
        ],
      },
      {
        path: "/konfigurasi/pengguna",
        label: "Pengguna dan Role",
        title: "Pengguna dan Role",
        permission: "konfigurasi.user",
        summary:
          "Pengelolaan akun, role, dan scope cabang. Otorisasi tetap divalidasi ulang di layer server.",
        willContain: [
          "Akun pengguna beserta role: Maker, Checker, Approver, Admin Cabang, Admin Pusat, Auditor",
          "Scope cabang per pengguna, Admin Pusat dan Auditor lintas cabang",
          "Menu dan tombol mengikuti permission, tetapi server tetap menolak akses tidak sah",
          "Riwayat perubahan hak akses tercatat pada audit trail",
        ],
      },
      {
        path: "/konfigurasi/parameter",
        label: "Parameter Sistem",
        title: "Parameter Sistem",
        permission: "konfigurasi.parameter",
        summary:
          "Semua parameter perhitungan bisa diubah dari sini tanpa deploy, sesuai spesifikasi bagian 5.",
        willContain: [
          "Rentang hari tunggakan per klasifikasi kolektibilitas, disimpan sebagai tabel range",
          "Rate penyisihan per klasifikasi dan dasar perhitungannya",
          "Rate, metode, basis hari, dan pembulatan Jasa Administrasi",
          "Urutan alokasi setoran, batasan program, dan parameter akuntansi",
        ],
      },
      {
        path: "/konfigurasi/event-jurnal",
        label: "Event Journal Mapping",
        title: "Event Journal Mapping",
        permission: "konfigurasi.parameter",
        summary:
          "Pemetaan peristiwa bisnis ke pasangan akun debit dan kredit, satu satunya jalur pembentukan jurnal otomatis.",
        willContain: [
          "Daftar event beserta akun debit dan kredit yang dipakai",
          "Validasi akun masih aktif dan sesuai tipe saldo normalnya",
          "Riwayat perubahan mapping beserta periode berlakunya",
          "Tidak ada modul yang boleh membuat baris jurnal di luar mapping ini",
        ],
      },
      {
        path: "/konfigurasi/nomor-dokumen",
        label: "Format Nomor Dokumen",
        title: "Format Nomor Dokumen",
        permission: "konfigurasi.parameter",
        summary: "Pola penomoran proposal, akad, jurnal, dan bukti, beserta reset counter per periode.",
        willContain: [
          "Pola nomor per jenis dokumen dengan komponen kode cabang, tahun, bulan, dan urutan",
          "Aturan reset counter per bulan atau per tahun",
          "Pratinjau nomor berikut yang akan terbentuk",
          "Nomor yang sudah terpakai tidak bisa dipakai ulang",
        ],
      },
      {
        path: "/konfigurasi/template-laporan",
        label: "Template Baris Laporan",
        title: "Template Baris Laporan",
        permission: "konfigurasi.parameter",
        summary:
          "Susunan baris Laporan Posisi Keuangan, Aktivitas, dan Arus Kas beserta akun yang masuk ke setiap baris.",
        willContain: [
          "Definisi baris laporan, urutan, indentasi, dan baris total",
          "Pemetaan akun ke baris laporan, satu akun tidak boleh terhitung dua kali",
          "Validasi Total Aset sama dengan Liabilitas plus Aset Neto",
          "Validasi Kas Akhir Arus Kas sama dengan saldo akun kas di Posisi Keuangan",
        ],
      },
    ],
  },
  {
    id: "portal",
    label: "Portal",
    icon: "portal",
    items: [
      {
        path: "/portal/pengajuan-pumk",
        label: "Pengajuan PUMK Online",
        title: "Pengajuan PUMK dari Portal Online",
        permission: "portal.view",
        summary:
          "Submission PUMK yang masuk dari portal publik, menunggu verifikasi petugas.",
        willContain: [
          "Daftar submission dengan nomor tiket, tanggal, pemohon, dan nilai diajukan",
          "Detail data pengajuan beserta dokumen yang diunggah pemohon",
          "Status verifikasi dan penanda sudah dikonversi atau belum",
          "Pemohon bisa cek status sendiri dengan nomor tiket ditambah NIK atau tanggal lahir",
        ],
      },
      {
        path: "/portal/pengajuan-non-pumk",
        label: "Pengajuan Non PUMK Online",
        title: "Pengajuan Non PUMK dari Portal Online",
        permission: "portal.view",
        summary: "Submission Non PUMK yang masuk dari portal publik.",
        willContain: [
          "Daftar submission dengan nomor tiket, tanggal, pemohon, bidang, dan nilai diajukan",
          "Detail data pengajuan beserta dokumen yang diunggah pemohon",
          "Status verifikasi dan penanda sudah dikonversi atau belum",
          "Rate limiting dan proteksi anti spam pada form publiknya",
        ],
      },
      {
        path: "/portal/verifikasi",
        label: "Verifikasi dan Konversi",
        title: "Verifikasi dan Konversi Submission",
        permission: "portal.konversi",
        summary:
          "Konversi submission portal menjadi proposal internal, dengan data yang tersalin dan tautan yang tersimpan.",
        willContain: [
          "Pemeriksaan kelengkapan data submission sebelum konversi",
          "Konversi menjadi proposal internal dengan sumber pengajuan PORTAL_ONLINE",
          "Tautan dua arah antara submission dan proposal hasil konversi",
          "Penolakan submission beserta alasan yang bisa dilihat pemohon",
        ],
      },
      {
        path: "/portal/akun-mitra",
        label: "Akun Mitra",
        title: "Akun Mitra Portal",
        permission: "portal.view",
        summary:
          "Pengelolaan akun Mitra Binaan yang sudah punya akad, untuk melihat jadwal dan riwayat pembayarannya sendiri.",
        willContain: [
          "Daftar akun mitra beserta status aktivasinya",
          "Reset akses dan penonaktifan akun",
          "Mitra hanya bisa melihat data akadnya sendiri",
          "Riwayat login mitra tercatat pada audit trail",
        ],
      },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    icon: "tools",
    items: [
      {
        path: "/tools/import-angsuran",
        label: "Import Angsuran",
        title: "Import Angsuran Massal",
        permission: "tools.import",
        summary:
          "Unggah setoran angsuran dari Excel, dengan pratinjau dan validasi per baris sebelum commit.",
        willContain: [
          "Pratinjau hasil parsing berikut validasi per baris",
          "Baris yang gagal ditampilkan beserta alasannya, baris valid bisa dicommit",
          "Commit sebagian selalu dilaporkan eksplisit, tidak pernah diam diam",
          "Jurnal penerimaan terbentuk per baris yang berhasil dicommit",
        ],
      },
      {
        path: "/tools/import-mitra",
        label: "Import Mitra Binaan",
        title: "Import Mitra Binaan Massal",
        permission: "tools.import",
        summary: "Unggah data Mitra Binaan dari Excel dengan validasi per baris.",
        willContain: [
          "Template Excel yang bisa diunduh beserta penjelasan kolomnya",
          "Validasi duplikasi NIK dan kelengkapan wilayah serta sektor",
          "Pratinjau baris valid dan baris gagal sebelum commit",
          "Laporan hasil import yang bisa diunduh",
        ],
      },
      {
        path: "/tools/import-saldo-awal",
        label: "Import Saldo Awal",
        title: "Import Saldo Awal",
        permission: "tools.import",
        summary:
          "Migrasi dari sistem lama: saldo awal per akun dan daftar akad beserta outstanding awalnya.",
        willContain: [
          "Unggah saldo awal per akun dan daftar akad beserta outstanding awal",
          "Validasi total saldo awal balance antara debit dan kredit",
          "Validasi sub ledger piutang cocok dengan saldo akun piutang",
          "Pratinjau sebelum commit, dengan laporan selisih bila ada",
        ],
      },
      {
        path: "/tools/rekonsiliasi",
        label: "Rekonsiliasi Piutang",
        title: "Rekonsiliasi Sub Ledger Piutang",
        permission: "tools.rekonsiliasi",
        summary:
          "Selisih antara sub ledger piutang dan buku besar, per cabang, dengan drill down ke akad penyebabnya.",
        willContain: [
          "Perbandingan saldo akun piutang di buku besar dengan total outstanding sub ledger",
          "Selisih per cabang dan per akun",
          "Drill down sampai akad yang menyebabkan selisih",
          "Selisih nol adalah kondisi yang wajib tercapai sebelum closing periode",
        ],
      },
      {
        path: "/tools/integritas",
        label: "Cek Integritas",
        title: "Cek Integritas Data",
        permission: "tools.integritas",
        summary:
          "Health check invarian sistem: temuan ditampilkan sebagai daftar yang bisa ditindaklanjuti.",
        willContain: [
          "Jurnal yang tidak balance antara total debit dan total kredit",
          "Akad dengan outstanding negatif",
          "Jadwal dengan total pokok tidak sama dengan pokok akad",
          "Snapshot kolektibilitas ganda pada satu periode",
        ],
      },
    ],
  },
];

/** Every route in the product, module pages and report pages alike. */
export const ALL_ROUTES: readonly PageRoute[] = NAV_GROUPS.flatMap((group) => group.items);

export interface RouteMatch {
  route: PageRoute;
  /** Values of the `:name` segments, e.g. { proposalId: "9f2c..." }. */
  params: Record<string, string>;
}

function normalize(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Match one path against one route pattern. A `:name` segment matches exactly
 * one non empty segment, and nothing else in the pattern is special: no
 * wildcards, no optional segments, no regular expressions. A matcher that can
 * only do this cannot silently swallow a path that was meant for another page.
 */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  if (!pattern.includes("/:")) return pattern === path ? {} : null;
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? "";
    const actual = pathParts[index] ?? "";
    if (expected.startsWith(":")) {
      if (actual === "") return null;
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

/**
 * Resolve a path to its page. An EXACT route always wins over a parameterised
 * one, so /pumk/proposal/baru opens the input form and never gets read as a
 * proposal whose id is the word "baru".
 */
export function matchRoute(path: string): RouteMatch | undefined {
  const normalized = normalize(path);
  const exact = ALL_ROUTES.find((route) => route.path === normalized);
  if (exact) return { route: exact, params: {} };
  for (const route of ALL_ROUTES) {
    const params = matchPattern(route.path, normalized);
    if (params) return { route, params };
  }
  return undefined;
}

export function findRoute(path: string): PageRoute | undefined {
  return matchRoute(path)?.route;
}

export function groupOfPath(path: string): NavGroup | undefined {
  const route = matchRoute(path)?.route;
  if (!route) return undefined;
  return NAV_GROUPS.find((group) => group.items.some((item) => item.path === route.path));
}

/**
 * Filter the navigation down to what the signed in permission set allows.
 * A group whose every item is hidden drops out entirely, so the sidebar never
 * shows an empty heading.
 *
 * This is a convenience for the user, not a security boundary: spec section 2
 * rule 4 requires the same check on the API for every request.
 */
export function visibleNav(permissions: readonly string[]): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const group of NAV_GROUPS) {
    const items = group.items.filter(
      (item) => !item.hideFromNav && hasPermission(permissions, item.permission),
    );
    if (items.length > 0) groups.push({ ...group, items });
  }
  return groups;
}

/** True when the permission set may open this path at all. */
export function canOpen(permissions: readonly string[], path: string): boolean {
  const route = findRoute(path);
  if (!route) return false;
  return hasPermission(permissions, route.permission);
}
