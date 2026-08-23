# Integrasi TJSL Online dengan Accurate (CPSSoft)

Dokumen riset verifikasi. Bukan rencana implementasi, bukan rekomendasi adopsi.
Tanggal riset: 23 Agustus 2026.

## 0. Batas metodologi (baca dulu, ini menentukan bobot semua temuan di bawah)

Pada sesi riset ini alat pembuka halaman (WebFetch) diblokir oleh hook lingkungan,
sehingga **tidak ada satu pun halaman sumber yang bisa saya buka langsung**. Semua
temuan di bawah berasal dari ekstraksi mesin pencari atas halaman yang URL-nya
dicantumkan. Konsekuensinya:

- Kutipan angka, nama field, dan nama endpoint di dokumen ini **belum diverifikasi
  dengan membuka halaman aslinya**. Wajib dicek ulang sebelum dipakai untuk keputusan
  teknis.
- Referensi API primer Accurate Online **tidak dapat dijangkau** karena berada di
  balik login Area Developer. Dua dokumen yang akan menyelesaikan hampir semua
  pertanyaan teknis di bawah:
  1. `https://account.accurate.id/developer/api-docs.do` (daftar + dokumentasi
     Basic API dan Accurate API, termasuk daftar scope)
  2. `https://account.accurate.id/open-api/json.do` (skema OpenAPI, bisa diimpor ke
     Postman/Swagger untuk melihat path, parameter, dan bentuk respons secara pasti)
  Keduanya perlu akun developer AOL. Selama belum diambil, semua nama endpoint dan
  nama field di dokumen ini berstatus **belum terkonfirmasi**.

Label tingkat keyakinan yang dipakai konsisten di seluruh dokumen:

| Label | Arti |
| --- | --- |
| **[P]** | Halaman resmi Accurate/CPSSoft (`accurate.id`, `help.accurate.id`, `cpssoft.com`), isi diambil lewat ekstraksi pencarian, halaman tidak saya buka sendiri |
| **[S]** | Sumber sekunder: reseller, konsultan, blog partner, forum, karya akademik |
| **[?]** | Tidak ditemukan sumber apa pun. Tidak diisi dengan dugaan |

Satu peringatan khusus: mesin pencari beberapa kali **mencampur "Accurate Online"
(CPSSoft, Indonesia) dengan "Exact Online" (Exact, Belanda)**. Angka rate limit
"60 panggilan per menit, 5.000 per hari" yang muncul saat pencarian adalah milik
**Exact Online**, bukan Accurate. Angka itu sengaja tidak dipakai di dokumen ini.
Kalau nanti ada dokumen internal yang menyebut angka tersebut untuk Accurate,
curigai sumbernya.

---

## 1. Produk Accurate mana yang punya permukaan integrasi hari ini

### Temuan

**Accurate Online (cloud) - satu-satunya yang punya API publik resmi.**

- Ada portal integrasi resmi dengan halaman OAuth, contoh API, daftar scope, dan
  informasi error. Aplikasi harus didaftarkan lebih dulu di Area Developer
  (`account.accurate.id/developer`) dan menerima Client ID + Client Secret. **[P]**
- Protokol: HTTP/REST gaya `*.do`, respons JSON. Pola URL yang disebut halaman contoh
  resmi: `https://[host]/accurate/api/<modul>/save.do`. **[P]**
- API dibagi dua: **Basic API** (operasi di luar data user, misalnya melihat daftar
  database) dan **Accurate API** (baca/tulis/ubah/hapus data di dalam database user).
  Untuk Accurate API wajib mengirim header `X-Session-ID` yang didapat dari
  `/api/open-db.do`. **[P]**
- Gating komersial: akses API dikenai biaya **per database yang diintegrasikan per
  bulan**, disebut Rp 20.000 (belum PPN) untuk "jalur umum" dan Rp 30.000 (belum PPN)
  untuk "jalur khusus" bagi aplikasi yang dipublikasikan di Marketplace Accurate
  Online. Angka ini muncul konsisten di beberapa halaman reseller, bukan di halaman
  resmi yang berhasil saya jangkau. **[S]**
- Ada halaman bantuan resmi berjudul "Cara Menonaktifkan Integrasi API di Accurate
  Online" yang berada di bawah kategori **Accurate Store**
  (`help.accurate.id/product/accurate-online/accurate-store/cara-hapus-api/`). Ini
  menguatkan dugaan bahwa integrasi API dikelola sebagai add-on per database lewat
  Accurate Store, bukan fitur bawaan semua langganan. **[P]** untuk keberadaan
  halaman; **[?]** untuk mekanisme aktivasi dan syarat paket persisnya.
- Apakah akses API dibatasi edisi/paket tertentu (Lite / Standard / Deluxe /
  Enterprise): **[?]**. Tidak ditemukan pernyataan resmi. Yang ditemukan hanya
  pernyataan reseller bahwa "API Key di Accurate Online bersifat Open". **[S]**

**Accurate 5 / Accurate Desktop (on-premise, Firebird).**

- Halaman produk resmi Accurate Desktop mendeskripsikannya sebagai software akuntansi
  offline sekali bayar, dan **tidak menyebut API sama sekali** dalam materi yang bisa
  saya jangkau. **[P]** untuk isi halaman produk; ketiadaan penyebutan bukan bukti
  ketiadaan fitur.
- Tidak ditemukan portal developer, dokumentasi API, atau SDK resmi untuk Accurate 5 /
  Desktop. **[?]** (pencarian eksplisit tidak menghasilkan sumber resmi mana pun)
- Accurate 5 berjalan di atas **Firebird 2.5** dan hanya versi itu. **[S]** (beberapa
  blog konsultan Accurate menyatakan hal yang sama, saling menguatkan)

### Sumber

