# SEED.md

Isi data demo, kredensial semua role, dan skenario demo yang disarankan.
Dokumen ini tumbuh per fase; yang ada di bawah adalah **Fase 0** (auth, RBAC,
scope cabang, audit log, konfigurasi, generator nomor dokumen). Data transaksi
24 bulan yang diminta spesifikasi Bagian 13 masuk di Fase 9.

## Cara menjalankan

```bash
bun run db:seed        # ke TEST_DATABASE_URL (tjsl_test), aman, bisa diulang
bun run db:seed:dev    # ke DATABASE_URL (tjsl_dev), untuk demo di lokal
```

Seed bersifat **idempoten**: dijalankan dua kali hasilnya sama, dan nilai
konfigurasi yang sudah diubah operator tidak ditimpa. Isinya tiga bagian:

| Modul | Isi | Kapan dipakai |
|---|---|---|
| `seedRbac` | 39 permission, 6 role sistem, dan grant antar keduanya | selalu |
| `seedKonfigurasiTambahan` | 9 kunci konfigurasi kapabilitas yang tidak dibawa migrasi (lihat `docs/BUILD-PLAN.md`) | selalu |
| `seedDemo` | 1 BUMN, 1 pusat + 2 cabang, 7 akun, 1 mitra + akun portal, 1 periode berjalan | **hanya demo** |

## KREDENSIAL DEMO (DEMO ONLY)

**Jangan pernah dipakai di database produksi.** Password sengaja ditulis di
sini dan dicetak oleh `db:seed`: kredensial demo yang terlihat seperti rahasia
lebih berbahaya daripada yang jelas jelas bukan rahasia. Sebelum go-live,
akun akun ini dihapus (soft delete) dan diganti akun riil.

Password untuk **semua** akun di bawah: `TjslDemo#2026`

| Username | Role | Cabang | Bisa apa |
|---|---|---|---|
| `maker` | Maker | 01 Cabang Cilegon | Input proposal, survey, akad, pencairan, angsuran, jurnal DRAFT |
| `checker` | Checker | 01 Cabang Cilegon | Review dan rekomendasi, verifikasi jurnal DRAFT. Tidak bisa input data baru |
| `approver` | Approver | 01 Cabang Cilegon | Setujui proposal, posting jurnal, eksekusi closing |
| `admincabang` | Admin Cabang | 01 Cabang Cilegon | Semua kewenangan operasional, **tetap terikat satu cabang** |
| `maker.serang` | Maker | 02 Cabang Serang | Ada supaya skenario lintas cabang punya data di kedua sisi |
| `adminpusat` | Admin Pusat | 00 Kantor Pusat | Semua cabang, master data, COA, konfigurasi, reopen periode |
| `auditor` | Auditor | 00 Kantor Pusat | Read only penuh termasuk audit trail. **Tidak bisa mengubah apa pun** |

Akun portal mitra (login portal publik, endpointnya baru dibangun di Fase 7):

| Email | Password | Mitra |
|---|---|---|
| `mitra@demo.tjsl.local` | `TjslDemo#2026` | `MTR-DEMO-0001` Warung Sembako Demo, Cabang Cilegon |

Username `maker` sampai `auditor` sengaja sama dengan akun demo di
`apps/web/src/api/auth.ts`, jadi SPA berperilaku sama baik saat memakai stub
demo maupun saat sudah menembak API sungguhan.

## Struktur organisasi demo

```
BUMN  KRAS  PT Krakatau Steel (Persero) Tbk
├── 00  Kantor Pusat     (is_pusat)   adminpusat, auditor
├── 01  Cabang Cilegon               maker, checker, approver, admincabang
└── 02  Cabang Serang                maker.serang
```

Setiap akun demo juga dibuat sebagai baris `karyawan` di cabangnya, supaya bisa
dipilih sebagai petugas survey di Fase 3 tanpa seed tambahan.

## Skenario demo Fase 0 yang disarankan

Empat hal yang bisa dibuktikan hari ini, semuanya lewat API langsung
(`curl`) maupun lewat UI:

1. **Login semua role.** `POST /auth/login` untuk ketujuh akun, lalu
   `GET /auth/session`. Perhatikan `permissions` berbeda per role dan menu di
   SPA ikut menyesuaikan. Ini kriteria selesai Fase 0 di spesifikasi Bagian 14.
2. **Akses tidak sah ditolak di API, bukan cuma tombolnya hilang.**
   Login sebagai `maker`, lalu `GET /audit` dan `PUT /konfigurasi/...`:
   dua duanya `403`. Ulangi sebagai `adminpusat`: `200`.
   (Spesifikasi Bagian 2 aturan 4.)
3. **Auditor benar benar read only.** Login sebagai `auditor`, semua laporan
   dan `GET /audit` terbuka, tapi setiap `POST`/`PUT`/`PATCH`/`DELETE` ke
   endpoint apa pun ditolak `403` sebelum sampai ke handler.
   (Spesifikasi Bagian 16 skenario 23.)
4. **Scope cabang tidak bisa ditembus lewat URL.** Login sebagai `maker`
   (Cabang Cilegon), lalu `GET /organisasi/karyawan/<id karyawan Cabang
   Serang>`: `403`, dengan pesan yang tidak membocorkan cabang mana.
   (Spesifikasi Bagian 16 skenario 24.)

Setiap penolakan di atas meninggalkan baris `DITOLAK` di `audit_log` lengkap
dengan user, IP, aksi, dan alasannya, dan tabel itu append only.

## Catatan

- Seed **tidak** membuat COA, wilayah, sektor, bidang, atau SDG. Data master
  itu ikut fase yang memakainya (COA di Fase 1, wilayah dan sektor di Fase 3),
  supaya tidak ada data master yang tidak jelas siapa pemiliknya.
- Periode berjalan (bulan kalender saat seed dijalankan) dibuat berstatus
  `OPEN` supaya payload `GET /auth/session` menampilkan periode sungguhan,
  bukan tebakan. Manajemen periode penuh ada di Fase 1.
