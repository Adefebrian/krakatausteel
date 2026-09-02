# SEED.md

Isi data demo, kredensial semua role, dan skenario demo yang disarankan
(spesifikasi Bagian 13 dan Bagian 17).

Ada **dua** seed, dan keduanya sengaja dipisah:

| Perintah | Isi | Lama |
|---|---|---|
| `bun run db:seed` | RBAC, konfigurasi, COA inti, event mapping, master program, akun demo, satu periode berjalan | detik |
| `bun run db:seed:demo` | **dunia transaksi 24 bulan**: mitra, proposal, akad, angsuran, Non PUMK, RKA, jurnal rutin, closing bulanan | ~15 detik |

`db:seed` yang pertama wajib jalan lebih dulu; generator kedua menambah
transaksi **di atas** dunia Fase 0, bukan menggantikannya.

## Cara menjalankan

```bash
# database test (dipakai bun test, aman, bisa dibuang kapan saja)
bun run db:reset
bun run db:seed
bun run db:seed:demo

# database demo lokal (DATABASE_URL)
bun run db:migrate
bun run db:seed:dev
bun run db:seed:demo:dev
```

Pagar produksi berlaku untuk keduanya: nama database wajib berakhir `_dev`,
`_test`, `_local` atau `_demo`. Kredensial di dokumen ini publik, jadi ini
bukan flag yang bisa dilewati.

Untuk uji asap cepat: `SEED_DEMO_BULAN=4 bun run db:seed:demo` memutar empat
bulan saja. **Jangan** dipakai untuk database demo sungguhan: jendela pendek
tidak punya pengukuran tunggakan dan tidak punya pembanding kumulatif setahun.

### Kenapa `db:seed:demo` terpisah dari `db:seed`

`seedFase0` ikut jalan di `bun run verify` dan di banyak test, jadi harus
tetap berukuran detik. Generator transaksi memutar 24 bulan lewat engine
sungguhan; menempelkannya ke `db:seed` berarti membebankan biaya itu ke setiap
run test dan setiap gate, untuk data yang tidak diminta satu unit test pun.

## Aturan yang menentukan seluruh desain generator

Spesifikasi Bagian 13 menuliskannya sendiri: **seed yang menghasilkan neraca
tidak balance lebih buruk daripada tidak ada seed sama sekali.**

Konsekuensinya, **setiap transaksi dibuat lewat engine, tidak ada satu pun baris
yang di-insert langsung**:

| Yang dibuat | Lewat |
|---|---|
| Proposal PUMK dan seluruh transisinya | state machine `modules/pumk` |
| Akad dan jadwal angsuran | `modules/pumk` → `modules/angsuran` |
| Setoran, alokasi, kelebihan bayar | `modules/angsuran` |
| Reschedule | `ajukanReschedule` + `setujuiReschedule` |
| Hapus buku dan pelunasan dipercepat | `catatPengakhiran` |
| Proposal Non PUMK, penyaluran, LPJ | state machine `modules/nonpumk` |
| Setiap jurnal | `postingEvent` / `buatJurnal` di `modules/jurnal` |
| Kolektibilitas, penyisihan, akrual, closing | `modules/closing` |
| RKA dan persetujuannya | `modules/rka` |

Ini bukan preferensi gaya. Trigger jalur posting (migrasi 0020, invarian 11)
menolak baris `jurnal` yang tidak lewat engine, `tools/check-boundaries.ts`
menolaknya secara statis termasuk di direktori seed, dan trigger jadwal
(invarian 8) menolak baris `pumk_jadwal_angsuran` buatan tangan.

Yang **memang** ditulis langsung, karena bukan tabel buku besar dan memang
belum punya engine: `provinsi`, `kota`, `mitra`, `cluster`, `periode`,
`portal_submission`. Keanggotaan cluster tetap lewat engine
(`pumk.tambahAnggotaCluster`), karena `cluster_anggota` adalah riwayat bertanggal
yang dibaca laporan kinerja kelompok.

## Bentuk data yang dihasilkan