- Integrasi API Accurate Online (resmi): https://accurate.id/api-integration/
- API Example (resmi, pola URL + header + open-db): https://accurate.id/api-integration/api-example/
- Scope pada proses OAuth (resmi): https://accurate.id/api-integration/scope/
- OAuth (resmi): https://accurate.id/api-integration/oauth/
- API Integration Error Info & Solution (resmi): https://accurate.id/api-integration/error-info/
- Cara Menonaktifkan Integrasi API di Accurate Online (resmi, help center, kategori Accurate Store): https://help.accurate.id/product/accurate-online/accurate-store/cara-hapus-api/
- Accurate Desktop, halaman produk resmi CPSSoft: https://cpssoft.com/produk/accuratedesktop/
- Biaya API per database (sekunder, reseller): https://penjualanonline.id/integrasi-accurate-online/ dan https://aplikasiandalanmilenial.co.id/dokumentasi-api-key-accurate-online/
- Accurate 5 dan Firebird 2.5 (sekunder, konsultan): https://aboutaccurate.com/2018/06/07/accurate-5-berjalan-pada-firebird-2-5/ dan https://softwareaccounting.id/accurate-5-hanya-bergerak-di-firebird-2-5/

### Dampak ke desain kita

Integrasi terprogram hanya realistis kalau unit TJSL memakai **Accurate Online**.
Kalau yang dipakai Accurate 5/Desktop, desain harus berasumsi **file-based** (ekspor
Excel/CSV dari sisi kita, impor manual di sisi Accurate) dan tidak boleh ada komponen
yang bergantung pada respons sinkron dari Accurate.

Karena biayanya per database per bulan, integrasi ini punya biaya berjalan yang harus
disetujui pemilik anggaran, bukan sekadar keputusan teknis.

---

## 2. Accurate Online: autentikasi, sesi, host, rate limit, sandbox, endpoint yang kita butuh

### Temuan

**Autentikasi.**

- Registrasi aplikasi di Area Developer menghasilkan Client ID dan Client Secret. **[P]**
- Endpoint otorisasi: `https://account.accurate.id/oauth/authorize`. Pertukaran token:
  HTTP POST ke `https://accurate.id/oauth/token`. **[S]** (muncul di tulisan
  developer dan halaman reseller; halaman resmi `accurate.id/api-integration/oauth/`
  ada tapi tidak bisa saya buka untuk konfirmasi)
- Grant type yang disebut: **implicit** dan **authorization_code**. Refresh token
  hanya tersedia pada jalur authorization_code, dan hanya bila aplikasi didaftarkan
  dengan platform "Website". **[S]**
- **Access token berlaku 15 hari** sejak dibuat. **[S]** (konsisten di dua sumber
  sekunder yang berbeda)
- Tipe token (apakah dikirim sebagai `Authorization: Bearer ...`): **[?]** tidak
  terkonfirmasi dari sumber yang bisa saya jangkau, meskipun sangat mungkin Bearer.
  Tidak saya nyatakan sebagai fakta.

**Langkah pemilihan database dan penemuan host.** Ini bagian paling penting dan paling
berbeda dari API akuntansi lain:

- Setelah punya access token, pemanggil harus memanggil **`/api/open-db.do`**. Respons
  memberikan (a) kode sesi database yang dikirim balik di header **`X-Session-ID`**
  pada setiap panggilan Accurate API, dan (b) parameter **`host`** yang harus dipakai
  sebagai prefix URL untuk panggilan berikutnya. **[P]**
- Host per database **bisa berubah kapan saja**. Ada halaman resmi khusus soal ini:
  bila host berpindah, permintaan ke host lama menjawab **HTTP 308 Permanent
  Redirect** ke host baru, klien HTTP wajib mengaktifkan follow-redirect, dan
  integrator tetap diwajibkan memperbarui konfigurasi host (contoh host baru yang
  disebut: `https://zeus.accurate.id`). **[P]**
- Masa hidup `X-Session-ID`, batas jumlah sesi terbuka, dan perilaku saat sesi
  kedaluwarsa: **[?]**. Halaman `accurate.id/api-integration/error-info/` adalah
  tempat yang tepat untuk menjawab ini, tapi isinya tidak berhasil saya ekstrak.

**Rate limit.** **[?]** Tidak ada angka rate limit resmi Accurate Online yang saya
temukan. Jangan pakai angka Exact Online. Yang bisa menyelesaikan: dokumentasi di
Area Developer dan halaman error-info.

**Sandbox / database uji.** **[?]** Tidak ditemukan sandbox atau database uji khusus
developer. Yang ada adalah **trial Accurate Online 30 hari** dengan fitur penuh dan
data yang tetap tersimpan bila dilanjutkan berlangganan, sehingga praktik yang tersedia
adalah memakai database trial atau database terpisah berbayar sebagai lingkungan uji.
**[S]** untuk trial 30 hari.

**Endpoint yang kita butuh.**

| Kebutuhan kita | Status |
| --- | --- |
| Jurnal umum multi-baris | Ada **scope** bernama `journal_voucher_save`, metode POST, dideskripsikan sebagai API untuk "membuat dan mengubah beberapa data jurnal umum sekaligus". **[S]**. Path pastinya tidak terkonfirmasi. Pola resmi `.../accurate/api/<modul>/save.do` **[P]** membuat path tertentu bisa diduga, tetapi **dugaan itu tidak saya tuliskan sebagai endpoint** |
| Daftar akun (COA) | **[?]** nama endpoint tidak terkonfirmasi. Pencarian atas nama yang saya duga tidak menghasilkan dokumen Accurate mana pun |
| Customer / vendor (untuk pemetaan Mitra Binaan) | **[?]** nama endpoint tidak terkonfirmasi. Yang terkonfirmasi hanya pola umum: `save.do` untuk simpan, `detail.do` untuk ambil satu record, parameter `id` untuk mode ubah **[P]** |
| Tutup/kunci periode | **[?]** tidak ditemukan indikasi ada API untuk tutup buku atau kunci periode. Lihat bagian 4 |

**Konvensi request yang terkonfirmasi dari halaman contoh resmi.** Ini yang paling
berguna dan paling bisa dipakai:

- Untuk **mengubah** data yang sudah ada, sertakan parameter `id` berisi ID record.
- Untuk objek dengan **detail berulang** (misalnya satu faktur banyak barang, dan
  dengan logika yang sama satu jurnal banyak baris), nama parameter di dokumentasi
  diberi indeks `[n]` dengan n mulai dari 0. Jadi baris jurnal dikirim sebagai
  parameter berindeks, bukan array JSON bersarang. **[P]**
