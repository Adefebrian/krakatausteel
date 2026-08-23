# REGULASI.md

Verifikasi dasar hukum dan dasar akuntansi yang dipakai spec `PROMPT-TJSL-Online.md`.
Tanggal riset: 23 Agustus 2026. Peneliti: agen riset (bukan penasihat hukum, bukan akuntan bersertifikat).

## 0. Metode dan keterbatasan (baca dulu)

Batasan teknis yang penting untuk dinilai pembaca: pada sesi riset ini alat pengambil halaman (fetch) tidak dapat dipakai, jadi **tidak ada satu pun dokumen yang saya buka sendiri baris per baris**. Semua kutipan di bawah berasal dari mesin pencari yang membaca dokumen sumber (PDF resmi peraturan.go.id, peraturan.bpk.go.id, jdih.bumn.go.id, laporan keuangan audited BUMN, publikasi IAI) lalu mengembalikan ringkasan atau kutipan. Ini satu tingkat lebih lemah daripada membaca teks pasal langsung.

Karena itu setiap temuan diberi label tingkat keyakinan:

| Label | Arti |
|---|---|
| A | Kutipan isi pasal dari dokumen resmi (PDF peraturan atau situs JDIH), diambil lewat mesin pencari, teks tidak dibuka langsung |
| B | Data dari laporan keuangan audited BUMN atau publikasi resmi IAI, diambil lewat mesin pencari |
| C | Ringkasan sekunder (kantor hukum, artikel, blog konsultan) |
| D | Belum terverifikasi, atau bukti negatif (saya tidak menemukan, bukan berarti tidak ada) |

Analisis saya sendiri (misalnya aritmetika konversi tarif) ditandai eksplisit sebagai **analisis**, bukan kutipan.

Dokumen primer yang WAJIB dibuka manual sebelum engine dibangun:

1. `https://peraturan.go.id/files/permen-bumn-no-per-1-mbu-03-2023-tahun-2023.pdf` (salinan resmi PER-1/MBU/03/2023, cek Pasal 22, pasal kualitas pinjaman, Pasal 30, Pasal 33, Pasal 41)
2. `https://ppid.kiw.co.id/regulasis/SALINAN%20PER-1-2023%20tentang%20Penugasan%20Khusus%20&%20program%20TJSL.pdf` (salinan tanda tangan, pembanding)
3. `https://jdihn.go.id/files/391/SE-02-MBU-WK-2012.pdf` (Pedoman Akuntansi PKBL Revisi 2012, sumber format laporan gaya PSAK 45 dan metode penyisihan)
4. SK-277/MBU/10/2023 (pedoman penyelesaian piutang bermasalah PUMK), belum ketemu URL teks lengkapnya
5. `https://web.iaiglobal.or.id/Berita-IAI/detail/pengesahan_amendemen_isak_335` dan naskah Amendemen ISAK 335 (3 Juni 2026)
6. Laporan keuangan PUMK/TJSL Krakatau Steel yang terakhir diaudit, plus kebijakan akuntansi TJSL internal Krakatau Steel. Ini yang paling menentukan, karena banyak pilihan di bawah adalah kebijakan entitas, bukan perintah peraturan.

## 1. Status PER-05/MBU/04/2021

### Yang diasumsikan spec

Bagian 1 spec: "TJSL Online adalah aplikasi administrasi dan pelaporan program tanggung jawab sosial BUMN, mengacu pada Peraturan Menteri BUMN Nomor PER-05/MBU/04/2021 tentang Program Tanggung Jawab Sosial dan Lingkungan BUMN." Spec memperlakukan peraturan ini sebagai dasar hukum yang berlaku.

### Temuan

1. **PER-05/MBU/04/2021 sudah TIDAK BERLAKU.** Rantainya: PER-05/MBU/04/2021 (April 2021) diubah oleh PER-6/MBU/09/2022 (Berita Negara 2022 Nomor 939), lalu keduanya dicabut oleh **PER-1/MBU/03/2023 Pasal 41**: pada saat Peraturan Menteri ini mulai berlaku, PER-05/MBU/04/2021 sebagaimana diubah dengan PER-6/MBU/09/2022 dicabut dan dinyatakan tidak berlaku. (A)
2. **Peraturan yang berlaku sekarang: PER-1/MBU/03/2023 tentang Penugasan Khusus dan Program Tanggung Jawab Sosial dan Lingkungan Badan Usaha Milik Negara**, Berita Negara 2023 Nomor 261, Maret 2023, bagian dari paket omnibus tiga Permen BUMN (PER-1, PER-2, PER-3/MBU/03/2023) yang menyederhanakan 45 Permen. (A untuk nomor dan judul, C untuk konteks omnibus)
   Catatan ketidakpastian: dua sumber sekunder menyebut tanggal berbeda (3 Maret 2023 dan 24 Maret 2023). Tanggal penetapan harus diambil dari salinan resmi. (D)
