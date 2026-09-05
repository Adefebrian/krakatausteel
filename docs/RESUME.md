# Titik lanjut

## DIJEDA 2026-09-02, DILANJUTKAN 2026-09-05

**Bagian ini digantung dari keadaan jeda. Yang sudah selesai ditandai SELESAI; yang masih
berjalan milik agen lain dan dibiarkan apa adanya.**

| Gerbang | Saat dijeda | 2026-09-05 |
|---|---|---|
| `bun test` | 2571 lulus, 10 gagal | **2622 lulus, 1 gagal** (lihat di bawah, dan merahnya bukan implementasi) |
| `bun run typecheck` | 1 error di `apps/web/src/pages/laporan/Matriks.tsx` | bersih |
| `bun run check:boundaries` | PASS | PASS |

### 1. Pembekuan saldo per dimensi, `modules/closing`. SELESAI, sembilan dari sepuluh

`tutupPeriode` sekarang menulis `saldo_akun_dimensi_periode` (migrasi 0027) dan
`saldo_dimensi_mitra_periode` (migrasi 0032), lewat tiga statement `insert ... select` di
`modules/closing/repo.ts`: sumbu SEKTOR dari baris pencairan PUMK, sumbu BIDANG dari
`dimensi_json`, lalu himpunan mitra beku yang menggantung pada bucket sektornya. Sisanya per
sumbu ditulis sebagai baris SISA, dihitung sebagai mutasi induk dikurangi jumlah bucket di
statement yang sama, jadi aturan totalitas 0027 (TJSL-SDP-002) tidak bisa gagal karena
pembulatan. Reopen menyapu semuanya lewat dua CASCADE, tanpa perubahan di kode reopen.

Akibatnya **Laporan 24 sekarang bisa dibuat untuk PUMK dan NON PUMK di periode CLOSED**, dengan
angka yang identik dengan bacaan jendela yang sama saat periodenya masih OPEN. Penolakan
`SKEMA_BELUM_LENGKAP` di `modules/rka/service.ts` menyempit: sekarang hanya untuk periode CLOSED
yang `dimensi_dibekukan_at`-nya NULL, yaitu periode yang ditutup sebelum mesin ini ada. Bukti:
`modules/closing/closing-laporan-24-beku.test.ts`.

**SATU TEST DIBIARKAN MERAH, DAN ITU BUKAN IMPLEMENTASINYA.**
`closing-saldo-dimensi.test.ts`, "dua sumbu atas satu periode direkonsiliasi sendiri sendiri".
Assertion-nya membandingkan `anak.split(": ")[1]`, yang selalu berawalan `"anak "`, dengan
`indukSisi.replace("induk ", "")`, yang tidak pernah berawalan begitu. Kedua sisi tidak pernah
bisa sama untuk nilai apa pun, jadi test ini tidak bisa dihijaukan dengan menulis kode apa pun.
Perbaikannya satu kata (`split(": anak ")`), dan sengaja TIDAK dikerjakan: aturan repo ini
melarang menghijaukan test dengan mengubah assertion-nya, dan yang ini milik pemilik test-nya.
Sifat yang mau diuji sudah dijamin di tempat lain di berkas yang sama, oleh dua `toContain`
terhadap `totalitas()` di test pertama dan test reversal.

**Dua perubahan fixture yang perlu diketahui**, keduanya di `closing/test-support.ts`, karena
keduanya menghasilkan ledger yang berbeda:
- `cairkan` sekarang mendaftarkan pembalik state bisnis untuk `pumk_pencairan` (no-op, sama
  seperti fixture operasional `modules/laporan`), karena fixture sudah mencap `referensi_tipe`
  pada setiap pencairan dan `reversalJurnal` menolak jurnal yang tipenya tidak punya pembalik.
- `cairkan` yang dipanggil dua kali atas satu akad sekarang **membalik pencairan yang hidup lebih
  dulu**. Pencairan kedua yang murni tidak bisa direpresentasikan: `pumk_akad_outstanding_pokok_max_ck`
  melarang outstanding melebihi pokok dan `pumk_akad_satu_aktif_per_mitra_uq` melarang akad hidup
  kedua untuk satu mitra, jadi memaksakannya bikin prasyarat 10 (sub ledger vs buku besar) gagal.

### 1b. OPEN-QUESTIONS 29, izin tutup buku. SELESAI