Angka di bawah adalah hasil run 2 September 2026. Yang bergerak antar-run hanya
**kalendernya**: periode terakhir selalu bulan berjalan, supaya demo tidak
terlihat basi seminggu kemudian. Sisanya deterministik (PRNG berbenih tetap),
jadi `MTR-01-0007` adalah mitra yang sama di setiap run.

### Periode

24 periode bulanan, dari 23 bulan sebelum bulan berjalan sampai bulan berjalan.
**23 CLOSED, 1 OPEN**, dan yang OPEN adalah bulan kalender hari ini.

Setiap periode CLOSED sudah melewati pipeline penuh: kolektibilitas,
penyisihan, akrual jasa administrasi, checklist 10 prasyarat, lalu
`tutupPeriode`. Periode OPEN juga sudah dijalankan kolektibilitas, penyisihan
dan akrualnya (tapi tidak ditutup), jadi dashboard menampilkan angka bulan
berjalan dan tombol "Tutup Periode" bisa benar-benar diklik saat demo.

> **Penyimpangan yang disengaja dari Bagian 13.** Bagian 13 meminta "20 periode
> CLOSED dan 1 OPEN" **dan** "riwayat angsuran 24 bulan". Keduanya tidak bisa
> benar bersamaan: sebuah transaksi hanya bisa dibukukan ke periode yang OPEN
> (`PERIODE_TIDAK_OPEN`), jadi riwayat 24 bulan butuh 24 periode, yang berarti
> 23 di antaranya ditutup. Yang dipilih adalah angka yang membuat laporannya
> hidup (24 bulan), dan jumlah periode tertutup melampaui minimum yang diminta.
> Ubah dengan `SEED_DEMO_BULAN` kalau memang 21 periode yang diinginkan.

### Mitra dan kelompok

- **120 mitra binaan**, 55 di Cilegon, 40 di Serang, 25 di Anyer.
- Demografi bervariasi: jenis kelamin, tanggal lahir, kota (5 kota/kabupaten
  Banten), sektor (8 sektor), jenis usaha, tahun mulai usaha, tenaga kerja,
  omzet dan aset usaha.
- Status akhir tersebar: `AKTIF`, `CALON`, `BERMASALAH` (ditandai otomatis oleh
  closing saat kolektibilitas masuk kelas bermasalah).
- **8 cluster** dengan keanggotaan bertanggal.
- Mitra pertama Cilegon adalah pemilik akun portal (`mitra@demo.tjsl.local`),
  jadi login portal publik mendarat di mitra yang punya akad, jadwal dan
  riwayat setoran, bukan profil kosong.

### PUMK

**150 proposal, seluruh state terisi**, termasuk dua yang selalu dilupakan seed
happy path:

| Status | Jumlah |
|---|---|
| DRAFT | 8 |
| SURVEY_PENDING | 7 |
| SURVEY_SELESAI | 7 |
| REVIEW_CHECKER | 7 |
| MENUNGGU_PERSETUJUAN | 6 |
| DISETUJUI | 5 |
| AKAD_DIBUAT | 4 |
| JADWAL_SIAP | 4 |
| **TIDAK_DIREKOMENDASIKAN** | 6 |
| **DITOLAK** | 6 |
| DICAIRKAN | 90 |

**90 akad dicairkan** (plus 8 yang berhenti di tahap akad), pokok Rp 10 juta
sampai Rp 150 juta dalam kelipatan Rp 500 ribu, tenor 12/18/24/36 bulan, metode
FLAT, EFEKTIF dan ANUITAS, sebagian dengan grace period. Sekitar seperempat
persetujuan **memotong plafon**, jadi baris `pumk_approval` layak dibaca: akad
dibangun dari keputusan, bukan dari usulan.

Perilaku pembayaran selama 24 bulan, per akad:

| Perilaku | Yang terlihat di layar |
|---|---|
| Selalu tepat waktu | kolektibilitas LANCAR sepanjang umur akad |
| Sering terlambat | dibayar 8 sampai 40 hari setelah jatuh tempo, tunggakan permanen satu ember |
| Macet | berhenti membayar, umur tunggakan naik dari KURANG_LANCAR ke MACET, muncul surat peringatan lalu somasi, sebagian berakhir hapus buku |
| Lunas dipercepat | melunasi sisa jadwal di tengah tenor, lalu `pengakhiran` LUNAS_DIPERCEPAT |
| Direstrukturisasi | menunggak dua angsuran, mengajukan perpanjangan tenor, disetujui, jadwal versi 2 aktif |
| Lebih bayar | membulatkan pelunasan ke atas, sisanya jadi Kelebihan Pembayaran Angsuran |

Hasil akhir portofolio: 64 AKTIF, 16 LUNAS, 7 RESCHEDULED, 3 HAPUS_BUKU, 8
BELUM_CAIR; 760 setoran, 7 reschedule, 6 pelunasan dipercepat, 3 hapus buku, 10
tindak lanjut penagihan.

Snapshot kolektibilitas bulan berjalan:

| Kelas | Akad | Outstanding pokok | Penyisihan |
|---|---|---|---|
| LANCAR | 45 | Rp 1.437.458.366 | Rp 0 |
| KURANG_LANCAR | 19 | Rp 610.594.724 | Rp 152.648.681 |
| DIRAGUKAN | 5 | Rp 74.067.917 | Rp 55.550.938 |
| MACET | 2 | Rp 13.125.000 | Rp 13.125.000 |

### Non PUMK

**60 proposal, seluruh 12 status terisi**: DRAFT 4, PENILAIAN 4, REVIEW_CHECKER
4, MENUNGGU_PERSETUJUAN 4, DISETUJUI 4, DISALURKAN 5, MENUNGGU_LPJ 8,
LPJ_DIAJUKAN 5, SELESAI 14, TIDAK_DIREKOMENDASIKAN 3, DITOLAK 3, LPJ_DITOLAK 2.

- 7 bidang, 2 SDG per proposal dengan bobot.
- Sepertiga disalurkan **bertahap** (dua termin), sisanya sekali bayar.
- LPJ diajukan 1 sampai 3 bulan setelah penyaluran; sebagian realisasinya di
  bawah nilai yang disalurkan, sehingga jurnal pengembalian sisa terbentuk.
- Delapan proposal **tidak pernah mengirim LPJ**, jadi kolom terlambat di
  monitoring Bagian 9.2 berisi data sungguhan, bukan hiasan.

### RKA

**6 RKA**: dua tahun buku (tahun berjalan dan tahun sebelumnya) x tiga jenis
(PUMK per sektor, NON_PUMK per bidang, KEUANGAN per akun), semuanya dengan baris
bulanan dan **baseline DISETUJUI**. Ditambah satu **revisi** RKA PUMK tahun
berjalan yang juga disahkan, jadi riwayat versi bukan satu baris.

Disusun `adminpusat`, disahkan `adminpusat2`. Menyetujui dengan akun yang sama
tetap ditolak (`KONFLIK_MAKER_APPROVER`), dan itu memang yang ingin ditunjukkan.

### Jurnal

1.255 jurnal POSTED, total debit Rp 34,3 miliar, seluruhnya balance:

| Jenis | Jumlah |
|---|---|
| OTOMATIS (event bisnis) | 1.134 |
| PENYISIHAN | 37 |
| AKRUAL | 36 |
| PINBUK | 24 |
| KAS_BANK (manual, tiga tangan) | 24 |

Entri rutin bulanan: alokasi dana dari BUMN Pembina (dikirim saat kas cabang
akan kurang, bukan angka ajaib di awal), jasa giro akhir bulan, beban
operasional, pengeluaran kas kecil, pembinaan mitra triwulanan, pengisian kas
kecil triwulanan lewat **jurnal manual Maker → Checker → Approver**, dan setoran
masuk tanpa identitas mitra yang mengendap di Angsuran Belum Teridentifikasi.

### Portal