3. **Sampai Agustus 2026 saya tidak menemukan pencabutan atau penggantian PER-1/MBU/03/2023.** UU 1/2025 (perubahan UU BUMN, era Danantara) disebut memperkuat mandat TJSL di tingkat undang-undang, tetapi tidak ada bukti ia mencabut Permen ini. Ini bukti negatif, bukan konfirmasi. Halaman status resmi di `jdih.bumn.go.id` wajib dicek manual. (D)
4. Untuk empat hal yang ditanyakan secara spesifik:
   - **Split Pendanaan UMK vs non-UMK: tetap dua lini.** PER-1/MBU/03/2023 tetap memisahkan Program Pendanaan UMK (pinjaman atau pembiayaan syariah, ada pengembalian) dari bantuan Program TJSL (hibah, pilar ekonomi, sosial, lingkungan, serta hukum dan tata kelola), dengan fokus utama bidang pendidikan, lingkungan, dan pengembangan usaha mikro dan usaha kecil. (A)
     Hal baru yang relevan ke model data: BUMN dapat menyalurkan Program Pendanaan UMK dalam bentuk **hibah kepada mitra kerja sama atau lembaga penyalur**, jadi tidak selalu BUMN sendiri yang menjadi kreditur. (C, ringkasan Assegaf Hamzah & Partners; wujud praktiknya terlihat di laporan PUMK Peruri berupa akun "Piutang Penyaluran Kerjasama dengan BRI") (B)
     Plafon: modal kerja pinjaman atau pembiayaan syariah paling banyak **Rp250.000.000** per usaha mikro dan kecil, ditambah pendanaan tambahan untuk kebutuhan jangka pendek paling lama 1 tahun paling banyak **Rp100.000.000**. (A)
     Sumber dana PUMK (Pasal 30): anggaran biaya, alokasi dari cadangan laba bersih, sumber lain yang sah, saldo dana yang telah dialokasikan, serta jasa administrasi pinjaman, margin, atau bagi hasil. (A)
   - **Jasa administrasi: BERUBAH SUBSTANSI, lihat Bagian 3.** Pasal 22 ayat (2) dan ketentuan peralihan yang mewajibkan penyesuaian tarif lama paling lambat 3 bulan setelah peraturan berlaku. (A)
   - **Kolektibilitas: tidak berubah,** lihat Bagian 2.
   - **Penyisihan: tidak saya temukan persentase penyisihan di PER-1/MBU/03/2023.** Pasal 33 ayat (3) justru menyerahkan penyusunan laporan keuangan Program Pendanaan UMK ke standar akuntansi keuangan. Artinya besaran penyisihan kemungkinan besar adalah urusan standar akuntansi dan kebijakan entitas, bukan tarif yang diperintah Menteri. Ini bukti negatif dan harus dipastikan dengan membaca seluruh naskah. (D)

### Sumber

- Permen BUMN No. PER-05/MBU/04/2021, JDIH BPK: `https://peraturan.bpk.go.id/Home/Details/171151/permen-bumn-no-per-05mbu042021-tahun-2021`
- Permen BUMN No. PER-6/MBU/09/2022 (perubahan atas PER-05/MBU/04/2021), JDIH BPK: `https://peraturan.bpk.go.id/Details/232830/permen-bumn-no-per-6mbu092022-tahun-2022` dan JDIH BUMN: `https://jdih.bumn.go.id/peraturan/PER-6-MBU-09-2022`
- Permen BUMN No. PER-1/MBU/03/2023, JDIH BPK: `https://peraturan.bpk.go.id/Details/264274/permen-bumn-no-per-1mbu032023-tahun-2023`; PDF resmi: `https://peraturan.go.id/files/permen-bumn-no-per-1-mbu-03-2023-tahun-2023.pdf`; salinan: `https://ppid.kiw.co.id/regulasis/SALINAN%20PER-1-2023%20tentang%20Penugasan%20Khusus%20&%20program%20TJSL.pdf`
- Assegaf Hamzah & Partners, client update 25 Mei 2023 (sekunder): `https://www.ahp.id/bumn-omnibus-regulations-highlights-special-assignment-and-environmental-social-responsibility-programs/`
- Konteks omnibus: `https://bumn.go.id/publikasi/berita/rilis/detail/tiga-omnibus-peraturan-menteri-bumn-telah-diundangkan-2r`

### Dampak ke implementasi

- Semua referensi regulasi di kode, seed konfigurasi, header laporan, dan dokumen harus diganti ke PER-1/MBU/03/2023. Ini kelihatan sepele tapi muncul di laporan yang dibaca auditor.
- `konfigurasi` perlu menyimpan nomor peraturan sebagai nilai, bukan string hardcode, karena rezim ini sudah berganti tiga kali dalam lima tahun (2015, 2021, 2023).
- Default `plafon_max_pumk` = 250.000.000 dan `tenor_max_bulan` = 36. Butuh konsep plafon terpisah untuk "pendanaan tambahan jangka pendek" maksimal Rp100.000.000 dengan tenor maksimal 12 bulan, yang **tidak ada di spec** (spec hanya punya satu plafon dan satu tenor per akad, dan `maks_pinjaman_aktif_per_mitra` = 1 yang justru menghalangi skema tambahan ini).
- Model penyaluran lewat lembaga penyalur atau hibah ke mitra kerja sama belum ada di state machine PUMK spec Bagian 9.1. Kalau Krakatau Steel memakai skema ini, ada modul baru.

## 2. Kolektibilitas (spec 5.1) dan penyisihan (spec 5.2)

### Yang diasumsikan spec

Kolektibilitas: Lancar 0 sampai 30 hari, Kurang Lancar 31 sampai 180, Diragukan 181 sampai 270, Macet di atas 270.
Penyisihan: Lancar 0 persen, Kurang Lancar 25 persen, Diragukan 75 persen, Macet 100 persen, dasar perhitungan outstanding pokok.

### Temuan

1. **Batas hari: COCOK dengan peraturan yang berlaku.** PER-1/MBU/03/2023 menilai kualitas pinjaman Program Pendanaan UMK berdasarkan ketepatan pembayaran angsuran pokok dan jasa administrasi (untuk pembiayaan syariah: pokok, margin, dan atau porsi bagi hasil), dengan 4 kriteria:
   - Lancar: tepat waktu atau keterlambatan paling lama 30 hari dari tanggal jatuh tempo sesuai perjanjian
   - Kurang lancar: keterlambatan melampaui 30 hari sampai 180 hari
   - Diragukan: keterlambatan melampaui 180 hari sampai 270 hari
   - Macet: keterlambatan melampaui 270 hari
   (A)
   Batas ini identik dengan rezim PKBL lama, PER-09/MBU/07/2015 Pasal 21. (A)
   Catatan semantik batas: peraturan memakai "paling lama 30 hari" dan "melampaui 30 hari sampai 180 hari", jadi hari ke-30 masuk Lancar, hari ke-180 masuk Kurang Lancar, hari ke-270 masuk Diragukan. Rentang spec (0 sampai 30, 31 sampai 180, 181 sampai 270, di atas 270) ekuivalen untuk hari bulat. Aman.
