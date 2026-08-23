# Titik lanjut

Dijeda atas permintaan pemilik repo. Kondisi saat dijeda: `bun run build` lulus, `bun test` 60 lulus 0 gagal, `bun run check:boundaries` lulus. Tidak ada pekerjaan yang hilang, tiga agen dihentikan di tengah jalan dan sisanya didaftar di bawah.

## Sudah selesai

| Bagian | Status |
|---|---|
| Scaffold monorepo, repo pribadi `Adefebrian/krakatausteel` private, deploy Docker Compose ke server sendiri | Selesai |
| Skema lengkap spesifikasi Bagian 4: 67 tabel, 15 migrasi, invarian Bagian 3 ditegakkan trigger database, dibuktikan lewat psql | Selesai |
| ADR 0002 sampai 0007, `docs/DATA-MODEL.md`, `ASSUMPTIONS.md` (A-01 sampai A-20), `OPEN-QUESTIONS.md` (10 butir) | Selesai |
| Verifikasi regulasi, `docs/REGULASI.md`, dampaknya dipetakan di `docs/BUILD-PLAN.md` | Selesai |
| Dev dan CI: `bun run verify` satu perintah, tooling DB test yang menolak database bukan `*_test`, CI runner GitHub dengan service container Postgres 15 dan Redis 7 | Selesai |
| Fondasi frontend: token, app shell, router, halaman placeholder, primitif UI (DataTable, StatusBadge, Timeline, FilterBar, Modal, Toast, FormField, EmptyState, Panel, Bento), formatter uang | Selesai, kecuali catatan di bawah |
| Layer inti API: port dan adapter db, keyvalue, ratelimit; perbaikan pengambilan IP klien di `core/client-ip.ts` dan `core/hardening.ts`; `core/principal.ts`; modul `audit` | Selesai |
| Kontrak engine jurnal `apps/api/src/modules/jurnal/contract.ts` | Selesai |

## Terputus di tengah, lanjut dari sini

**1. jal-ux, fondasi frontend.** Terhenti saat sedang merapikan CSS. Belum ada laporan hasil screenshot di lebar 1280 dan 375, jadi kepatuhan ke hukum frontend JAL (latar putih, tanpa gradien, tanpa emoji, tanpa garis dekoratif, bento tanpa sel kosong, tanpa emdash) belum diverifikasi secara visual. Lanjutan: jalankan `bun apps/web/server.ts`, ambil screenshot dua lebar, audit sendiri, perbaiki temuan.

**2. jal-backend, Fase 0 aplikasi.** Terhenti tepat setelah modul `audit` selesai. Yang BELUM ada:
- modul `auth`: `POST /auth/login`, `POST /auth/logout`, `GET /auth/session`, hash `Bun.password` argon2id, sesi di Redis lewat port, cookie HttpOnly SameSite=Lax, rate limit khusus login, `last_login_at`
- middleware `requirePermission` dan resolver scope cabang, Auditor read-only secara struktural
- pemeriksaan segregation of duties di layer service supaya API mengembalikan 409 bersih, bukan error trigger mentah
- modul `konfigurasi`: baca bertipe dengan cache Redis, invalidasi eksplisit saat tulis, gagal keras kalau nilai hilang
- generator `nomor_urut` dengan `SELECT ... FOR UPDATE`
- seed user semua role termasuk Auditor dan akun Mitra portal
- test otorisasi sisi server: setiap role menabrak endpoint yang tidak diizinkan, Maker cabang A menembus data cabang B lewat manipulasi id, baris penolakan muncul di `audit_log`, XFF palsu tidak menipu rate limiter, `nomor_urut` di bawah beban paralel, rollback transaksi

Catatan: `core/ports/db.ts` sudah disentuh, tapi belum dikonfirmasi apakah `transaction()` sudah ada dan sudah diuji rollbacknya. Periksa dulu sebelum menulis ulang.

**3. jal-qa, test engine jurnal.** Terhenti tepat sebelum menulis file test, jadi baru `contract.ts` yang ada. Yang BELUM ada: 10 test Bagian 6.6, 9 validasi Bagian 6.2, aturan reversal Bagian 6.3, 20 event mapping Bagian 6.4, tiga jenis jurnal manual Bagian 6.5, test konkurensi, dan helper fixture dunia minimal. Semua harus gagal lebih dulu dengan alasan yang benar, bukan gagal karena import atau fixture rusak.

## Urutan lanjut

1. Selesaikan tiga butir terputus di atas, urutan bebas, ketiganya independen secara file.
2. Gate Fase 0: `bun run verify` hijau, lalu review oleh jal-reviewer dan pass keamanan jal-security.
3. Fase 1 engine jurnal: implementasi terhadap test jal-qa yang sudah merah.
4. Lanjut Fase 2 sampai 9 sesuai `docs/BUILD-PLAN.md`. Cadence yang dipilih pemilik repo: nonstop tanpa berhenti per fase.

## Keputusan yang masih menunggu pemilik repo

Tidak memblokir pembangunan, semuanya sudah punya default konservatif di `ASSUMPTIONS.md`, tapi butuh jawaban tim keuangan klien dan KAP sebelum produksi:

1. Metode jasa administrasi: 3 persen flat sesuai spesifikasi, atau 3 persen efektif sesuai PER-1/MBU/03/2023 Pasal 22 ayat (2).
2. Dasar penyisihan: tabel rate 0, 25, 75, 100 persen sesuai spesifikasi, atau penurunan nilai kolektif berbasis histori penagihan.
3. Format laporan: istilah PSAK 45 sesuai spesifikasi, atau ISAK 335 yang berlaku.
4. Sepuluh butir di `OPEN-QUESTIONS.md`, terutama nomor 3 (kapan event akrual dipakai), 4 (basis 360 hari di metode FLAT), 6 (dasar penyisihan), dan 10 (struktur akun Aset Neto Terikat Temporer).