- Bentuk respons persisnya: **[?]** tidak ada contoh respons yang bisa saya kutip.

### Sumber

- API Example (resmi): https://accurate.id/api-integration/api-example/
- Informasi terkait Response Code 308 (resmi): https://accurate.id/api-integration/informasi-terkait-response-code-308/
- Scope pada proses OAuth (resmi): https://accurate.id/api-integration/scope/
- OAuth (resmi, tidak berhasil dibuka): https://accurate.id/api-integration/oauth/
- Error Info & Solution (resmi, tidak berhasil dibuka): https://accurate.id/api-integration/error-info/
- Integrasi OAuth 2.0 di API Accurate Online, Mahdani (sekunder, Medium): https://medium.com/@mahdanidani776/integrasi-oauth-89454172f253
- Otentikasi dan Otorisasi OAuth API Accurate Online (sekunder, reseller): https://account.co.id/otentikasi-dan-otorisasi-oauth-api/
- Penggunaan API Accurate Online (sekunder, reseller): https://programakuntansi.id/penggunaan-api-accurate/
- Trial 30 hari (sekunder): https://aplikasiakuntansi.co.id/trial-accurate-online/
- Wrapper PHP komunitas, berguna untuk membaca nama endpoint nyata (sekunder, belum saya audit): https://github.com/ngambang/api-accurate
- Skripsi/laporan otomatisasi proses akuntansi dengan API Accurate (sekunder, akademik): https://openlibrary.telkomuniversity.ac.id/pustaka/files/200558/jurnal_eproc/otomatisasi-proses-akuntansi-menggunakan-api-accurate-di-pt-inovasi-daya-solusi-jakarta-selatan.pdf

### Dampak ke desain kita

Empat hal yang harus masuk desain sejak awal bila kita jadi push ke AOL:

1. Klien Accurate kita bukan "base URL tetap". Harus ada **penyimpanan host per
   database** plus penanganan 308 dan pembaruan host otomatis. Ini state, bukan
   konstanta konfigurasi.
2. Ada **dua lapis kredensial**: OAuth token (15 hari, perlu mekanisme refresh atau
   re-auth terjadwal) dan session database (`X-Session-ID`, masa hidup tak diketahui).
   Push job harus bisa membuka ulang sesi secara transparan dan retry.
3. Karena rate limit tak diketahui, pengiriman harus **serial dengan backoff dan
   antrean**, bukan burst paralel. Asumsikan pembatasan ada sampai terbukti sebaliknya.
4. Baris jurnal dikirim sebagai parameter berindeks. Pembangun payload kita harus
   memetakan `jurnal_baris` ke bentuk berindeks, dan itu berarti **batas jumlah baris
   per voucher menjadi risiko yang belum terukur** (lihat bagian 7).

Yang belum boleh dikodekan sama sekali: nama endpoint dan nama field. Ambil dulu
`open-api/json.do`.

---

## 3. Idempotensi dan referensi eksternal

### Temuan

- **Tidak ditemukan mekanisme idempotensi apa pun** di API Accurate Online: tidak ada
  idempotency key, tidak ada header dedup, tidak ada dokumentasi yang menjanjikan
  "kirim dua kali, tersimpan sekali". **[?]** Ini pernyataan tentang ketiadaan sumber,
  bukan bukti bahwa fiturnya tidak ada, tetapi tidak ada satu pun sumber yang
  menyebutnya.
- Nomor transaksi jurnal umum **bisa diisi otomatis oleh sistem atau diisi manual**,
  dan nomor yang diberikan sistem "dapat diganti sesuai keinginan". **[P]** (halaman
  bantuan resmi jurnal umum) **[S]** (halaman reseller menambahkan bahwa membuat nomor
  duplikat sebaiknya dihindari agar pelacakan tidak bingung, yang secara implisit
  menunjukkan **keunikan nomor tidak dipaksakan sistem**)
- Daftar Jurnal Umum menampilkan dua kolom nomor: **`Nomor #`** (nomor jurnal itu
  sendiri) dan **`No. Trans #`** (nomor transaksi sumber asal jurnal tersebut). Jadi
  konsep "nomor sumber" memang ada di model datanya. **[S]**
- Apakah `No. Trans #` bisa diisi lewat API untuk jurnal umum yang kita kirim, dan
  apakah ada endpoint pencarian/filter berdasarkan nomor: **[?]**. Ini pertanyaan yang
  paling langsung menentukan desain kita dan hanya bisa dijawab oleh skema OpenAPI.

### Sumber

- Cara Membuat Jurnal Umum (resmi, help center): https://help.accurate.id/product/accurate-online/fitur-aol/buku-besar/jurnal-umum/membuat-jurnal-umum/
- Jurnal Umum Accurate Online, penjelasan kolom Nomor # dan No. Trans # (sekunder): https://mitraku.id/jurnal-umum-accurate-online/ dan https://abckotaraya.id/membuat-jurnal-umum-di-accurate-online/
- API Example, parameter `id` untuk mode ubah (resmi): https://accurate.id/api-integration/api-example/

### Dampak ke desain kita

Katakan terang: **kita harus berasumsi tidak ada idempotensi di sisi Accurate.**
Perlindungan terhadap double posting sepenuhnya menjadi tanggung jawab sistem kita.
Konsekuensi konkret untuk arsitektur yang sudah ada:

1. Tabel pemetaan baru, misalnya `accurate_push_log`, dengan kunci unik pada
   `(jurnal_id, target_db)` dan menyimpan `accurate_id` hasil respons. Satu jurnal
   internal hanya boleh punya satu baris sukses. Ini yang mencegah double posting,
   bukan Accurate.
2. Nomor jurnal yang kita kirim harus **deterministik dan berasal dari nomor jurnal
   internal kita** (misalnya nomor `jurnal` TJSL apa adanya), supaya bila terjadi
   kirim ganda kita bisa mengenalinya secara manual di Accurate.
3. Push harus punya state machine eksplisit: `pending`, `in_flight`, `posted`,
   `failed`, `needs_review`. Kasus paling berbahaya adalah timeout pada request yang
   sebenarnya berhasil di sisi Accurate. Tanpa idempotensi, retry otomatis pada
   `in_flight` **dilarang**. Yang boleh dilakukan hanya rekonsiliasi: baca kembali dari
   Accurate lalu putuskan. Karena kemampuan baca-berdasarkan-nomor belum
   terkonfirmasi, rekonsiliasi itu mungkin harus manual pada tahap awal.
