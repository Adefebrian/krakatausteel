# Panduan Developer (lokal)

Dari clone bersih sampai aplikasi jalan dan test hijau. Urutannya penting, jalankan dari atas.

Yang dipakai lokal: Bun, Postgres 15 native, Redis native. **Docker tidak dipakai untuk dev.** Semua perintah di dokumen ini jalan tanpa Docker Engine hidup.

## 0. Prasyarat

| Kebutuhan | Cek |
|---|---|
| Bun 1.3.14 | `bun --version` |
| Postgres 15 jalan di `localhost:5432` | `psql -tAc 'select version()' postgres` |
| Redis jalan di `localhost:6379` | `redis-cli ping` (harus `PONG`) |

Kalau Postgres atau Redis belum jalan (Homebrew):

```bash
brew services start postgresql@15
brew services start redis
```

## 1. Clone bersih sampai aplikasi jalan

```bash
git clone git@github.com:Adefebrian/krakatausteel.git
cd krakatausteel

bun install

cp .env.example .env          # nilai default sudah benar untuk Postgres Homebrew

createdb tjsl_dev             # database pengembangan
createdb tjsl_test            # database test, dipakai bun test

bun run db:status             # cek dua URL terbaca dan mengarah ke database yang benar
bun run db:migrate           # migrasi ke tjsl_dev
bun run db:reset             # wipe + migrasi tjsl_test dari nol

bun run verify               # gate lengkap, harus PASSED sebelum lanjut

bun run dev                  # web di :3000, api di :3001
```

Cek hidup:

```bash
curl -fsS http://localhost:3001/health   # {"ok":true}
open http://localhost:3000
```

`bun run dev` menjalankan `apps/web` (rebuild tiap save, bukan HMR, memang begitu supaya jalur build dev dan prod identik) dan `apps/api` (`bun --watch`, restart tiap save) paralel.

## 2. Satu perintah untuk seluruh gate

```bash
bun run verify
```

Isinya, berurutan, berhenti di kegagalan pertama dan keluar non-zero:

| Langkah | Perintah | Kenapa |
|---|---|---|
| 1 | `bun tools/db.ts reset` | schema test dibuang, seluruh `migrations/*.sql` diputar ulang dari 0001, jadi test selalu mulai dari schema yang diketahui |
| 2 | `bun run typecheck` | `tsc --noEmit` di semua workspace. Langkah tersendiri dan paling awal karena `apps/api` tidak punya build step nyata (`echo ... && exit 0`, API dikirim sebagai sumber TypeScript), jadi tanpa langkah ini paket terbesar di repo tidak pernah dicek tipenya di gate |
| 3 | `bun run build` | SPA benar benar terbangun |
| 4 | `bun test` | seluruh suite, termasuk yang memakai Postgres nyata |
| 5 | `bun run check:boundaries` | tidak ada deep import antar modul, infra selalu di balik port, dan tidak ada tulis mentah ke `jurnal` / `jurnal_baris` di luar `modules/jurnal/**` (invarian 11) |
| 6 | `bun run check:compose` | validasi statis `infra/docker-compose.prod.yml` tanpa Docker |

Ringkasan PASS/FAIL per langkah dicetak di akhir. Langkah 1 berubah jadi `SKIP` (bukan gagal) kalau Postgres tidak bisa dihubungi, dan ringkasannya menyebutkan itu, supaya tidak ada gate yang lulus diam diam tanpa database.

Ini gate yang dipakai setiap fase di `docs/BUILD-PLAN.md`.

## 3. Database

### Kenapa test butuh Postgres sungguhan

Invarian akuntansi sistem ini (Bagian 3 spesifikasi) ditegakkan oleh trigger dan check constraint di dalam database, bukan di kode aplikasi. Repository tiruan atau in-memory fake tidak membuktikan apa pun tentang invarian itu. Karena itu test jalan di atas `tjsl_test`, database terpisah yang bisa dibangun ulang dari nol kapan saja.

### Perintah

| Perintah | Efek |
|---|---|
| `bun run db:status` | cetak `DATABASE_URL` dan `TEST_DATABASE_URL` (password disamarkan), tanpa menulis apa pun |
| `bun run db:migrate` | migrasi naik di **dev** DB (`DATABASE_URL`) |
| `bun run db:migrate:test` | migrasi naik di **test** DB (`TEST_DATABASE_URL`), tanpa wipe |
| `bun run db:reset` | **buang** schema `public` di test DB lalu putar ulang semua migrasi |
| `bun run db:seed` | seed data (masih placeholder, diisi per fase) |
| `bun run test:fresh` | `db:reset` lalu `bun test` |
| `bun run migrate create <nama>` | buat file migrasi baru bernomor di `migrations/` |

