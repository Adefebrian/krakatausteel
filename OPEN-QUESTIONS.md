# OPEN QUESTIONS

Pertanyaan yang muncul dari pembacaan spesifikasi `PROMPT-TJSL-Online.md` saat membangun model
data, di mana spesifikasi **bertentangan dengan dirinya sendiri** atau tidak cukup untuk
menentukan satu jawaban. Untuk setiap butir dicatat bacaan paling konservatif yang dipakai
sekarang, supaya pekerjaan bisa lanjut tanpa mengarang aturan diam diam.

Butir yang sudah punya keputusan sementara juga tercatat di `ASSUMPTIONS.md`.

---

## 1. Idempotensi closing kolektibilitas: hapus atau perbarui?

**Konflik:** Bagian 8.1 menyatakan menjalankan ulang closing untuk periode yang sama
"menghapus snapshot lama periode itu dan menulis ulang". Invarian 12 (Bagian 3) menyatakan
semua entitas keuangan memakai soft delete dan tidak ada operasi yang menghapus data keuangan
secara fisik.

**Dipakai sekarang:** upsert di tempat. `kolektibilitas_snapshot` unik pada
`(periode_id, akad_id)` tanpa filter soft delete, jadi run ulang memperbarui baris yang sama.
Hasil akhir identik dengan "hapus lalu tulis ulang" dan tidak ada baris keuangan yang hilang.

**Perlu keputusan:** apakah hasil run yang digantikan perlu disimpan sebagai riwayat (butuh
kolom versi pada snapshot), atau cukup hasil terakhir saja.

## 2. Periode entitas-wide, tetapi closing kolektibilitas dan penyisihan per cabang

**Konflik:** `periode` didefinisikan per BUMN (Bagian 4.7) dengan satu status. Sementara closing
kolektibilitas (Bagian 8.1) dan `penyisihan_periode` (Bagian 4.7) berscope cabang, dan Bagian
8.4 checklist bicara soal "closing periode" tanpa menyebut cabang.

**Dipakai sekarang:** status periode berlaku untuk seluruh entitas. Satu cabang tidak bisa
"tutup sendiri". Closing kolektibilitas boleh dijalankan per cabang, tetapi periode baru boleh
di-CLOSED setelah semua prasyarat semua cabang terpenuhi.