2. **Persentase penyisihan 0, 25, 75, 100: TIDAK saya temukan di peraturan yang berlaku, dan bertentangan dengan praktik akuntansi PUMK yang berjalan sekarang.**
   - Laporan keuangan PUMK BUMN yang diaudit menyatakan kebijakan penyisihan dihitung **secara kolektif berdasarkan persentase tingkat kolektibilitas penagihan dari data historis, minimal 2 tahun**, mengacu Pedoman Akuntansi PKBL Revisi 2012 (SE-02/MBU/Wk/2012). Ini metode penurunan nilai (impairment), bukan tabel tarif per kelas kolektibilitas. (B)
   - Angka 0, 25, 75, 100 muncul di banyak sumber sekunder sebagai "ketentuan PKBL", dan sangat mungkin berasal dari pedoman akuntansi PKBL sebelum revisi 2012. Saya tidak berhasil mengonfirmasi angka ini di dokumen resmi yang berlaku hari ini. (C untuk keberadaan angka, D untuk status hukumnya)
   - Laporan audited yang saya sempat lihat juga menunjukkan bahwa penyisihan bisa **pulih** (ada pos pemulihan penyisihan piutang bermasalah), jadi arsitektur "beban penyisihan bisa negatif" di spec 8.2 sudah benar. (B, Perum Jasa Tirta II, laporan TJSL 2024 audited)
3. Konsekuensinya: tabel tarif per kelas kolektibilitas boleh dipakai sebagai **kebijakan entitas** kalau Krakatau Steel dan KAP-nya memang memakai itu, tetapi tidak boleh disajikan di aplikasi sebagai "sesuai peraturan".

### Sumber

- PER-1/MBU/03/2023, pasal kualitas pinjaman (nomor pasal belum terverifikasi): `https://peraturan.go.id/files/permen-bumn-no-per-1-mbu-03-2023-tahun-2023.pdf`
- PER-09/MBU/07/2015 Pasal 21 (rezim PKBL, sudah dicabut oleh PER-05/MBU/04/2021 yang juga sudah dicabut): `https://peraturan.bpk.go.id/Home/Details/146583/permen-bumn-no-per-09mbu072015-tahun-2015`
- SE-02/MBU/Wk/2012, Pedoman Akuntansi PKBL Revisi 2012: `https://jdihn.go.id/files/391/SE-02-MBU-WK-2012.pdf`
- Praktik: laporan keuangan Program Pendanaan UMK PT Timah Tbk `https://timah.com/userfiles/post/24042366276061F3E08.pdf`; Laporan PUMK AirNav tahun buku 2024 `https://www.airnavindonesia.co.id/wp-content/uploads/2025/10/Laporan-PUMK-Airnav-Tahun-Buku-2024-TJSL-1.pdf`; Laporan TJSL Perum Jasa Tirta II 2024 audited `https://www.jasatirta2.co.id/src/frontend/file/layanan/Laporan_TJSL_Tahun_2025_(Audited)_compressed.pdf`

### Dampak ke implementasi

- Tabel rentang hari kolektibilitas: aman dibangun sesuai spec, tetap sebagai tabel range yang bisa diedit.
- Engine penyisihan (spec 8.2) **tidak boleh** mengasumsikan hanya satu metode. Butuh minimal dua mode:
  - `TARIF_PER_KELAS`: rate per kolektibilitas dikali outstanding (versi spec)
  - `KOLEKTIF_HISTORIS`: rate per kelas atau per bucket dihitung dari data historis penagihan minimal 2 tahun, lalu diterapkan kolektif
  Mode kedua butuh penyimpanan rate hasil perhitungan per periode (agar reproducible) dan sumber data historis penagihan. Ini pekerjaan tambahan yang nyata, bukan sekadar config.
- `kolektibilitas_snapshot.rate_penyisihan` tetap berguna di kedua mode, tetapi harus jelas apakah nilainya berasal dari tabel konfigurasi atau hasil kalkulasi historis. Tambahkan kolom `sumber_rate`.
- Test spec 8.5 nomor 2 dan 4 (25 persen dan 100 persen) hanya valid untuk mode pertama. Test harus ditulis terhadap mode yang dipilih, dan mode itu dicatat di `ASSUMPTIONS.md`.

## 3. Jasa administrasi (spec 5.3 dan 7.1)

### Yang diasumsikan spec

`jasa_adm_rate_default` 3 persen per tahun, `jasa_adm_metode_default` FLAT, `jasa_adm_basis_hari` 360.
Rumus FLAT di spec 7.1: `total_jasa = pokok * rate * (tenor / 12)`.
Test wajib spec 7.5 nomor 1: pokok 10.000.000, rate 3 persen, tenor 12, FLAT, jasa total 300.000.

### Temuan

1. **PER-1/MBU/03/2023 Pasal 22 ayat (2): modal kerja berupa pinjaman untuk Program Pendanaan UMK dikenakan jasa administrasi sebesar 3 persen (tiga persen) EFEKTIF per tahun, atau tarif FLAT yang SETARA dengan 3 persen efektif per tahun, atau ketentuan lain yang ditetapkan Menteri, dengan tenor pinjaman paling lama 3 tahun.** (A)
2. Ada ketentuan peralihan: besaran jasa administrasi yang dikenakan BUMN sebelum peraturan ini berlaku wajib disesuaikan dengan ketentuan Pasal 22 ayat (2) paling lambat 3 bulan setelah peraturan berlaku. Satu sumber sekunder menyebut perubahan tarif diterapkan mulai 1 Januari 2023. (A untuk ketentuan peralihan, C untuk tanggal penerapan)
3. **Jadi asumsi spec "3 persen FLAT" tidak sesuai peraturan.** Peraturan mematok 3 persen dalam ukuran EFEKTIF. Kalau dipakai metode flat, tarif flatnya harus tarif yang ekuivalen 3 persen efektif, yang nilainya **lebih rendah** dari 3 persen.
   **Analisis (bukan kutipan):** untuk pinjaman yang diangsur bulanan dengan pokok rata selama 12 bulan, saldo rata-rata sekitar 54 persen dari pokok awal, sehingga tarif flat yang ekuivalen 3 persen efektif per tahun ada di kisaran 1,6 sampai 1,7 persen per tahun. Angka pastinya bergantung definisi "efektif" yang dipakai (bunga menurun sederhana, IRR anuitas, atau XIRR) dan itu **harus diputuskan tim akuntansi Krakatau Steel, bukan oleh kami**. Kalau kita bangun 3 persen flat, mitra binaan ditagih hampir dua kali lipat dari yang seharusnya dan pendapatan jasa administrasi overstated.