`admin.closing.periode` sekarang hanya menjaga `tutupPeriode` dan hanya dipegang ADMIN_PUSAT.
Kode baru `admin.closing.hitung` menjaga penyisihan dan akrual (plus pratinjau penyisihan) dan
dipegang APPROVER, jadi juga ADMIN_CABANG. Kolektibilitas dan reopen tidak berubah. Rinciannya,
termasuk sisa pekerjaan di `apps/web` yang bukan milik butir ini, ada di `OPEN-QUESTIONS.md` 29.

### 2. Layar 23 laporan operasional dan portal, `apps/web`, berhenti di tengah berkas

Satu error typecheck: `Matriks.tsx` mengimpor `Angka` yang belum diekspor
`api/laporan-operasional.ts`. Berkas baru yang sudah ada: `generik.tsx`, `operasional.tsx`,
`Rentang.tsx`, `Matriks.tsx`, `AgingPiutang.tsx`, `KartuPiutangLaporan.tsx`.

Pendekatannya: satu layar generik yang digerakkan katalog untuk mayoritas laporan, plus layar
sendiri untuk yang bentuknya memang beda (matriks aging, kartu piutang). **Portal publik dan area
mitra belum tersentuh sama sekali** oleh agen ini.

### 3. Ekspor Excel dan PDF, SELESAI (dilanjutkan 2026-09-05)

Inti ZIP/OOXML berbatas itu **dilanjutkan, bukan diganti**, dan library xlsx **tidak jadi
ditambahkan**: alasannya ada di kepala `core/xlsx/zip.ts`, yaitu tidak satu pun pustaka
JavaScript untuk .xlsx yang mengekspos batas jumlah byte yang boleh DIHASILKAN dekompresi, dan
itu satu-satunya pertahanan jujur terhadap zip bomb. `node:zlib` punya
`inflateRawSync(buf, { maxOutputLength })`, dan itu satu-satunya primitif berisiko di sana.

Yang mendarat:

- `core/xlsx/` lengkap: `zip.ts`, `xml.ts`, `batas.ts` (dari agen sebelumnya), plus `tulis.ts`
  (penulis workbook), `baca.ts` (pembaca berbatas) dan `sanitasi.ts` (netralisasi formula).
- `core/ekspor/` (model dokumen generik untuk ketiga puluh laporan, plus render HTML cetak) dan
  `core/ports/pdf.ts` + `core/adapters/pdf-chromium.ts`.
- `GET /laporan/ekspor/:kode?format=xlsx|html|pdf`, satu rute untuk 30 laporan, memanggil metode
  engine yang SAMA dengan rute layarnya.
- `laporan.export` di katalog izin, dipegang Auditor dan Approver, **bukan** Maker dan Checker.
  Argumennya di tempat hibahnya; pertanyaan yang tersisa di OPEN-QUESTIONS 30.
- `modules/impor` menerima `.xlsx` (`format: "XLSX"`, isi base64) lewat parser yang sama.

**PDF butuh `CHROMIUM_PATH` dan sengaja tidak menebak.** Tanpa itu `format=pdf` menjawab 503
dengan kalimat yang menyuruh operator memakai `format=html` lalu mencetaknya dari browser
sendiri; Excel dan HTML tetap jalan. Image produksi belum berisi Chromium.

**Yang belum, dan diserahkan:** `apps/web/src/permissions.ts` belum memuat `laporan.export`
(berkas itu dipegang agen lain), dan sebuah ekspor belum menulis baris `audit_log` karena
`modules/laporan` sengaja tidak punya port tulis sama sekali. Keduanya dijelaskan di
OPEN-QUESTIONS 30 dan di kepala `modules/laporan/ekspor.ts`.

### Yang tersisa saat lanjut

Butir 2 dan 3 di atas masih milik agennya masing masing. Butir 1, 1b dan OPEN-QUESTIONS 29 sudah
selesai, jadi `modules/closing`, `modules/rka` dan katalog izin sudah bebas lagi.

Yang ditemukan sambil jalan dan **tidak** dikerjakan, supaya tidak hilang:
- `modules/dashboard` `REALISASI_NON_PUMK` masih tidak punya rincian per bidang untuk bulan
  tertutup. Datanya sekarang ADA (`saldo_akun_dimensi_periode` sumbu BIDANG), jadi ini tinggal
  pembacaan di modul dashboard; tidak disentuh karena bukan bagian dari Laporan 24.