**Perlu keputusan:** apakah ada kebutuhan cabang menutup pembukuannya lebih dulu (pola "soft
close per cabang, hard close per entitas"). Kalau ya, `periode` butuh tabel turunan status per
cabang, dan guard jurnal periode CLOSED harus jadi per cabang. Ini perubahan berdampak luas dan
jauh lebih murah diputuskan sekarang.

## 3. Kapan `ANGSURAN_JASA_ADM` versus `ANGSURAN_JASA_ADM_AKRUAL` dipakai?

**Konflik:** Bagian 6.4 menyediakan dua event: `ANGSURAN_JASA_ADM` (Kas / Pendapatan Jasa
Administrasi) dan `ANGSURAN_JASA_ADM_AKRUAL` (Kas / Piutang Jasa Administrasi). Bagian 8.3
menyatakan saat kas diterima "pakai event `ANGSURAN_JASA_ADM_AKRUAL`". Dengan default
`metode_pengakuan_jasa_adm = ACCRUAL`, tidak jelas kapan `ANGSURAN_JASA_ADM` masih terpakai:
saat jasa yang diterima belum pernah diakrual (misalnya akad kolektibilitas MACET yang tidak
diakrual, atau setoran di bulan yang sama sebelum closing), atau tidak terpakai sama sekali.

**Dipakai sekarang:** model data tidak memaksa pilihan. `event_jurnal_mapping` menyimpan kedua
event, dan `akrual_jasa_snapshot` menyimpan berapa jasa yang sudah diakrual per akad per
periode, sehingga engine bisa memutuskan per rupiah: sebesar yang pernah diakrual pakai event
akrual, sisanya pakai event non akrual.

**Perlu keputusan:** aturan pemilihan event tersebut wajib dikonfirmasi tim akuntansi sebelum
engine angsuran dibangun, karena salah pilih berarti pendapatan diakui dua kali.

## 4. Basis 360 hari dipakai di mana pada metode FLAT?

**Konflik:** `jasa_adm_basis_hari = 360` (Bagian 5.3) adalah parameter perhitungan harian,
sementara metode default FLAT dengan tenor bulanan biasanya dihitung
`pokok x rate x tenor / 12` tanpa basis hari.

**Dipakai sekarang:** parameter disimpan (`konfigurasi.jasa_adm_basis_hari`) tetapi model data
tidak mengasumsikan penggunaannya. Kandidat pemakaian: perhitungan jasa pro-rata untuk pelunasan
dipercepat, dan akrual harian di akhir periode saat tanggal jatuh tempo tidak jatuh di akhir
bulan.

**Perlu keputusan:** rumus resmi jasa administrasi untuk FLAT, EFEKTIF dan ANUITAS, dengan satu
contoh angka per metode. Ini prasyarat fase engine angsuran (test wajib Bagian 7.5 butir 1
sampai 4 tidak bisa ditulis tanpa ini).

## 5. Status akad sebelum pencairan tidak ada di daftar

**Konflik:** state machine Bagian 9.1 punya `AKAD_DIBUAT` dan `JADWAL_SIAP` sebelum `DICAIRKAN`,
tetapi daftar status akad Bagian 4.4 hanya `AKTIF / LUNAS / RESCHEDULED / MACET / HAPUS_BUKU`.

**Dipakai sekarang:** ditambahkan status `BELUM_CAIR` (lihat ASSUMPTIONS A-08), supaya akad yang
belum dijurnal tidak merusak rekonsiliasi sub buku besar piutang.

**Perlu keputusan:** konfirmasi penamaan status ini, karena akan muncul di UI dan laporan.

## 6. Dasar perhitungan penyisihan: pokok saja atau pokok plus jasa?

**Konflik:** Bagian 8.1 butir 5 menyatakan `nilai_penyisihan = outstanding_pokok x
rate_penyisihan` (mengunci basis ke pokok), sementara Bagian 5.2 meminta opsi konfigurasi
`OUTSTANDING_POKOK` atau `OUTSTANDING_POKOK_PLUS_JASA`.

**Dipakai sekarang:** konfigurasi disediakan dengan default `OUTSTANDING_POKOK` (sesuai Bagian
8.1), dan basis yang benar benar dipakai disimpan per baris snapshot sehingga periode lampau
tetap bisa direkonstruksi.

**Perlu keputusan:** apakah klien memang pernah memakai basis pokok plus jasa. Kalau tidak,
opsinya bisa dihapus dari UI untuk mengurangi peluang salah setel.

## 7. Reopen periode dan snapshot saldo

**Konflik:** Bagian 8.4 menyatakan reopen "otomatis menghapus snapshot saldo periode itu",
sementara invarian 12 melarang penghapusan fisik data keuangan.

**Dipakai sekarang:** `saldo_akun_periode` diperlakukan sebagai data turunan, bukan data
keuangan sumber, sehingga penghapusan fisiknya diizinkan (dan bisa dihasilkan ulang dari
ledger). Tabel ini satu satunya tabel keuangan yang tidak diberi proteksi hapus.

**Perlu keputusan:** apakah auditor klien menerima bahwa snapshot saldo periode yang di-reopen
hilang, atau perlu diarsipkan (butuh kolom "reopen ke berapa" dan penyimpanan berlapis).

## 8. Batas maksimum pinjaman aktif per mitra: aturan keras atau parameter?

**Konflik:** Bagian 5.5 menyebut `maks_pinjaman_aktif_per_mitra: 1` sebagai parameter
konfigurable, tetapi mengizinkan lebih dari satu piutang aktif per mitra mengubah arti
rekonsiliasi per mitra dan Kartu Piutang.

**Dipakai sekarang:** ditegakkan sebagai partial unique index di database (ASSUMPTIONS A-13),
jadi menaikkan batas butuh migrasi eksplisit, bukan sekadar edit konfigurasi.

**Perlu keputusan:** apakah klien pernah memberi lebih dari satu akad aktif ke satu mitra
(misalnya pinjaman modal kerja + pinjaman investasi). Kalau ya, index harus dibuang sebelum
fase seed.

## 9. Retensi data portal publik

**Tidak diatur spesifikasi:** berapa lama `portal_submission` berstatus DITOLAK (beserta
`data_json` yang memuat data pribadi dan `dokumen_json`) disimpan.

**Dipakai sekarang:** tidak ada penghapusan otomatis; kredensial cek status disimpan sebagai
hash (ASSUMPTIONS A-18).

**Perlu keputusan:** kebijakan retensi dan anonimisasi, sebelum portal publik dibuka.

## 10. Struktur akun Aset Neto Terikat Temporer

**Tidak cukup diatur:** Bagian 10.3 laporan 17 dan 19 meminta bagian "Perubahan Aset Neto
Terikat Temporer", tetapi tidak ada satu pun event di Bagian 6.4 yang mengkredit atau mendebit
aset neto terikat temporer, dan tidak ada mekanisme pelepasan pembatasan (release from
restriction).

**Dipakai sekarang:** `akun.tipe = 'ASET_NETO'` dan `baris_laporan` sudah mampu memuat kedua
kategori, jadi struktur laporannya bisa dibentuk sebagai data. Yang belum ada adalah event
jurnalnya.

**Perlu keputusan:** apakah unit TJSL klien benar benar punya dana terikat temporer, dan kalau
ya, event apa yang membentuk serta melepaskannya. Tanpa itu, bagian laporan tersebut akan selalu
nol.
