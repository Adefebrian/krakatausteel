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

**TERJAWAB, migrasi 0030 dan ADR 0018.** Aturannya persis yang dirumuskan di sini: **per
rupiah**, sebesar yang pernah diakrual pakai `ANGSURAN_JASA_ADM_AKRUAL`, sisanya
`ANGSURAN_JASA_ADM`, dan satu setoran boleh memakai keduanya. Yang berubah dari catatan lama
hanyalah SUMBER faktanya: `akrual_jasa_snapshot` per akad per periode tidak cukup untuk
menjawab "berapa jasa BARIS INI yang sudah jadi piutang", jadi faktanya pindah ke kolom
`pumk_jadwal_angsuran.jasa_akrual_belum_tertagih`, ditulis mesin akrual closing dan dikurangi
saat jasanya tertagih.

Sampai itu dikerjakan, engine memilih event hanya dari
`akuntansi.metode_pengakuan_jasa_adm`, dan akibatnya persis yang ditakutkan di butir ini,
hanya dengan tanda terbalik: setiap setoran mengkredit Piutang Jasa Administrasi tanpa debit
pasangannya, sehingga 1.1.04 bersaldo negatif dan pendapatan jasa tidak pernah diakui.
Neraca tetap balance, jadi tidak ada pemeriksaan integritas yang menangkapnya.

**Masih perlu konfirmasi tim akuntansi**, tapi bukan lagi sebagai prasyarat: satu kasus batas
yang sengaja ditolak keras, bukan ditebak, adalah reschedule yang membuat jasa jadwal baru
LEBIH KECIL dari jasa yang sudah diakrual sebagai pendapatan. Itu penghapusan pendapatan
(waiver) dan spec 6.4 tidak punya eventnya, jadi engine menolak dengan
`AKRUAL_TIDAK_TERTAMPUNG`. Kalau tim akuntansi memang menghendaki waiver, event jurnalnya
harus dinamai lebih dulu.

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

## 11. Siapa pemegang buku resmi TJSL? SUDAH DIPUTUSKAN 2026-08-31

**Keputusan pemilik repo: sistem ini yang memegang buku.** Accurate Online hanya menerima jurnal ringkas untuk konsolidasi induk. Laporan 17 sampai 20 tetap laporan resmi, COA bebas mengikuti struktur Bagian 10.3, dan lapisan integrasi tetap satu arah dan opsional.

Dasar keputusan, dicatat supaya bisa ditinjau ulang kalau premisnya berubah:

1. Spesifikasi Bagian 1 menyebut unit TJSL sebagai entitas pelaporan tersendiri, dan PER-1/MBU/03/2023 Pasal 33 ayat 3 mewajibkan laporan PUMK diaudit KAP **secara terpisah**. Mendorong detail TJSL ke buku korporat induk berarti mencampur dua entitas yang justru wajib terpisah.
2. Permukaan integrasi Accurate lemah untuk dijadikan buku resmi, menurut `docs/INTEGRASI-ACCURATE.md`: tidak ditemukan mekanisme idempotensi, jurnalnya bisa diedit dan dihapus dari sisi sana, dan ada kasus terdokumentasi baris jurnal ke akun piutang dengan jenis pihak salah yang hilang diam-diam dari buku pembantu. Memindahkan buku resmi ke sana berarti memindahkan kebenaran angka ke sistem yang lebih sulit dijamin.

**Yang membatalkan keputusan ini** kalau ternyata benar: instance Accurate yang dimaksud adalah company file milik unit TJSL sendiri, bukan buku korporat induk, DAN laporan PUMK yang diaudit KAP selama ini memang dicetak dari Accurate. Kalau keduanya benar, pola buku pembantu memberi umpan ke buku besar adalah yang baku dan keputusan ini harus ditinjau.

**Yang berubah karena keputusan ini:** tidak ada laporan diturunkan statusnya, granularitas push tetap ringkasan per periode, status kirim tetap bukan prasyarat closing, dan laporan rekonsiliasi terhadap Accurate tetap dibangun tapi bukan penghalang Fase 6.