**25 pengajuan online**: 10 BARU, 6 DIPROSES, 4 DITOLAK, 5 DIKONVERSI. Yang
DIKONVERSI dibuat lewat `pumk.konversiSubmissionPortal`, jadi
`converted_proposal_id` benar-benar menunjuk proposal internal dengan
`sumber_pengajuan = PORTAL_ONLINE`, bukan status yang ditulis tangan.

## Aturan penerimaan Bagian 13, dijalankan otomatis

Sesudah seluruh dunia dibangun, generator menjalankan **46 pemeriksaan** dan
**gagal dengan exit code bukan nol** kalau satu saja tidak lulus. Tidak ada
"sukses bersyarat".

1. Template laporan entitas punya **tepat satu** kategori aset neto (jebakan
   yang dicatat `docs/DEV.md`: template dengan dua atau nol kategori membuat
   laporan 17, 19 dan 20 menolak dengan `SEKSI_ASET_NETO_TIDAK_DIKENAL`).
2. `v_integritas_jurnal` kosong (tidak ada jurnal POSTED yang tidak balance).
3. `v_integritas_jadwal` kosong (total pokok jadwal = pokok akad).
4. `v_integritas_snapshot` kosong (tidak ada snapshot kolektibilitas ganda).
5. `v_rekonsiliasi_piutang` tanpa selisih (sub ledger piutang = buku besar,
   Bagian 8.4 butir 10).
6. Tangga kolektibilitas tanpa celah dan tanpa tumpang tindih.
7. Tidak ada jurnal DRAFT di periode CLOSED.
8. Tidak ada akad dengan outstanding negatif (invarian 10).
9. Total debit = total kredit untuk seluruh jurnal POSTED.
10. Laporan 19: Total Aset = Liabilitas + Aset Neto, untuk periode CLOSED
    terakhir **dan** periode OPEN.
11. Laporan 23: neraca lajur balance (saldo akhir dan mutasi).
12. Laporan 18: Kas Akhir = Kas dan Setara Kas di Laporan 19.
13. Laporan 17 dan 20: kenaikan aset neto konsisten.
14. Seed benar-benar punya baseline RKA miliknya sendiri untuk diuji.
15. Laporan 24 dalam mode BULANAN (sumber ledger hidup dan sumber saldo beku)
    dan KUMULATIF_YTD.
16. **Seluruh 10 prasyarat closing untuk ke-24 periode**, termasuk yang OPEN.

Checklist prasyarat juga jadi **gerbang per bulan**: `tutupPeriode` hanya
dipanggil kalau kesepuluh pemeriksaan lulus, jadi cacat muncul di bulan yang
menyebabkannya, bukan dua puluh bulan kemudian sebagai selisih tanpa penjelasan.

## Waktu jalan

**Sekitar 11 sampai 15 detik** untuk 24 bulan penuh di Postgres lokal (1.255
jurnal, 3.271 baris jurnal, 760 setoran, 24 kali pipeline closing). Wajar untuk
reset demo; tidak perlu dipangkas.

## Idempotensi, dan apa artinya di sini

Buku besar menolak penghapusan fisik (migrasi 0002), jadi "jalankan lagi dan
dapatkan dunia yang sama" tidak bisa diimplementasikan sebagai hapus-lalu-bangun.
Yang berlaku:

- **Dunia lengkap** (98 akad) terdeteksi dan run kedua **tidak mengubah apa pun**,
  hanya mencetak "sudah lengkap" dan keluar dengan exit code 0.
- **Dunia separuh jadi** (ada akad, tapi belum lengkap) **ditolak** dengan
  instruksi. Melanjutkan replay yang terputus akan menghasilkan buku besar yang
  tampak wajar tapi tidak bisa direkonsiliasi, dan itu justru yang dilarang
  Bagian 13.
