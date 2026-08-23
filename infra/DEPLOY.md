# Deploy krakatausteel (TJSL Online) ke server sendiri

Target: satu server milik sendiri, bukan PaaS. Semua komponen jalan dalam satu
Docker Compose stack di host itu: Caddy sebagai reverse proxy dan TLS, SPA web,
API Hono, Postgres, Redis, MinIO untuk lampiran dokumen.

Selama pengembangan tidak ada yang perlu di-deploy. Semua jalan lokal, lihat
bagian berikut.

## Menjalankan lokal (kondisi saat ini)

Dev lokal tidak memakai Docker. Postgres dan Redis native yang sudah jalan di
mesin dipakai langsung:

| Komponen | Lokal |
|---|---|
| Postgres | `localhost:5432`, database `tjsl_dev` dan `tjsl_test` |
| Redis | `localhost:6379` |
| API | port 3001 |
| Web | port 3000 |
| Object storage | belum diperlukan; upload dokumen menulis ke disk lokal sampai fase yang benar benar butuh MinIO |

Perintah harian:

```bash
bun install && bun tools/migrate.ts up && bun run dev
```

Gate sebelum apa pun dianggap jadi:

```bash
bun run build && bun test && bun run check:boundaries
```

`infra/docker-compose.yml` (Postgres plus Redis saja) tersedia kalau suatu saat
mau dev di dalam container, tapi bukan jalur default sekarang.

## Prasyarat server

1. Linux dengan Docker Engine dan plugin Compose v2, cek dengan `docker compose version`.
2. Domain atau subdomain yang A recordnya sudah menunjuk ke IP server.
3. Port 80 dan 443 terbuka dari internet. Port lain tidak perlu dibuka sama
   sekali: Postgres, Redis, dan MinIO tidak mem-publish port, hanya ada di
   network internal Compose.
4. Disk cukup untuk volume Postgres dan MinIO, plus ruang backup.

## Langkah pertama di server

```bash
git clone git@github.com:Adefebrian/krakatausteel.git
cd krakatausteel
cp .env.example .env.prod
```

Isi `.env.prod` di server, file ini tidak pernah di-commit:

| Key | Isi |
|---|---|
| `APP_DOMAIN` | domain publik tanpa skema, misal `tjsl.domainku.com` |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | kredensial database, password acak panjang |
| `SESSION_SECRET` | acak minimal 32 byte, hasilkan dengan `openssl rand -hex 32` |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | kredensial object storage |
| `S3_BUCKET` | nama bucket, default `tjsl` |
| `OPENAI_API_KEY` | boleh kosong kalau layer AI dimatikan |
| `AI_ENABLED` | `false` sampai fase AI benar benar dipakai |

Lalu naikkan stack dan jalankan migrasi:

```bash
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod exec api bun tools/migrate.ts up
```

Verifikasi: `curl -fsS https://$APP_DOMAIN/api/health` mengembalikan
`{"ok":true}` dan halaman login terbuka di `https://$APP_DOMAIN`.

## Update versi

```bash
git pull
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod exec api bun tools/migrate.ts up
```

Migrasi dijalankan setelah container baru hidup, bukan saat build image, supaya
proses build tidak pernah menyentuh database.

## Rollback

Rollback berarti checkout commit sebelumnya lalu build ulang. Migrasi database
tidak ikut turun otomatis. `bun tools/migrate.ts down` hanya membalik satu
migrasi terakhir dan harus dijalankan secara sadar, karena ini sistem pembukuan
dan menurunkan skema bisa membuang data keuangan. Ambil backup lebih dulu,
selalu.

## Backup

Minimal harian, biasakan sejak sebelum ada data riil:

```bash
docker compose -f infra/docker-compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > backup-$(date +%F).sql.gz
```

Volume MinIO dibackup terpisah, rsync direktori volume atau `mc mirror` ke
storage lain. Uji restore ke database kosong sekali sebelum sistem dipakai
sungguhan. Backup yang belum pernah direstore bukan backup.

## Catatan keamanan

- Tidak ada layanan stateful yang mem-publish port ke host. Akses Postgres dari
  laptop lewat SSH tunnel, jangan membuka 5432 ke internet.
- `SESSION_SECRET` dan password database wajib berbeda antara lokal dan server.
- Console MinIO (port 9001) tidak diproxy Caddy. Kalau perlu diakses, lewat SSH
  tunnel.
- Rate limit aplikasi di `apps/api/src/core/hardening.ts` mengambil IP dari
  header `X-Forwarded-For` nilai paling kiri. Nilai paling kiri bisa dipalsukan
  klien, sedangkan yang benar adalah hop yang diisi proxy tepercaya, yaitu Caddy
  di stack ini. Ini dicatat sebagai temuan untuk pass keamanan, harus diperbaiki
  sebelum portal publik dibuka.
- CI di `.github/workflows/ci.yml` jalan di runner GitHub biasa dan hanya
  menjalankan typecheck, lint, test, build, dan cek boundary. CI tidak pernah
  menyentuh server. Deploy tetap manual dari server lewat `git pull`.