4. **Apakah dibatasi (cap)?** Bunyi pasal adalah penetapan besaran, bukan batas atas, dengan klausul pelarian "atau ketentuan lain yang ditetapkan Menteri". Jadi 3 persen efektif adalah angka yang diperintahkan, bukan plafon yang boleh diisi sesukanya, dan penyimpangan butuh dasar penetapan Menteri. (A, tetapi rumusan persisnya harus dibaca langsung karena ini menentukan apakah UI boleh mengizinkan input bebas)
5. **Basis hari 360 atau 365: tidak saya temukan diatur.** Di metode flat basis hari tidak dipakai. Di metode efektif, basis hari menentukan angka. Ini kebijakan entitas. (D)

### Sumber

- PER-1/MBU/03/2023 Pasal 22 ayat (2) dan ketentuan peralihan: `https://peraturan.go.id/files/permen-bumn-no-per-1-mbu-03-2023-tahun-2023.pdf`
- Pembanding praktik: laporan keuangan PUMK PT Timah Tbk `https://timah.com/userfiles/post/24042366276061F3E08.pdf`

### Dampak ke implementasi

- **Ini mengubah engine angsuran, bukan cuma satu nilai config.** Default seharusnya rate 3 persen dengan metode EFEKTIF, dan butuh fungsi konversi "tarif flat ekuivalen" kalau klien tetap ingin jadwal flat. Fungsi konversi ini butuh definisi efektif yang disepakati dan test fixture dari tim akuntansi klien.
- Test wajib spec 7.5 nomor 1 (jasa total 300.000) adalah fixture untuk interpretasi FLAT 3 persen. Kalau interpretasi efektif dipakai, fixture ini salah dan harus diganti. Jangan tulis test itu dulu sebelum keputusan turun.
- Validasi baru: `tenor_max_bulan` 36 adalah batas peraturan, bukan preferensi. Tenor di atas 36 bulan harus ditolak server, bukan hanya diberi warning.
- Perlu field di `pumk_akad` untuk mencatat dasar penetapan tarif kalau tarif menyimpang dari 3 persen (nomor SK Menteri atau dasar internal), demi jejak audit.

## 4. Format laporan keuangan: PSAK 45 vs ISAK 35 dan ISAK 335 (spec 1 dan 10.3)

### Yang diasumsikan spec

Unit TJSL adalah entitas pelaporan tersendiri bergaya nirlaba, laporannya Laporan Posisi Keuangan, Laporan Aktivitas, Laporan Arus Kas, Laporan Perubahan Aset Neto, dengan klasifikasi **Aset Neto Tidak Terikat** dan **Aset Neto Terikat Temporer**. `akun.tipe` memuat `ASET_NETO`, dan `klasifikasi_laporan` memetakan akun ke baris laporan.

### Temuan

1. **PSAK 45 sudah dicabut. Terminologi spec adalah terminologi PSAK 45, jadi secara standar sudah usang.** DSAK IAI mengesahkan ISAK 35 Penyajian Laporan Keuangan Entitas Berorientasi Nonlaba pada 11 April 2019 bersama Amendemen PSAK 1, Penyesuaian Tahunan PSAK 1, dan PPSAK 13, berlaku efektif untuk periode tahun buku yang dimulai pada atau setelah 1 Januari 2020. (B)
   Catatan: bahwa PPSAK 13 adalah instrumen pencabutan PSAK 45 adalah pemahaman umum yang muncul di sumber sekunder; judul persis PPSAK 13 belum saya konfirmasi dari IAI. (C)
2. **Apa yang diminta ISAK 35.** ISAK 35 adalah interpretasi atas PSAK 1 paragraf 05, dan isinya memberi contoh bagaimana entitas nonlaba menyesuaikan (i) deskripsi pos-pos dalam laporan keuangan dan (ii) deskripsi nama laporan keuangannya sendiri. Contoh Ilustratif ISAK 35 memakai set laporan: **Laporan Posisi Keuangan, Laporan Penghasilan Komprehensif, Laporan Perubahan Aset Neto, Laporan Arus Kas, dan Catatan atas Laporan Keuangan**. Laporan penghasilan komprehensif dibagi dua bagian sesuai klasifikasi aset neto. Ada dua opsi format laporan posisi keuangan (Format A dan Format B) terkait penyajian penghasilan komprehensif lain. (B)
3. **Klasifikasi aset neto menurut ISAK 35: tanpa pembatasan dari pemberi sumber daya dan dengan pembatasan dari pemberi sumber daya** (without restrictions dan with restrictions). Pembagian tiga arah PSAK 45 (tidak terikat, terikat temporer, terikat permanen) bukan rumusan ISAK 35. (B)
4. **Nama laporan tidak dipaksa.** Amendemen PSAK 1 yang disahkan bersama ISAK 35 membuka opsi yang memperkenankan entitas memakai judul laporan selain yang dipakai PSAK 1. Jadi "Laporan Aktivitas" bukan pelanggaran, tetapi ia bukan istilah standar dan bukan istilah contoh ilustratif. (B)
5. **Penomoran berubah: ISAK 35 menjadi ISAK 335, PSAK 1 menjadi PSAK 201, berlaku 1 Januari 2024, tanpa perubahan substansi.** Sitasi resmi hari ini adalah ISAK 335. (B)
6. **Ada perubahan yang akan datang dan ini penting untuk roadmap.** Pada 3 Juni 2026 DSAK IAI mengesahkan **Amendemen ISAK 335** untuk mengakomodasi PSAK 118 (adopsi IFRS 18, menggantikan PSAK 201, berlaku efektif 1 Januari 2027). Amendemen menambah **format laporan kinerja keuangan** yang mensyaratkan penyajian subklasifikasi **operasi, investasi, pendanaan, pajak penghasilan, dan operasi yang dihentikan** di bagian surplus defisit, serta menambah format laporan arus kas yang selaras PSAK 118. (B)
   Artinya: bentuk "Laporan Aktivitas" bergaya PSAK 45 akan makin jauh dari standar, dan untuk tahun buku 2027 struktur baris laporan berubah lagi.