Pagar keamanan di `tools/db.ts`: perintah destruktif menolak jalan kalau nama database tidak berakhiran `_test`, dan `TEST_DATABASE_URL` yang tidak diset adalah error keras, bukan fallback diam diam ke `DATABASE_URL`. Wipe `tjsl_dev` karena env salah bukan mode kegagalan yang bisa diterima.

`db:reset` membuang **schema**, bukan database, supaya tidak butuh privilege `CREATEDB`, tidak pernah gagal dengan "database is being accessed by other users", dan sama perilakunya di lokal maupun di service container CI.

### Sesudah migrasi 0029: ada daftar kerja yang harus dibaca

`migrations/0029_koreksi_seksi_baris_laporan.sql` memperbaiki `baris_laporan.seksi`
pada database yang sudah pernah diseed sebelum perbaikan seed (nilainya berisi
nama laporan, bukan nama seksi, sehingga Laporan Posisi Keuangan menolak dengan
`SEKSI_ASET_NETO_TIDAK_DIKENAL`).

Migrasi itu **tidak menebak**. Baris Laporan Aktivitas hanya dikoreksi kalau
templatenya punya tepat satu kategori aset neto, karena kalau kategorinya dua
(mis. template gaya PSAK 45: tidak terikat dan terikat temporer) hanya akuntan
yang tahu baris pendapatan itu masuk yang mana. Baris seperti itu **dibiarkan apa
adanya** dan dicatat, jadi sesudah menjalankan migrasi periksa daftarnya:

```sql
SELECT b.kode AS bumn, r.laporan, r.kode, r.seksi_lama, r.alasan
  FROM _migrasi_0029_seksi_baris_laporan r
  JOIN baris_laporan l ON l.id = r.baris_laporan_id
  JOIN bumn b ON b.id = l.bumn_id
 WHERE r.keputusan = 'DILEWATI';
```

Baris yang muncul di situ masih membuat laporan 17, 19 dan 20 menolak untuk
entitas tersebut sampai seseorang mengisi seksinya dengan kode baris kategori
aset neto yang benar. Tabel yang sama menyimpan nilai lama setiap baris yang
dikoreksi, dan itulah yang dipakai rollback migrasi supaya pemulihannya persis.

### Test tidak akan pernah menyentuh DB dev

`bunfig.toml` di root memuat `tools/test-env.ts` sebagai preload, sebelum satu pun modul di-import. File itu menimpa `DATABASE_URL` dengan `TEST_DATABASE_URL` untuk proses test, dan menolak jalan kalau hasilnya bukan database `_test`. `tools/db.test.ts` menguji pagar ini, jadi kalau preload dilepas, suite yang gagal.

Konsekuensinya: **jalankan test dari root repo**. Bun hanya membaca `bunfig.toml` terdekat dari cwd, jadi `cd apps/api && bun test` melewati preload ini. Lihat bagian berikut untuk cara menjalankan sebagian test dengan benar.

### Inspeksi DB dev dengan psql

```bash
psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"    # atau: psql tjsl_dev
```

Di dalam psql:

```
\dt                       daftar tabel
\d+ pumk_proposal         struktur satu tabel, termasuk trigger dan constraint
\dv                       daftar view
\df                       daftar function
select * from _migrations order by id;    migrasi yang sudah terpasang
\x on                     tampilan vertikal, enak untuk baris lebar
\q                        keluar
```

Sekali jalan tanpa masuk shell:

```bash
psql tjsl_dev -c 'select id, applied_at from _migrations order by id'
psql tjsl_test -c '\dt'
```

## 4. Menjalankan sebagian test saja

Selalu dari root repo (supaya preload dan happy-dom aktif). Argumen `bun test` adalah filter path:

```bash
bun test apps/api/src          # hanya test apps/api
bun test apps/web/src          # hanya test apps/web
bun test tools                 # hanya test tooling (tools/db.test.ts)
bun test apps/api/src/modules/example    # satu folder modul
bun test --test-name-pattern "health"    # filter berdasarkan nama test
bun test apps/api/src/index.test.ts      # satu file
```

`cd apps/api && bun test` juga bekerja, tapi tanpa pagar `tools/test-env.ts`, jadi jangan dipakai untuk test yang menyentuh database.

## 4b. Aturan tulis ledger (invarian 11)