- `apps/web/src/closing.test.tsx` dan `apps/web/src/nav.ts` masih menggambarkan kebijakan izin
  lama (Approver menutup buku). Hijau, tapi sudah tidak benar. Milik pemilik `apps/web`.
- ADR 0016 butir 2 masih terbuka: `PENCAIRAN_PUMK` belum membawa `sektorId` di `dimensi_json`,
  jadi sumbu SEKTOR yang dibekukan masih diturunkan lewat `pumk_proposal.sektor_id`. Bekunya
  membuat angkanya tidak bisa bergerak SESUDAH tutup buku; ia tidak membuat sambungannya jadi
  data ledger. Perbaikannya di `modules/pumk`.

---

Diperbarui setelah commit `7678e55`, "the other 23 reports, and the identities that make them believable".

Dokumen ini menggambarkan keadaan repo pada saat penulisan, bukan rencana. Kalau isinya berbeda dengan yang di disk, yang di disk benar.

## Kondisi

| Hal | Keadaan |
|---|---|
| Commit terakhir | `7678e55` |
| `bun test` | 2463 lulus, 22786 pemanggilan expect, 115 berkas. Satu gagal, dan itu milik agen portal yang masih mengetik |
| `bun run typecheck` | bersih |
| `bun run check:boundaries` | PASS |
| Migrasi | 0001 sampai 0030 |
| Modul API dengan rute | audit, auth, closing, dashboard, konfigurasi, laporan, nonpumk, organisasi, pumk, rka, tools |

## Yang sudah selesai

Fase 0 sampai 4 selesai penuh: fondasi, engine jurnal, engine angsuran, PUMK (41 endpoint, 17 layar), Non PUMK (18 endpoint, 9 layar).

Fase 5 closing: selesai. Engine, 14 endpoint, dan tiga layar. Tutup buku dan buka kembali keduanya di balik frasa konfirmasi yang harus diketik.

Fase 6 RKA dan laporan: **30 dari 31 laporan** di katalog spesifikasi bagian 10 sudah hidup dan teruji. Yang ke-31 adalah Laporan 24, milik modul RKA, dan penolakannya untuk jenis PUMK dan NON PUMK di periode tertutup masih berlaku sampai cacat kedua di bawah ditutup. Layar baru ada untuk tujuh laporan inti; 23 laporan operasional belum punya layar. Ekspor Excel dan PDF belum ada sama sekali.

Fase 7: modul dashboard (11 metrik, semuanya bisa ditelusuri ke barisnya) dan modul tools (9 pemeriksaan integritas plus rekonsiliasi piutang) sudah mendarat di sisi API. Layarnya sedang dibangun. Portal publik, login mitra dan impor massal sedang dibangun.

Fase 9 dunia demo: selesai. `bun run db:seed:demo` memutar ulang 24 bulan lewat engine yang sama dengan yang dipanggil UI, bukan menyisipkan baris. Rinciannya di SEED.md. Gerbang penerimaan 46 pemeriksaan ikut di dalam seed dan harus tetap lulus.

## Dua cacat modul yang sudah terbukti, bukan dugaan

Keduanya ditemukan oleh dunia demo, yang memang gunanya untuk itu. Keduanya sedang dikerjakan.

### 1. SUDAH DIPERBAIKI, migrasi 0030 dan ADR 0018. Pendapatan Jasa Administrasi kurang catat, Piutang Jasa Administrasi minus

`modules/angsuran/service.ts` memilih event jasa hanya dari sel konfigurasi `akuntansi.metode_pengakuan_jasa_adm`. Karena selnya ACCRUAL, **setiap** setoran mem-posting `ANGSURAN_JASA_ADM_AKRUAL`, yang **mengkredit** 1.1.04 dengan anggapan piutangnya sudah ada. Sementara `modules/closing` menghitung akrual sebagai `jasa_jatuh_tempo_periode - jasa_diterima_periode`, sehingga angsuran yang dibayar di bulan jatuh temponya tidak menghasilkan akrual sama sekali, jadi tidak ada debit penyeimbang.

Kreditnya terjadi, debitnya tidak pernah.

Di dunia demo: piutang jasa sekitar Rp -86.700.000 dan pendapatan jasa hanya sekitar Rp 12,6 juta atas portofolio Rp 2,1 miliar selama dua tahun. Neraca tetap seimbang karena sisi pendapatannya juga hilang, jadi tidak ada satu pun pemeriksaan integritas yang bisa menangkapnya. Yang salah adalah klasifikasinya, bukan aritmetikanya.

