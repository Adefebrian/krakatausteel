# Rencana Pembangunan TJSL Online

Spesifikasi sumber kebenaran: `PROMPT-TJSL-Online.md` (di luar repo, dipegang pemilik repo).
Dokumen ini memetakan Bagian 14 spesifikasi ke pekerjaan nyata di repo ini, siapa yang mengerjakan, dan gate apa yang harus lulus sebelum fase dianggap selesai.

## Keputusan yang sudah dikonfirmasi pemilik repo

| Pertanyaan (Bagian 18) | Jawaban |
|---|---|
| Konvensi stack dan folder | Monorepo JAL: Bun, Hono di `apps/api`, React SPA di `apps/web` (Bun.build, tanpa Vite), UI bersama di `packages/ui`, Postgres self-hosted, migrasi SQL di `migrations/` |
| COA | COA contoh 80 sampai 100 akun sesuai struktur Bagian 10.3 |
| Jasa administrasi | FLAT 3 persen per tahun, basis 360 hari |
| Urutan alokasi setoran | Tunggakan jasa, tunggakan pokok, jasa berjalan, pokok berjalan, kelebihan |
| Pengakuan jasa administrasi | ACCRUAL, akrual bulanan saat closing |
| Data legacy | Tidak ada data riil, dibuatkan data dummy legacy untuk menguji import saldo awal |
| Hierarki cabang | Satu level, 1 pusat dan 3 cabang |
| Cadence build | Semua fase dikerjakan berurutan tanpa berhenti untuk review |
| Repo | `Adefebrian/krakatausteel` di GitHub pribadi, private. Bukan repo organisasi |
| Deploy | Server sendiri, Docker Compose (`infra/docker-compose.prod.yml`). Bukan Coolify, bukan PaaS |
| Tahap sekarang | Semua jalan lokal, termasuk database. Belum ada deploy |

Semua nilai parameter di atas disimpan sebagai baris di tabel `konfigurasi`, bukan konstanta di kode.

## Lingkungan lokal

| Sumber daya | Nilai |
|---|---|
| Postgres | 15.17 Homebrew, `localhost:5432` |
| DB dev | `tjsl_dev` |
| DB test | `tjsl_test` |
| Redis | `localhost:6379` |
| API | port 3001 |
| Web | port 3000 |

`.env` ada di root, tidak pernah di-commit. Docker tidak dipakai untuk dev lokal karena Postgres dan Redis native sudah jalan; `infra/docker-compose.yml` tetap dipertahankan untuk lingkungan lain.

Upload dokumen (KTP, NPWP, foto usaha, lampiran LPJ) di lokal ditulis ke disk lokal lewat port storage, bukan ke S3 eksternal. MinIO baru muncul di stack server (`infra/docker-compose.prod.yml`). Artinya tidak ada satu pun dependensi ke layanan luar selama pengembangan.

Deploy ke server sendiri dijelaskan di `infra/DEPLOY.md`. Guardrail plugin yang mengunci target deploy ke host organisasi dimatikan khusus repo ini lewat `.jal/guardrails.json`, karena ini project pribadi; guardrail lainnya (Bun saja, tanpa Vite atau Next, tanpa emdash di frontend, tanpa deep import antar modul) tetap aktif.

## Fase dan gate

| Fase | Isi | Gate selesai |
|---|---|---|
| 0 | Skema lengkap Bagian 4, invarian Bagian 3 di level database, auth, RBAC, scope cabang, audit log, konfigurasi, generator nomor dokumen, app shell dan navigasi | Migrasi apply dan rollback bersih, trigger invarian benar benar menolak data buruk, login semua role, akses tidak sah ditolak di level API dengan test yang membuktikannya |
| 1 | Engine jurnal, event mapping, tiga jenis jurnal manual, buku besar, neraca lajur, rekap jurnal, reversal, manajemen periode dasar | 10 test Bagian 6.6 lulus |
| 2 | Generator jadwal tiga metode, alokasi setoran, reschedule, simulasi, kartu piutang | 12 test Bagian 7.5 lulus |
| 3 | Modul PUMK penuh, state machine, timeline persetujuan, jaminan, cluster, pencairan, angsuran, pengakhiran, mitra bermasalah | Satu proposal jalan dari DRAFT sampai DICAIRKAN, jurnal otomatis benar, sub ledger piutang cocok buku besar |
| 4 | Modul Non PUMK, penilaian, penyaluran bertahap, LPJ, monitoring aging | Satu proposal jalan sampai LPJ diverifikasi, jurnal pengembalian sisa terbentuk |
| 5 | Closing kolektibilitas dengan preview, penyisihan, akrual, closing periode dengan checklist, snapshot saldo, reopen | 12 test Bagian 8.5 lulus, tiga periode berurutan bisa ditutup dengan angka konsisten |
| 6 | RKA tiga jenis, lalu 31 laporan, akuntansi inti lebih dulu | Total Aset = Liabilitas + Aset Neto, kas akhir Arus Kas = saldo kas Posisi Keuangan, neraca lajur balance, export Excel dan PDF layak |
| 7 | Dashboard dengan drill down, portal publik, login mitra, import massal, tools rekonsiliasi dan integritas | Semua KPI bisa ditelusuri ke data sumber, submission portal bisa dikonversi jadi proposal internal |
| 8 | Layer AI opsional di balik feature flag, prioritas 1 dan 2 dulu | AI tidak pernah memposting, menyetujui, atau closing; setiap output bertanda sumber AI dan wajib konfirmasi manusia |
| 9 | Seed 24 bulan, test end to end, cek performa laporan, review keamanan, dokumentasi | 24 skenario Bagian 16 jalan tanpa intervensi manual di database |

