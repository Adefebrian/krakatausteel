# ASSUMPTIONS

Daftar asumsi yang diambil saat membangun model data TJSL Online (fase model data, migrasi
`0002` sampai `0015`). Format tiap entri: **apa yang diasumsikan**, **kenapa**, dan **dampak
kalau asumsi ini salah**.

Semua nilai parameter di Bagian 5 spesifikasi diperlakukan sebagai **default asumsi yang wajib
dikonfirmasi ke tim akuntansi klien**. Semuanya tersimpan sebagai baris data di tabel
`konfigurasi`, `kolektibilitas_range`, `penyisihan_rate`, dan `alokasi_setoran_preset`, dengan
kolom penanda `konfigurasi.perlu_konfirmasi = true`. Tidak ada satu pun yang di-hardcode di
kode aplikasi.

---

## A-01. Hierarki cabang satu tingkat

**Diasumsikan:** struktur organisasi hanya dua lapis, yaitu 1 kantor pusat dan N cabang di
bawahnya langsung. Tabel `cabang` tidak punya `parent_id`; scope otorisasi dan filter laporan
adalah kesamaan langsung pada `cabang_id`. Persis satu baris `is_pusat` per BUMN (dijaga
partial unique index).

**Kenapa:** Bagian 4.1 mendefinisikan `cabang` hanya dengan flag `is_pusat` tanpa parent, dan
Bagian 13 meminta seed 1 pusat + 3 cabang. Tidak ada satu pun laporan di Bagian 10 yang
mengelompokkan per wilayah antara pusat dan cabang.

**Dampak kalau salah:** kalau ternyata ada lapis wilayah (pusat, wilayah, cabang), penambahan
kolom `cabang.parent_id` bersifat aditif dan kolom `cabang_id` yang sudah didenormalisasi tetap
benar karena selalu menunjuk cabang terdaftar. Yang harus dikerjakan ulang adalah setiap
agregat "Semua Cabang" dan setiap pemeriksaan hak akses, karena keduanya harus jadi query
rekursif. Perkiraan: satu migrasi aditif + satu fungsi resolusi scope + revisi semua query
laporan berscope cabang. Lihat `docs/adr/0007`.

## A-02. Sampel COA 80 sampai 100 akun, `klasifikasi_laporan` wajib terisi

**Diasumsikan:** COA contoh berjumlah 80 sampai 100 akun sesuai struktur Bagian 10.3, dan
`akun.klasifikasi_laporan` dibuat **NOT NULL** untuk semua akun (termasuk akun induk), dengan
foreign key komposit ke `baris_laporan (bumn_id, kode)`.

**Kenapa:** dikonfirmasi pemilik repo. `klasifikasi_laporan` adalah satu satunya kunci pemetaan
akun ke baris laporan; kalau boleh NULL, akan ada akun yang tidak muncul di laporan mana pun
dan selisihnya baru ketahuan saat audit.

**Dampak kalau salah:** kalau klien ingin sebagian akun tanpa pemetaan laporan, kolom harus
dilonggarkan jadi nullable (migrasi aditif, mudah). Sebaliknya, urutan seeding jadi terikat:
`baris_laporan` wajib di-seed sebelum `akun`. Ini didokumentasikan supaya tidak jadi kejutan
saat fase seed.

## A-03. Default kredit: jasa administrasi 3 persen FLAT, basis 360 hari

**Diasumsikan:** `jasa_adm_rate_default = 0.030000` per tahun, `jasa_adm_metode_default = FLAT`,
`jasa_adm_basis_hari = 360`, `pembulatan_angsuran = 0`, urutan alokasi setoran
`TUNGGAKAN_JASA, TUNGGAKAN_POKOK, JASA_BERJALAN, POKOK_BERJALAN, KELEBIHAN` (preset `DEFAULT`),
dan `metode_pengakuan_jasa_adm = ACCRUAL`.

**Kenapa:** dikonfirmasi pemilik repo, sesuai default Bagian 5.3, 5.4 dan 5.6. Semuanya
tersimpan sebagai baris `konfigurasi` dan `alokasi_setoran_preset`, bisa diubah lewat menu
Konfigurasi tanpa deploy.