Perbaikannya: fakta pindah ke tempat pertanyaannya diajukan. Migrasi 0030 menaruh `jasa_akrual_belum_tertagih` di `pumk_jadwal_angsuran`, ditulis mesin akrual closing dan dikurangi saat jasanya tertagih. Sebuah setoran sekarang dipecah **per rupiah**: sebesar yang pernah diakrual melunasi piutang, sisanya pendapatan langsung, dan satu setoran boleh butuh kedua kaki itu. Akad di luar kelas yang diakrual tidak pernah diakrual, jadi jasanya selalu pendapatan langsung, dan itu jatuh dari aturan yang sama alih alih jadi kasus khusus.

Yang menemukan cacat ini adalah dunia demo, dan yang **tidak** menemukannya adalah 46 pemeriksaan yang semuanya hijau. Karena itu modul tools sekarang punya pemeriksaan kesembilan: Piutang Jasa Administrasi tidak boleh bersaldo kredit, diperiksa di **setiap akhir bulan**, bukan cuma yang terakhir.

### 2. `saldo_akun_dimensi_periode` tidak pernah ditulis

Migrasi 0027 membuat tabel itu untuk dekomposisi beku per sektor dan per bidang, dan `modules/rka/repo.ts` sudah punya `adaSaldoBekuDimensi`. Tidak ada yang mengisinya: engine closing tidak pernah menulis ke sana.

Akibatnya `laporanRkaVsRealisasi` (Laporan 24) menolak jenis PUMK dan NON_PUMK begitu jendelanya menyentuh periode CLOSED, dengan `SKEMA_BELUM_LENGKAP`. Penolakan itu disengaja dan sudah didokumentasikan di `modules/rka/service.ts`. Separuh yang hilang ada di sisi closing.

## Sisa pekerjaan

1. Layar untuk 23 laporan operasional.
2. Ekspor Excel dan PDF untuk setiap laporan. Izin `laporan.export` sengaja belum ada dan sebuah test memakukan bahwa memintanya gagal di perkabelan. Ekspor butuh dependensi baru, dan dependensi baru butuh persetujuan pemilik lebih dulu.
4. Fase 7: dashboard dengan drill down, portal publik, login mitra, impor massal, alat rekonsiliasi dan integritas.
5. Fase 8: lapisan AI sebagai asisten, di balik feature flag. Prioritas 1 dan 2 dulu, ekstraksi dokumen dan deteksi anomali jurnal. AI tidak pernah menyetujui, mem-posting, atau menutup.
6. Menjalankan 24 skenario penerimaan spesifikasi bagian 16 sebagai bukti, bukan sebagai klaim.
7. Memindahkan test penyapu kelas error dari `modules/closing/` ke `core/`, tempat daftar yang dijaganya berada.

## Keputusan yang menunggu pemilik

`ADMIN_CABANG` saat ini mewarisi `admin.closing.kolektibilitas` dan `admin.closing.periode`, jadi admin cabang bisa menjalankan tutup buku selingkup entitas. Membuka kembali periode tetap hanya Admin Pusat. Pertanyaannya apakah menutup buku memang boleh di tangan cabang, atau harus Admin Pusat saja.

## Aturan yang tidak boleh dilanggar saat melanjutkan

- Jangan pernah `git stash`, `git checkout -- <path>`, atau `git reset --hard` selama ada agen lain hidup di tree yang sama. Dua insiden di proyek ini menghapus ribuan baris kerja agen lain persis dengan cara itu.
- Jangan pernah `git add <direktori>` atau `git add -A`. Stage berkas yang kamu sentuh saja, per path.
- Test dibuat hijau dengan memperbaiki kode, tidak pernah dengan melemahkan assertion. Test yang memang salah dibiarkan merah dan dilaporkan.
- Setiap kelas error yang diekspor modul harus terdaftar di `NAMA_ERROR_BERKODE` di `core/http.ts`. Empat modul pernah mendarat tanpa itu, tiap kali menghasilkan 500 tanpa nama dan tanpa baris audit penolakan. Sekarang ada test penyapu yang menjaganya.
- Pembacaan saldo lewat `v_ledger_baris`, tidak pernah dengan filter POSTED saja. Lihat ADR 0010.
- Semua jurnal lewat `postingEvent`. Ada trigger basis data dan pemeriksaan statis yang menjaganya.