## Gate yang berlaku di setiap fase

Sebelum sebuah fase dinyatakan selesai, semua ini harus lulus:

1. `bun test` hijau, termasuk test wajib fase itu.
2. `bun run build` hijau.
3. `bun run check:boundaries` hijau (modul tidak saling deep import, infra selalu di balik port).
4. Review kode oleh agen reviewer, tidak ada temuan Critical atau Important yang terbuka.
5. Pass keamanan untuk fase yang menyentuh otorisasi, upload, atau data mitra.
6. Setiap asumsi baru masuk ke `ASSUMPTIONS.md`, setiap pertanyaan terbuka masuk ke `OPEN-QUESTIONS.md`.

## Dokumen wajib (Bagian 17)

| File | Diisi pada fase |
|---|---|
| `ASSUMPTIONS.md` | 0, ditambah setiap fase |
| `OPEN-QUESTIONS.md` | 0, ditambah setiap fase |
| `ACCOUNTING.md` | 1, dilengkapi di 5 |
| `ENGINE-ANGSURAN.md` | 2 |
| `CLOSING.md` | 5 |
| `LAPORAN.md` | 6 |
| `SEED.md` | 9 |

## Dampak temuan regulasi ke kemampuan engine

Riset di `docs/REGULASI.md` menemukan spesifikasi mengacu ke peraturan yang sudah dicabut. Konsekuensinya bukan "ganti angka default", tapi "engine harus punya dua mode" di beberapa titik. Semua di bawah ini wajib dibangun sebagai kemampuan, dengan mode aktif dipilih lewat tabel `konfigurasi`, bukan lewat deploy.

| Titik | Yang diminta spec | Yang ditemukan berlaku | Kemampuan yang harus ada |
|---|---|---|---|
| Jasa administrasi | FLAT 3 persen per tahun | PER-1/MBU/03/2023 Pasal 22 ayat (2): 3 persen efektif per tahun, atau flat yang ekuivalen dengan 3 persen efektif, tenor maksimum 3 tahun | Tiga metode (FLAT, EFEKTIF, ANUITAS) memang sudah diminta spec Bagian 7.1, jadi enginenya sama. Tambahan: fungsi konversi "flat yang ekuivalen dengan rate efektif" supaya rate flat bisa diturunkan dari 3 persen efektif, bukan diketik manual. Test fixture spec 7.5 nomor 1 tetap dipakai sebagai test metode FLAT, bukan sebagai klaim kepatuhan |
| Batas tenor | `tenor_max_bulan` konfigurable | Maksimum 3 tahun | Default `tenor_max_bulan` = 36 |
| Penyisihan | Tabel rate 0, 25, 75, 100 persen per kolektibilitas | Pedoman Akuntansi PKBL dan praktik audited: penurunan nilai kolektif berbasis tingkat penagihan historis, minimum data 2 tahun | Dua mode: `RATE_TABLE` (default, sesuai spec, demoable hari pertama) dan `KOLEKTIF_HISTORIS` (menghitung rate dari histori penerimaan per bucket kolektibilitas). Snapshot menyimpan rate yang benar benar dipakai, supaya laporan periode lampau tetap reproducible saat mode diganti |
| Format laporan | Aset Neto Tidak Terikat dan Terikat Temporer (istilah PSAK 45) | ISAK 35, dinomori ulang jadi ISAK 335 sejak 1 Januari 2024: tanpa pembatasan dan dengan pembatasan. Amendemen ISAK 335 disahkan 3 Juni 2026 untuk PSAK 118, berlaku 1 Januari 2027 | `baris_laporan` harus menampung lebih dari satu template laporan yang hidup bersamaan, dan `akun.klasifikasi_laporan` menunjuk baris per template, bukan satu format tunggal. Seed dua template: gaya spec (PSAK 45) sebagai default demo, dan ISAK 335 sebagai alternatif |
| Hapus buku | `HAPUS_BUKU_PIUTANG` mendebet Penyisihan sebesar seluruh outstanding | SK-277/MBU/10/2023: istilah resminya penghapusbukuan dan penghapustagihan, dua peristiwa berbeda | Event terpisah untuk penghapustagihan, plus jalur untuk kekurangan penyisihan: kalau saldo penyisihan lebih kecil dari outstanding yang dihapus buku, sisanya jadi beban periode itu, bukan mendebet penyisihan sampai negatif |
| Pinjaman aktif per mitra | `maks_pinjaman_aktif_per_mitra` = 1 | Plafon Rp250 juta plus tambahan jangka pendek Rp100 juta | Konfigurasi tambahan untuk mengizinkan top-up jangka pendek di atas akad aktif, default mati |
| Pelaporan ke Kementerian | Tidak disebut spec | Pasal 33: laporan triwulanan dan tahunan, audit KAP terpisah | Dicatat sebagai backlog di `OPEN-QUESTIONS.md`, tidak dibangun tanpa keputusan pemilik |