4. Cocok dengan arsitektur kita yang sudah menyalurkan semua jurnal otomatis melalui
   satu jalur `event_jurnal_mapping`: titik push ke Accurate ditempatkan **setelah**
   jurnal internal commit, sebagai proses terpisah yang membaca dari `jurnal`, bukan
   di dalam transaksi pembuatan jurnal.

---

## 4. Mutabilitas: edit, hapus, koreksi, dan periode terkunci

### Temuan

- Di aplikasi, jurnal umum di Accurate Online **bisa diedit dan dihapus**, bahkan ada
  fitur **hapus jurnal umum secara massal** dengan tombol "Hapus Massal" di daftar
  jurnal. **[P]** (halaman bantuan resmi khusus hapus massal)
- Nama scope `journal_voucher_save` dideskripsikan sebagai untuk "membuat **dan
  mengubah**" jurnal umum, dan pola resmi menyebut parameter `id` dipakai untuk
  mengubah record. Jadi **edit lewat API tampaknya dimungkinkan**. **[S]** untuk
  deskripsi scope, **[P]** untuk pola `id`.
- Apakah ada endpoint hapus/void lewat API: **[?]** tidak terkonfirmasi.
- Ada kondisi di mana jurnal **tidak dapat dihapus**, dengan pesan error "Tidak Dapat
  Menghapus Jurnal Dari Transaksi", yaitu ketika jurnal itu adalah turunan dari
  transaksi modul lain, bukan jurnal umum berdiri sendiri. **[S]**
- **Penguncian periode.** Ada dua mekanisme berbeda yang muncul di sumber:
  1. **Pembatasan tanggal transaksi** (setting agar transaksi di luar periode yang
     diizinkan tidak bisa dibuat/diubah).
  2. **Proses Akhir Bulan / tutup buku**. Setelah suatu bulan/periode ditutup buku,
     transaksi pada periode itu **tidak dapat diedit, tidak dapat di-void/hapus, dan
     tidak dapat dibuat transaksi baru**. **[S]** (beberapa halaman konsultan/partner
     menyatakan hal yang sama)
  3. Periode akuntansi diatur di Pengaturan | Preferensi | Perusahaan | Periode
     Akuntansi, dan pada pergantian tahun sistem memindahkan saldo laba rugi ke Laba
     Ditahan secara otomatis. **[S]**
- Apakah API mengekspos status tutup buku atau batas tanggal transaksi, dan **error apa
  yang dikembalikan** bila kita push jurnal bertanggal di dalam periode terkunci:
  **[?]**. Tidak ada sumber. Ini harus diuji empiris di database uji, dan itu satu-satunya
  cara jujur untuk mengetahuinya.

### Sumber

- Cara Menghapus Jurnal Umum Secara Massal (resmi, help center): https://help.accurate.id/product/accurate-online/fitur-aol/buku-besar/jurnal-umum/hapus-jurnal-massal/
- Cara Membuat Jurnal Umum (resmi, help center): https://help.accurate.id/product/accurate-online/fitur-aol/buku-besar/jurnal-umum/membuat-jurnal-umum/
- Error "Tidak Dapat Menghapus Jurnal Dari Transaksi" (sekunder, reseller): https://penjualanonline.id/error-tidak-dapat-menghapus-jurnal-dari-transaksi/
- Aktivitas Tutup Buku pada Accurate Online (sekunder, partner): https://ultimasolusindo.com/aktivitas-tutup-buku-pada-accurate-online/ dan https://facinstitute.id/aktivitas-tutup-buku-pada-accurate-online/
- Tutup Buku pada Accurate, penjelasan Period End (sekunder, reseller): https://account.co.id/tutup-buku-pada-accurate/
- Cara Mengedit dan Menghapus Transaksi Jurnal Umum di Accurate Online (sekunder): https://www.acisindonesia.com/2020/06/25/cara-mengedit-dan-menghapus-transaksi-jurnal-umum-di-accurate-online/

### Dampak ke desain kita

- Karena jurnal umum di Accurate **mutable** (berbeda dari asumsi ledger append-only
  kita), ada risiko nyata **drift**: seseorang mengedit jurnal hasil push di Accurate,
  dan angka di TJSL Online tidak lagi sama dengan Accurate. Desain harus memilih secara
  eksplisit satu dari dua sikap: (a) Accurate diperlakukan sebagai target laporan yang
  boleh berbeda, dengan laporan rekonsiliasi periodik, atau (b) push bersifat sekali
  jalan lalu Accurate menjadi sumber otoritatif dan sistem kita berhenti mengoreksi.
  Menggantung di antara keduanya adalah cara paling pasti menghasilkan angka yang tidak
  bisa dipertanggungjawabkan.
- Kebijakan koreksi kita sebaiknya tetap **reversing entry**, bukan edit lewat API.
  Alasannya bukan keterbatasan Accurate, melainkan karena reversing entry adalah
  satu-satunya cara koreksi yang tetap valid ketika periode tujuan sudah terkunci, dan
  satu-satunya yang meninggalkan jejak audit di kedua sistem.
- Push harus **memvalidasi tanggal terhadap periode** di sisi kita sebelum kirim
  (`periode` sudah ada di skema kita), dan menyediakan mekanisme "posting ke periode
  berikutnya" untuk jurnal yang tanggalnya jatuh di periode Accurate yang sudah
  ditutup. Jangan bergantung pada pesan error Accurate yang belum diketahui bentuknya.

---

## 5. Accurate Desktop / Accurate 5: jalur integrasi yang benar-benar ada

### Temuan

**Impor file.**

- Accurate 5 punya fitur **Impor Jurnal** melalui menu **File > Impor Jurnal**, dengan
  file **Excel (.xls/.xlsx)** yang harus mengikuti format template resmi. Catatan
  praktik yang disebut: akun harus sudah ada di COA, jangan pakai nilai negatif
  (gunakan posisi debit/kredit), jangan ada baris kosong, dan pecah file besar menjadi
  beberapa batch. **[S]** (blog training/konsultan Accurate; saya **tidak** menemukan
  halaman resmi yang mendokumentasikan layout kolom Accurate 5 secara eksplisit)