Konteks aslinya dipertahankan di bawah karena menjelaskan apa yang dipertaruhkan.

---

**Konteks saat pertanyaan masih terbuka:**

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

**PEMBARUAN (migrasi 0025, ADR 0015): sebagian ditutup, sisanya TIDAK.** Engine akrual ternyata
menulis satu baris per akad di kelas yang dikonfigurasi termasuk akad yang jasanya nol, jadi
faktanya sekarang punya tempat per baris dan `metode` serta `kelas_diakrual` menjadi kolom.
Yang tertutup: setiap periode yang punya minimal satu akad di daftar itu kini menjelaskan seluruh
pengecualiannya sendiri. Yang **tidak** tertutup, dan tidak boleh disebut tertutup: periode yang
daftarnya mengecualikan seluruh portofolio tidak punya baris sama sekali, jadi tidak membawa daftar
itu, dan lebih jauh lagi tidak meninggalkan jejak apa pun bahwa langkah 8.3 pernah dijalankan
(tidak ada snapshot, tidak ada jurnal, dan `jalankanAkrualJasaAdm` tidak menulis audit). Prasyarat
nomor 6 meloloskannya lewat cabang `adaRun && !adaKandidat`, yang membaca daftar kelas **saat
checklist dijalankan**, bukan saat periode ditutup; jadi menjalankan ulang checklist atas periode
yang sudah CLOSED setelah daftarnya diperluas bisa melaporkan GAGAL.

Ini yang membuat tabel induk `closing_akrual` tetap jawaban akhirnya. Batas waktunya tidak berubah:
sebelum periode produksi pertama ditutup.

---

## 24. Apakah buku dibekukan selama rangkaian tutup buku berjalan?

**Ini pertanyaan kebijakan klien, dan ia menentukan apakah `CLOSING_IN_PROGRESS` pernah ditulis.**

Nilai itu disebut spesifikasi (Bagian 4.7), diizinkan CHECK di migrasi 0007, dan sampai hari ini
tidak pernah ditulis oleh kode mana pun. Keputusan skema sudah diambil dan tidak menunggu jawaban
ini: nilainya **dipertahankan**, alasannya ditulis di ADR 0015 dan di `COMMENT` kolom
`periode.status` (migrasi 0025). Ringkasnya, ia bukan penanda crash recovery, karena `tutupPeriode`
berjalan dalam satu transaksi sehingga crash membatalkan seluruhnya dan tidak menyisakan apa pun
untuk dipulihkan; dan ia bukan nilai mati, karena guard periode di jurnal sudah menolak posting
untuk periode yang bukan OPEN, jadi ia langsung bermakna begitu ada yang menulisnya.

**Yang belum diputuskan, dan hanya klien yang bisa memutuskan:** rangkaian 8.1 sampai 8.4 berjalan
dalam empat transaksi terpisah (kolektibilitas, penyisihan, akrual, tutup periode), dan di
antaranya posting biasa masih diterima. Artinya seorang Maker bisa memposting jurnal bertanggal
dalam periode itu setelah snapshot kolektibilitas dibuat tetapi sebelum neraca lajur dibekukan.
Sistem sudah menangani konsekuensinya (prasyarat dievaluasi ulang di dalam transaksi penutupan,
jadi jurnal DRAFT atau ledger yang tidak balance akan menolak penutupan), tetapi menangani bukan
mencegah.

Dua pilihan, dengan biayanya:

1. **Tidak membekukan** (perilaku hari ini). Operasional cabang tidak pernah berhenti. Risikonya
   rangkaian tutup buku bisa harus diulang karena ada yang memposting di tengah jalan.
2. **Membekukan**, dengan menulis `CLOSING_IN_PROGRESS` di awal rangkaian dan mengembalikannya ke
   OPEN kalau dibatalkan. Tutup buku jadi deterministik, tetapi seluruh cabang berhenti bisa
   memposting selama rangkaian berjalan, dan butuh jalur "batalkan closing" yang jelas supaya
   sebuah periode tidak tertinggal dalam status beku karena operatornya pulang.