- Semua yang di hulu buku besar (wilayah, mitra, cluster, periode, pengajuan
  portal) ditulis dengan `ON CONFLICT DO UPDATE`, jadi bagian itu memang
  idempoten. Keanggotaan cluster melewati mitra yang sudah jadi anggota, dan RKA
  **tidak menyentuh** tahun/jenis yang sudah punya versi (milik siapa pun),
  hanya mencatatnya sebagai dilewati. Laporan 24 lalu hanya diuji untuk baseline
  yang memang dibuat seed ini, bukan untuk dokumen orang lain.

Untuk membangun ulang: `bun run db:reset && bun run db:seed && bun run db:seed:demo`
(test DB), atau `dropdb`/`createdb` + `db:migrate` + `db:seed:dev` +
`db:seed:demo:dev` (dev DB).

## Jam yang bisa digeser

24 bulan riwayat tidak bisa dibuat dengan jam dinding. Generator memegang **satu
instan yang bisa dipindahkan** dan menyerahkannya sebagai `jam` ke setiap engine
(`JurnalEngineDeps.jam`, `PumkEngineDeps.jam`, `ClosingEngineDeps.jam`, dan
seterusnya, konvensi yang memang sudah ada di modul-modulnya), lalu
memindahkannya ke tanggal bisnis sebelum setiap panggilan.

Yang berubah karenanya: timeline persetujuan (`pumk_proposal_transisi.waktu`),
stempel `posted_at` jurnal, `closed_at` periode, dan pengukuran umur LPJ.
Tanpa itu, seluruh timeline demo bertanda "sekarang" dan tidak menceritakan
apa-apa. Yang **tidak** dipalsukan: `created_at` (default `now()` di database,
tetap jujur mencatat kapan barisnya ditulis) dan `tanggal_*` bisnis, yang memang
argumen eksplisit ke engine.

Karena `sekarang` juga diinjeksikan (`seedDemoTransaksi({ sekarang })`), seluruh
dunia bisa dibangun ulang pada instan tetap kalau nanti dibutuhkan test.

## KREDENSIAL DEMO (DEMO ONLY)

**Jangan pernah dipakai di database produksi.** Password sengaja ditulis di
sini dan dicetak oleh `db:seed`: kredensial demo yang terlihat seperti rahasia
lebih berbahaya daripada yang jelas jelas bukan rahasia. Sebelum go-live,
akun akun ini dihapus (soft delete) dan diganti akun riil.

Password untuk **semua** akun di bawah: `TjslDemo#2026`

| Username | Role | Cabang | Bisa apa |
|---|---|---|---|
| `maker` | Maker | 01 Cabang Cilegon | Input proposal, survey, akad, pencairan, angsuran, jurnal DRAFT |
| `checker` | Checker | 01 Cabang Cilegon | Review dan rekomendasi, verifikasi jurnal DRAFT dan LPJ |
| `approver` | Approver | 01 Cabang Cilegon | Setujui proposal, posting jurnal, eksekusi closing |
| `admincabang` | Admin Cabang | 01 Cabang Cilegon | Semua kewenangan operasional, **tetap terikat satu cabang** |
| `maker.serang` | Maker | 02 Cabang Serang | Sama seperti `maker`, di Cabang Serang |
| `checker.serang` | Checker | 02 Cabang Serang | Pasangan empat mata Cabang Serang |
| `approver.serang` | Approver | 02 Cabang Serang | Persetujuan dan closing Cabang Serang |
| `maker.anyer` | Maker | 03 Cabang Anyer | Sama seperti `maker`, di Cabang Anyer |
| `checker.anyer` | Checker | 03 Cabang Anyer | Pasangan empat mata Cabang Anyer |
| `approver.anyer` | Approver | 03 Cabang Anyer | Persetujuan dan closing Cabang Anyer |
| `adminpusat` | Admin Pusat | 00 Kantor Pusat | Semua cabang, master data, COA, konfigurasi, reopen periode, penyusun RKA |
| `adminpusat2` | Admin Pusat | 00 Kantor Pusat | Admin Pusat **kedua**, penyetuju RKA |
| `auditor` | Auditor | 00 Kantor Pusat | Read only penuh termasuk audit trail. **Tidak bisa mengubah apa pun** |

Akun portal mitra:

