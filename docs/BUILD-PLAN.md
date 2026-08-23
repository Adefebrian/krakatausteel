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

## Batas scope (Bagian 15)

Tidak dibangun: payment gateway atau integrasi bank apa pun, aplikasi mobile native, UI multi tenant, multi mata uang, modul di luar TJSL, realtime atau websocket, design system baru dari nol, fitur AI di luar delapan yang disebut Bagian 12, hard delete data keuangan, optimasi performa prematur.