7. **Apakah pedoman BUMN tetap memaksa format lama?** Yang saya temukan: PER-1/MBU/03/2023 **Pasal 33 ayat (3)** hanya mewajibkan laporan keuangan Program Pendanaan UMK tahunan diaudit kantor akuntan publik terpisah dari audit laporan keuangan BUMN, **disusun sesuai standar akuntansi keuangan**, untuk mendapat pengesahan RUPS atau Menteri. Saya **tidak menemukan** format baris laporan yang diperintahkan Permen. (A untuk isi Pasal 33, D untuk ketiadaan format)
   Format gaya PSAK 45 yang dipakai spec berasal dari Pedoman Akuntansi PKBL (SE-02/MBU/Wk/2012), dan **status berlaku pedoman itu setelah PER-1/MBU/03/2023 belum terverifikasi**. PER-1/MBU/03/2023 Pasal 41 mencabut Permen, bukan Surat Edaran, jadi SE itu bisa jadi masih dianggap berlaku secara praktik. (D)
8. **Praktik di lapangan terbelah, dan ini kontradiksi yang harus dilaporkan apa adanya:**
   - Peruri: laporan keuangan TJSL 2023 dinyatakan disusun menggunakan **ISAK 35** setelah pencabutan PSAK 45. (B)
   - PT Timah Tbk: laporan keuangan Program Pendanaan UMK 2023 masih memakai klasifikasi **aset neto terikat dan aset neto tidak terikat**. (B)
   - Perum Jasa Tirta II: laporan TJSL 2024 audited masih memakai pos **aset neto tidak terikat**. (B)
   Kesimpulan jujur: istilah lama masih lolos audit di 2023 dan 2024, tampaknya sebagai judul alternatif yang diperkenankan Amendemen PSAK 1, tetapi ia bukan rumusan standar. Yang mengikat kita adalah pilihan Krakatau Steel bersama KAP-nya, bukan preferensi kita.

### Sumber

- Pengesahan ISAK 35, Amendemen PSAK 1, Penyesuaian Tahunan PSAK 1, PPSAK 13, IAI: `https://web.iaiglobal.or.id/Berita-IAI/detail/pengesahan-isak-35-amendemen-psak-1-penyesuaian-tahunan-psak-1-dan-ppsak-13`
- Draf Eksposur ISAK 35 (contoh ilustratif dan format A/B), IAI: `https://web.iaiglobal.or.id/assets/files/file_sak/exposure-draft/DE%20ISAK%2035.pdf`
- Perubahan penomoran PSAK dan ISAK, IAI: `https://web.iaiglobal.or.id/Berita-IAI/detail/penomoran_psak_dan_isak_dalam_sak_indonesia` dan komparasi `https://web.iaiglobal.or.id/assets/files/file_publikasi/Komparasi%20Perubahan%20Penomoran%20PSAK%20ISAK%20SAK%20Indonesia_FINAL.pdf`
- Post-implementation review ISAK 335, discussion paper Maret 2025: `https://web.iaiglobal.or.id/assets/files/file_sak/1.%20Discussion%20Paper%20PIR%20ISAK%20335%20(2025,%20Maret%2017).pdf`
- Pengesahan Amendemen ISAK 335 (3 Juni 2026) dan PSAK 118: `https://web.iaiglobal.or.id/Berita-IAI/detail/pengesahan_amendemen_isak_335`
- SAK Indonesia efektif per 1 Januari 2025: `https://web.iaiglobal.or.id/Berita-IAI/detail/standar_akuntansi_keuangan_indonesia_efektif_per_1_januari_2025`
- PER-1/MBU/03/2023 Pasal 33: `https://peraturan.go.id/files/permen-bumn-no-per-1-mbu-03-2023-tahun-2023.pdf`
- Praktik: Peruri laporan TJSL 2023 `https://ppid.peruri.co.id/assets/media/file/laporan-tjsl-2023.pdf`; PT Timah PUMK `https://timah.com/userfiles/post/24042366276061F3E08.pdf`; Perum Jasa Tirta II laporan TJSL 2024 audited `https://www.jasatirta2.co.id/src/frontend/file/layanan/Laporan_TJSL_Tahun_2025_(Audited)_compressed.pdf`

### Dampak ke implementasi

Ini yang paling mahal kalau salah, karena menyentuh COA, `baris_laporan`, dan lima laporan di spec 10.3 sekaligus.

- **Jangan hardcode enum `TIDAK_TERIKAT` dan `TERIKAT_TEMPORER`.** Tambahkan kelas aset neto sebagai data referensi (`kelas_aset_neto`: kode, label, urutan), berisi minimal `TANPA_PEMBATASAN` dan `DENGAN_PEMBATASAN`, dengan kemampuan memberi label warisan ("Aset Neto Tidak Terikat") kalau klien memilih istilah lama. Kolom `akun.tipe = ASET_NETO` tetap, yang dinamis adalah kelasnya.
- **Nama laporan harus data, bukan konstanta di kode.** Set laporan harus bisa dikonfigurasi antara set warisan (Laporan Aktivitas) dan set ISAK 335 (Laporan Penghasilan Komprehensif). Judul laporan muncul di header cetak, nama file export, dan menu, jadi jadikan satu sumber.
- `klasifikasi_laporan` dan `baris_laporan` harus mendukung **lebih dari satu template laporan aktif berdampingan**, karena kita bisa harus menyajikan format warisan untuk periode lama dan format baru untuk periode baru tanpa merusak reproducibility laporan periode lampau (invarian spec nomor 14).
- Siapkan ruang untuk subklasifikasi operasi, investasi, pendanaan pada baris laporan kinerja keuangan, karena Amendemen ISAK 335 dan PSAK 118 berlaku 2027. Tidak perlu dibangun sekarang, tetapi jangan bikin skema yang menutup pintunya.
- Keputusan ini harus datang dari tim akuntansi Krakatau Steel dan KAP-nya sebelum COA di-seed. Menyeed COA dengan asumsi salah berarti migrasi data akun dan pemetaan laporan setelahnya.

## 5. Hapus buku dan penghapusan bersyarat piutang Mitra Binaan

### Yang diasumsikan spec

Glosarium: "Hapus Buku: Penghapusan piutang macet dari neraca, piutang tetap dicatat ekstrakomtabel."
`pumk_pengakhiran` jenis LUNAS_DIPERCEPAT, HAPUS_BUKU, PENGHAPUSAN_BERSYARAT, dengan `dasar_keputusan`, `no_sk`, `approved_by`.
Event 6.4: `HAPUS_BUKU_PIUTANG` debit Penyisihan Penurunan Nilai Piutang, kredit Piutang Pinjaman Mitra Binaan. `PENERIMAAN_HAPUS_BUKU` debit Kas, kredit Pendapatan Lain lain.