**Sampai dijawab:** nilainya tetap ada di CHECK, tidak pernah ditulis, dan alasannya terbaca di
kolomnya sendiri. Jangan menghapusnya tanpa jawaban, dan jangan menulisnya tanpa jalur pembatalan.

## 25. RKA: boleh tidak satu Admin Pusat menyusun sekaligus menyetujui anggaran tahunan?

**Kenapa ini pertanyaan dan bukan bug.** Bagian 2 menuliskan dua aturan pemisahan tugasnya untuk
"pola Maker, Checker, Approval yang berlaku di dua modul (PUMK dan Non PUMK)". RKA punya
persetujuan dan tidak punya tahap Checker, jadi tidak satu pun aturan itu mengenainya secara
harfiah. Yang kami kerjakan adalah mekaniknya, bukan kebijakannya: kunci
`rka.pemisahan_tugas_persetujuan` ada di katalog, engine membacanya, dan menolak kalau barisnya
tidak ada.

**Yang kami kirim, dan statusnya:** default `true` (penyusun atau penyunting terakhir tidak boleh
menyetujui), ditandai `ASUMSI` di katalog dan dicatat sebagai A-50, bukan sebagai kebijakan.

**Yang perlu diputuskan klien:** apakah RKA memerlukan pihak kedua. Biayanya nyata di kedua arah.
Menyala berarti klien dengan satu akun Admin Pusat tidak bisa menyetujui RKA sampai ada akun kedua.
Mati berarti tolok ukur setiap angka "versus anggaran" di sistem ini ditetapkan dan diberkati oleh
orang yang sama, tanpa jejak pihak kedua di mana pun.

**Pemilik:** tim akuntansi dan SPI Krakatau Steel. **Batas waktu:** sebelum RKA pertama disetujui
di produksi.

## 26. Siapa yang boleh MEMBACA RKA, dan apakah cabang boleh punya RKA sendiri?

`admin.rka.view` sekarang ada dan dipegang Auditor (dan Admin Pusat), karena Auditor memegang
`laporan.view` sehingga laporan 24 terbuka baginya sementara ia tidak memegang apa pun yang
menjangkau versi anggaran yang dibandingkan laporan itu. Itu menutup celah yang dipin oleh suite
RKA dan mengikuti preseden `admin.closing.view`.

**Yang belum dijawab, dan sengaja tidak kami putuskan:**

1. Apakah **Admin Cabang** boleh membaca RKA cabangnya. Hari ini tidak: `admin.rka.view` ada di
   `HANYA_BUKTI`, jadi tidak diwarisi role operasional.
2. Apakah **cabang boleh punya RKA sendiri**. `rka.cabang_id` nullable justru supaya bisa, tetapi
   hanya ADMIN_PUSAT yang memegang `admin.rka`, sehingga setiap anggaran cabang harus diketik
   kantor pusat. Salah satu dari dua hal itu harus berubah: entah cabang tidak pernah menyusun
   anggarannya sendiri (dan kolomnya hanya penanda kepemilikan), entah ada pemegang `admin.rka` di
   level cabang.

**Pemilik:** tim akuntansi Krakatau Steel. **Batas waktu:** sebelum penyusunan RKA tahun buku
berikutnya.

## 27. Bolehkah template laporan diubah setelah periode yang memakainya ditutup?

Migrasi 0028 sudah menutup kegagalan yang paling mungkin terjadi tanpa sengaja: **mengganti**
template tidak bisa mengubah bentuk laporan periode lampau, karena `periode.template_laporan_id`
mencatat template yang berlaku saat periode itu ditutup dan cetak ulang membacanya dari sana.