`bun run check:boundaries` menolak `insert into` / `update` / `delete from` terhadap tabel `jurnal` dan `jurnal_baris` di file mana pun di bawah `apps/api/src/modules/**` (kecuali `modules/jurnal/**`), `apps/api/src/core/**`, dan direktori seed. Setiap event yang berkonsekuensi keuangan harus lewat `postingEvent` dari `modules/jurnal`, satu jalur, atau buku besar tidak bisa direkonsiliasi.

Penjaga utamanya adalah trigger database (bergantung pada `SET LOCAL tjsl.jalur_posting` di dalam transaksi). Pengecekan statis ini garis kedua: menangkap hasil copy-paste di gate, sebelum sampai ke Postgres.

Yang tidak dikecualikan: `*.test.ts` dan `test-support.ts` di luar `modules/jurnal/**`. Kalau sebuah fixture benar benar butuh menulis baris jurnal langsung, pakai pengecualian eksplisit satu baris tepat di atas statementnya:

```ts
// boundary-allow: ledger-write alasan yang jelas, minimal 10 karakter
```

Satu pengecualian berlaku untuk satu statement saja, dan setiap pengecualian yang aktif dicetak di setiap run supaya tidak menumpuk tanpa terlihat.

## 5. Perintah lain

```bash
bun run typecheck        # tsc --noEmit di semua workspace, via turbo
bun run lint             # lint per workspace, via turbo
bun run build            # build semua workspace, via turbo
bun run check:boundaries # batas modul + aturan tulis ledger
bun run check:compose    # validasi statis compose produksi
```

## 6. Menjalankan stack produksi lokal (OPSIONAL, butuh Docker)

**Tidak diperlukan untuk pengembangan sehari hari.** Docker tidak hidup di mesin dev saat ini, dan semua di atas jalan tanpanya. Bagian ini hanya relevan kalau nanti Docker Desktop dinyalakan dan kamu mau menguji stack yang sama dengan server sebelum deploy.

Prasyarat: `docker compose version` bekerja.

```bash
# 1. env produksi terpisah, jangan pakai .env
cp .env.example .env.prod
# isi APP_DOMAIN (boleh localhost untuk uji lokal), POSTGRES_PASSWORD,
# MINIO_ROOT_USER, MINIO_ROOT_PASSWORD=$(openssl rand -hex 32)

# 2. validasi compose secara nyata (ini yang tidak bisa dijalankan tanpa daemon)
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod config

# 3. naikkan stack
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod up -d --build

# 4. migrasi dijalankan setelah container hidup, bukan saat build image
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod exec api bun tools/migrate.ts up

# 5. status dan log
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod ps
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod logs -f api

# 6. turunkan (tanpa -v, supaya volume data tidak ikut terhapus)
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod down
```

Catatan untuk uji lokal: Caddy minta sertifikat Let's Encrypt untuk `APP_DOMAIN`, dan itu gagal kalau domainnya tidak mengarah ke mesin ini. Untuk uji lokal pakai `APP_DOMAIN=localhost` supaya Caddy memakai sertifikat internal, dan terima peringatan sertifikat di browser. Postgres, Redis, dan MinIO di stack ini tidak mem-publish port ke host (dijaga oleh `bun run check:compose`), jadi mereka tidak akan bentrok dengan Postgres dan Redis native di port 5432 dan 6379.

`infra/docker-compose.yml` (Postgres plus Redis saja, dengan port dipublish) ada untuk kasus lain: mesin tanpa Postgres native. Kalau itu dipakai, matikan dulu Postgres native, atau port 5432 akan bentrok.

Deploy sungguhan ke server ada di `infra/DEPLOY.md`. Deploy selalu manual dari server; CI tidak pernah menyentuh server.

## 7. Kalau macet

| Gejala | Sebab dan solusi |
|---|---|
| `TEST_DATABASE_URL is not set` | `.env` belum ada atau belum punya key itu, `cp .env.example .env` |
| `database "tjsl_test" does not exist` | `createdb tjsl_test` |
| `ECONNREFUSED 127.0.0.1:5432` | Postgres mati, `brew services start postgresql@15` |
| `verify` melaporkan langkah 1 `SKIP` | Postgres tidak terhubung; test yang butuh DB tidak benar benar terbukti, perbaiki dulu sebelum menganggap gate lulus |
| `Refusing to use TEST_DATABASE_URL=...` | nama database tidak berakhiran `_test`, itu pagar keamanan, ganti nama databasenya |
| `document is not defined` di test | test dijalankan dari cwd yang bunfig-nya tidak memuat happy-dom, jalankan dari root repo |
| Build web bersih tapi halaman kosong | `rm -rf apps/web/dist .turbo && bun run build` |