### Temuan

1. **Perlakuan ekstrakomtabel yang dijelaskan spec sesuai dengan pedoman yang berlaku.** Keputusan Menteri BUMN **SK-277/MBU/10/2023 tanggal 4 Oktober 2023** tentang pedoman penyelesaian piutang bermasalah pada Program Pendanaan UMK BUMN: Direksi dapat melakukan **penghapusbukuan** dan **penghapustagihan** atas piutang bermasalah; penghapusbukuan dilakukan setelah berbagai upaya optimal penyelesaian piutang bermasalah ditempuh; penghapusbukuan dilakukan dengan **mengeluarkan catatan dari akun piutang bermasalah dan mencatatnya secara tersendiri, tanpa menghapus hak tagih** atas piutang tersebut. (C, ringkasan mesin pencari atas dokumen kebijakan TJSL BUMN yang mengutip SK ini; teks SK sendiri belum saya temukan)
2. **Istilah peraturan adalah penghapusbukuan dan penghapustagihan.** Istilah spec "penghapusan bersyarat" tidak muncul di sumber yang saya temukan. Kemungkinan itu istilah warisan pengelolaan piutang negara, bukan istilah PUMK. Perlu dikonfirmasi apakah klien memang memakai istilah itu secara internal. (D)
3. **Level persetujuan belum terverifikasi.** Sumber menyebut kewenangan ada di Direksi, tetapi apakah butuh persetujuan Dewan Komisaris atau RUPS di atas nilai tertentu belum saya konfirmasi. Kandidat sumber: SK-277/MBU/10/2023 sendiri, dan PER-2/MBU/03/2023 tentang Pedoman Tata Kelola dan Kegiatan Korporasi Signifikan BUMN yang biasanya mengatur ambang kewenangan penghapusan piutang. (D)
4. **Masalah teknis di event mapping spec (analisis saya, bukan temuan regulasi):**
   - `HAPUS_BUKU_PIUTANG` yang mendebit Penyisihan sebesar seluruh outstanding hanya benar kalau saldo penyisihan atas akad itu sudah menutup penuh outstanding. Kalau penyisihan lebih kecil (misalnya penyisihan dihitung kolektif historis, bukan 100 persen untuk Macet), jurnal ini membuat akun kontra aset bersaldo debit dan neraca jadi salah. Butuh jalur kekurangan penyisihan yang membebankan sisanya ke beban penyisihan pada saat hapus buku.
   - Tidak ada event untuk **penghapustagihan**. Penghapustagihan menghapus hak tagih, jadi ia harus mengeluarkan piutang dari catatan ekstrakomtabel dan tidak boleh lagi muncul di daftar tagih. Tanpa event dan tanpa tabel ekstrakomtabel yang nyata, dua peristiwa yang berbeda hukum akan tercampur.
   - Piutang hapus buku perlu jadi tabel tersendiri (bukan hanya status di `pumk_akad`), karena harus bisa dilaporkan, ditagih, diterima cicilannya (`PENERIMAAN_HAPUS_BUKU`), dan direkonsiliasi terpisah dari buku besar.

### Sumber

- SK-277/MBU/10/2023, dikutip di dalam Pedoman TJSL PT KIW: `https://ppid.kiw.co.id/pdfs/daftar_informasi/1729569049_Pedoman%20TJSL%20PT%20KIW%202023.pdf` (sekunder, mengutip SK)
- PER-2/MBU/03/2023 tentang Pedoman Tata Kelola dan Kegiatan Korporasi Signifikan BUMN: `https://peraturan.bpk.go.id/Details/264291/permen-bumn-no-per-2mbu032023-tahun-2023`
- JDIH Kementerian BUMN untuk mencari teks SK-277/MBU/10/2023: `https://jdih.bumn.go.id/`

### Dampak ke implementasi

- Tambah event `HAPUS_TAGIH_PIUTANG` dan `KEKURANGAN_PENYISIHAN_HAPUS_BUKU` (atau perluas `BEBAN_PENYISIHAN` untuk dipakai saat hapus buku).
- Tambah tabel `piutang_ekstrakomtabel` (akad_id, tanggal_hapus_buku, no_sk, outstanding_pokok, outstanding_jasa, penerimaan_kumulatif, status AKTIF atau DIHAPUS_TAGIH) plus laporannya. Ini menyelesaikan sekaligus laporan penerimaan atas piutang hapus buku yang biasanya diminta auditor.
- Simpan level otorisasi (Direksi, Dewan Komisaris, RUPS) dan nomor dasar keputusan pada `pumk_pengakhiran`. Jangan cukup `approved_by` user aplikasi, karena persetujuan sebenarnya terjadi di luar sistem.
- Konfirmasi istilah "penghapusan bersyarat" dengan klien sebelum dipakai di UI.

## 6. Kewajiban pelaporan yang belum ada di spec

### Yang diasumsikan spec

Katalog laporan spec Bagian 10 berisi 24 laporan operasional dan akuntansi, semuanya berbasis periode bulanan dan cabang, dengan export Excel dan PDF. Tidak ada mekanisme paket pelaporan ke Kementerian, tidak ada siklus triwulanan, tidak ada paket audit.

### Temuan