- **Layout kolom persis untuk Accurate 5 tidak terkonfirmasi.** **[?]** Sumber yang
  akan menyelesaikan: template contoh yang bisa diunduh dari dalam dialog impor
  Accurate 5 itu sendiri, plus manual Accurate 5 resmi.
- Sebagai pembanding, untuk **Accurate Online** ada halaman resmi impor jurnal umum:
  Buku Besar > Jurnal Umum > Daftar Jurnal Umum > Impor Data > Impor dari File, dengan
  tombol untuk **mengunduh file contoh format Excel atau CSV**. Kolom yang disebut:
  tanggal/`date`, keterangan/`description`, referensi/`reference`, `debit`, `credit`;
  nama dan struktur kolom tidak boleh diubah; jurnal wajib balance debit-kredit.
  **[P]** untuk keberadaan fitur dan mekanisme unduh template, **[S]** untuk daftar
  kolom (ekstraksi pencarian, belum saya lihat langsung di halaman resmi)
- Ada juga halaman resmi impor untuk **master data pemasok** dari file Excel di
  Accurate Online, jadi pola template-per-objek konsisten dipakai. **[P]**

**Akses langsung ke database Firebird.**

- Secara teknis, database Accurate 5 adalah Firebird 2.5, dan driver ODBC Firebird
  pihak ketiga (Devart, Easysoft, driver open source Firebird) memang ada dan
  mendukung Firebird 2.5. Jadi **secara teknis koneksi mungkin**. **[S]**
- Praktik yang dibicarakan publik untuk membuka database Accurate melibatkan **reset
  password SYSDBA dengan mengganti/mengedit `security.fdb`**, yaitu teknik pemulihan
  password, bukan jalur integrasi yang didukung. Kredensial database tidak
  dipublikasikan oleh CPSSoft. **[S]** (blog komunitas)
- **Ketentuan lisensi atau kebijakan dukungan CPSSoft mengenai akses database
  langsung: [?].** Saya tidak berhasil menemukan EULA CPSSoft, syarat penggunaan, atau
  pernyataan kebijakan dukungan mana pun. **Saya tidak akan menyimpulkan bahwa hal ini
  diizinkan atau dilarang.** Yang akan menyelesaikan: EULA yang tampil saat instalasi
  Accurate Desktop, kontrak lisensi/berlangganan yang dipegang unit, dan konfirmasi
  tertulis dari CPSSoft atau mitra resminya.
- **Konektor resmi, driver ODBC resmi, atau middleware resmi dari CPSSoft untuk
  Accurate 5: [?]** tidak ditemukan.

### Sumber

- Cara Impor Jurnal Umum File Excel/CSV, Accurate Online (resmi, help center): https://help.accurate.id/product/accurate-online/fitur-aol/buku-besar/jurnal-umum/impor-jurnal-umum/
- Cara melakukan impor data pemasok dari file Excel (resmi, help center): https://help.accurate.id/product/accurate-online/fitur-aol/pembelian/cara-melakukan-impor-data-pemasok-dari-file-excel/
- Mengenal Fitur Impor Jurnal di Accurate 5 (sekunder, training): https://trainingaccurate.com/blog/mengenal-fitur-impor-jurnal-di-accurate-5/
- Impor Transaksi Jurnal Umum dari File Excel atau CSV (sekunder, partner): https://ultimasolusindo.com/impor-transaksi-jurnal-umum-dari-file-excel-atau-csv/
- Accurate 5 dan Firebird 2.5 (sekunder): https://aboutaccurate.com/2018/06/07/accurate-5-berjalan-pada-firebird-2-5/
- Driver ODBC Firebird pihak ketiga (sekunder, vendor): https://www.devart.com/odbc/firebird/ dan https://www.easysoft.com/products/data_access/odbc_firebird_driver/index.html
- Teknik reset password database GDB (sekunder, blog komunitas): https://desrifani.blogspot.com/2013/12/lupa-user-password-database-gdb.html
- Halaman produk Accurate Desktop (resmi): https://cpssoft.com/produk/accuratedesktop/

### Dampak ke desain kita

- Jalur yang bisa kita andalkan untuk Accurate Desktop adalah **ekspor file dari sisi
  kita** dengan layout yang cocok dengan template impor jurnal Accurate, lalu impor
  dilakukan manual oleh staf akuntansi. Artinya modul ekspor kita harus:
  (a) menghasilkan Excel/CSV per periode dan per jenis jurnal,
  (b) memvalidasi balance debit-kredit sebelum file dihasilkan,
  (c) memakai nilai positif dengan penempatan debit/kredit, tidak pernah negatif,
  (d) memetakan `akun` kita ke nomor akun COA Accurate lewat tabel pemetaan eksplisit,
      karena impor akan gagal untuk akun yang belum ada di Accurate,
  (e) mendukung pemecahan batch untuk file besar.
- **Layout kolom tidak boleh ditebak.** Ambil file template dari dialog impor pada
  instalasi Accurate yang sebenarnya dipakai unit, lalu jadikan file itu fixture uji di
  repo kita. Versi Accurate yang berbeda bisa punya template berbeda.
- Akses langsung ke Firebird sebaiknya **tidak dijadikan opsi desain** sampai ada
  konfirmasi tertulis dari CPSSoft. Untuk sistem akuntansi entitas BUMN, jalur yang
  status legalnya tidak jelas adalah risiko audit, bukan sekadar risiko teknis.

---

## 6. Pola nyata di Indonesia untuk mengisi Accurate

### Temuan

- **Impor file terjadwal/manual** adalah pola paling banyak didokumentasikan, dan
  didukung resmi lewat fitur Impor Data per objek di Accurate Online (jurnal umum,
  penerimaan, pembayaran, pengiriman, karyawan, pemasok, dan lain-lain masing-masing
  punya halaman bantuan resmi sendiri). **[P]**