| Email | Password | Mitra |
|---|---|---|
| `mitra@demo.tjsl.local` | `TjslDemo#2026` | `MTR-DEMO-0001` Warung Sembako Demo, Cabang Cilegon, punya akad dan riwayat angsuran |

### Kenapa setiap cabang punya trio maker/checker/approver sendiri

Bukan kelengkapan kosmetik. `pumk_review` dan `pumk_approval` dijaga trigger
pemisahan tugas (TJSL-SOD-001 / TJSL-SOD-002, migrasi 0008), dan enginenya
menolak checker yang merangkap maker (`KONFLIK_MAKER_CHECKER`) serta approver
yang merangkap checker (`KONFLIK_CHECKER_APPROVER`) sebelum trigger itu sempat
menyala. Cabang dengan satu akun operasional **tidak bisa** menjalankan satu pun
proposal dari DRAFT sampai DICAIRKAN, jadi dunia demo untuk cabang itu akan
kosong. Meminjam checker cabang lain juga bukan opsi: spesifikasi Bagian 2
aturan 3 mengikat peran operasional ke cabangnya, dan engine menegakkannya
(`CABANG_DILUAR_SCOPE`).

### Kenapa ada dua akun Admin Pusat

`rka.pemisahan_tugas_persetujuan` **aktif** secara bawaan, jadi `setujuiRka`
menolak penyetuju yang menyusun atau terakhir mengubah versi itu
(`KONFLIK_MAKER_APPROVER`), dan hak `admin.rka.approve` hanya dipegang
ADMIN_PUSAT (keputusan sadar, lihat `apps/api/src/modules/auth/permissions.ts`
dan OPEN-QUESTIONS 26: Admin Cabang boleh **membaca** RKA, tidak boleh
menyetujui).

Dengan satu akun Admin Pusat, penyusun RKA selalu satu-satunya calon penyetuju,
setiap persetujuan ditolak, dan database demo **tidak pernah bisa punya baseline
DISETUJUI**. Laporan 24 membandingkan terhadap baseline itu dan menolak dengan
`BASELINE_TIDAK_ADA` kalau tidak ada.

Perbaikannya ada di **daftar pemainnya**, bukan di kontrolnya: mematikan kunci
pemisahan tugas untuk demo berarti mendemokan sistem tanpa kontrol yang justru
sedang dibeli klien. Instalasi sungguhan pun begitu: satu entitas dengan satu
administrator pusat tidak bisa menjalankan aturan empat mata apa pun.

## Struktur organisasi demo

```
BUMN  KRAS  PT Krakatau Steel (Persero) Tbk
├── 00  Kantor Pusat     (is_pusat)   adminpusat, adminpusat2, auditor
├── 01  Cabang Cilegon               maker, checker, approver, admincabang   55 mitra
├── 02  Cabang Serang                maker.serang, checker.serang, approver.serang   40 mitra
└── 03  Cabang Anyer                 maker.anyer, checker.anyer, approver.anyer      25 mitra
```

Setiap akun demo juga dibuat sebagai baris `karyawan` di cabangnya, supaya bisa
dipilih sebagai petugas survey.

## Skenario demo yang disarankan

Urutannya naik: dari satu dokumen, ke satu portofolio, ke laporan keuangan, ke
kontrol yang menolak.

**1. Satu proposal, dari nol sampai uang keluar (5 menit).**
Login `maker`, buat proposal untuk mitra yang belum punya pinjaman aktif, isi
survey, ajukan ke checker. Login `checker`, rekomendasikan. Login `approver`,
setujui dengan plafon dipotong. Kembali sebagai `maker`: buat akad, generate
jadwal, catat pencairan. Buka Kartu Piutang: jadwalnya ada, saldo buku besarnya
cocok, selisih rekonsiliasi Rp 0. Buka timeline: siapa, kapan, catatan apa.