**Dampak kalau salah:** mengubah rate, metode, atau urutan alokasi hanya mengubah data, bukan
kode. Tetapi **jurnal yang sudah POSTED tidak dihitung ulang**: perubahan parameter hanya
berlaku untuk akad dan setoran berikutnya. Kalau klien butuh perhitungan ulang retroaktif, itu
pekerjaan koreksi manual lewat jurnal pembalik, bukan konfigurasi. Perubahan
`metode_pengakuan_jasa_adm` dari ACCRUAL ke CASH_BASIS di tengah tahun buku akan meninggalkan
saldo Piutang Jasa Administrasi yang harus dihapus lewat jurnal koreksi eksplisit.

## A-04. Rentang kolektibilitas dan rate penyisihan versi default

**Diasumsikan:** rentang hari 0-30 / 31-180 / 181-270 / lebih dari 270 dan rate 0 / 25 / 75 /
100 persen, dengan dasar perhitungan `OUTSTANDING_POKOK`.

**Kenapa:** default Bagian 5.1 dan 5.2. Disimpan sebagai baris di `kolektibilitas_range` dan
`penyisihan_rate`, bukan if-else di kode, dan **diberi tanggal berlaku** (`berlaku_dari`).

**Dampak kalau salah:** rate baru dibuat sebagai baris baru dengan `berlaku_dari` di masa
depan; periode yang sudah CLOSED tetap memakai rate yang dipakainya saat itu, karena
`kolektibilitas_snapshot` menyimpan `rate_penyisihan` dan `dasar_perhitungan` per baris dan ada
CHECK yang menurunkan ulang `nilai_penyisihan` dari keduanya. Jadi perubahan rate tidak pernah
mengubah angka periode lampau. Kalau klien justru **ingin** perhitungan ulang periode lampau,
itu wajib reopen periode.

## A-05. Jasa administrasi selama grace period tidak dihitung

**Diasumsikan:** selama `grace_period_bulan`, mitra tidak membayar pokok **dan** tidak dibebani
jasa administrasi. Disimpan sebagai `konfigurasi.jasa_grace_period = TIDAK_DIHITUNG`, dengan
alternatif `DIHITUNG_DITANGGUHKAN` (jasa dihitung, ditagih setelah grace) dan
`DIHITUNG_DIBAYAR` (jasa tetap ditagih bulanan selama grace).

**Kenapa:** spesifikasi menyebut `grace_period_bulan` di akad dan `GRACE_PERIOD` sebagai jenis
reschedule, tetapi tidak pernah menyatakan perlakuan jasa administrasi selama masa itu. Tiga
kebijakan di atas semuanya lazim di praktik BUMN. Pilihan paling konservatif untuk mitra dan
paling sederhana untuk jadwal dipakai sebagai default.

**Dampak kalau salah:** total jasa administrasi seumur akad berubah, artinya
`pumk_jadwal_angsuran.jasa_adm` dan `pumk_akad.outstanding_jasa` berubah untuk semua akad
bergrace. Skema tidak perlu diubah (kebijakan ini murni parameter engine jadwal), tetapi akad
yang jadwalnya sudah di-generate harus di-reschedule, bukan diperbaiki di tempat, karena jadwal
bersifat immutable. Ini alasan asumsi ini perlu dikonfirmasi **sebelum** fase engine angsuran.

## A-06. Konfigurasi bertingkat: baris global lalu override per BUMN

**Diasumsikan:** `konfigurasi`, `kolektibilitas_range` dan `penyisihan_rate` boleh punya
`bumn_id NULL` yang berarti "default platform". Resolusi nilai: ambil baris milik BUMN itu,
kalau tidak ada pakai baris global.

**Kenapa:** default Bagian 5 harus sudah ada sebelum ada satu pun baris `bumn` (migrasi tidak
boleh mengarang data master klien). Baris global adalah cara menyimpan default sebagai data,
bukan sebagai konstanta di kode.

**Dampak kalau salah:** kalau klien menolak konsep default global, semua baris global harus
disalin jadi baris per BUMN dan kolom `bumn_id` dijadikan NOT NULL (migrasi mudah). Yang perlu
diperhatikan: setiap query konfigurasi **wajib** memakai pola "baris BUMN dulu, baru global";
kalau ada kode yang lupa, ia akan membaca default global padahal klien sudah override.

## A-07. Periode akuntansi selalu bulan kalender