Batas kepercayaan temuan: riset dilakukan tanpa bisa membuka dokumen primer secara langsung, jadi setiap temuan diberi label tingkat keyakinan di `docs/REGULASI.md` dan enam dokumen primer yang harus dibuka manual sudah didaftar di sana. Keputusan kebijakan akuntansi (metode jasa, dasar penyisihan, format laporan) adalah wewenang tim keuangan klien dan KAP-nya, bukan tim pembangun. Sampai ada keputusan, default mengikuti spec supaya prototype tetap bisa didemokan, dan setiap default ditandai di `ASSUMPTIONS.md`.

## Integrasi Accurate Online, dan dampaknya ke posisi sistem ini

Keputusan pemilik repo: produk yang dituju adalah **Accurate Online** (bukan Accurate 5 desktop), sehingga API resmi tersedia. Tetapi **siapa pemegang buku resmi TJSL belum diputuskan.** Jangan membangun seolah sudah diputuskan.

Sampai ada keputusan, yang berlaku:

- **Default mengikuti spesifikasi Bagian 1**: unit TJSL adalah entitas pelaporan tersendiri, jadi sistem ini yang memegang buku dan menghasilkan laporan Bagian 10.3 secara penuh.
- **Integrasi Accurate dibangun sebagai lapisan opsional yang inert** kalau tidak ada target yang dikonfigurasi. Tujuannya menjaga keputusan tetap bisa dibalik tanpa bongkar skema.

Dua kemungkinan dan konsekuensinya, supaya keputusan nanti diambil dengan sadar:

| Kalau diputuskan | Konsekuensi |
|---|---|
| Sistem ini tetap pemegang buku | Accurate hanya menerima jurnal ringkas untuk konsolidasi induk. Laporan Bagian 10.3 tetap laporan resmi. Perubahan paling kecil |
| Accurate jadi pemegang buku | COA kita wajib mencerminkan COA Accurate persis, laporan 17 sampai 20 turun status jadi laporan manajemen dan alat rekonsiliasi, dan scope Fase 6 berubah cukup besar |

Yang dibangun sekarang, karena murah, aditif, dan justru yang membuat keputusan tetap terbuka:

1. **Pemetaan akun kita ke akun Accurate sebagai tabel**, bukan kolom tempelan. Akun yang sudah punya baris jurnal POSTED tapi belum punya padanan harus terdeteksi lewat query sebelum push dimulai, bukan gagal di tengah jalan.
2. **Status pengiriman per jurnal**: belum terkirim, terkirim, gagal, atau sengaja dikecualikan, beserta id eksternal dari Accurate, jumlah percobaan, dan sidik jari payload. Nomor jurnal kita dipakai sebagai kunci idempotensi supaya dobel posting mustahil.
3. **Tabel pendaratan saldo Accurate** supaya rekonsiliasi per periode bisa direproduksi, bukan dihitung ulang terhadap API yang hidup.
4. **Satu port ekspor dengan dua adapter**, API dan file. Kalau ternyata API tidak mendukung referensi eksternal, idempotensi harus ditegakkan sepenuhnya di sisi kita, dan jalur file tetap ada.

