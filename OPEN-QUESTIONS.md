# OPEN QUESTIONS

Pertanyaan yang muncul dari pembacaan spesifikasi `PROMPT-TJSL-Online.md` saat membangun model
data, di mana spesifikasi **bertentangan dengan dirinya sendiri** atau tidak cukup untuk
menentukan satu jawaban. Untuk setiap butir dicatat bacaan paling konservatif yang dipakai
sekarang, supaya pekerjaan bisa lanjut tanpa mengarang aturan diam diam.

Butir yang sudah punya keputusan sementara juga tercatat di `ASSUMPTIONS.md`.

---

## 1. Idempotensi closing kolektibilitas: hapus atau perbarui?

**Konflik:** Bagian 8.1 menyatakan menjalankan ulang closing untuk periode yang sama
"menghapus snapshot lama periode itu dan menulis ulang". Invarian 12 (Bagian 3) menyatakan
semua entitas keuangan memakai soft delete dan tidak ada operasi yang menghapus data keuangan
secara fisik.

**Dipakai sekarang:** upsert di tempat. `kolektibilitas_snapshot` unik pada
`(periode_id, akad_id)` tanpa filter soft delete, jadi run ulang memperbarui baris yang sama.
Hasil akhir identik dengan "hapus lalu tulis ulang" dan tidak ada baris keuangan yang hilang.

**Perlu keputusan:** apakah hasil run yang digantikan perlu disimpan sebagai riwayat (butuh
kolom versi pada snapshot), atau cukup hasil terakhir saja.

## 2. Periode entitas-wide, tetapi closing kolektibilitas dan penyisihan per cabang

**Konflik:** `periode` didefinisikan per BUMN (Bagian 4.7) dengan satu status. Sementara closing
kolektibilitas (Bagian 8.1) dan `penyisihan_periode` (Bagian 4.7) berscope cabang, dan Bagian
8.4 checklist bicara soal "closing periode" tanpa menyebut cabang.

**Dipakai sekarang:** status periode berlaku untuk seluruh entitas. Satu cabang tidak bisa
"tutup sendiri". Closing kolektibilitas boleh dijalankan per cabang, tetapi periode baru boleh
di-CLOSED setelah semua prasyarat semua cabang terpenuhi.