**Diasumsikan:** satu baris `periode` = satu bulan kalender penuh (`tanggal_mulai` = tanggal 1,
`tanggal_akhir` = akhir bulan, dijaga CHECK). Tahun buku yang tidak dimulai Januari
(`bumn.tahun_buku_mulai_bulan`) diperlakukan sebagai pengelompokan 12 baris bulanan saat
pelaporan, bukan bentuk periode yang berbeda.

**Kenapa:** Bagian 4.7 mendefinisikan periode dengan `tahun` dan `bulan`, dan Bagian 8 berbicara
soal closing bulanan.

**Dampak kalau salah:** kalau klien butuh periode 13 (periode penyesuaian audit di akhir tahun),
CHECK `periode_window_ck` harus dilonggarkan dan `bulan` harus mengizinkan nilai 13. Itu migrasi
kecil, tapi mengubah asumsi "bulan 1 sampai 12" di seluruh laporan komparatif bulanan.

## A-08. Status akad `BELUM_CAIR`

**Diasumsikan:** ada satu status akad tambahan di luar daftar Bagian 4.4, yaitu `BELUM_CAIR`,
untuk akad yang sudah ditandatangani tetapi pencairannya belum dijurnal.

**Kenapa:** state machine Bagian 9.1 punya langkah `AKAD_DIBUAT` dan `JADWAL_SIAP` **sebelum**
`DICAIRKAN`, sementara daftar status akad hanya menyediakan `AKTIF` sebagai status awal. Kalau
akad yang belum cair dipaksa berstatus `AKTIF`, ia akan ikut terhitung di rekonsiliasi sub buku
besar piutang (Bagian 8.4 butir 10) padahal buku besar belum mencatat apa pun, sehingga
rekonsiliasi selalu selisih.

**Dampak kalau salah:** kalau klien memang ingin akad langsung `AKTIF`, hapus nilai
`BELUM_CAIR` dari CHECK dan sesuaikan index `pumk_akad_outstanding_idx`. Risiko sebaliknya
lebih besar: tanpa status ini, checklist closing akan memblokir closing karena selisih semu.

## A-09. Bobot SDG tidak wajib berjumlah 1

**Diasumsikan:** `nonpumk_proposal_sdg.bobot` bernilai lebih dari 0 sampai 1, default 1, dan
jumlah bobot satu proposal **tidak** dipaksa sama dengan 1.

**Kenapa:** Bagian 4.1 menyebut pemetaan SDG "bisa many to many dengan bobot" tanpa aturan
normalisasi. Memaksa jumlah = 1 adalah aturan karangan yang akan menyulitkan input.

**Dampak kalau salah:** laporan kontribusi SDG bisa menghitung nilai program lebih dari sekali
kalau bobot diisi 1 untuk beberapa SDG sekaligus. Kalau klien butuh normalisasi, tambahkan
deferred constraint trigger per proposal; datanya tidak perlu diubah bentuknya.

## A-10. Tabel `akrual_jasa_snapshot` diadakan sendiri

**Diasumsikan:** perlu satu tabel per akad per periode untuk akrual jasa administrasi, meski
Bagian 4 tidak menyebutnya.

**Kenapa:** Bagian 8.3 mewajibkan akrual bulanan yang idempoten, dan laporan nomor 30 (Laporan
Akrual Piutang Jasa Administrasi) harus reproducible untuk periode yang sudah CLOSED. Keduanya
mustahil kalau angkanya dihitung ulang dari data master yang bisa berubah (invarian 14).

**Dampak kalau salah:** kalau klien tidak butuh rincian per akad, tabel ini bisa ditinggalkan
tanpa mengganggu apa pun (tidak ada tabel lain yang bergantung padanya).

## A-11. Konvensi tanda `saldo_akun_periode` adalah debit positif

**Diasumsikan:** `saldo_awal`, `mutasi_debit`, `mutasi_kredit`, `saldo_akhir` semuanya dalam
konvensi **debit positif**. Akun bersaldo normal kredit (liabilitas, aset neto, pendapatan)
karena itu bersaldo negatif di tabel ini. Penyajian membalik tanda memakai `akun.saldo_normal`.

