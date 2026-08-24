# Titik lanjut

Dijeda atas permintaan pemilik repo. Commit terakhir `51802cf`, sudah dipush. Kondisi commit itu: **599 test lulus, 0 gagal**, typecheck bersih 5 dari 5 paket, `check:boundaries` lolos.

## Selesai dan terkunci

| Fase | Isi | Bukti |
|---|---|---|
| 0 Fondasi | 67 tabel spesifikasi Bagian 4, invarian Bagian 3 ditegakkan trigger database, auth argon2id dengan sesi Redis, 42 permission kanonik, scope cabang, audit log, konfigurasi tanpa default diam diam, generator nomor dokumen tanpa endpoint HTTP | 288 test di 12 file |
| 1 Engine jurnal | Tujuh operasi Bagian 6.1 plus edit draft, event mapping dari tabel, reversal yang membalik state bisnis di transaksi yang sama, posting batch atomik, posting gabungan satu jurnal beberapa baris, audit per operasi | 112 test |
| 2 Engine angsuran | FLAT, EFEKTIF, ANUITAS di atas BigInt sen, sisa pembulatan seluruhnya ke baris terakhir terpisah pokok dan jasa, grace, jatuh tempo tanggal 31 yang clamp lalu kembali, waterfall alokasi dari konfigurasi, reschedule dengan riwayat versi, simulasi satu kernel, konversi rate flat ekuivalen | 89 test |
| Integrasi | Engine angsuran menembak ledger hanya lewat instance engine jurnal di composition root. Invarian 11 juga ditolak database lewat trigger jalur posting | Wiring di `core/app.ts` |
| Keamanan | Sepuluh temuan `docs/SECURITY-FASE-0.md` ditutup, dibuktikan pada boot nyata dengan `PORT` terisi | Satu listener, `/example` 404, XFF palsu tidak sampai audit log |

## Terputus di tengah, lanjut dari sini

**1. Fase 3 PUMK, test lebih dulu (agen QA).** Yang ada di disk baru `apps/api/src/modules/pumk/{contract.ts,index.ts,test-support.ts}`. **Belum ada satu pun file test.** Agen berhenti saat mengerjakan index dan test-support.

Ada satu file uji coba yang **sengaja tidak di-commit** dan masih tergeletak di working tree: `apps/api/src/modules/pumk/zz-smoke.test.ts`. File itu merah karena kekhasan driver yang sudah terdokumentasi di `modules/jurnal/repo.ts`: array JS terikat ke Postgres sebagai string dipisah koma, bukan array, sehingga muncul `malformed array literal ... 22P02`. Perbaikannya membangun daftar `IN ($2,$3,...)` atau cast eksplisit. Hapus atau perbaiki file itu, jangan dibiarkan menggantung.

Yang masih harus ditulis, semuanya dari spesifikasi Bagian 9.1: seluruh transisi state machine termasuk setiap penolakan, otorisasi per role plus skenario 24 (Maker cabang A menembus cabang B lewat manipulasi id), segregation of duties sebagai error domain bersih bukan trigger mentah, approver mengubah plafon dan tenor lalu mengalir ke akad dan jadwal, akad dan jadwal dan pencairan lewat kedua engine sungguhan dengan rekonsiliasi sub ledger nol, penerimaan angsuran tiga kasus skenario 6, reschedule, pengakhiran dan hapus buku, tindak lanjut penagihan, cluster, kartu piutang, dan konversi submission portal.

**2. Tiga kode event baru (agen engine jurnal).** Sudah mendarat di seed dan fixture bersama, plus test keputusannya. Yang belum: satu test yang benar benar penting, yaitu hapus buku ketika **saldo penyisihan kurang**, yang harus mengonsumsi penyisihan lebih dulu lalu menyalurkan sisanya ke `HAPUS_BUKU_KEKURANGAN_PENYISIHAN`, dengan akun kontra aset tidak pernah negatif dan ledger tetap balance. Juga belum: entri `ASSUMPTIONS.md` untuk ketiga keputusan itu.

## Keputusan yang diambil sementara, bisa diganti

Pemilik repo meminta ambil yang paling masuk akal dulu. Semua ada di `docs/BUILD-PLAN.md` bagian "Keputusan sementara". Menggantinya berarti mengedit baris `event_jurnal_mapping`, bukan mengubah kode.

| Kode | Debit | Kredit |
|---|---|---|
| `HAPUS_BUKU_KEKURANGAN_PENYISIHAN` | Beban Penyisihan | Piutang Pokok |
| `RESTRUKTUR_POKOK_NAIK` | Piutang Pokok | Piutang Jasa Administrasi |
| `RESTRUKTUR_POKOK_TURUN` | Penyisihan | Piutang Pokok |

Penghapustagihan sengaja tanpa kode event, karena piutangnya sudah keluar dari neraca saat hapus buku sehingga tidak ada saldo yang digeser.

## Masih menunggu keputusan pemilik repo

Tidak memblokir pembangunan, semuanya punya default konservatif, tapi butuh jawaban tim keuangan klien dan KAP sebelum produksi:

1. **Siapa pemegang buku resmi TJSL** (`OPEN-QUESTIONS.md` item 11). Fork scope terbesar dan memblokir Fase 6. Kalau Accurate yang jadi pemegang buku, COA wajib mencerminkan COA Accurate dan laporan 17 sampai 20 turun status jadi laporan manajemen.
2. Metode jasa administrasi: 3 persen flat sesuai spesifikasi, atau 3 persen efektif sesuai PER-1/MBU/03/2023 Pasal 22 ayat (2).
3. Dasar penyisihan: tabel rate 0, 25, 75, 100 persen, atau penurunan nilai kolektif berbasis histori penagihan.
4. Format laporan: istilah PSAK 45 sesuai spesifikasi, atau ISAK 335 yang berlaku.
5. Siapa yang memelihara ratusan record customer Mitra Binaan di Accurate (item 15). Tata kelola data, bukan rekayasa.
6. Dua puluh dua butir di `OPEN-QUESTIONS.md`.

## Lingkungan lokal

Postgres 15.17 native `localhost:5432`, database `tjsl_dev` dan `tjsl_test`, 21 migrasi terpasang. Redis `localhost:6379`. Tidak perlu setup ulang.

Dua server dev **masih hidup** dari sesi terakhir: API di 3001, SPA di 3000. Login pakai kredensial di `SEED.md` setelah `bun run db:seed:dev`. Matikan dengan:

```bash
lsof -ti:3000 -ti:3001 | xargs kill
```

## Urutan lanjut

1. Selesaikan test PUMK, lalu implementasi modulnya terhadap test yang merah.
2. Gate Fase 3: satu proposal jalan dari DRAFT sampai DICAIRKAN, jurnal otomatis benar, sub ledger piutang cocok buku besar.
3. Fase 4 Non PUMK, Fase 5 closing. Untuk closing ada satu syarat keras dari ADR 0010: `saldo_akun_periode` **wajib** membaca `v_ledger_baris`, bukan memfilter `POSTED` saja, atau setiap periode yang ditutup akan membawa dobel hitung reversal secara permanen di neraca lajur bekunya.
4. Fase 6 sampai 9 sesuai `docs/BUILD-PLAN.md`.