**Yang masih bisa terjadi, dan tidak kami larang:** menyunting template yang sama di tempat.
Memindahkan akun ke klasifikasi lain, membalik `tanda`, atau menonaktifkan satu baris akan mengubah
bentuk laporan periode yang sudah dilaporkan. Alasannya ada di ADR 0017: angkanya tidak bergerak
(saldo per akun beku di `saldo_akun_periode` dan bebas template), penyajian ulang komparatif justru
diwajibkan ketika standar berubah, dan mencegahnya secara benar berarti memversikan template
**dan** kaitan akun ke klasifikasi sepanjang waktu, yaitu master data temporal yang tidak dipakai di
mana pun dalam sistem ini.

**Mitigasi yang ada sekarang:** ketiga tabel baru memakai audit trigger, jadi siapa yang mengubah
bentuk sebuah laporan dan kapan bisa dijawab dari `audit_log`.

**Yang perlu diputuskan:** apakah tim akuntansi menghendaki penyuntingan template dikunci setelah
periode pertama ditutup (dan setiap koreksi harus berupa template baru dengan rentang berlaku
baru), atau cukup jejak audit. Jawaban pertama bisa ditegakkan trigger dan biayanya adalah setiap
koreksi salah ketik pun jadi template baru.

**Pemilik:** tim akuntansi Krakatau Steel bersama KAP. **Batas waktu:** sebelum tutup buku pertama
di produksi.

## 28. Apakah dimensi analitik wajib per event, atau cukup dipasok pemanggilnya?

`PENYALURAN_NON_PUMK` membawa `bidangId` ke `dimensi_json` karena modul Non PUMK memasoknya. Tidak
ada apa pun di basis data yang **mewajibkannya**. Satu jurnal manual ke akun beban per bidang, atau
satu event baru yang lupa, menghasilkan jumlah yang tidak bisa diatribusikan ke bidang mana pun, dan
laporan per bidang diam diam kurang.

Sejak migrasi 0027 kekurangan itu setidaknya **terlihat**: pembekuan wajib menaruh sisanya di baris
sisa. Yang belum ada adalah pencegahannya. `event_jurnal_mapping` sudah berupa data (ADR 0004), jadi
tempat yang benar untuk "event ini wajib membawa dimensi X" adalah kolom di sana, bukan `if` di satu
modul. Tidak dikerjakan sekarang karena tabel itu dilalui tiga modul yang sedang aktif ditulis.

**Pemilik:** arsitektur. **Batas waktu:** sebelum modul Pinbuk dan modul program berikutnya menambah
event baru.

## 29. Akrual jasa yang dijalankan ulang memposting jurnal kedua tanpa membalik yang pertama

**Ditemukan saat mengerjakan migrasi 0030 dan ADR 0018, TIDAK diperbaiki di sana**, karena ini
cacat tersendiri di `jalankanAkrualJasaAdm` dan bukan bagian dari salah klasifikasi yang
dikerjakan.

Invarian 13 mengizinkan langkah closing diulang selama periodenya masih OPEN. Kalau akrual
diulang dan totalnya berubah (misalnya karena ada setoran di antara dua run), engine memposting
`AKRUAL_JASA_ADM` **baru** dan tidak membalik yang lama: kunci idempotensinya
`closing:akrual:<periode>:<cabang>:<total>` memuat totalnya, dan `hapusAkrual` hanya menghapus
baris `akrual_jasa_snapshot`, bukan jurnalnya.

Terukur, bukan dugaan (probe dua run dengan setoran 15.000,00 di tengahnya, jasa periode
30.000,00):

| Langkah | Saldo 1.1.04 | `jasa_akrual_belum_tertagih` baris |
|---|---|---|
| run akrual pertama | 30.000,00 | 30.000,00 |
| setoran 15.000,00 | 15.000,00 | 15.000,00 |
| run akrual kedua | **30.000,00** | 15.000,00 |

Jadi buku besar menggandakan akrual sementara sub ledger benar, persis kebalikan dari cacat yang
ditutup ADR 0018. Dunia demo tidak terkena karena generatornya menjalankan pipeline closing tepat
sekali per periode, jadi ini belum pernah muncul di data mana pun yang ada sekarang.