1. **PER-1/MBU/03/2023 Pasal 33: setiap BUMN wajib menyusun laporan keuangan dan laporan pelaksanaan Program TJSL BUMN yang disampaikan kepada Menteri dalam laporan triwulanan dan laporan tahunan. Laporan keuangan dan laporan pelaksanaan Program TJSL menjadi satu kesatuan dengan laporan triwulanan dan laporan tahunan kinerja BUMN, dituangkan dalam bab tersendiri.** (A)
2. **Pasal 33 ayat (3): khusus laporan keuangan Program Pendanaan UMK tahunan harus diaudit kantor akuntan publik secara terpisah dari audit laporan keuangan BUMN, disusun sesuai standar akuntansi keuangan, untuk mendapat pengesahan RUPS atau Menteri.** (A)
3. **Orientasi SDGs dan ISO 26000 bersifat wajib pada level program.** Pelaksanaan Program TJSL BUMN diorientasikan pada pencapaian Sustainable Development Goals dan berpedoman pada ISO 26000 sebagai panduan pelaksanaan program. (A untuk kewajiban SDGs dan ISO 26000 di peraturan, C untuk rumusan persisnya)
4. **Batas waktu penyampaian laporan triwulanan dan tahunan: belum terverifikasi.** Kandidat sumber adalah PER-2/MBU/03/2023 (pelaporan kinerja BUMN) dan ketentuan RKAP. (D)
5. **Kewajiban lain yang perlu diperiksa relevansinya untuk Krakatau Steel sebagai emiten:** POJK 51/POJK.03/2017 tentang Keuangan Berkelanjutan mewajibkan Laporan Keberlanjutan bagi emiten, dan data TJSL adalah sumber datanya. Relevansi ke aplikasi ini adalah ekspor data, bukan laporan baru. (C, belum diverifikasi ke naskah POJK)
6. **Satu praktik penyajian yang bertentangan dengan spec.** Laporan keuangan PUMK PT Timah 2023 menyajikan seluruh nilai **angsuran belum teridentifikasi sebagai pengurang saldo piutang pinjaman mitra binaan**, bukan sebagai liabilitas. Spec (glosarium dan spec 6.4 event `TERIMA_ANGSURAN_BELUM_TERIDENTIFIKASI`, serta spec 10.3 Laporan Posisi Keuangan) memperlakukannya sebagai liabilitas suspense. Keduanya bisa benar tergantung kondisi (Timah menyebut ada ketentuan yang harus dipenuhi), tetapi penyajian di neraca berbeda. (B)

### Sumber

- PER-1/MBU/03/2023 Pasal 33: `https://peraturan.go.id/files/permen-bumn-no-per-1-mbu-03-2023-tahun-2023.pdf`
- PER-2/MBU/03/2023: `https://peraturan.bpk.go.id/Details/264291/permen-bumn-no-per-2mbu032023-tahun-2023`
- Pedoman TJSL PT KIW 2023 (contoh penerapan, sekunder): `https://ppid.kiw.co.id/pdfs/daftar_informasi/1729569049_Pedoman%20TJSL%20PT%20KIW%202023.pdf`
- PT Timah PUMK, perlakuan angsuran belum teridentifikasi: `https://timah.com/userfiles/post/24042366276061F3E08.pdf`

### Dampak ke implementasi

- Tambah konsep **periode pelaporan triwulanan** di samping periode bulanan. Closing tetap bulanan, tetapi paket laporan harus bisa dirakit per triwulan (Tw I, Tw II, Tw III, Tw IV) dan per tahun.
- Tambah fitur **paket laporan** (satu aksi, satu file, urutan laporan tetap) untuk dua tujuan berbeda: paket ke Kementerian (bab TJSL dalam laporan kinerja BUMN) dan paket audit KAP (neraca lajur, buku besar, daftar akad, daftar penyisihan, rekonsiliasi sub ledger). Paket audit ini hampir gratis karena laporannya sudah ada di spec 10.3, yang belum ada hanya perakitannya.
- Tambah status pengesahan laporan tahunan (RUPS atau Menteri) sebagai atribut periode tahunan, agar terlihat mana angka yang sudah disahkan dan tidak boleh diubah lagi.
- Pemetaan SDG sudah ada di spec (bagus). Tambahkan pemetaan ke pokok bahasan ISO 26000 kalau klien memakainya untuk pelaporan.
- Keputusan penyajian angsuran belum teridentifikasi (liabilitas atau pengurang piutang) harus diambil sebelum `baris_laporan` di-seed.

## Perlu keputusan pemilik repo

Diurutkan dari yang paling mahal kalau kita bangun versi spec dan ternyata salah.

