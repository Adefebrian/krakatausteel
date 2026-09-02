# Titik lanjut

Diperbarui setelah commit `5f759f9`, "a 24 month demo world replayed through the real engines".

Dokumen ini menggambarkan keadaan repo pada saat penulisan, bukan rencana. Kalau isinya berbeda dengan yang di disk, yang di disk benar.

## Kondisi

| Hal | Keadaan |
|---|---|
| Commit terakhir | `5f759f9` |
| `bun test` | 2215 lulus, 0 gagal, 18740 pemanggilan expect, 101 berkas |
| `bun run typecheck` | bersih |
| `bun run check:boundaries` | PASS |
| Migrasi | 0001 sampai 0029 |
| Baris implementasi | sekitar 67.300 |
| Modul API dengan rute | audit, auth, closing, konfigurasi, laporan, nonpumk, organisasi, pumk, rka |

## Yang sudah selesai

Fase 0 sampai 4 selesai penuh: fondasi, engine jurnal, engine angsuran, PUMK (41 endpoint, 17 layar), Non PUMK (18 endpoint, 9 layar).

Fase 5 closing: engine dan 14 endpoint selesai. Layar sedang dibangun.

Fase 6 RKA dan laporan: engine, rute dan layar untuk RKA dan tujuh laporan inti. Dua puluh empat laporan sisanya sedang dibangun.

Fase 9 dunia demo: selesai. `bun run db:seed:demo` memutar ulang 24 bulan lewat engine yang sama dengan yang dipanggil UI, bukan menyisipkan baris. Rinciannya di SEED.md. Gerbang penerimaan 46 pemeriksaan ikut di dalam seed dan harus tetap lulus.

## Dua cacat modul yang sudah terbukti, bukan dugaan

Keduanya ditemukan oleh dunia demo, yang memang gunanya untuk itu. Keduanya sedang dikerjakan.

### 1. Pendapatan Jasa Administrasi kurang catat, Piutang Jasa Administrasi minus

`modules/angsuran/service.ts` memilih event jasa hanya dari sel konfigurasi `akuntansi.metode_pengakuan_jasa_adm`. Karena selnya ACCRUAL, **setiap** setoran mem-posting `ANGSURAN_JASA_ADM_AKRUAL`, yang **mengkredit** 1.1.04 dengan anggapan piutangnya sudah ada. Sementara `modules/closing` menghitung akrual sebagai `jasa_jatuh_tempo_periode - jasa_diterima_periode`, sehingga angsuran yang dibayar di bulan jatuh temponya tidak menghasilkan akrual sama sekali, jadi tidak ada debit penyeimbang.

Kreditnya terjadi, debitnya tidak pernah.

Di dunia demo: piutang jasa sekitar Rp -86.700.000 dan pendapatan jasa hanya sekitar Rp 12,6 juta atas portofolio Rp 2,1 miliar selama dua tahun. Neraca tetap seimbang karena sisi pendapatannya juga hilang, jadi tidak ada satu pun pemeriksaan integritas yang bisa menangkapnya. Yang salah adalah klasifikasinya, bukan aritmetikanya.

Arah perbaikan yang dipilih: event untuk kaki jasa sebuah setoran mengikuti apakah jasa **itu** benar diakrual, bukan apa kata sel konfigurasi global. Jangan berhenti menetokan setoran dari akrual, karena netonya sendiri sudah benar.

### 2. `saldo_akun_dimensi_periode` tidak pernah ditulis

Migrasi 0027 membuat tabel itu untuk dekomposisi beku per sektor dan per bidang, dan `modules/rka/repo.ts` sudah punya `adaSaldoBekuDimensi`. Tidak ada yang mengisinya: engine closing tidak pernah menulis ke sana.

Akibatnya `laporanRkaVsRealisasi` (Laporan 24) menolak jenis PUMK dan NON_PUMK begitu jendelanya menyentuh periode CLOSED, dengan `SKEMA_BELUM_LENGKAP`. Penolakan itu disengaja dan sudah didokumentasikan di `modules/rka/service.ts`. Separuh yang hilang ada di sisi closing.

## Sisa pekerjaan

1. Layar closing. Engine dan rutenya siap, tutup buku bulanan belum bisa dijalankan dari browser sama sekali. Ini satu satunya fase yang tidak punya UI.
2. Dua puluh empat laporan sisa dari katalog 31 laporan di spesifikasi bagian 10.
3. Ekspor Excel dan PDF untuk setiap laporan. Izin `laporan.export` sengaja belum ada dan sebuah test memakukan bahwa memintanya gagal di perkabelan. Ekspor butuh dependensi baru, dan dependensi baru butuh persetujuan pemilik lebih dulu.
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