**Perlu keputusan:** apakah run ulang **membalik** jurnal akrual sebelumnya (reversal, ADR 0010,
jadi ada dua baris di buku besar dan jejaknya utuh) atau memposting **selisihnya** saja (satu
baris, lebih ringkas, tapi jurnal akrual sebuah periode tidak lagi bisa dibaca sebagai satu
angka). Keduanya sah secara akuntansi; yang tidak sah adalah yang berjalan sekarang.

**Pemilik:** pemilik `modules/closing`, dengan konfirmasi tim akuntansi untuk pilihan reversal
versus selisih. **Batas waktu:** sebelum operator dilatih membuka dan mengulang periode, karena
sesudah itu cacat ini bisa masuk ke data produksi.

---

## 29. Siapa boleh menutup buku bulanan? DIPUTUSKAN 2026-09-02, SELESAI 2026-09-05

> Catatan penomoran: ada DUA butir bernomor 29 di berkas ini. Yang di atas soal akrual jasa yang
> diulang; yang ini soal izin. Keduanya dibiarkan bernomor sama supaya rujukan yang sudah
> terlanjur dipakai di komit dan komentar kode tidak jadi menunjuk butir yang salah.

**Keputusan pemilik repo:** menutup periode jadi wewenang **Admin Pusat saja**. Cabang tetap
membaca checklist, menjalankan penilaian kolektibilitas, dan **menjalankan perhitungan bulanan**.

**SELESAI.** Kodenya dipisah, persis seperti yang diusulkan di bawah:

| Kode | Menjaga | Dipegang |
|---|---|---|
| `admin.closing.view` | membaca checklist, riwayat, snapshot, saldo beku | APPROVER, ADMIN_CABANG, ADMIN_PUSAT, AUDITOR |
| `admin.closing.kolektibilitas` | spec 8.1, termasuk pratinjaunya. **Tidak berubah** | APPROVER, ADMIN_CABANG, ADMIN_PUSAT |
| `admin.closing.hitung` | **baru.** spec 8.2 penyisihan dan spec 8.3 akrual, termasuk pratinjau penyisihan | APPROVER, ADMIN_CABANG, ADMIN_PUSAT |
| `admin.closing.periode` | **hanya `tutupPeriode`** | ADMIN_PUSAT |
| `admin.periode.reopen` | `bukaKembaliPeriode`. **Tidak berubah** | ADMIN_PUSAT |

**Kenapa dipisah, bukan dicabut apa adanya.** `admin.closing.periode` dulu menjaga tiga hal
sekaligus: tutup buku, penyisihan, dan akrual jasa administrasi. Mencabutnya dari cabang, apa
adanya, ikut memindahkan kedua perhitungan bulanan itu ke pusat, dan itu bukan yang diputuskan:
yang dipusatkan adalah **pernyataan bahwa bulannya selesai**, bukan aritmetika yang menyiapkannya.
Penyisihan dan akrual boleh diulang selama periodenya masih OPEN (invarian 13) dan seluruh
hasilnya bisa diturunkan ulang dari buku besar; tutup buku membekukan neraca saldo dan hanya bisa
dibatalkan lewat reopen Admin Pusat. Bentuknya sama dengan pemisahan `admin.rka` dan
`admin.rka.approve`: kalau satu kode menjaga tindakan rutin dan tindakan yang tidak bisa
dibatalkan sekaligus, yang rutinlah yang menentukan siapa memegang yang tidak bisa dibatalkan.

**Yang ikut berubah, dan sengaja:** setiap fixture dan test closing yang dulu menutup periode
sebagai Approver sekarang menutup sebagai Admin Pusat, dan `periode.closed_by` pada test itu
ikut berpindah. Fixture dashboard, seed demo, dan `modules/tools` sudah menutup sebagai Admin
Pusat sejak awal, jadi tidak tersentuh.