- **Marketplace / Accurate Store**: Accurate punya jalur publikasi aplikasi pihak
  ketiga, dan tarif API "jalur khusus" dikaitkan dengan aplikasi yang dipublikasikan di
  Marketplace Accurate Online. Ada juga contoh integrasi pihak ketiga yang
  didokumentasikan resmi di kategori Accurate Store, misalnya integrasi Paper
  (disbursement) dengan Accurate Online. **[P]** untuk keberadaan kategori dan contoh
  integrasi; **[S]** untuk tarif jalur khusus.
- **Bridge buatan partner/vendor**: platform omnichannel Indonesia seperti Jubelio
  disebut punya integrasi ke Accurate, dan integrasi semacam ini dibangun oleh vendor
  tersebut, bukan oleh CPSSoft. **[S]** (materi pemasaran vendor, jadi bobotnya rendah
  dan perlu verifikasi langsung ke halaman integrasi resmi vendor)
- **iPaaS umum (Zapier, Make, n8n)**: **[?]** tidak ditemukan konektor Accurate Online
  bawaan di ketiganya. Yang mungkin dilakukan di n8n/Make adalah memanggil API lewat
  node HTTP generik, dan itu berarti seluruh kompleksitas OAuth + open-db + host 308
  tetap harus kita tangani sendiri, tidak dihilangkan oleh iPaaS.
- Ada laporan akademik Indonesia yang mendokumentasikan otomatisasi proses akuntansi
  memakai API Accurate di sebuah perusahaan. Berguna sebagai bukti bahwa pola push
  terprogram memang dijalankan di lapangan, bukan hanya teori. **[S]**
- Satu pernyataan penting dari sisi reseller yang perlu dicatat: **Accurate tidak
  melakukan push keluar**. Sistem kitalah yang menarik atau mengirim; tidak ada webhook
  dari Accurate. **[S]** Saya tidak menemukan dokumentasi webhook resmi mana pun, yang
  konsisten dengan pernyataan itu. **[?]** untuk konfirmasi resmi.

### Sumber

- Indeks Accurate Store (resmi, help center): https://help.accurate.id/product/accurate-store/
- Contoh integrasi pihak ketiga terdokumentasi resmi, Paper disbursement: https://help.accurate.id/product/accurate-store/cara-integrasi-paper-disbursement-dan-penggunaannya-dengan-accurate-online/
- Halaman impor resmi lain sebagai bukti pola template-per-objek: https://help.accurate.id/product/accurate-online/kas-bank/pembayaran/cara-melakukan-impor-pembayaran/ dan https://help.accurate.id/product/accurate-online/fitur-aol/perusahaan/karyawan/impor-karyawan/
- Jubelio menyebut integrasi ke Accurate (sekunder, pemasaran vendor): https://jubelio.com/integrasi-marketplace/
- Laporan akademik otomatisasi dengan API Accurate (sekunder): https://openlibrary.telkomuniversity.ac.id/pustaka/files/200558/jurnal_eproc/otomatisasi-proses-akuntansi-menggunakan-api-accurate-di-pt-inovasi-daya-solusi-jakarta-selatan.pdf
- Pernyataan "Accurate tidak push otomatis, sistem Anda yang meminta" (sekunder, reseller): https://penjualanonline.id/integrasi-accurate-online/

### Dampak ke desain kita

- Tidak ada webhook berarti **tidak ada sinkronisasi dua arah yang murah**. Kalau
  pemilik ingin tahu apakah jurnal hasil push masih utuh di Accurate, itu harus lewat
  **polling/rekonsiliasi terjadwal** dari sisi kita, dengan biaya panggilan API.
- Pola paling murah dan paling tahan banting untuk fase pertama tetap **ekspor file**.
  Ini juga yang paling mudah diterima auditor, karena file ekspor itu sendiri adalah
  artefak yang bisa dilampirkan.
- Menempuh jalur Marketplace hanya masuk akal kalau ada rencana memakai sistem ini di
  lebih dari satu unit/BUMN. Untuk satu unit TJSL, jalur umum cukup.

---

## 7. Kendala yang akan menggigit integrasi akuntansi

### Temuan

- **Multi-currency.** Accurate Online punya fitur mata uang dengan pengaturan mata uang
  dan mata uang default per database. **[P]** Bagaimana jurnal umum menangani baris
  mata uang asing lewat API (field nilai tukar, apakah nilai dikirim dalam mata uang
  asing atau base): **[?]**.
- **Presisi desimal.** Yang saya temukan hanyalah pengaturan **format tampilan desimal
  pada desain cetakan** dan format mata uang, bukan **presisi penyimpanan** angka.
  **[P]** untuk keberadaan pengaturan format cetak; **[?]** untuk jumlah desimal yang
  disimpan dan diterima API. Ini harus diuji, karena selisih pembulatan pada level
  entitas pelaporan adalah temuan audit.
- **Maksimum baris per voucher.** **[?]** Tidak ada angka di sumber mana pun. Yang ada
  hanya saran praktik untuk **memecah file impor besar menjadi beberapa batch** karena
  proses menjadi berat. **[S]** Sinyal yang cukup untuk mengasumsikan ada batas
  praktis, meski batas kerasnya tidak diketahui.
- **Field wajib pada jurnal umum, dan dimensi departemen/proyek/cabang.**
  - Jurnal wajib **balance debit-kredit**. **[S]** (dinyatakan pada konteks impor)
  - **Departemen dan Proyek terintegrasi penuh dengan Bukti Jurnal Umum, tetapi hanya
    pada edisi yang mendukung fitur tersebut.** **[S]** Ini penting: dimensi ini
    **tergantung edisi/paket**, jadi ketersediaannya bukan hal yang boleh diasumsikan.
  - Pada format impor jurnal umum AOL, kolom di luar tanggal/debit/kredit seperti
    keterangan, nomor referensi, dan proyek disebut **opsional**. **[S]**
  - Dimensi **cabang**: pola URL resmi menyebut modul `branch` (`.../api/branch/save.do`
    muncul sebagai contoh di halaman resmi), jadi konsep cabang ada sebagai objek
    master. **[P]** Apakah cabang wajib pada baris jurnal: **[?]**.