**Kenapa:** satu konvensi untuk semua tipe akun membuat identitas `saldo_akhir = saldo_awal +
mutasi_debit - mutasi_kredit` bisa dijadikan CHECK, dan membuat total Neraca Lajur berjumlah nol
alih alih dua angka yang harus dibandingkan.

**Dampak kalau salah:** kalau tim akuntansi ingin saldo disimpan sesuai saldo normal (selalu
positif), setiap laporan yang membaca tabel ini harus diubah dan CHECK identitas harus dihapus.
Ini keputusan yang lebih murah dikonfirmasi sekarang daripada setelah 20 periode ditutup.

## A-12. Penamaan kolom dan tabel yang menyimpang dari spesifikasi

**Diasumsikan:**

- tabel `user` menjadi `app_user` dan `role` menjadi `app_role` (keduanya kata kunci Postgres);
- `uploaded_by` / `uploaded_at` pada `mitra_dokumen` dan `lampiran` **adalah** `created_by` /
  `created_at` dari blok audit standar, bukan kolom tambahan;
- `sdg_ids` pada `nonpumk_proposal` diwujudkan sebagai tabel relasi `nonpumk_proposal_sdg`,
  bukan array.

**Kenapa:** Bagian 4 mengizinkan penyesuaian nama kolom ke konvensi repo selama semantik dan
relasinya sama. Array tidak bisa membawa bobot dan tidak bisa di-join untuk laporan SDG.

**Dampak kalau salah:** hanya penamaan; tidak ada dampak angka. Perlu dicatat di dokumentasi API
supaya kontrak yang dibaca klien tetap memakai istilah spesifikasi.

## A-13. Satu pinjaman aktif per mitra ditegakkan sebagai unique index

**Diasumsikan:** `maks_pinjaman_aktif_per_mitra = 1` (default Bagian 5.5) ditegakkan di database
lewat partial unique index pada `pumk_akad (mitra_id)` untuk status `BELUM_CAIR`, `AKTIF`,
`RESCHEDULED`, `MACET`. Mitra yang akadnya `LUNAS` atau `HAPUS_BUKU` boleh mengajukan lagi.

**Kenapa:** parameternya memang konfigurable, tetapi nilai 1 adalah aturan yang paling mahal
kalau dilanggar (piutang ganda ke orang yang sama). Selama nilainya 1, database yang menjaganya.

**Dampak kalau salah:** kalau klien menaikkan batas di atas 1, index ini harus di-DROP lewat
migrasi eksplisit dan penegakan pindah ke layer aplikasi yang membaca `konfigurasi`. Ini
disengaja: menaikkan batas harus jadi keputusan yang terlihat, bukan efek samping edit
konfigurasi.

## A-14. Keputusan tambahan pada review dan approval

**Diasumsikan:** `pumk_review.keputusan` dan `nonpumk_review.keputusan` mengizinkan
`MINTA_PERBAIKAN` selain `REKOMENDASI` / `TIDAK_REKOMENDASI`, dan `*_approval.keputusan`
mengizinkan `KEMBALIKAN` selain `SETUJU` / `TOLAK`.

**Kenapa:** state machine Bagian 9.1 punya transisi "Checker minta perbaikan" dan "Approver
kembalikan", tetapi daftar nilai keputusan di Bagian 4.4 tidak memuatnya. Tanpa nilai ini,
transisi yang diminta spesifikasi tidak bisa dicatat.

**Dampak kalau salah:** kalau klien tidak mengenal alur pengembalian, nilai tersebut cukup tidak
dipakai; tidak ada dampak angka.

## A-15. Kolom denormalisasi: `nonpumk_proposal.jumlah_disetujui` dan `pumk_akad.cabang_id`

**Diasumsikan:** nilai disetujui disalin dari `nonpumk_approval` ke `nonpumk_proposal`, dan
`cabang_id` disalin dari `pumk_proposal` ke `pumk_akad`. Keduanya dijaga: `cabang_id` oleh
trigger yang menolak nilai berbeda dari proposalnya, dan `jumlah_disetujui` oleh deferred
trigger yang memblokir total penyaluran melebihi nilai itu.

**Kenapa:** setiap laporan PUMK memfilter per cabang, dan pagu penyaluran Non PUMK harus bisa
diperiksa dalam satu lookup, bukan subquery ke tabel approval terakhir.