Yang belum dibangun sampai ada keputusan: laporan rekonsiliasi terhadap Accurate, dan status kirim sebagai prasyarat closing. Keduanya masuk akal hanya kalau push sudah benar benar dipakai.

Yang tidak akan dibangun dalam kondisi apa pun: sinkronisasi jurnal dua arah. Arah data satu saja, dari sini ke Accurate.

Granularitas push dan mekanisme idempotensi menunggu verifikasi kemampuan API di `docs/INTEGRASI-ACCURATE.md`.

Granularitas push (per jurnal detail versus ringkasan per periode) dan mekanisme idempotensi masih menunggu verifikasi kemampuan API di `docs/INTEGRASI-ACCURATE.md`. Sampai itu selesai, desain harus menyediakan satu port ekspor dengan dua adapter, file dan API, supaya jalur file tetap ada kalau API ternyata membatasi.

## Keputusan sementara: event yang tidak ada di spesifikasi Bagian 6.4

Spesifikasi mendaftarkan 19 kode event. Tiga peristiwa uang yang nyata tidak punya kode di daftar itu, dan pekerjaan Fase 3 sampai 5 tersandung karenanya. Pemilik repo meminta diambil keputusan yang paling masuk akal sekarang, dengan catatan bisa diganti belakangan. Karena pemetaan akun adalah baris di `event_jurnal_mapping`, menggantinya nanti berarti mengedit satu baris, bukan mengubah kode.

| Kode | Kapan dipakai | Debit | Kredit | Alasan |
|---|---|---|---|---|
| `HAPUS_BUKU_KEKURANGAN_PENYISIHAN` | Saat hapus buku sementara saldo penyisihan lebih kecil dari outstanding yang dihapus | Beban Penyisihan Penurunan Nilai Piutang | Piutang Pinjaman Mitra Binaan | Spesifikasi mengasumsikan penyisihan selalu menutup seluruh outstanding. Itu hanya benar kalau kolektibilitasnya Macet dengan rate 100 persen. Kalau dasar penyisihan kolektif seperti temuan `docs/REGULASI.md`, saldo penyisihan bisa kurang, dan `HAPUS_BUKU_PIUTANG` apa adanya akan membuat akun kontra aset menjadi negatif. Kekurangannya dibebankan ke periode berjalan |
| `RESTRUKTUR_POKOK_NAIK` | Reschedule yang menaikkan pokok | Piutang Pinjaman Mitra Binaan | Piutang Jasa Administrasi | Pokok naik tanpa uang keluar berarti kewajiban yang sudah diakui dikapitalisasi ke pokok. Yang paling mungkin adalah jasa administrasi yang sudah diakrual tapi belum dibayar. Kalau ternyata yang dikapitalisasi bukan itu, baris pemetaan diubah tanpa deploy |
| `RESTRUKTUR_POKOK_TURUN` | Reschedule yang menurunkan pokok | Penyisihan Penurunan Nilai Piutang | Piutang Pinjaman Mitra Binaan | Penurunan pokok adalah pengurangan tagihan, jadi diserap penyisihan lebih dulu. Kalau penyisihan tidak cukup, sisanya lewat `HAPUS_BUKU_KEKURANGAN_PENYISIHAN` dengan alasan yang sama seperti di atas |

**Penghapustagihan sengaja TIDAK diberi kode event.** Alasannya bukan kelalaian: menurut SK-277/MBU/10/2023, penghapusbukuan mengeluarkan piutang dari neraca sementara hak tagih tetap ada dan dicatat ekstrakomtabel. Penghapustagihan menghapus hak tagih itu, dan pada saat itu piutangnya sudah tidak ada di neraca, jadi tidak ada saldo yang perlu digeser. Perlakuannya adalah peristiwa memorandum pada register ekstrakomtabel, bukan jurnal. Kalau suatu kasus perlu menghapus tagihan atas piutang yang masih di neraca, urutannya dua langkah: hapus buku lebih dulu, lalu hapus tagih. Ini menghindari dua kode event yang menghasilkan jurnal identik, yang justru sumber kebingungan saat rekonsiliasi.

Ketiga keputusan di atas berstatus **asumsi yang perlu dikonfirmasi tim keuangan klien dan KAP**, dicatat di `ASSUMPTIONS.md`, dan tidak boleh dianggap sebagai kepatuhan regulasi.

## Batas scope (Bagian 15)

Tidak dibangun: payment gateway atau integrasi bank apa pun, aplikasi mobile native, UI multi tenant, multi mata uang, modul di luar TJSL, realtime atau websocket, design system baru dari nol, fitur AI di luar delapan yang disebut Bagian 12, hard delete data keuangan, optimasi performa prematur.