- **Dimensi sub-ledger per Mitra (ini yang paling penting untuk kita).** Ada kasus
  terdokumentasi di mana sebuah transaksi **Jurnal Umum** memiliki baris ke akun
  bertipe **Piutang Usaha** dan pada baris itu **terpilih nama Pemasok** alih-alih nama
  Pelanggan, dengan akibat nilai tersebut **tidak muncul di laporan Buku Besar Pembantu
  Piutang**. **[S]** Dua implikasi yang bisa ditarik dengan hati-hati:
  1. Baris jurnal umum ke akun bertipe piutang/utang **memang membawa pilihan pihak
     sub-ledger** (pelanggan atau pemasok). Jadi pelacakan per Mitra lewat jurnal umum
     bukan hal yang mustahil di Accurate.
  2. Pemetaan yang salah (tipe akun tidak cocok dengan tipe pihak) **gagal secara
     senyap**: transaksi tersimpan, tetapi buku besar pembantu tidak cocok dengan
     neraca. Ini kelas bug terburuk untuk sistem akuntansi, karena tidak ada error.
  Nama field API untuk pihak sub-ledger pada baris jurnal: **[?]**.

### Sumber

- Cara mengatur mata uang (resmi, help center): https://help.accurate.id/product/accurate-online/fitur-aol/perusahaan/mengatur-mata-uang/ dan https://help.accurate.id/product/accurate-online/fitur-aol/perusahaan/mata-uang/mengatur-mata-uang/
- Pengaturan format desimal pada desain cetakan (sekunder, konsultan): https://solusiakuntansiindonesia.com/pengaturan-format-desimal-pada-desain-cetakan-accurate-online/
- Cara Impor Jurnal Umum File Excel/CSV (resmi, help center): https://help.accurate.id/product/accurate-online/fitur-aol/buku-besar/jurnal-umum/impor-jurnal-umum/
- Fitur Bukti Jurnal Umum pada Accurate 5, integrasi Departemen dan Proyek (sekunder, konsultan): https://www.szetoaccurate.com/fitur-bukti-jurnal-umum-di-accurate-5/
- Selisih nilai piutang antara Buku Besar Pembantu Piutang dan Neraca, kasus jurnal umum ke akun piutang dengan nama pemasok (sekunder, partner): https://ultimasolusindo.com/selisih-nilai-piutang-pada-laporan-buku-besar-pembantu-piutang-dengan-laporan-neraca-2/
- API Example, contoh modul `branch` (resmi): https://accurate.id/api-integration/api-example/

### Dampak ke desain kita

- Pelacakan piutang per Mitra Binaan **mungkin** dipetakan ke sub-ledger Pelanggan
  Accurate, tetapi konsekuensinya setiap Mitra Binaan menjadi satu record master di
  Accurate. Untuk program dengan ratusan mitra, itu keputusan tata kelola master data,
  bukan detail teknis: siapa yang berhak membuat, menonaktifkan, dan memelihara record
  itu.
- Karena mismatch tipe akun dan tipe pihak **gagal senyap**, validator kita harus
  menolak sebelum kirim: baris ke akun piutang wajib membawa pihak bertipe pelanggan,
  baris ke akun utang wajib bertipe pemasok. Validasi ini di sisi kita, bukan
  mengandalkan Accurate.
- Ketergantungan Departemen/Proyek pada edisi berarti pemetaan dimensi kita (misalnya
  program TJSL atau pilar) **tidak boleh menjadi syarat wajib** dalam desain push. Harus
  ada mode degradasi yang tetap valid ketika dimensi tersebut tidak tersedia.
- Presisi desimal dan maksimum baris harus **diukur secara empiris di database uji**
  sebelum push otomatis diaktifkan. Sampai terukur, batasi jumlah baris per voucher
  secara konservatif di sisi kita dan rekap jurnal agregat per periode alih-alih
  mengirim satu voucher raksasa.

---

## Tingkat integrasi yang realistis

| Tingkat | Bentuk | Butuh dari Accurate | Butuh dari kita | Yang rusak bila API tidak tersedia |
| --- | --- | --- | --- | --- |
| **0. Laporan terpisah** | TJSL Online adalah ledger otoritatif TJSL. Accurate tidak menerima apa pun. Rekonsiliasi lewat laporan PDF/Excel di luar sistem | Tidak ada | Tidak ada tambahan | Tidak ada. Ini baseline yang selalu tersedia |
| **1. Ekspor file manual** | Kita hasilkan Excel/CSV sesuai template impor jurnal umum Accurate. Staf akuntansi mengunggahnya sendiri | Fitur Impor Data (ada di AOL **[P]**, ada di Accurate 5 lewat File > Impor Jurnal **[S]**). Template contoh dari instalasi yang dipakai unit | Modul ekspor, tabel pemetaan akun ke COA Accurate, validasi balance, penomoran deterministik, validasi nilai non-negatif dengan posisi debit/kredit, pemecahan batch | Tidak ada. Tingkat ini **tidak bergantung pada API sama sekali** dan karena itu jadi kandidat fase pertama |
| **2. Ekspor file terjadwal** | Sama dengan tingkat 1 plus penjadwalan, arsip file per periode, jejak audit siapa mengunggah kapan, dan status "sudah diimpor" per batch | Sama dengan tingkat 1 | Penjadwal, penyimpanan artefak, status batch, laporan rekonsiliasi manual | Tidak ada |
| **3. Baca dari Accurate (read-only API)** | Kita ambil COA dan master pelanggan/pemasok dari Accurate untuk memvalidasi pemetaan sebelum ekspor | Accurate Online + API aktif per database + scope baca. Nama endpoint COA dan customer/vendor **belum terkonfirmasi** | Klien OAuth, penyimpanan token, `open-db` + `X-Session-ID`, penanganan 308 dan host dinamis, cache COA | Turun ke tingkat 2: pemetaan akun dipelihara manual dan salah-akun baru ketahuan saat impor gagal |
| **4. Push jurnal semi-otomatis** | Kita kirim jurnal umum lewat API, tapi hanya setelah persetujuan manual per batch, dan dengan tombol "tandai sudah terkirim" | Tambahan scope `journal_voucher_save` **[S]**, periode tujuan tidak terkunci | Semua dari tingkat 3, plus `accurate_push_log` dengan unique key, state machine push, larangan retry otomatis pada `in_flight`, validator dimensi dan sub-ledger, prosedur rekonsiliasi manual | Turun ke tingkat 2. Kode ekspor tetap terpakai, kode push jadi mati. Karena itu ekspor harus dibangun lebih dulu, bukan sesudah |
| **5. Push otomatis penuh** | Setiap jurnal internal dikirim otomatis mendekati real time | Semua di atas, plus **rate limit yang diketahui**, perilaku periode terkunci yang teruji, dan kemampuan **mencari voucher berdasarkan nomor** untuk rekonsiliasi | Antrean tahan gagal, backoff, alerting, laporan drift harian, prosedur koreksi lewat reversing entry | Seluruh lapisan ini hilang. Tanpa idempotensi dan tanpa lookup-by-number, tingkat 5 **belum bisa dipertanggungjawabkan secara audit**. Rekomendasi riset: jangan jadikan target sebelum tingkat 4 berjalan minimal satu siklus tutup buku |