| # | Titik konflik | Versi spec | Temuan riset | Biaya rework kalau spec salah | Keputusan yang dibutuhkan | Pemutus |
|---|---|---|---|---|---|---|
| 1 | Terminologi dan format laporan entitas nirlaba (spec Bagian 1, 4.2 `klasifikasi_laporan`, 10.3 laporan 17 sampai 20) | Aset Neto Tidak Terikat dan Terikat Temporer, Laporan Aktivitas (PSAK 45) | PSAK 45 dicabut, ISAK 35 (kini ISAK 335) memakai tanpa pembatasan dan dengan pembatasan serta Laporan Penghasilan Komprehensif; judul lain diperkenankan; praktik audited BUMN masih terbelah; Amendemen ISAK 335 (3 Juni 2026) dan PSAK 118 mengubah format lagi mulai 2027 | Sangat tinggi. Menyentuh seed COA, `baris_laporan`, 5 laporan, snapshot saldo, dan test balance. Salah di sini berarti migrasi akun setelah data masuk | Set istilah dan set nama laporan mana yang dipakai, dan apakah kita siapkan dua template berdampingan | Tim akuntansi Krakatau Steel bersama KAP |
| 2 | Tarif dan metode jasa administrasi (spec 5.3, 7.1, test 7.5 nomor 1) | 3 persen per tahun, FLAT, basis 360 | PER-1/MBU/03/2023 Pasal 22 ayat (2): 3 persen EFEKTIF per tahun, atau flat yang setara 3 persen efektif, tenor maksimal 3 tahun | Sangat tinggi. Mengubah engine jadwal, akrual, alokasi setoran, dan seluruh fixture test. 3 persen flat menagih mitra hampir dua kali lipat | Definisi "efektif" yang dipakai, dan apakah jadwal disajikan efektif atau flat ekuivalen | Tim akuntansi klien, dengan fixture angka dari mereka |
| 3 | Metode penyisihan (spec 5.2, 8.2, test 8.5 nomor 2, 4, 6) | Tarif tetap per kelas 0, 25, 75, 100 persen atas outstanding pokok | Tidak ditemukan di peraturan yang berlaku. Laporan PUMK audited memakai impairment kolektif berbasis tingkat kolektibilitas historis minimal 2 tahun (Pedoman Akuntansi PKBL Revisi 2012) | Tinggi. Kalau mode kolektif historis yang dipakai, engine closing butuh sumber data historis, penyimpanan rate per periode, dan test baru | Mode penyisihan mana yang berlaku di Krakatau Steel, dan kalau tarif tetap, apa dasar kebijakannya | Tim akuntansi klien dan KAP |
| 4 | Hapus buku, penghapustagihan, dan kekurangan penyisihan (spec glosarium, 4.4 `pumk_pengakhiran`, 6.4) | Satu event `HAPUS_BUKU_PIUTANG` mendebit penuh akun Penyisihan, ekstrakomtabel hanya konsep | Ekstrakomtabel benar (SK-277/MBU/10/2023), tetapi peraturan membedakan penghapusbukuan dan penghapustagihan; spec tidak menangani penyisihan yang tidak cukup; ekstrakomtabel butuh tabel nyata | Sedang ke tinggi. Menambah event, tabel, dan laporan, tetapi belum tersentuh data | Apakah penghapustagihan masuk scope prototype, dan level otorisasi mana yang direkam | Pemilik repo bersama unit TJSL klien |
| 5 | Rujukan dasar hukum di seluruh aplikasi (spec Bagian 1) | PER-05/MBU/04/2021 | Dicabut oleh PER-1/MBU/03/2023 Pasal 41 | Rendah secara kode, tinggi secara kredibilitas. Muncul di header laporan yang dibaca auditor | Konfirmasi bahwa rujukan diganti dan disimpan sebagai konfigurasi | Pemilik repo, langsung |
| 6 | Siklus dan paket pelaporan ke Kementerian (spec Bagian 10) | Hanya laporan bulanan dan tahunan per cabang | Pasal 33 mewajibkan laporan triwulanan dan tahunan ke Menteri, dalam bab tersendiri di laporan kinerja BUMN, plus audit KAP terpisah untuk laporan keuangan PUMK tahunan dengan pengesahan RUPS atau Menteri | Sedang. Scope baru, tetapi memakai laporan yang sudah ada | Apakah paket triwulanan dan paket audit masuk scope prototype atau fase berikutnya | Pemilik repo |
| 7 | Batas program (spec 5.5) | `plafon_max_pumk` dan `tenor_max_bulan` tanpa nilai default; satu plafon per akad; `maks_pinjaman_aktif_per_mitra` = 1 | Peraturan: modal kerja maksimal Rp250.000.000, pendanaan tambahan jangka pendek maksimal 1 tahun maksimal Rp100.000.000, tenor maksimal 3 tahun | Sedang. Skema pendanaan tambahan butuh akad kedua yang berjalan bersamaan, bertentangan dengan aturan maksimal 1 pinjaman aktif | Apakah pendanaan tambahan jangka pendek dipakai Krakatau Steel | Unit TJSL klien |
| 8 | Penyajian Angsuran Belum Teridentifikasi (spec glosarium, 6.4, 10.3 laporan 19) | Liabilitas suspense | Laporan PUMK PT Timah 2023 menyajikannya sebagai pengurang piutang pinjaman mitra binaan | Sedang. Mengubah pemetaan baris Laporan Posisi Keuangan dan makna rekonsiliasi sub ledger di spec 8.4 nomor 10 | Penyajian mana yang dipakai, dan kalau pengurang piutang, apa syaratnya | Tim akuntansi klien |
| 9 | Penyaluran PUMK lewat lembaga penyalur atau hibah ke mitra kerja sama | Tidak ada di state machine spec 9.1 | Diperkenankan oleh PER-1/MBU/03/2023 (sumber sekunder), dan terlihat di praktik (akun Piutang Penyaluran Kerjasama dengan bank) | Sedang. Modul dan akun baru kalau dipakai | Apakah Krakatau Steel menyalurkan langsung atau lewat penyalur | Unit TJSL klien |
| 10 | Rentang hari kolektibilitas (spec 5.1) | 0 sampai 30, 31 sampai 180, 181 sampai 270, di atas 270 | COCOK dengan PER-1/MBU/03/2023 dan identik dengan PER-09/MBU/07/2015 Pasal 21 | Nol, cukup dikonfirmasi | Tidak ada keputusan, hanya verifikasi pasal saat naskah dibuka | Pemilik repo |
| 11 | `jasa_adm_basis_hari` 360 atau 365 (spec 5.3) | 360 | Tidak diatur peraturan sejauh yang saya temukan; hanya relevan di metode efektif | Rendah, tetap konfigurasi | Ikut keputusan nomor 2 | Tim akuntansi klien |
| 12 | Status Pedoman Akuntansi PKBL SE-02/MBU/Wk/2012 setelah 2023 | Spec tidak menyebut sama sekali, tetapi memakai formatnya | Belum terverifikasi. PER-1/MBU/03/2023 Pasal 41 mencabut Permen, bukan Surat Edaran | Tinggi secara tidak langsung, karena inilah yang menentukan nomor 1, 3, dan 8 | Tanyakan ke unit TJSL klien apakah pedoman ini masih dipakai sebagai acuan internal | Unit TJSL klien |

### Yang secara jujur tidak berhasil saya verifikasi

1. Nomor pasal untuk ketentuan kualitas pinjaman di PER-1/MBU/03/2023 (isinya terkonfirmasi, nomor pasalnya belum).
2. Apakah PER-1/MBU/03/2023 memuat ketentuan penyisihan sama sekali. Ini bukti negatif dari pencarian, bukan hasil pembacaan seluruh naskah.
3. Status berlaku PER-1/MBU/03/2023 per Agustus 2026 secara resmi, termasuk dampak UU 1/2025 dan penataan kelembagaan setelahnya.
4. Teks SK-277/MBU/10/2023 dan ambang kewenangan penghapusbukuan serta penghapustagihan.
5. Status berlaku SE-02/MBU/Wk/2012.
6. Batas waktu penyampaian laporan triwulanan dan tahunan TJSL ke Menteri.
7. Judul persis PPSAK 13 sebagai instrumen pencabutan PSAK 45.
8. Tanggal penetapan PER-1/MBU/03/2023 (sumber sekunder menyebut 3 Maret dan 24 Maret 2023).

Semua delapan hal di atas dapat diselesaikan dengan membuka enam dokumen yang didaftar di Bagian 0 secara manual. Sampai itu dilakukan, jangan tulis test engine untuk nomor 2 dan 3 di tabel keputusan.