**Perlu keputusan:** apakah ada kebutuhan cabang menutup pembukuannya lebih dulu (pola "soft
close per cabang, hard close per entitas"). Kalau ya, `periode` butuh tabel turunan status per
cabang, dan guard jurnal periode CLOSED harus jadi per cabang. Ini perubahan berdampak luas dan
jauh lebih murah diputuskan sekarang.

## 3. Kapan `ANGSURAN_JASA_ADM` versus `ANGSURAN_JASA_ADM_AKRUAL` dipakai?

**Konflik:** Bagian 6.4 menyediakan dua event: `ANGSURAN_JASA_ADM` (Kas / Pendapatan Jasa
Administrasi) dan `ANGSURAN_JASA_ADM_AKRUAL` (Kas / Piutang Jasa Administrasi). Bagian 8.3
menyatakan saat kas diterima "pakai event `ANGSURAN_JASA_ADM_AKRUAL`". Dengan default
`metode_pengakuan_jasa_adm = ACCRUAL`, tidak jelas kapan `ANGSURAN_JASA_ADM` masih terpakai:
saat jasa yang diterima belum pernah diakrual (misalnya akad kolektibilitas MACET yang tidak
diakrual, atau setoran di bulan yang sama sebelum closing), atau tidak terpakai sama sekali.

**Dipakai sekarang:** model data tidak memaksa pilihan. `event_jurnal_mapping` menyimpan kedua
event, dan `akrual_jasa_snapshot` menyimpan berapa jasa yang sudah diakrual per akad per
periode, sehingga engine bisa memutuskan per rupiah: sebesar yang pernah diakrual pakai event
akrual, sisanya pakai event non akrual.

**Perlu keputusan:** aturan pemilihan event tersebut wajib dikonfirmasi tim akuntansi sebelum
engine angsuran dibangun, karena salah pilih berarti pendapatan diakui dua kali.

## 4. Basis 360 hari dipakai di mana pada metode FLAT?

**Konflik:** `jasa_adm_basis_hari = 360` (Bagian 5.3) adalah parameter perhitungan harian,
sementara metode default FLAT dengan tenor bulanan biasanya dihitung
`pokok x rate x tenor / 12` tanpa basis hari.

**Dipakai sekarang:** parameter disimpan (`konfigurasi.jasa_adm_basis_hari`) tetapi model data
tidak mengasumsikan penggunaannya. Kandidat pemakaian: perhitungan jasa pro-rata untuk pelunasan
dipercepat, dan akrual harian di akhir periode saat tanggal jatuh tempo tidak jatuh di akhir
bulan.

**Perlu keputusan:** rumus resmi jasa administrasi untuk FLAT, EFEKTIF dan ANUITAS, dengan satu
contoh angka per metode. Ini prasyarat fase engine angsuran (test wajib Bagian 7.5 butir 1
sampai 4 tidak bisa ditulis tanpa ini).

## 5. Status akad sebelum pencairan tidak ada di daftar

**Konflik:** state machine Bagian 9.1 punya `AKAD_DIBUAT` dan `JADWAL_SIAP` sebelum `DICAIRKAN`,
tetapi daftar status akad Bagian 4.4 hanya `AKTIF / LUNAS / RESCHEDULED / MACET / HAPUS_BUKU`.

**Dipakai sekarang:** ditambahkan status `BELUM_CAIR` (lihat ASSUMPTIONS A-08), supaya akad yang
belum dijurnal tidak merusak rekonsiliasi sub buku besar piutang.

**Perlu keputusan:** konfirmasi penamaan status ini, karena akan muncul di UI dan laporan.

## 6. Dasar perhitungan penyisihan: pokok saja atau pokok plus jasa?

**Konflik:** Bagian 8.1 butir 5 menyatakan `nilai_penyisihan = outstanding_pokok x
rate_penyisihan` (mengunci basis ke pokok), sementara Bagian 5.2 meminta opsi konfigurasi
`OUTSTANDING_POKOK` atau `OUTSTANDING_POKOK_PLUS_JASA`.

**Dipakai sekarang:** konfigurasi disediakan dengan default `OUTSTANDING_POKOK` (sesuai Bagian
8.1), dan basis yang benar benar dipakai disimpan per baris snapshot sehingga periode lampau
tetap bisa direkonstruksi.

**Perlu keputusan:** apakah klien memang pernah memakai basis pokok plus jasa. Kalau tidak,
opsinya bisa dihapus dari UI untuk mengurangi peluang salah setel.

## 7. Reopen periode dan snapshot saldo

**Konflik:** Bagian 8.4 menyatakan reopen "otomatis menghapus snapshot saldo periode itu",
sementara invarian 12 melarang penghapusan fisik data keuangan.

**Dipakai sekarang:** `saldo_akun_periode` diperlakukan sebagai data turunan, bukan data
keuangan sumber, sehingga penghapusan fisiknya diizinkan (dan bisa dihasilkan ulang dari
ledger). Tabel ini satu satunya tabel keuangan yang tidak diberi proteksi hapus.

**Perlu keputusan:** apakah auditor klien menerima bahwa snapshot saldo periode yang di-reopen
hilang, atau perlu diarsipkan (butuh kolom "reopen ke berapa" dan penyimpanan berlapis).

## 8. Batas maksimum pinjaman aktif per mitra: aturan keras atau parameter?

**Konflik:** Bagian 5.5 menyebut `maks_pinjaman_aktif_per_mitra: 1` sebagai parameter
konfigurable, tetapi mengizinkan lebih dari satu piutang aktif per mitra mengubah arti
rekonsiliasi per mitra dan Kartu Piutang.

**Dipakai sekarang:** ditegakkan sebagai partial unique index di database (ASSUMPTIONS A-13),
jadi menaikkan batas butuh migrasi eksplisit, bukan sekadar edit konfigurasi.

**Perlu keputusan:** apakah klien pernah memberi lebih dari satu akad aktif ke satu mitra
(misalnya pinjaman modal kerja + pinjaman investasi). Kalau ya, index harus dibuang sebelum
fase seed.

## 9. Retensi data portal publik

**Tidak diatur spesifikasi:** berapa lama `portal_submission` berstatus DITOLAK (beserta
`data_json` yang memuat data pribadi dan `dokumen_json`) disimpan.

**Dipakai sekarang:** tidak ada penghapusan otomatis; kredensial cek status disimpan sebagai
hash (ASSUMPTIONS A-18).

**Perlu keputusan:** kebijakan retensi dan anonimisasi, sebelum portal publik dibuka.

## 10. Struktur akun Aset Neto Terikat Temporer

**Tidak cukup diatur:** Bagian 10.3 laporan 17 dan 19 meminta bagian "Perubahan Aset Neto
Terikat Temporer", tetapi tidak ada satu pun event di Bagian 6.4 yang mengkredit atau mendebit
aset neto terikat temporer, dan tidak ada mekanisme pelepasan pembatasan (release from
restriction).

**Dipakai sekarang:** `akun.tipe = 'ASET_NETO'` dan `baris_laporan` sudah mampu memuat kedua
kategori, jadi struktur laporannya bisa dibentuk sebagai data. Yang belum ada adalah event
jurnalnya.

**Perlu keputusan:** apakah unit TJSL klien benar benar punya dana terikat temporer, dan kalau
ya, event apa yang membentuk serta melepaskannya. Tanpa itu, bagian laporan tersebut akan selalu
nol.

---

# Integrasi Accurate Online (migrasi 0016, 0017)

Semua butir di bawah lahir dari dua ketidakpastian yang berbeda: keputusan pemilik yang belum
diambil, dan kemampuan API yang belum terverifikasi. Yang kedua hanya bisa dijawab dengan menarik
deskriptor API memakai akun developer Accurate Online; `docs/INTEGRASI-ACCURATE.md` bagian 0
menjelaskan batas metodologinya.

## 11. Siapa pemegang buku resmi TJSL? (fork scope terbesar di proyek ini)

**Belum diputuskan.** Ini bukan detail teknis, ini menentukan bentuk beberapa fase berikutnya.

- **Kalau sistem ini tetap pemegang buku** (default sekarang, sesuai spesifikasi Bagian 1: unit
  TJSL adalah entitas pelaporan tersendiri): Accurate hanya menerima jurnal ringkas untuk
  konsolidasi induk, laporan 17 sampai 20 tetap laporan resmi, COA kita bebas mengikuti struktur
  Bagian 10.3, dan perubahannya paling kecil.
- **Kalau Accurate jadi pemegang buku:** COA kita wajib mencerminkan COA Accurate persis (ini
  batasan pada `akun` itu sendiri, bukan hanya pada pemetaannya, dan layak ADR sendiri), laporan
  17 sampai 20 turun status menjadi laporan manajemen dan alat rekonsiliasi, granularitas push
  wajib per jurnal, dan status kirim wajib menjadi prasyarat closing.

**Dipakai sekarang:** default `SISTEM_INI` di `konfigurasi.pemegang_buku_resmi`, lapisan integrasi
inert, dan tidak ada satu pun laporan yang diturunkan statusnya. Lihat ADR 0008.

**Perlu keputusan:** pemilik repo bersama tim keuangan klien dan KAP-nya. Sebelum fase pelaporan
mulai, karena fase itu yang paling terpengaruh.

## 12. Apakah API Accurate menerima referensi eksternal, dan bisa dicari berdasarkan nomor kita?

**Belum terverifikasi.** Daftar Jurnal Umum menampilkan kolom `No. Trans #` (nomor transaksi
sumber), jadi konsepnya ada di model datanya, tetapi apakah bisa diisi lewat API dan apakah ada
endpoint pencarian berdasarkan nomor: tidak diketahui.

**Dipakai sekarang:** `no_jurnal` kita tetap dikirim sebagai `referensi_eksternal` dan dijaga sama
dengan nomor jurnal oleh trigger, tetapi idempotensi tidak bergantung pada Accurate menghormatinya.
Flag `dukung_referensi_eksternal` dan `dukung_baca_by_referensi` default false.

**Dampak kalau tidak didukung:** penyelesaian status `AMBIGU` harus manual (petugas mencari di
Accurate). Itu beban operasional yang harus disepakati sebelum push otomatis dinyalakan.

## 13. Apakah benar tidak ada mekanisme idempotensi di Accurate Online?

**Argumen dari ketiadaan sumber.** Tidak ada satu pun sumber yang menyebut idempotency key, header
dedup, atau jaminan "kirim dua kali tersimpan sekali", tetapi itu bukan bukti bahwa fiturnya tidak
ada.

**Dipakai sekarang:** diasumsikan tidak ada. Seluruh proteksi dobel posting ada di sisi kita
(unique index `(jurnal_id, sistem_kode)`, state machine dengan in-flight tercatat sebelum
panggilan, dan larangan retry atas `AMBIGU`). Lihat ADR 0009.

**Perlu verifikasi:** deskriptor API. Kalau ternyata ada, biayanya hanya status `AMBIGU` yang
jarang terpakai.

## 14. Berapa batas baris per voucher, dan berapa presisi desimal yang diterima?

**Tidak ada angka di sumber mana pun.** Yang ada hanya saran memecah impor besar, dan pengaturan
format desimal untuk cetakan (bukan presisi penyimpanan).

**Dipakai sekarang:** `maks_baris_per_dokumen` = 0 (belum diketahui) dan granularitas push default
`REKAP_PERIODE`.

**Perlu pengukuran empiris di database uji sebelum push otomatis dinyalakan.** Selisih pembulatan
pada level entitas pelaporan adalah temuan audit, jadi presisi desimal wajib diuji, bukan
diasumsikan sama dengan NUMERIC(20,2) kita.

## 15. Tata kelola master data pihak: siapa yang memelihara ratusan record Mitra di Accurate?

Buku pembantu piutang per Mitra hanya bisa terbentuk di Accurate kalau setiap Mitra Binaan menjadi
satu record pelanggan di sana. Untuk program dengan ratusan mitra, itu keputusan tata kelola, bukan
detail teknis: siapa yang berhak membuat, menonaktifkan, dan memelihara record tersebut, dan apa
yang terjadi kalau seseorang di sisi Accurate menghapus atau menggabungkannya.

**Dipakai sekarang:** `pemetaan_mitra_eksternal` satu ke satu di kedua arah, jadi penggabungan dua
Mitra ke satu record pelanggan tidak bisa terjadi lewat sistem ini (A-30).

**Alternatif kalau klien menolak:** push agregat tanpa dimensi pihak, dan buku pembantu per Mitra
tetap hanya ada di sistem ini. Itu pilihan yang sah, tetapi harus disadari, karena artinya
Accurate tidak akan pernah bisa menjawab "berapa piutang mitra X".

## 16. Kalau jurnal yang sudah dikirim diubah atau dihapus di Accurate, apa kebijakannya?

Jurnal umum di sana mutable, termasuk hapus massal. Sistem ini bisa mendeteksinya
(`status_remote`, `v_ekspor_perlu_keputusan`, `v_drift_saldo_eksternal`), tetapi deteksi bukan
kebijakan.

Tiga sikap yang mungkin: (a) perbedaan diterima dan didokumentasikan di laporan rekonsiliasi,
(b) selisihnya wajib dikoreksi di sisi Accurate oleh yang mengubahnya, (c) sistem ini mengirim
jurnal pembalik plus jurnal baru untuk memaksa angka kembali cocok.

**Dipakai sekarang:** hanya deteksi dan pencatatan, tanpa koreksi otomatis, dan koreksi apa pun
tetap lewat jurnal pembalik (bukan edit lewat API), karena itu satu satunya cara koreksi yang
tetap sah ketika periode tujuan sudah terkunci.

**Perlu keputusan:** menggantung di antara ketiganya adalah cara paling pasti menghasilkan angka
yang tidak bisa dipertanggungjawabkan.

## 17. Kapan status kirim menjadi prasyarat closing internal?

BUILD-PLAN butir 5 memintanya, dan datanya sudah tersedia (`v_jurnal_belum_terkirim`), tetapi
belum dipasang: integrasi yang belum diputuskan dan belum aktif tidak boleh bisa memblokir cutoff
akuntansi.

**Dipakai sekarang:** tidak ada kopling. Closing internal berjalan apa pun status ekspornya, dan
hal itu dibuktikan lewat tes psql.

**Perlu keputusan:** aktifkan bersamaan dengan keputusan butir 11 dan penyalaan push. Pemasangannya
satu trigger `BEFORE UPDATE` pada `periode`.

## 18. Bagaimana jurnal yang tanggalnya jatuh di periode Accurate yang sudah terkunci?

Periode di Accurate punya penguncian sendiri, dan bentuk pesan errornya belum diketahui. Sistem ini
sudah memvalidasi tanggal terhadap `periode` kita, tetapi kalender kita dan kalender mereka bisa
berbeda status.

**Dipakai sekarang:** tidak ada mekanisme khusus. Push memvalidasi terhadap periode kita saja.

**Perlu keputusan:** apakah jurnal semacam itu (a) ditahan sampai periode mereka dibuka,
(b) dikirim dengan tanggal periode berikutnya beserta keterangan, atau (c) ditandai
`DIKECUALIKAN` dan diselesaikan manual. Opsi (b) mengubah tanggal transaksi antara dua sistem dan
itu keputusan akuntansi, bukan teknis.

## 19. Multi mata uang

Accurate punya fitur mata uang dengan mata uang default per database; bagaimana jurnal umum
menangani baris mata uang asing lewat API tidak diketahui. Spesifikasi TJSL tidak menyebut mata
uang selain rupiah dan Bagian 15 menyatakan multi mata uang tidak dibangun.

**Dipakai sekarang:** semua angka rupiah, tanpa kolom mata uang di skema.

**Perlu konfirmasi:** bahwa database Accurate tujuan memang berbasis rupiah. Kalau tidak, push akan
menghasilkan konversi implisit, dan itu temuan audit.

## 20. Apakah engine closing menghitung jurnal REVERSED saat menulis `saldo_akun_periode`?

**Bukan pertanyaan kebijakan, ini pemeriksaan yang harus dilakukan sebelum periode pertama
ditutup.** Perbaikan 0018 menutup dua kebocoran di sisi skema (guard periode menolak pembalikan,
dan `v_rekonsiliasi_piutang` menghitung ganda), tetapi `saldo_akun_periode` **ditulis oleh kode**,
bukan oleh view.

Kalau engine closing menjumlahkan baris jurnal dengan filter `status = 'POSTED'` saja, maka setiap
pembalikan terhitung dua kali di neraca lajur periode itu. Karena snapshot itu dibekukan dan
menjadi sumber laporan periode lampau (invarian 14), angka salahnya menjadi **permanen dan tidak
terlihat**: `v_rekonsiliasi_eksternal` membaca snapshot itu dan akan melaporkan angka salah
tersebut dengan setia.

**Yang harus dilakukan:** engine closing wajib membaca `v_ledger_baris` (migrasi 0018), atau
memakai predikat `status IN ('POSTED','REVERSED') AND deleted_at IS NULL` secara eksplisit. Sudah
disampaikan ke pemilik engine closing lewat ADR 0010; dicatat di sini karena skema tidak bisa
memaksanya.

**Uji yang membuktikannya:** tutup satu periode yang memuat satu jurnal POSTED dan satu pasangan
pembalikan, lalu pastikan `saldo_akun_periode.saldo_akhir` sama dengan hasil agregat
`v_ledger_baris` untuk periode itu. Kalau berbeda, snapshot-nya salah, bukan view-nya.

---

## Scope cabang untuk audit trail: siapa boleh lihat baris siapa

`GET /audit` sekarang terikat scope cabang (Bagian 2 aturan 3): peran yang
terikat cabang hanya melihat baris yang **pelakunya** ada di cabangnya, karena
`audit_log` tidak punya kolom `cabang_id` dan pelaku (`user_id` ->
`app_user.cabang_id`) adalah satu satunya fakta cabang yang dibawa satu baris.

Dua konsekuensi yang perlu keputusan pemilik, bukan tebakan tim pembangun:

1. **Baris yang pelakunya di cabang Anda tetapi objeknya di cabang lain tetap
   terlihat.** Contoh: Admin Pusat memindahkan data cabang B sambil "bertindak
   sebagai" seseorang di cabang A. Menyaring berdasarkan objek berarti join per
   entitas (`entitas`, `entitas_id` bersifat polimorfik), dan itu keputusan
   desain yang lebih besar daripada satu predikat.
2. **Baris anonim (`user_id IS NULL`, misal login gagal) terlihat oleh semua
   pemegang `audit.view`.** Menyembunyikannya berarti menyembunyikan justru
   bukti percobaan penyusupan; mengatribusikannya ke satu cabang tidak mungkin,
   karena tidak diketahui siapa pelakunya.

Pertanyaan ke klien: apakah Auditor cabang (kalau nanti ada peran itu) boleh
melihat percobaan login gagal untuk seluruh entitas, atau harus dibatasi?
Sampai dijawab, default-nya seperti di atas dan `audit.view` hanya dipegang
Auditor dan Admin Pusat, yang keduanya lintas cabang.

## 22. Pemisahan role database: menjadikan guard jalur posting sebagai batas, bukan tripwire

**Ini keputusan devops, bukan migrasi.** Guard di migrasi 0020 mewajibkan setiap penulisan jurnal
mendeklarasikan jalurnya, dan itu menangkap kelalaian dengan andal. Tetapi ia **tidak** menangkap
niat: modul yang bisa menjalankan SQL bisa menyetel penanda yang sama di transaksinya sendiri
(dibuktikan sengaja di output psql). Selama aplikasi terhubung sebagai pemilik tabel, tidak ada
cara membuatnya lebih kuat dari dalam skema.

**Batas yang sebenarnya:**

1. buat role aplikasi terpisah, misalnya `tjsl_app`, yang bukan pemilik tabel;
2. `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON jurnal, jurnal_baris FROM tjsl_app`;
3. sediakan satu fungsi `SECURITY DEFINER` milik role pemilik sebagai satu satunya pintu tulis
   jurnal, dan `GRANT EXECUTE` ke `tjsl_app`;
4. arahkan `DATABASE_URL` aplikasi ke role baru itu.

Setelah itu spoofing tidak mungkin karena role aplikasi memang tidak punya hak tulis, dan finding
F-5 (TRUNCATE) juga tertutup di lapisan hak akses, bukan hanya oleh trigger.

**Konsekuensi yang harus disadari:** migrasi tetap dijalankan sebagai pemilik (dua kredensial,
bukan satu), fungsi `SECURITY DEFINER` menjadi permukaan yang wajib direview ketat, dan pengujian
lokal butuh role yang sama supaya perilaku dev dan produksi tidak berbeda.

**Sampai keputusan itu diambil:** trigger 0020 adalah kontrolnya, `tools/check-boundaries.ts`
adalah penegakan utama di CI, dan keduanya didokumentasikan apa adanya di ADR 0012. Jangan
menuliskan di dokumen mana pun bahwa jalur posting "tidak bisa dilewati", karena hari ini bisa.

---

## 23. Akrual jasa: di mana daftar kelas yang layak diakrual dibekukan?

**Pola yang sama, di tabel yang lain.** Migrasi 0024 menutup lubang rekonstruksi di
`kolektibilitas_snapshot` (asal rate penyisihan). Pemeriksaan dua tabel snapshot lain di 0011
menemukan satu lubang sejenis dan satu bukan:

- `saldo_akun_periode` **tidak** punya lubang ini. Empat kolomnya adalah angka debit positif hasil
  agregasi buku besar yang append only, saling diikat satu CHECK, dan tidak membaca satu pun
  parameter kebijakan, jadi tidak ada masukan yang bisa berubah di belakangnya. Risiko yang ada di
  sana adalah predikat status jurnal yang dipakai engine (butir 20 di dokumen ini, ADR 0010), bukan
  kolom yang hilang.
- `akrual_jasa_snapshot` **punya**. Ia menyimpan jasa jatuh tempo, jasa diterima, dan jasa
  diakrual per akad, tetapi tidak menyimpan `akuntansi.akrual_hanya_untuk_kolektibilitas`, yaitu
  daftar kelas yang berhak diakrual saat run itu berjalan. `HasilAkrual` menghitung daftar itu
  (`kelasDiakrual`) lalu membuangnya. Begitu daftarnya diubah, pertanyaan "kenapa akad DIRAGUKAN
  ini tidak diakrual di periode itu" tidak bisa dijawab dari snapshot, dan Laporan Akrual Piutang
  Jasa Administrasi (Bagian 10.4 laporan 30) kehilangan penjelasan populasinya. Persis invarian 14
  yang sama.

**Kenapa tidak langsung ditambal seperti 0024.** Faktanya bersifat **per run**, bukan per akad,
dan berbeda dengan kolektibilitas yang punya tabel induk `closing_kolektibilitas`, akrual tidak
punya baris induk untuk menggantungkannya. Jadi ada dua bentuk yang masuk akal dan keduanya
keputusan desain engine akrual, bukan tebakan migrasi:

1. tabel induk `closing_akrual` (periode, cabang, metode, daftar kelas, dijalankan_oleh), sejajar
   dengan `closing_kolektibilitas`, dan snapshot menunjuk ke sana; atau
2. satu kolom boolean per baris, misalnya `layak_akrual`, yang hanya berguna kalau engine memang
   menulis baris untuk akad yang tidak layak sekalipun.

**Yang dipakai sampai diputuskan:** tidak ada. Kolomnya belum ada, dan `akrual_jasa_snapshot`
masih kosong di setiap database karena engine-nya belum ada. Batas waktunya jelas: keputusan ini
harus diambil **sebelum periode produksi pertama ditutup**, karena setelah itu daftar kelas untuk
periode yang sudah tertutup tidak bisa dibangun ulang dan kolom baru hanya bisa diisi NULL.

**Pemilik keputusan:** pemilik engine closing (bentuk 1 atau 2), bukan tim akuntansi klien;
pertanyaan ke klien hanya soal isi daftar kelasnya, yang sudah menjadi baris konfigurasi.