**2. Kontrol empat mata menolak, di API bukan cuma tombolnya hilang.**
Ulangi langkah review sebagai `maker` yang membuat proposalnya:
`KONFLIK_MAKER_CHECKER`. Ulangi persetujuan sebagai `checker` yang mereview:
`KONFLIK_CHECKER_APPROVER`. Setiap penolakan meninggalkan baris `DITOLAK` di
`audit_log` lengkap dengan user, IP dan alasan.

**3. Mitra bermasalah, dari tunggakan sampai hapus buku.**
Filter daftar akad ke kolektibilitas MACET dan DIRAGUKAN. Buka salah satunya:
angsuran berhenti di tengah, umur tunggakan naik lintas periode, ada surat
peringatan lalu somasi di trail penagihan. Cari akad berstatus `HAPUS_BUKU`:
jurnalnya mendebet penyisihan, dan hak tagihnya tetap tercatat.

**4. Restrukturisasi.**
Cari akad `RESCHEDULED`. Bandingkan jadwal versi 1 dan versi 2: total pokoknya
sama, tenornya berbeda, dan baris lama bertanda `DIRESCHEDULE` bukan dihapus.

**5. Closing satu bulan, di depan mata.**
Login `approver` (atau `adminpusat`), buka periode berjalan. Jalankan preview
kolektibilitas: matriks perpindahan kelas dari bulan lalu. Buka checklist
prasyarat: sepuluh butir, semuanya PASS, jadi tombol tutup periode aktif.
(Kolektibilitas, penyisihan dan akrual bulan berjalan sudah dijalankan oleh
seed, sehingga periode ini memang siap ditutup.)

**6. Laporan keuangan yang benar-benar balance.**
Laporan 19 Posisi Keuangan: Total Aset = Liabilitas + Aset Neto. Laporan 18
Arus Kas: Kas Akhir sama persis dengan Kas dan Setara Kas di Laporan 19.
Laporan 23 Neraca Lajur: kolom debit dan kredit sama di ketiga pasangan.
Bandingkan periode CLOSED (sumber: snapshot beku) dengan periode OPEN (sumber:
ledger hidup); headernya menyebutkan sumbernya sendiri.

**7. Anggaran versus realisasi.**
Laporan 24, jenis KEUANGAN, mode KUMULATIF_YTD, bulan berjalan: baseline yang
disahkan `adminpusat2`, realisasi dari campuran saldo beku dan ledger hidup.
Ganti ke mode BULANAN untuk melihat satu bulan saja. Buka riwayat versi RKA PUMK
tahun berjalan: versi 1 dan revisinya.

**8. Non PUMK dan LPJ yang menunggak.**
Monitoring LPJ Bagian 9.2: ember umur 0-29, 30-59, 60-89, 90+ semuanya terisi,
dan delapan proposal ditandai terlambat. Buka satu proposal SELESAI yang
realisasinya di bawah penyaluran: ada jurnal pengembalian sisa.

**9. Portal publik.**
Daftar pengajuan online: 25 tiket di empat status. Buka satu yang DIKONVERSI,
lalu ikuti tautannya ke proposal internal dengan `sumber_pengajuan =
PORTAL_ONLINE`. Login portal sebagai `mitra@demo.tjsl.local` untuk melihat sisi
mitra: akad, jadwal, riwayat setoran.

**10. Auditor benar-benar read only.**
Login `auditor`: semua laporan dan `GET /audit` terbuka; setiap
`POST`/`PUT`/`PATCH`/`DELETE` ditolak `403` sebelum sampai ke handler.
(Bagian 16 skenario 23.)

**11. Scope cabang tidak bisa ditembus lewat URL.**
Login `maker` (Cilegon), buka akad milik Cabang Anyer lewat id-nya langsung:
`403`, dengan pesan yang tidak membocorkan cabang mana. (Bagian 16 skenario 24.)

## Cacat yang diketahui dan terlihat di data demo

**Piutang Jasa Administrasi bersaldo negatif (sekitar Rp 87 juta), dan
Pendapatan Jasa Administrasi jauh lebih kecil dari yang seharusnya.**