Catatan penting: urutan ini disusun supaya kerja di tingkat rendah **tidak terbuang**
bila API ternyata tidak tersedia atau tidak disetujui. Pemetaan akun, validasi balance,
dan penomoran deterministik dipakai di semua tingkat.

---

## Perlu keputusan pemilik repo

| No | Pertanyaan | Mengapa memblokir | Yang akan menyelesaikan |
| --- | --- | --- | --- |
| 1 | Accurate mana yang dipakai unit TJSL: **Accurate Online** atau **Accurate 5 / Desktop**? | Menentukan apakah integrasi terprogram mungkin sama sekali. Desktop berarti file-only | Konfirmasi dari unit akuntansi, plus tangkapan layar menu About/versi |
| 2 | Edisi/paket dan status langganan database yang dipakai | Departemen dan Proyek pada jurnal umum tergantung edisi **[S]**. Tanpa ini kita tidak tahu apakah dimensi program TJSL bisa dibawa | Halaman langganan di Area Penagihan AOL, atau lisensi Accurate 5 |
| 3 | Siapa **ledger otoritatif** untuk TJSL: sistem kita atau Accurate? | Ini keputusan tata kelola, bukan teknis, dan menentukan arah aliran data, kebijakan koreksi, serta apa yang dianggap benar saat terjadi drift | Keputusan pemilik proses TJSL dan auditor internal |
| 4 | Apakah biaya API per database per bulan disetujui, dan siapa pemegang anggarannya? | Tingkat 3 ke atas berbiaya berjalan **[S]** | Konfirmasi tarif resmi dari mitra Accurate atau CPSSoft, plus persetujuan anggaran |
| 5 | Apakah unit bersedia **membuat akun Area Developer** dan membagikan hasil `open-api/json.do` kepada kita? | Tanpa skema OpenAPI, semua nama endpoint dan field tetap tidak terkonfirmasi dan tidak boleh dikodekan | Kredensial developer AOL atau ekspor skema OpenAPI dari pihak unit |
| 6 | Apakah tersedia **database uji terpisah** (trial atau berbayar) untuk pengujian push? | Presisi desimal, maksimum baris, perilaku periode terkunci, dan bentuk error hanya bisa dijawab empiris. Menguji di database produksi tidak dapat diterima | Persetujuan pengadaan satu database uji |
| 7 | Bagaimana **Mitra Binaan** dipetakan di Accurate: Pelanggan, Pemasok, atau tidak dipetakan sama sekali? | Pelacakan piutang per Mitra bergantung pada ini, dan mismatch tipe akun dengan tipe pihak **gagal senyap** **[S]** | Keputusan akuntansi TJSL, sebaiknya bersama pemegang COA Accurate |
| 8 | Apakah **COA Accurate** akan disesuaikan dengan COA TJSL kita, atau kita yang memetakan ke COA yang sudah ada? | Impor gagal untuk akun yang belum ada di Accurate. Arah pemetaan menentukan siapa memelihara tabel pemetaan | Ekspor daftar akun Accurate yang berlaku saat ini |
| 9 | Apakah **koreksi wajib berupa reversing entry** di kedua sistem? | Jurnal umum Accurate bisa diedit dan dihapus **[P]**, jadi tanpa aturan eksplisit drift pasti terjadi | Kebijakan akuntansi tertulis dari unit |
| 10 | Apakah pihak Accurate atau mitranya mengizinkan **akses langsung ke database Firebird** (khusus skenario Desktop)? | Status lisensi dan dukungan **tidak diketahui [?]**. Untuk entitas BUMN ini risiko audit | EULA Accurate Desktop yang tampil saat instalasi, kontrak lisensi unit, dan pernyataan tertulis dari CPSSoft atau mitra resmi |
| 11 | Siapa pemilik kredensial OAuth dan siapa yang memutar token 15 hari? | Token kedaluwarsa berarti push berhenti senyap kalau tidak ada yang bertanggung jawab | Penunjukan pemilik operasional integrasi |
| 12 | Apakah unit menginginkan **rekonsiliasi dua arah**? | Tidak ada webhook dari Accurate **[S]**, jadi ini berarti polling berbiaya panggilan API dan perlu jadwal | Kebutuhan pelaporan dari pemilik proses |

---

## Yang masih harus diverifikasi sebelum dokumen ini dipakai untuk keputusan

1. Buka langsung dan verifikasi ulang: `accurate.id/api-integration/`,
   `/api-example/`, `/oauth/`, `/scope/`, `/error-info/`,
   `/informasi-terkait-response-code-308/`.
2. Ambil `https://account.accurate.id/open-api/json.do` dan
   `https://account.accurate.id/developer/api-docs.do`. Dari kedua dokumen ini
   dapatkan: nama endpoint jurnal umum, COA, customer, vendor; daftar field beserta
   tipe dan sifat wajib; apakah ada field referensi eksternal atau nomor sumber yang
   bisa kita isi; apakah ada filter pencarian berdasarkan nomor; rate limit.
3. Tarik template impor jurnal umum langsung dari instalasi Accurate milik unit, dan
   jadikan fixture uji.
4. Uji empiris di database uji: presisi desimal, jumlah baris maksimum yang praktis,
   perilaku push ke periode yang sudah ditutup, dan perilaku kirim ganda dengan nomor
   yang sama.
