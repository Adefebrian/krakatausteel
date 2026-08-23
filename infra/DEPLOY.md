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
bun install && bun run db:migrate && bun run dev
```

Gate sebelum apa pun dianggap jadi, satu perintah:

```bash
bun run verify
```

`verify` menjalankan reset schema plus migrasi di `tjsl_test`, lalu `bun run build`,
`bun test`, `bun run check:boundaries`, dan `bun run check:compose`, berhenti di
kegagalan pertama dengan ringkasan PASS/FAIL per langkah. Detail lingkungan lokal,
resep psql, dan cara menjalankan sebagian test ada di `docs/DEV.md`.

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
| `S3_REGION` | region S3, default `us-east-1`, MinIO tidak peduli nilainya tapi SDK butuh diisi |
| `OPENAI_API_KEY` | boleh kosong kalau layer AI dimatikan |
| `AI_ENABLED` | `false` sampai fase AI benar benar dipakai |
| `TRUSTED_PROXY_COUNT` | jumlah reverse proxy di depan API, dihitung dari socket ke dalam. Topologi di `infra/docker-compose.prod.yml` cuma punya satu Caddy, jadi `1` (nilai default kalau key ini tidak diisi). Naikkan HANYA kalau benar benar ada proxy tambahan (misal CDN di depan Caddy). Salah setting bikin rate limit dan `audit_log.ip` memakai alamat palsu yang dikirim klien, lihat `apps/api/src/core/client-ip.ts` |
| `TRUSTED_PROXY_CIDRS` | opsional, alternatif `TRUSTED_PROXY_COUNT` untuk topologi dengan kedalaman proxy tidak tetap: daftar CIDR milik infrastruktur sendiri, dipisah koma |

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
- CI di `.github/workflows/ci.yml` jalan di runner GitHub biasa (bukan self
  hosted). Postgres 15 dan Redis 7 dipakai sebagai service container, migrasi
  diterapkan lebih dulu, lalu typecheck, lint, test, build, cek boundary, dan
  cek statis compose. CI tidak pernah menyentuh server dan tidak pernah
  memegang kredensial yang bisa menjangkaunya. Deploy tetap manual dari server
  lewat `git pull`.
- `docker compose ... config` belum pernah dijalankan untuk file ini karena
  Docker tidak hidup di mesin dev. Gantinya `bun run check:compose` memvalidasi
  file secara statis (YAML valid, setiap `${VAR}` terdokumentasi di sini dan ada
  di `.env.example`, tidak ada layanan stateful yang mem-publish port, semua
  service punya healthcheck, tidak ada secret hardcoded). Jalankan
  `docker compose -f infra/docker-compose.prod.yml --env-file .env.prod config`
  sekali di server sebelum deploy pertama.