Ini **bukan** cacat generator; generator justru yang memunculkannya. Sebabnya
interaksi dua modul yang masing-masing benar sendiri-sendiri:

- `modules/angsuran` memilih event jasa **hanya** dari
  `akuntansi.metode_pengakuan_jasa_adm`. Karena nilainya `ACCRUAL`, setiap
  setoran memakai `ANGSURAN_JASA_ADM_AKRUAL`, yang **mengkredit Piutang Jasa
  Administrasi (1.1.04)**, dengan asumsi jasa itu sudah pernah diakrual.
- `modules/closing` menghitung akrual sebagai
  `jasa_jatuh_tempo_periode - jasa_diterima_periode`. Angsuran yang dibayar di
  **bulan yang sama** dengan jatuh temponya membuat selisih itu nol, jadi tidak
  ada akrual yang mendebet 1.1.04.

Hasilnya: untuk setiap angsuran yang dibayar tepat waktu, ada kredit ke piutang
jasa tanpa debit pasangannya, dan pendapatan jasa administrasi tidak pernah
diakui. Neraca **tetap** balance (karena bebannya juga tidak muncul), sehingga
tidak ada satu pun pemeriksaan integritas yang menangkapnya; yang salah adalah
klasifikasinya.

Perbaikannya ada di modul, bukan di seed, dan ada dua kandidat: setoran memilih
event berdasarkan **ada atau tidaknya akrual untuk baris jadwal itu** (bukan
berdasarkan kunci konfigurasi saja), atau akrual berhenti mengurangkan
`jasa_diterima_periode`. Keputusannya milik tim yang memiliki
`modules/angsuran` dan `modules/closing`.

**Laporan 24 untuk jenis PUMK dan NON_PUMK menolak begitu jendelanya menyentuh
periode CLOSED** (`SKEMA_BELUM_LENGKAP`). Migrasi 0027 sudah menyiapkan
`saldo_akun_dimensi_periode` untuk menyimpan dekomposisi per sektor dan per
bidang, tapi belum ada yang menulisnya saat closing, dan `modules/rka` memilih
menolak daripada menghitung ulang bulan tertutup dari master data yang masih
bisa berubah. Karena itu skenario demo nomor 7 memakai jenis KEUANGAN untuk mode
kumulatif. Ini penolakan yang disengaja, bukan kerusakan data.

## Catatan

- Seed transaksi **membuat** wilayah (1 provinsi Banten, 5 kota/kabupaten),
  karena `mitra.kota_id` adalah dimensi yang dipakai setiap rincian demografis
  di Bagian 10; tanpa itu kolom wilayah di setiap laporan berisi "Belum diisi".
- Angka uang sengaja dibuat bulat dan masuk akal (kelipatan Rp 500 ribu untuk
  pokok, kelipatan Rp 5 juta untuk hibah). Nilai seperti Rp 12.345.678 merusak
  demo lebih parah daripada layar kosong.
- Alokasi dana dari BUMN Pembina dikirim **saat dibutuhkan**, dihitung dari
  saldo kas cabang yang sebenarnya sebelum belanja bulan itu. Karena itu tidak
  ada satu bulan pun yang saldo kasnya negatif, dan prasyarat closing butir 8
  tidak pernah jadi peringatan.
- `seedCoaInti` sekarang **mengisi `klasifikasi_arus_kas` yang masih NULL** pada
  akun miliknya. Kolom itu datang setelah database pertama diseed, jadi baris
  lama masih kosong, dan Laporan 18 menolak seluruhnya dengan
  `KLASIFIKASI_ARUS_KAS_TIDAK_LENGKAP` begitu akun seperti itu jadi lawan mutasi
  kas. NULL adalah ketiadaan, bukan keputusan akuntan, jadi mengisinya adalah
  perbaikan, bukan penimpaan: predikatnya hanya menyentuh baris yang masih NULL,
  dan dua akun yang definisinya memang tidak punya klasifikasi (penyisihan dan
  Aset Neto) tetap NULL. Jalankan ulang `bun run db:seed` di database lama untuk
  memperbaikinya.