**Dampak kalau salah:** kalau approval boleh direvisi setelah penyaluran berjalan, kolom
`jumlah_disetujui` bisa jadi tidak sinkron dengan baris approval terakhir. Tim aplikasi wajib
memperbarui keduanya dalam satu transaksi.

## A-16. Timeline transisi status disimpan di tabel sendiri

**Diasumsikan:** `pumk_proposal_transisi` dan `nonpumk_proposal_transisi` (append only) adalah
sumber timeline di halaman detail proposal, terpisah dari `audit_log`.

**Kenapa:** Bagian 9.1 mewajibkan setiap transisi mencatat siapa, kapan, dan catatan apa, serta
menampilkannya sebagai timeline. `audit_log` adalah jejak teknis semua entitas dan tidak enak
dipakai sebagai sumber tampilan bisnis.

**Dampak kalau salah:** duplikasi kecil antara dua tabel. Kalau klien ingin satu sumber saja,
timeline bisa dibaca dari `audit_log` dan tabel transisi dihapus tanpa mengganggu angka.

## A-17. Idempotensi closing kolektibilitas dilakukan dengan upsert, bukan hapus fisik

**Diasumsikan:** menjalankan ulang closing kolektibilitas untuk periode yang sama
**memperbarui** baris `kolektibilitas_snapshot` yang ada (unique pada `(periode_id, akad_id)`,
tanpa filter soft delete), bukan menghapusnya lalu menulis ulang.

**Kenapa:** Bagian 8.1 menulis "menghapus snapshot lama periode itu dan menulis ulang",
sementara invarian 12 melarang penghapusan fisik data keuangan. Bacaan paling konservatif yang
memenuhi keduanya adalah upsert di tempat: hasil akhirnya identik dan tidak ada baris yang
hilang. Lihat OPEN-QUESTIONS.md butir 1.

**Dampak kalau salah:** kalau klien benar benar butuh jejak "snapshot versi sebelumnya", perlu
tambahan kolom versi pada snapshot atau tabel riwayat. Bentuk sekarang tidak menyimpan hasil
run yang dibatalkan.

## A-18. Kredensial cek status portal disimpan sebagai hash

**Diasumsikan:** kombinasi nomor tiket + tanggal lahir atau NIK yang dipakai publik untuk cek
status disimpan sebagai `portal_submission.pemeriksa_hash`, bukan sebagai NIK terbuka.

**Kenapa:** Bagian 9.5 memerlukan mekanisme cek status tanpa login, dan nilai pembandingnya
adalah data pribadi. Menyimpan hash cukup untuk verifikasi dan mengurangi dampak kebocoran.

**Dampak kalau salah:** kalau petugas perlu melihat NIK pemohon online sebelum konversi, NIK
tetap tersedia di `data_json` (isi formulir apa adanya). Perlu keputusan retensi: berapa lama
`data_json` submission yang DITOLAK disimpan.

## A-19. Invarian 9 hanya ditegakkan database untuk jadwal versi 1

**Diasumsikan:** "total angsuran pokok = pokok pinjaman" ditegakkan database hanya untuk jadwal
`versi = 1`. Untuk versi hasil reschedule, total pokok adalah outstanding saat reschedule, dan
kecocokannya diperiksa engine reschedule serta view `v_integritas_jadwal`.

**Kenapa:** reschedule jenis `RESTRUKTUR_POKOK` justru mengubah dasar perhitungan, sehingga
membandingkannya dengan pokok pinjaman awal pasti gagal.

**Dampak kalau salah:** kalau klien memastikan reschedule tidak pernah mengubah pokok, trigger
bisa diperluas ke semua versi (lebih ketat, migrasi mudah).

## A-20. NIK mitra unik bila diisi

**Diasumsikan:** `mitra.nik` unik untuk baris yang belum dihapus, tetapi boleh NULL (calon mitra
dari portal bisa belum lengkap).

**Kenapa:** tanpa keunikan NIK, batas satu pinjaman aktif per mitra bisa dilanggar hanya dengan
mendaftarkan orang yang sama dua kali.

**Dampak kalau salah:** kalau di data lama ada NIK ganda yang sah (misalnya salah input yang
belum dibersihkan), import mitra massal akan menolak baris tersebut. Itu memang perilaku yang
diinginkan, tapi harus dikomunikasikan sebelum migrasi go-live.