**Buktinya:** `modules/closing/closing-otorisasi.test.ts` (Approver dan Admin Cabang menjalankan
kolektibilitas, penyisihan dan akrual, lalu DITOLAK `tutupPeriode`; Admin Pusat lolos keempatnya;
tidak ada selain Admin Pusat yang bisa reopen), `closing-fixture.test.ts` (matriks terkirim, dibaca
dari database bukan diketik di fixture), dan `closing-rute-otorisasi.test.ts` (matriks per endpoint,
plus penolakan `POST /closing/periode/:id/tutup` oleh Approver dan Admin Cabang yang meninggalkan
baris `DITOLAK` di `audit_log`, spec 2 aturan 5).

**Berkas:** `modules/auth/permissions.ts`, `modules/closing/{contract,service,routes}.ts`,
`apps/web/src/permissions.ts`. `seed/rbac.ts` tidak perlu diubah: ia membaca
`PERMISSIONS_BY_ROLE` dengan semantik himpunan, jadi kode yang dicabut ikut tercabut saat seed
dijalankan ulang.

**Sisa pekerjaan yang BUKAN milik butir ini:** `apps/web/src/closing.test.tsx` dan
`apps/web/src/nav.ts` masih menyusun sesi Approver dengan `admin.closing.periode` dan masih
menjelaskan tombol closing dengan kode itu. Keduanya tetap hijau karena kodenya masih ada di
katalog, tetapi keduanya sekarang menggambarkan kebijakan yang sudah tidak berlaku. Diserahkan ke
pemilik `apps/web`.

## 30. Apakah Maker dan Checker boleh MENGUNDUH laporan, bukan cuma membacanya?

`laporan.export` sekarang ada di katalog (spec 10: "ekspor ke Excel dan PDF"), terpisah dari
`laporan.view`, dan dipegang **AUDITOR** dan **APPROVER** (karena itu juga ADMIN_CABANG dan
ADMIN_PUSAT). **MAKER dan CHECKER tidak memegangnya**: keduanya membuka semua laporan di layar,
dan mendapat 403 kalau menekan unduh.

**Kenapa dipisah sama sekali.** Layar itu berbatas: terikat scope cabang, terpaginasi, setiap
pembukaannya meninggalkan sesi, dan yang keluar keluar selembar demi selembar. Ekspor adalah
**berkas**: ekstraksi massal `mitra.nik`, `alamat`, `telepon` dan outstanding per orang bernama, ke
bentuk yang dikirim lewat surel, disalin ke flashdisk, dan dibuka di mesin yang tidak pernah
didengar sistem ini, tanpa pemeriksaan scope di seberang sana dan tanpa cara menariknya kembali.
Kalau keduanya satu kode, sistem ini tidak punya cara mengucapkan "baca laporannya, jangan bawa
salinannya", dan itu kalimat yang harus bisa diucapkan pemilik data sebuah BUMN.

**Kenapa Maker dan Checker tidak dapat, dan kenapa itu pertanyaan dan bukan jawaban.** Keduanya
adalah role dengan orang paling banyak dan alasan paling tipis untuk memegang seluruh register
mitra satu cabang sebagai berkas; spec 2 tidak memberi keduanya tugas pelaporan di luar membaca.
Tapi "Maker yang menyiapkan paket penyaluran bulanan" adalah alur kerja yang masuk akal dan belum
pernah dijelaskan siapa pun kepada kami. Kalau memang begitu, ini **satu baris** di daftar `MAKER`
di `modules/auth/permissions.ts`. Arahnya sengaja: melebarkan hibah belakangan adalah keputusan
yang diambil dengan sadar, menyempitkannya setelah semua orang punya berkasnya bukan.

**Yang perlu diputuskan:**

1. Apakah Maker boleh mengunduh laporan operasional cabangnya sendiri.
2. Apakah Checker boleh, mengingat perannya adalah memeriksa berkas orang lain, bukan membawanya.
3. Kalau salah satunya boleh, apakah cukup semua 30 laporan, atau perlu dibedakan antara laporan
   operasional dan laporan yang memuat NIK dan alamat.

**Pemilik:** pemilik data dan tim kepatuhan Krakatau Steel.

