# Titik lanjut

Dijeda atas permintaan pemilik repo saat batas pemakaian hampir tercapai. Commit terakhir `318141f`, sudah dipush.

**PENTING: working tree sedang di tengah perubahan yang sengaja memutus.** Jangan anggap kegagalan test sebagai kerusakan sampai membaca bagian berikut.

## Kondisi persis saat dijeda

| Hal | Keadaan |
|---|---|
| Commit terakhir | `318141f`, hijau saat di-commit |
| Working tree | 6 file dimodifikasi, rename belum selesai |
| `bun run typecheck` | bersih, 0 error |
| `bun test` | merah, dan itu memang diharapkan, lihat sebab di bawah |
| Database `tjsl_test` | masih di migrasi 26, berisi 6234 baris BUMN sisa fixture |
| Database `tjsl_dev` | di migrasi 26 |

**Kenapa test merah:** migrasi 0027 dan 0028 sudah di-commit tapi **belum diterapkan** ke database mana pun. Kode sudah sebagian di-rename ke nama kolom baru (`akun.klasifikasi_akun`), sementara database masih punya nama lama (`akun.klasifikasi_laporan`). Jadi merahnya karena kode dan database berbeda versi, bukan karena logikanya salah.

## Yang sedang dikerjakan saat berhenti

Mendaratkan migrasi 0027 dan 0028 yang sengaja memutus, memperbaiki 25 titik pemanggilan, lalu mereset database test. Agen berhenti tepat saat menulis badan fungsi `seedCoaInti`.

File yang sudah tersentuh: `apps/api/src/seed/{coa-inti.ts,event-jurnal.test.ts,index.ts}`, `apps/api/src/modules/jurnal/{test-support.ts,jurnal-event.test.ts}`, `apps/api/src/modules/nonpumk/test-support.ts`.

Yang **belum** tersentuh dan masih harus di-rename: `apps/api/src/modules/laporan/` (`test-support.ts`, `contract.ts`, `laporan-struktur-data.test.ts`, `laporan-bagan-akun.test.ts`, `laporan-aktivitas.test.ts`, `laporan-perubahan-aset-neto.test.ts`, sekitar 11 titik) dan `apps/api/src/modules/angsuran/test-support.ts` (3 titik).

## Urutan lanjut, jangan diacak

1. Selesaikan rename di dua modul yang tersisa di atas.
2. Lengkapi `seedCoaInti` supaya menghasilkan bentuk baru: klasifikasi akun, minimal satu template, dan pemetaan yang membuat keempat laporan digerakkan akun.
3. Tutup empat celah seed yang difilekan suite laporan sebagai test gagal-tertutup: tidak ada akun aset neto yang bisa diposting, seksi baris laporan diisi nama laporan bukan nama seksi, dua laporan tidak punya baris template sama sekali, dan klasifikasi arus kas hanya diisi di akun kas sehingga setiap lawan akun tidak terklasifikasi.
4. Re-pin satu test di `modules/rka` yang memakukan ketiadaan kolom `saldo_akun_periode.sektor_id`. Perbaikannya ternyata berbentuk tabel (`saldo_akun_dimensi_periode`), dan pin berbentuk kolom tidak bisa mendeteksinya, jadi celah itu akan terbaca terbuka selamanya. Ganti ke keberadaan tabel barunya, pertahankan catatan asalnya.
5. Jalankan `bun run db:reset` (aman, tidak ada agen lain), lalu seed ulang, lalu verifikasi dua kali tanpa reset.

## Yang sengaja TIDAK dikerjakan di langkah ini

Dua ini punya pemilik sendiri dan test yang memakukannya memang harus tetap merah:

- Engine closing menulis `saldo_akun_dimensi_periode` (termasuk baris sisa) dan `periode.template_laporan_id`.
- Modul PUMK mengirim `dimensi: { sektorId }` saat memposting pencairan, supaya atribusi per sektor tidak lagi bergantung pada master data yang bisa diubah.

## Status fase

| Fase | Status |
|---|---|
| 0 sampai 4 | Selesai penuh, engine plus API plus layar |
| 5 Closing | Engine selesai, 132 test. Belum ada API dan layar |
| 6 RKA dan laporan | Test selesai ditulis, 104 dan 147 test, keduanya merah sesuai desain. Implementasi belum |
| 7 sampai 9 | Belum |

## Menjalankan lokal

Port 3000 dipakai project lain (traveldiary), jadi aplikasi ini di **3100**.

```bash
PORT=3001 CORS_ORIGINS=http://localhost:3100,http://localhost:3000 bun apps/api/src/index.ts
WEB_PORT=3100 API_BASE_URL=http://localhost:3001 bun apps/web/server.ts
```

Buka http://localhost:3100, login `adminpusat` dengan kata sandi `TjslDemo#2026`. Kalau muncul "Origin tidak diizinkan", itu karena API dijalankan tanpa `CORS_ORIGINS` yang memuat port 3100.

## Keputusan yang masih menunggu pemilik repo

1. Siapa pemegang buku resmi TJSL. Fork scope terbesar, menggigit di Fase 6.
2. Metode jasa administrasi, flat atau efektif.
3. Dasar penyisihan, tabel rate atau penurunan nilai kolektif.
4. Format laporan, PSAK 45 atau ISAK 335. Skema sekarang mendukung keduanya hidup berdampingan lewat template bermasa berlaku.
5. Butir 1 sampai 28 di `OPEN-QUESTIONS.md`.