**Bukti perilaku sekarang:** `modules/laporan/laporan-ekspor.test.ts` memanggil rute ekspor sebagai
keenam role dan membaca hibahnya dari `PERMISSIONS_BY_ROLE`, bukan menuliskannya ulang, jadi hari
hibah itu dilebarkan test ini yang bicara.

**Yang BUKAN milik butir ini, dan masih harus mendarat:** `apps/web/src/permissions.ts` belum
memuat `laporan.export`. Berkas itu sedang dipegang agen lain saat pekerjaan ini dikerjakan.
Mirrornya wajib ditambah sebelum tombol ekspor muncul di layar mana pun; sampai itu terjadi, rute
ekspor tetap benar dan tetap dijaga server, tetapi SPA tidak punya cara mengecek izinnya.

---

## 31. Posting jurnal manual TIDAK menuntut verifikasi, jadi Checker bisa dilewati

**Ditemukan 2026-09-02** saat membangun layar Posting Jurnal, oleh agen yang membaca engine-nya
sebelum menggambar layarnya.

`postingSatu` di `apps/api/src/modules/jurnal/service.ts` memeriksa: jurnalnya ada, statusnya
DRAFT, tidak ada yang mendahului, cabangnya dalam scope, periodenya OPEN, barisnya minimal dua,
dan debit sama dengan kredit. **Tidak ada satu pun pemeriksaan atas `verified_at`, dan tidak ada
pemeriksaan bahwa yang mem-posting bukan yang membuat.**

Akibatnya dua, dan yang kedua lebih serius:

1. Jurnal manual bisa di-posting tanpa pernah diverifikasi, jadi langkah Checker bisa dilewati
   sepenuhnya.
2. Pemegang `jurnal.create` dan `jurnal.post` sekaligus, yaitu **ADMIN_CABANG dan ADMIN_PUSAT**,
   bisa membuat lalu mem-posting jurnalnya sendiri, tanpa orang kedua di mana pun.

Yang bikin ini bukan sekadar kelonggaran: modul ini **sudah** menegakkan maker bukan checker di
`verifikasiJurnal`. Aturan yang bisa dilewati dengan mengambil jalan lain bukan aturan yang
ditegakkan, itu aturan yang kelihatan ditegakkan.

Jalur engine tidak terpengaruh. `postingEvent` tidak memanggil `postingSatu`, jadi ini murni soal
jurnal manual, yang justru tempat spesifikasi bagian 2 menuntut maker checker approver.

**Kenapa belum diperbaiki.** Ada 39 titik pemanggilan `postingJurnal` di seluruh repo, sebagian
besar fixture yang mem-posting draft tanpa langkah verifikasi. Menambahkan syaratnya bukan satu
baris, dan lebih penting lagi ini **keputusan model kontrol**, bukan perbaikan mekanis. Ada
pembacaan yang sah bahwa verifikasi adalah tinjauan opsional dan posting adalah tindakan
otoritatifnya. Saya tidak mau memutuskannya sendirian di akhir sesi panjang, pada sistem yang
pemiliknya sudah memilihnya jadi pemegang buku resmi.

**Pilihan yang perlu diputuskan pemilik:**

1. Posting menuntut `verified_at` terisi, dan yang mem-posting bukan yang membuat. Paling dekat
   dengan bunyi spesifikasi bagian 2.
2. Sama dengan 1, ditambah yang mem-posting juga bukan yang memverifikasi. Tiga orang penuh.
3. Biarkan seperti sekarang, dan nyatakan di dokumentasi bahwa verifikasi jurnal adalah tinjauan
   opsional. Kalau ini yang dipilih, `verifikasiJurnal` sebaiknya berhenti menegakkan maker bukan
   checker, karena penegakan yang bisa dilewati lebih buruk daripada tidak ada.

**Pemilik:** pemilik `modules/jurnal`, dengan konfirmasi tim akuntansi.
**Batas waktu:** sebelum role dibagikan ke pengguna nyata.
