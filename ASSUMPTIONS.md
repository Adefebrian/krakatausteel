# ASSUMPTIONS

Daftar asumsi yang diambil saat membangun model data TJSL Online (fase model data, migrasi
`0002` sampai `0015`). Format tiap entri: **apa yang diasumsikan**, **kenapa**, dan **dampak
kalau asumsi ini salah**.

Semua nilai parameter di Bagian 5 spesifikasi diperlakukan sebagai **default asumsi yang wajib
dikonfirmasi ke tim akuntansi klien**. Semuanya tersimpan sebagai baris data di tabel
`konfigurasi`, `kolektibilitas_range`, `penyisihan_rate`, dan `alokasi_setoran_preset`, dengan
kolom penanda `konfigurasi.perlu_konfirmasi = true`. Tidak ada satu pun yang di-hardcode di
kode aplikasi.

---

## A-01. Hierarki cabang satu tingkat

**Diasumsikan:** struktur organisasi hanya dua lapis, yaitu 1 kantor pusat dan N cabang di
bawahnya langsung. Tabel `cabang` tidak punya `parent_id`; scope otorisasi dan filter laporan
adalah kesamaan langsung pada `cabang_id`. Persis satu baris `is_pusat` per BUMN (dijaga
partial unique index).

**Kenapa:** Bagian 4.1 mendefinisikan `cabang` hanya dengan flag `is_pusat` tanpa parent, dan
Bagian 13 meminta seed 1 pusat + 3 cabang. Tidak ada satu pun laporan di Bagian 10 yang
mengelompokkan per wilayah antara pusat dan cabang.

**Dampak kalau salah:** kalau ternyata ada lapis wilayah (pusat, wilayah, cabang), penambahan
kolom `cabang.parent_id` bersifat aditif dan kolom `cabang_id` yang sudah didenormalisasi tetap
benar karena selalu menunjuk cabang terdaftar. Yang harus dikerjakan ulang adalah setiap
agregat "Semua Cabang" dan setiap pemeriksaan hak akses, karena keduanya harus jadi query
rekursif. Perkiraan: satu migrasi aditif + satu fungsi resolusi scope + revisi semua query
laporan berscope cabang. Lihat `docs/adr/0007`.

## A-02. Sampel COA 80 sampai 100 akun, `klasifikasi_laporan` wajib terisi

**Diasumsikan:** COA contoh berjumlah 80 sampai 100 akun sesuai struktur Bagian 10.3, dan
`akun.klasifikasi_laporan` dibuat **NOT NULL** untuk semua akun (termasuk akun induk), dengan
foreign key komposit ke `baris_laporan (bumn_id, kode)`.

**Kenapa:** dikonfirmasi pemilik repo. `klasifikasi_laporan` adalah satu satunya kunci pemetaan
akun ke baris laporan; kalau boleh NULL, akan ada akun yang tidak muncul di laporan mana pun
dan selisihnya baru ketahuan saat audit.

**Dampak kalau salah:** kalau klien ingin sebagian akun tanpa pemetaan laporan, kolom harus
dilonggarkan jadi nullable (migrasi aditif, mudah). Sebaliknya, urutan seeding jadi terikat:
`baris_laporan` wajib di-seed sebelum `akun`. Ini didokumentasikan supaya tidak jadi kejutan
saat fase seed.

## A-03. Default kredit: jasa administrasi 3 persen FLAT, basis 360 hari

**Diasumsikan:** `jasa_adm_rate_default = 0.030000` per tahun, `jasa_adm_metode_default = FLAT`,
`jasa_adm_basis_hari = 360`, `pembulatan_angsuran = 0`, urutan alokasi setoran
`TUNGGAKAN_JASA, TUNGGAKAN_POKOK, JASA_BERJALAN, POKOK_BERJALAN, KELEBIHAN` (preset `DEFAULT`),
dan `metode_pengakuan_jasa_adm = ACCRUAL`.

**Kenapa:** dikonfirmasi pemilik repo, sesuai default Bagian 5.3, 5.4 dan 5.6. Semuanya
tersimpan sebagai baris `konfigurasi` dan `alokasi_setoran_preset`, bisa diubah lewat menu
Konfigurasi tanpa deploy.

**Dampak kalau salah:** mengubah rate, metode, atau urutan alokasi hanya mengubah data, bukan
kode. Tetapi **jurnal yang sudah POSTED tidak dihitung ulang**: perubahan parameter hanya
berlaku untuk akad dan setoran berikutnya. Kalau klien butuh perhitungan ulang retroaktif, itu
pekerjaan koreksi manual lewat jurnal pembalik, bukan konfigurasi. Perubahan
`metode_pengakuan_jasa_adm` dari ACCRUAL ke CASH_BASIS di tengah tahun buku akan meninggalkan
saldo Piutang Jasa Administrasi yang harus dihapus lewat jurnal koreksi eksplisit.

## A-04. Rentang kolektibilitas dan rate penyisihan versi default

**Diasumsikan:** rentang hari 0-30 / 31-180 / 181-270 / lebih dari 270 dan rate 0 / 25 / 75 /
100 persen, dengan dasar perhitungan `OUTSTANDING_POKOK`.

**Kenapa:** default Bagian 5.1 dan 5.2. Disimpan sebagai baris di `kolektibilitas_range` dan
`penyisihan_rate`, bukan if-else di kode, dan **diberi tanggal berlaku** (`berlaku_dari`).

**Dampak kalau salah:** rate baru dibuat sebagai baris baru dengan `berlaku_dari` di masa
depan; periode yang sudah CLOSED tetap memakai rate yang dipakainya saat itu, karena
`kolektibilitas_snapshot` menyimpan `rate_penyisihan` dan `dasar_perhitungan` per baris dan ada
CHECK yang menurunkan ulang `nilai_penyisihan` dari keduanya. Jadi perubahan rate tidak pernah
mengubah angka periode lampau. Kalau klien justru **ingin** perhitungan ulang periode lampau,
itu wajib reopen periode.

## A-05. Jasa administrasi selama grace period tidak dihitung

**Diasumsikan:** selama `grace_period_bulan`, mitra tidak membayar pokok **dan** tidak dibebani
jasa administrasi. Disimpan sebagai `konfigurasi.jasa_grace_period = TIDAK_DIHITUNG`, dengan
alternatif `DIHITUNG_DITANGGUHKAN` (jasa dihitung, ditagih setelah grace) dan
`DIHITUNG_DIBAYAR` (jasa tetap ditagih bulanan selama grace).

**Kenapa:** spesifikasi menyebut `grace_period_bulan` di akad dan `GRACE_PERIOD` sebagai jenis
reschedule, tetapi tidak pernah menyatakan perlakuan jasa administrasi selama masa itu. Tiga
kebijakan di atas semuanya lazim di praktik BUMN. Pilihan paling konservatif untuk mitra dan
paling sederhana untuk jadwal dipakai sebagai default.

**Dampak kalau salah:** total jasa administrasi seumur akad berubah, artinya
`pumk_jadwal_angsuran.jasa_adm` dan `pumk_akad.outstanding_jasa` berubah untuk semua akad
bergrace. Skema tidak perlu diubah (kebijakan ini murni parameter engine jadwal), tetapi akad
yang jadwalnya sudah di-generate harus di-reschedule, bukan diperbaiki di tempat, karena jadwal
bersifat immutable. Ini alasan asumsi ini perlu dikonfirmasi **sebelum** fase engine angsuran.

## A-06. Konfigurasi bertingkat: baris global lalu override per BUMN

**Diasumsikan:** `konfigurasi`, `kolektibilitas_range` dan `penyisihan_rate` boleh punya
`bumn_id NULL` yang berarti "default platform". Resolusi nilai: ambil baris milik BUMN itu,
kalau tidak ada pakai baris global.

**Kenapa:** default Bagian 5 harus sudah ada sebelum ada satu pun baris `bumn` (migrasi tidak
boleh mengarang data master klien). Baris global adalah cara menyimpan default sebagai data,
bukan sebagai konstanta di kode.

**Dampak kalau salah:** kalau klien menolak konsep default global, semua baris global harus
disalin jadi baris per BUMN dan kolom `bumn_id` dijadikan NOT NULL (migrasi mudah). Yang perlu
diperhatikan: setiap query konfigurasi **wajib** memakai pola "baris BUMN dulu, baru global";
kalau ada kode yang lupa, ia akan membaca default global padahal klien sudah override.

## A-07. Periode akuntansi selalu bulan kalender

**Diasumsikan:** satu baris `periode` = satu bulan kalender penuh (`tanggal_mulai` = tanggal 1,
`tanggal_akhir` = akhir bulan, dijaga CHECK). Tahun buku yang tidak dimulai Januari
(`bumn.tahun_buku_mulai_bulan`) diperlakukan sebagai pengelompokan 12 baris bulanan saat
pelaporan, bukan bentuk periode yang berbeda.

**Kenapa:** Bagian 4.7 mendefinisikan periode dengan `tahun` dan `bulan`, dan Bagian 8 berbicara
soal closing bulanan.

**Dampak kalau salah:** kalau klien butuh periode 13 (periode penyesuaian audit di akhir tahun),
CHECK `periode_window_ck` harus dilonggarkan dan `bulan` harus mengizinkan nilai 13. Itu migrasi
kecil, tapi mengubah asumsi "bulan 1 sampai 12" di seluruh laporan komparatif bulanan.

## A-08. Status akad `BELUM_CAIR`

**Diasumsikan:** ada satu status akad tambahan di luar daftar Bagian 4.4, yaitu `BELUM_CAIR`,
untuk akad yang sudah ditandatangani tetapi pencairannya belum dijurnal.

**Kenapa:** state machine Bagian 9.1 punya langkah `AKAD_DIBUAT` dan `JADWAL_SIAP` **sebelum**
`DICAIRKAN`, sementara daftar status akad hanya menyediakan `AKTIF` sebagai status awal. Kalau
akad yang belum cair dipaksa berstatus `AKTIF`, ia akan ikut terhitung di rekonsiliasi sub buku
besar piutang (Bagian 8.4 butir 10) padahal buku besar belum mencatat apa pun, sehingga
rekonsiliasi selalu selisih.

**Dampak kalau salah:** kalau klien memang ingin akad langsung `AKTIF`, hapus nilai
`BELUM_CAIR` dari CHECK dan sesuaikan index `pumk_akad_outstanding_idx`. Risiko sebaliknya
lebih besar: tanpa status ini, checklist closing akan memblokir closing karena selisih semu.

## A-09. Bobot SDG tidak wajib berjumlah 1

**Diasumsikan:** `nonpumk_proposal_sdg.bobot` bernilai lebih dari 0 sampai 1, default 1, dan
jumlah bobot satu proposal **tidak** dipaksa sama dengan 1.

**Kenapa:** Bagian 4.1 menyebut pemetaan SDG "bisa many to many dengan bobot" tanpa aturan
normalisasi. Memaksa jumlah = 1 adalah aturan karangan yang akan menyulitkan input.

**Dampak kalau salah:** laporan kontribusi SDG bisa menghitung nilai program lebih dari sekali
kalau bobot diisi 1 untuk beberapa SDG sekaligus. Kalau klien butuh normalisasi, tambahkan
deferred constraint trigger per proposal; datanya tidak perlu diubah bentuknya.

## A-10. Tabel `akrual_jasa_snapshot` diadakan sendiri

**Diasumsikan:** perlu satu tabel per akad per periode untuk akrual jasa administrasi, meski
Bagian 4 tidak menyebutnya.

**Kenapa:** Bagian 8.3 mewajibkan akrual bulanan yang idempoten, dan laporan nomor 30 (Laporan
Akrual Piutang Jasa Administrasi) harus reproducible untuk periode yang sudah CLOSED. Keduanya
mustahil kalau angkanya dihitung ulang dari data master yang bisa berubah (invarian 14).

**Dampak kalau salah:** kalau klien tidak butuh rincian per akad, tabel ini bisa ditinggalkan
tanpa mengganggu apa pun (tidak ada tabel lain yang bergantung padanya).

## A-11. Konvensi tanda `saldo_akun_periode` adalah debit positif

**Diasumsikan:** `saldo_awal`, `mutasi_debit`, `mutasi_kredit`, `saldo_akhir` semuanya dalam
konvensi **debit positif**. Akun bersaldo normal kredit (liabilitas, aset neto, pendapatan)
karena itu bersaldo negatif di tabel ini. Penyajian membalik tanda memakai `akun.saldo_normal`.

**Kenapa:** satu konvensi untuk semua tipe akun membuat identitas `saldo_akhir = saldo_awal +
mutasi_debit - mutasi_kredit` bisa dijadikan CHECK, dan membuat total Neraca Lajur berjumlah nol
alih alih dua angka yang harus dibandingkan.

**Dampak kalau salah:** kalau tim akuntansi ingin saldo disimpan sesuai saldo normal (selalu
positif), setiap laporan yang membaca tabel ini harus diubah dan CHECK identitas harus dihapus.
Ini keputusan yang lebih murah dikonfirmasi sekarang daripada setelah 20 periode ditutup.

## A-12. Penamaan kolom dan tabel yang menyimpang dari spesifikasi

**Diasumsikan:**

- tabel `user` menjadi `app_user` dan `role` menjadi `app_role` (keduanya kata kunci Postgres);
- `uploaded_by` / `uploaded_at` pada `mitra_dokumen` dan `lampiran` **adalah** `created_by` /
  `created_at` dari blok audit standar, bukan kolom tambahan;
- `sdg_ids` pada `nonpumk_proposal` diwujudkan sebagai tabel relasi `nonpumk_proposal_sdg`,
  bukan array.

**Kenapa:** Bagian 4 mengizinkan penyesuaian nama kolom ke konvensi repo selama semantik dan
relasinya sama. Array tidak bisa membawa bobot dan tidak bisa di-join untuk laporan SDG.

**Dampak kalau salah:** hanya penamaan; tidak ada dampak angka. Perlu dicatat di dokumentasi API
supaya kontrak yang dibaca klien tetap memakai istilah spesifikasi.

## A-13. Satu pinjaman aktif per mitra ditegakkan sebagai unique index

**Diasumsikan:** `maks_pinjaman_aktif_per_mitra = 1` (default Bagian 5.5) ditegakkan di database
lewat partial unique index pada `pumk_akad (mitra_id)` untuk status `BELUM_CAIR`, `AKTIF`,
`RESCHEDULED`, `MACET`. Mitra yang akadnya `LUNAS` atau `HAPUS_BUKU` boleh mengajukan lagi.

**Kenapa:** parameternya memang konfigurable, tetapi nilai 1 adalah aturan yang paling mahal
kalau dilanggar (piutang ganda ke orang yang sama). Selama nilainya 1, database yang menjaganya.

**Dampak kalau salah:** kalau klien menaikkan batas di atas 1, index ini harus di-DROP lewat
migrasi eksplisit dan penegakan pindah ke layer aplikasi yang membaca `konfigurasi`. Ini
disengaja: menaikkan batas harus jadi keputusan yang terlihat, bukan efek samping edit
konfigurasi.

## A-14. Keputusan tambahan pada review dan approval

**Diasumsikan:** `pumk_review.keputusan` dan `nonpumk_review.keputusan` mengizinkan
`MINTA_PERBAIKAN` selain `REKOMENDASI` / `TIDAK_REKOMENDASI`, dan `*_approval.keputusan`
mengizinkan `KEMBALIKAN` selain `SETUJU` / `TOLAK`.

**Kenapa:** state machine Bagian 9.1 punya transisi "Checker minta perbaikan" dan "Approver
kembalikan", tetapi daftar nilai keputusan di Bagian 4.4 tidak memuatnya. Tanpa nilai ini,
transisi yang diminta spesifikasi tidak bisa dicatat.

**Dampak kalau salah:** kalau klien tidak mengenal alur pengembalian, nilai tersebut cukup tidak
dipakai; tidak ada dampak angka.

## A-15. Kolom denormalisasi: `nonpumk_proposal.jumlah_disetujui` dan `pumk_akad.cabang_id`

**Diasumsikan:** nilai disetujui disalin dari `nonpumk_approval` ke `nonpumk_proposal`, dan
`cabang_id` disalin dari `pumk_proposal` ke `pumk_akad`. Keduanya dijaga: `cabang_id` oleh
trigger yang menolak nilai berbeda dari proposalnya, dan `jumlah_disetujui` oleh deferred
trigger yang memblokir total penyaluran melebihi nilai itu.

**Kenapa:** setiap laporan PUMK memfilter per cabang, dan pagu penyaluran Non PUMK harus bisa
diperiksa dalam satu lookup, bukan subquery ke tabel approval terakhir.

**Dampak kalau salah:** kalau approval boleh direvisi setelah penyaluran berjalan, kolom
`jumlah_disetujui` bisa jadi tidak sinkron dengan baris approval terakhir. Tim aplikasi wajib
memperbarui keduanya dalam satu transaksi.

## A-16. Timeline transisi status disimpan di tabel sendiri

**Diasumsikan:** `pumk_proposal_transisi` dan `nonpumk_proposal_transisi` (append only) adalah
sumber timeline di halaman detail proposal, terpisah dari `audit_log`.

**Kenapa:** Bagian 9.1 mewajibkan setiap transisi mencatat siapa, kapan, dan catatan apa, serta
menampilkannya sebagai timeline. `audit_log` adalah jejak teknis semua entitas dan tidak enak
dipakai sebagai sumber tampilan bisnis.

**Dampak kalau salah:** duplikasi kecil antara dua tabel. Kalau klien ingin satu sumber saja,
timeline bisa dibaca dari `audit_log` dan tabel transisi dihapus tanpa mengganggu angka.

## A-17. Idempotensi closing kolektibilitas dilakukan dengan upsert, bukan hapus fisik

**Diasumsikan:** menjalankan ulang closing kolektibilitas untuk periode yang sama
**memperbarui** baris `kolektibilitas_snapshot` yang ada (unique pada `(periode_id, akad_id)`,
tanpa filter soft delete), bukan menghapusnya lalu menulis ulang.

**Kenapa:** Bagian 8.1 menulis "menghapus snapshot lama periode itu dan menulis ulang",
sementara invarian 12 melarang penghapusan fisik data keuangan. Bacaan paling konservatif yang
memenuhi keduanya adalah upsert di tempat: hasil akhirnya identik dan tidak ada baris yang
hilang. Lihat OPEN-QUESTIONS.md butir 1.

**Dampak kalau salah:** kalau klien benar benar butuh jejak "snapshot versi sebelumnya", perlu
tambahan kolom versi pada snapshot atau tabel riwayat. Bentuk sekarang tidak menyimpan hasil
run yang dibatalkan.

## A-18. Kredensial cek status portal disimpan sebagai hash

**Diasumsikan:** kombinasi nomor tiket + tanggal lahir atau NIK yang dipakai publik untuk cek
status disimpan sebagai `portal_submission.pemeriksa_hash`, bukan sebagai NIK terbuka.

**Kenapa:** Bagian 9.5 memerlukan mekanisme cek status tanpa login, dan nilai pembandingnya
adalah data pribadi. Menyimpan hash cukup untuk verifikasi dan mengurangi dampak kebocoran.

**Dampak kalau salah:** kalau petugas perlu melihat NIK pemohon online sebelum konversi, NIK
tetap tersedia di `data_json` (isi formulir apa adanya). Perlu keputusan retensi: berapa lama
`data_json` submission yang DITOLAK disimpan.

## A-19. Invarian 9 hanya ditegakkan database untuk jadwal versi 1

**Diasumsikan:** "total angsuran pokok = pokok pinjaman" ditegakkan database hanya untuk jadwal
`versi = 1`. Untuk versi hasil reschedule, total pokok adalah outstanding saat reschedule, dan
kecocokannya diperiksa engine reschedule serta view `v_integritas_jadwal`.

**Kenapa:** reschedule jenis `RESTRUKTUR_POKOK` justru mengubah dasar perhitungan, sehingga
membandingkannya dengan pokok pinjaman awal pasti gagal.

**Dampak kalau salah:** kalau klien memastikan reschedule tidak pernah mengubah pokok, trigger
bisa diperluas ke semua versi (lebih ketat, migrasi mudah).

**STATUS: SUDAH DITUTUP oleh migrasi 0019.** Celah ini tidak lagi diserahkan ke engine. Dasar
pokok untuk versi di atas 1 ternyata bisa diketahui database lewat tautan
`pumk_jadwal_versi.reschedule_id` yang sudah ada sejak 0008: dasarnya adalah
`coalesce(pokok_baru, outstanding_pokok_sebelum)` dari baris reschedule yang melahirkan versi itu
(`TJSL-JDW-006`, deferred, sama pola dengan versi 1). Sekaligus menaikkan "versi di atas 1 hanya
lahir dari reschedule" dari harapan menjadi aturan (`TJSL-JDW-004`). Lihat ADR 0011.

## A-20. NIK mitra unik bila diisi

**Diasumsikan:** `mitra.nik` unik untuk baris yang belum dihapus, tetapi boleh NULL (calon mitra
dari portal bisa belum lengkap).

**Kenapa:** tanpa keunikan NIK, batas satu pinjaman aktif per mitra bisa dilanggar hanya dengan
mendaftarkan orang yang sama dua kali.

**Dampak kalau salah:** kalau di data lama ada NIK ganda yang sah (misalnya salah input yang
belum dibersihkan), import mitra massal akan menolak baris tersebut. Itu memang perilaku yang
diinginkan, tapi harus dikomunikasikan sebelum migrasi go-live.

---

# Asumsi lapisan integrasi eksternal (migrasi 0016, 0017)

Konteks: **siapa pemegang buku resmi TJSL belum diputuskan** (lihat ADR 0008 dan
OPEN-QUESTIONS butir 11). Default tetap mengikuti spesifikasi Bagian 1, yaitu sistem ini yang
memegang buku. Lapisan integrasi dibangun sebagai lapisan opsional yang inert supaya keputusan
itu tetap bisa dibalik tanpa bongkar skema.

Konteks kedua: temuan API di `docs/INTEGRASI-ACCURATE.md` **belum diverifikasi dari sumber
primer** (WebFetch terblokir, semua temuan hasil ekstraksi pencarian, sebagian berlabel sekunder,
dan temuan soal ketiadaan idempotensi adalah argumen dari ketiadaan sumber). Semua asumsi di
bawah karena itu memilih sikap paling pesimistis: kalau nanti terbukti Accurate lebih mampu,
konsekuensinya hanya kolom yang tidak terpakai dan status AMBIGU yang jarang muncul, bukan
constraint yang salah.

## A-21. Arah data satu saja, keluar, dalam kedua kemungkinan

**Diasumsikan:** tidak ada jurnal yang pernah masuk ke sistem ini dari sistem luar.
`sistem_eksternal.arah` di-CHECK ke `'KELUAR'`, jadi konfigurasi masuk tidak bisa direpresentasikan.

**Kenapa:** dua penulis atas data double entry yang sama berarti dua skema idempotensi dan dua
jam; kegagalannya berupa duplikat senyap atau lubang senyap di buku yang akan diaudit.
Rekonsiliasi memberi visibilitas yang sama tanpa risiko itu. Berlaku sama baik sistem ini tetap
pemegang buku maupun tidak.

**Dampak kalau salah:** kalau klien benar benar butuh jurnal dari Accurate masuk ke sini, CHECK
harus dilonggarkan lewat migrasi eksplisit, dan seluruh model idempotensi harus dirancang ulang
dari dua arah. Itu justru alasan CHECK ini ada: keputusan sebesar itu tidak boleh terjadi sebagai
efek samping edit konfigurasi.

## A-22. Accurate butuh nomor akun, id internalnya belum pasti dipakai

**Diasumsikan:** pemetaan akun menyimpan dua identitas, `akun_eksternal_no` (wajib) dan
`akun_eksternal_id` (opsional), karena belum diketahui mana yang diminta API-nya.

**Kenapa:** nomor akun adalah yang direkonsiliasi manusia terhadap laporan Accurate, sedangkan id
internal adalah surrogate key yang biasanya diminta kembali oleh API. Riset belum bisa memastikan
bentuk payload-nya.

**Dampak kalau salah:** salah satu kolom jadi tidak terpakai. Tidak ada dampak angka.

## A-23. Pemetaan akun bersifat satu ke satu di kedua arah

**Diasumsikan:** satu akun kita menunjuk tepat satu akun Accurate, dan satu akun Accurate hanya
boleh ditunjuk satu akun kita (dua partial unique index).

**Kenapa:** kalau dua akun kita menunjuk satu akun Accurate, rekonsiliasi per akun tidak punya
jawaban yang terdefinisi.

**Dampak kalau salah:** kalau klien butuh banyak ke satu (misalnya beberapa akun rinci kita
diringkas ke satu akun Accurate), index `pemetaan_akun_eksternal_eksternal_uq` harus di-DROP lewat
migrasi eksplisit, dan laporan rekonsiliasi harus diubah jadi membandingkan agregat, bukan per
akun.

## A-24. Accurate belum tentu mengembalikan id, dan belum tentu menerima referensi eksternal

**Diasumsikan:** `jurnal_ekspor.id_eksternal` nullable, dan idempotensi tidak bergantung padanya.
Kunci identifikasi adalah `referensi_eksternal` = `no_jurnal` kita, unik per sistem tujuan, dan
proteksi dobel posting yang sebenarnya adalah unique index `(jurnal_id, sistem_kode)` di sisi kita.

**Kenapa:** riset tidak menemukan mekanisme idempotensi apa pun di Accurate Online, dan kemampuan
mencari berdasarkan nomor kita belum terkonfirmasi. Bertumpu pada id yang mereka buat juga tidak
mungkin: id itu belum ada tepat pada saat retry setelah timeout membutuhkannya.

**Dampak kalau salah (ternyata ada idempotensi):** status `AMBIGU` jadi jarang dan bisa
diselesaikan otomatis; flag `dukung_idempotensi` dan `dukung_baca_by_referensi` dinyalakan tanpa
migrasi. Tidak ada yang perlu dibongkar.

## A-25. Retry hanya untuk kegagalan yang PASTI

**Diasumsikan:** hanya status `GAGAL` (terbukti tidak tersimpan di tujuan) yang boleh dicoba ulang
otomatis. `AMBIGU` (timeout, proses mati, respons tidak terbaca) tidak pernah boleh dikirim ulang;
transisi `AMBIGU -> SEDANG_DIKIRIM` tidak ada di tabel transisi.

**Kenapa:** tanpa idempotensi di sisi tujuan, retry atas kiriman yang mungkin berhasil adalah cara
paling langsung menghasilkan jurnal ganda di buku yang diaudit.

**Dampak kalau salah:** kalau ternyata aman untuk retry, satu baris ditambahkan ke tabel transisi.
Kalau asumsi ini dilonggarkan tanpa bukti, akibatnya persis kelas kesalahan yang paling mahal.
Konsekuensi yang harus diterima sekarang: penyelesaian `AMBIGU` mungkin manual (petugas membuka
Accurate dan mencari nomor jurnal kita) sampai kemampuan baca berdasarkan nomor terverifikasi.

## A-26. Saldo dari Accurate diasumsikan konsolidasi, tanpa dimensi cabang

**Diasumsikan:** `saldo_akun_eksternal.cabang_id` nullable dan NULL berarti angka konsolidasi.
Saldo internal (per cabang) diagregasi ke tingkat akun sebelum dibandingkan.

**Kenapa:** dimensi cabang di Accurate ada sebagai objek master, tetapi apakah wajib di baris
jurnal belum diketahui, dan dimensi departemen/proyek tergantung edisi.

**Dampak kalau salah:** kalau ternyata saldo bisa diambil per cabang, kolomnya sudah ada dan
unique index sudah memakai `NULLS NOT DISTINCT`, jadi tinggal diisi. Rekonsiliasi per cabang
menjadi lebih tajam, bukan berubah bentuk.

## A-27. Sekali kirim dianggap benar hanya sampai diverifikasi ulang

**Diasumsikan:** status `TERKIRIM` bukan klaim permanen. Jurnal di Accurate bisa diedit dan
dihapus, jadi ada triple verifikasi (`status_remote`, `sidik_remote`, `diverifikasi_at`) dan
interval pemeriksaan ulang (`konfigurasi.verifikasi_remote_setiap_hari`, default 7 hari).

**Kenapa:** riset menemukan jurnal umum Accurate mutable, termasuk hapus massal.

**Dampak kalau salah:** kalau ternyata jurnal hasil push bisa dikunci di sisi mereka, verifikasi
ulang jadi pekerjaan sia sia dan intervalnya bisa dimatikan lewat konfigurasi. Sebaliknya, tanpa
mekanisme ini, perubahan di sisi mereka tidak akan pernah terdeteksi.

## A-28. Saldo eksternal disimpan per pengambilan, bukan ditimpa

**Diasumsikan:** setiap pengambilan saldo dari sistem tujuan adalah baris tersendiri
(`pengambilan_saldo_eksternal`), tepat satu ditandai `is_terkini` per (sistem, periode), dan baris
saldo menempel pada pengambilan.

**Kenapa:** kalau ditimpa di tempat, perubahan angka di sisi mereka untuk periode yang sudah
ditutup akan diam diam menjadi baseline baru, dan drift-nya tidak bisa dibuktikan.

**Dampak kalau salah:** biaya penyimpanan tumbuh sebanyak jumlah pengambilan. Itu memang harga
dari kemampuan membuktikan bahwa angka di sisi lain berubah. Kalau klien tidak peduli, pengambilan
lama bisa diarsipkan; jangan dihapus tanpa keputusan tertulis.

## A-29. Pihak sub-ledger di sisi tujuan hanya Mitra Binaan

**Diasumsikan:** satu satunya pihak sub-ledger yang di-push sistem ini adalah Mitra Binaan, jadi
`pemetaan_mitra_eksternal` memakai foreign key langsung ke `mitra`, bukan pasangan polimorfik
`entitas` plus `entitas_id`.

**Kenapa:** buku pembantu yang jadi inti sistem ini adalah piutang per Mitra. Membuat bentuk
generik sekarang menukar foreign key nyata dengan fleksibilitas yang belum dibutuhkan.

**Dampak kalau salah:** kalau nanti beban operasional perlu di-push dengan pihak pemasok, perlu
tabel sejenis untuk vendor (aditif) atau generalisasi tabel ini (migrasi sedang). Tidak ada dampak
angka pada data yang sudah ada.

## A-30. Satu Mitra sama dengan satu record pihak di sisi tujuan

**Diasumsikan:** pemetaan Mitra ke pihak eksternal satu ke satu di kedua arah.

**Kenapa:** dua Mitra yang memakai satu record pelanggan akan menggabungkan piutang dua orang di
buku pembantu Accurate, dan itu tidak bisa dipisahkan lagi setelah terjadi.

**Dampak kalau salah:** ini menciptakan kebutuhan tata kelola master data di sisi klien (ratusan
Mitra berarti ratusan record pelanggan di Accurate, dengan pemilik proses yang jelas). Kalau klien
menolak, alternatifnya adalah push agregat tanpa dimensi pihak, dan buku pembantu per Mitra tetap
hanya ada di sistem ini. Lihat OPEN-QUESTIONS butir 15.

## A-31. Dimensi program dan sektor tidak wajib ikut pada ekspor

**Diasumsikan:** dimensi departemen dan proyek di sistem tujuan tergantung edisi, jadi
`konfigurasi.kirim_dimensi_program` default mati dan ekspor tetap sah tanpa dimensi apa pun.
`jurnal_baris.dimensi_json` tetap dimensi analitik kita, bukan syarat push.

**Kenapa:** riset menyatakan integrasi departemen/proyek hanya ada pada edisi yang mendukungnya.

**Dampak kalau salah:** kalau edisi klien mendukung dan mereka ingin dimensi terkirim, cukup
menyalakan flag kemampuan dan konfigurasi; pembangun payload yang menambahkan pemetaan dimensi.
Tidak ada perubahan skema.

## A-32. Granularitas push default ringkas per periode

**Diasumsikan:** `konfigurasi.granularitas_push` default `REKAP_PERIODE`, dan
`maks_baris_per_dokumen` default 0 yang berarti belum diketahui.

**Kenapa:** batas baris per voucher di sistem tujuan tidak ditemukan di sumber mana pun, hanya
saran memecah impor besar. Selama sistem ini masih pemegang buku, jurnal ringkas sudah cukup untuk
konsolidasi induk.

**Dampak kalau salah:** kalau Accurate jadi pemegang buku, granularitas wajib `PER_JURNAL` dan
batas baris harus diukur empiris di database uji lebih dulu. Ini setelan, bukan skema, tetapi
mengubahnya tanpa mengukur batas baris adalah cara paling pasti menghasilkan periode yang
setengah terkirim.

---

# Semantik status jurnal setelah perbaikan 0018

## A-33. REVERSED berarti "masih di buku, sudah diimbangi", bukan "ditarik"

**Diasumsikan:** baris jurnal dari jurnal berstatus `REVERSED` **tetap ikut** dihitung dalam
setiap agregat buku besar, karena baris itu masih entri riil dan sudah diimbangi oleh baris
jurnal pembaliknya (yang berstatus `POSTED`). Predikat resmi "baris ini masuk buku besar" adalah
`status IN ('POSTED','REVERSED') AND deleted_at IS NULL`, dan dinyatakan satu kali di view
`v_ledger_baris` (migrasi 0018).

**Kenapa:** koreksi memakai jurnal pembalik (invarian 4, Bagian 6.3) menambah dua baris dan tidak
pernah menghapus satu pun. Menyaring `POSTED` saja hanya menghitung satu sisi dari pasangan
koreksi, sehingga efek setiap pembalikan terhitung dua kali. Ini bukan insiden, ini kelas
kesalahan: dua bug yang dilaporkan tim engine (guard periode menolak pembalikan, dan rekonsiliasi
piutang menghitung ganda) berakar pada asumsi yang sama.

**Dampak kalau salah:** kalau klien ternyata menginginkan jurnal `REVERSED` hilang dari buku besar
(artinya pembalikan dianggap membatalkan, bukan mengimbangi), maka jurnal pembalik tidak boleh
dibuat sama sekali, dan itu bertentangan dengan invarian 4 serta menghapus jejak audit di kedua
sisi. Jadi asumsi ini tidak berdiri sendiri: mengubahnya berarti mengubah kebijakan koreksi,
bukan sekadar mengubah satu `WHERE`.

**Dampak operasional yang harus diperhatikan tim aplikasi:** setiap query buku besar baru wajib
membaca `v_ledger_baris`. Yang paling berisiko adalah engine closing yang menulis
`saldo_akun_periode`: snapshot itu dibekukan, jadi kalau ia menyaring `POSTED` saja, angka salahnya
menjadi permanen dan tidak terlihat oleh view mana pun (lihat OPEN-QUESTIONS butir 20).

## A-34. Transisi POSTED ke REVERSED dikecualikan dari guard periode CLOSED

**Diasumsikan:** menandai jurnal asli `POSTED -> REVERSED` boleh dilakukan meskipun periode jurnal
asli sudah CLOSED, selama tanggal transaksi dan periode_id-nya tidak berubah. Jurnal pembaliknya
sendiri tetap divalidasi penuh saat INSERT, jadi tetap wajib bertanggal di periode yang terbuka.

**Kenapa:** Bagian 6.3 justru mengharuskan kasus ini jalan, dengan alasan eksplisit "periode asli
mungkin sudah tutup". Tanpa pengecualian ini, jurnal yang periodenya sudah ditutup tidak bisa
dikoreksi dengan cara apa pun.

**Dampak kalau salah:** kalau klien ingin pembalikan atas periode CLOSED harus lewat reopen
periode lebih dulu (kebijakan yang lebih ketat dan sah), pengecualian ini harus dihapus dan alur
koreksi wajib melewati reopen. Konsekuensinya reopen menjadi operasi rutin, bukan operasi
pengecualian, dan itu keputusan tim akuntansi.

---

# Penegakan jalur posting dan penghapusan fisik (migrasi 0020, 0021)

## A-35. Guard jalur posting adalah tripwire, bukan batas keamanan

**Diasumsikan:** trigger `BEFORE INSERT` pada `jurnal` dan `jurnal_baris` yang mewajibkan
`tjsl.jalur_posting = '<jalur>:' || txid_current()` **bisa** dilewati oleh pemanggil yang memang
berniat: modul apa pun yang bisa menjalankan SQL juga bisa menjalankan `set_config` yang sama di
dalam transaksinya sendiri. Database tidak tahu modul mana yang memanggil.

**Kenapa tetap dibangun:** yang realistis terjadi bukan sabotase, tetapi kelalaian. Seseorang
menulis INSERT langsung karena praktis, lalu angkanya masuk buku tanpa lewat engine dan tanpa
peringatan apa pun. Guard ini membuat kelalaian itu gagal seketika dengan pesan yang menyebut
aturannya, dan ia menjangkau jalur yang tidak bisa dilihat oleh pemeriksa statis: sesi psql,
skrip sekali pakai, `tools/`, `core/`, seed, dan berkas apa pun di luar
`apps/api/src/modules/**`. Nonce transaksi menutup kebocoran nilai antar transaksi, termasuk
akibat salah tulis `SET` alih alih `SET LOCAL`.

**Dampak kalau salah dipahami:** kalau guard ini diperlakukan sebagai jaminan keamanan, review
kode bisa jadi lengah. Penegakan utama tetap `tools/check-boundaries.ts` di CI; batas yang
sebenarnya adalah pemisahan role database (REVOKE plus SECURITY DEFINER), lihat OPEN-QUESTIONS
butir 22 dan ADR 0012.

## A-36. Jalur non-engine yang sah dibuat kelihatan di data, bukan disembunyikan di kode

**Diasumsikan:** selain `engine`, hanya `seed` dan `import_saldo_awal` yang sah, dan nilainya
**dicap ke baris** (`jurnal.jalur_posting`) sehingga bisa dikueri, bukan hanya berupa konstanta di
kode.

**Kenapa:** nilai sah kedua yang hanya hidup di kode akan menyebar lewat salin tempel tanpa jejak.
Kalau ia menyebar sebagai kolom, penyebarannya terlihat: `SELECT * FROM
v_jurnal_jalur_bukan_engine` menjawab "apa saja yang masuk bukan lewat engine" untuk semua periode.

**Dampak kalau salah:** kalau ternyata ada jalur sah lain (misalnya migrasi dari sistem lain di
luar import saldo awal), daftar nilai di CHECK harus ditambah lewat migrasi eksplisit. Itu memang
disengaja: menambah pintu masuk ke buku besar harus terlihat di riwayat migrasi.

## A-37. Yang tidak bisa direkonstruksi adalah yang tidak boleh dihapus

**Diasumsikan:** proteksi TRUNCATE hanya dipasang pada tabel bukti (buku besar, jejak audit,
periode, COA, jadwal angsuran, jejak ekspor), tidak pada snapshot turunan
(`saldo_akun_periode`, `kolektibilitas_snapshot`, `saldo_akun_eksternal`).

**Kenapa:** spesifikasi 8.4 mendefinisikan reopen periode sebagai menghapus snapshot saldo
periode itu, dan angka yang bisa dihitung ulang dari ledger bukan bukti. Memproteksi semuanya
akan membuat operasi yang sah menjadi mustahil.

**Dampak kalau salah:** kalau auditor klien menganggap snapshot periode tertutup juga bukti,
proteksi harus diperluas dan mekanisme reopen harus diganti dengan pengarsipan berlapis, bukan
penghapusan. Lihat OPEN-QUESTIONS butir 7 yang sudah mencatat pertanyaan itu.

---

# Tiga event jurnal yang tidak ada di spesifikasi Bagian 6.4 (A-38 sampai A-40)

Bagian 6.4 mendaftarkan 19 kode event. Tiga peristiwa uang yang nyata tidak punya kode di daftar
itu, sementara modul bisnis Fase 3 sampai 5 harus mencatatnya. Pemilik repo memutuskan mengambil
pembacaan yang paling masuk akal sekarang dan menandainya bisa diganti belakangan; alasan
lengkapnya ada di `docs/BUILD-PLAN.md`, bagian "Keputusan sementara: event yang tidak ada di
spesifikasi Bagian 6.4". Katalognya ada di `apps/api/src/seed/event-jurnal.ts`.

Tiga entri berikut adalah **asumsi yang wajib dikonfirmasi tim keuangan klien bersama KAP mereka**,
dan **bukan klaim kepatuhan** terhadap peraturan mana pun. Tidak satu pun berasal dari naskah
peraturan yang sudah dibaca utuh; ketiganya adalah pembacaan kami atas praktik akuntansi yang
lazim, diambil supaya kode bisnis tidak mengarang jurnalnya sendiri (invarian 11).

Biaya membetulkannya sengaja dibuat murah: pasangan akun tiap event adalah satu baris di
`event_jurnal_mapping`, jadi koreksi berarti `UPDATE` satu baris, bukan deploy. Yang tidak murah
adalah alternatif yang dihindari, yaitu modul bisnis menulis jurnal sendiri karena tidak ada kode
event yang cocok.

## A-38. Kekurangan penyisihan saat hapus buku dibebankan ke periode berjalan

**Diasumsikan:** kalau saldo Penyisihan Penurunan Nilai Piutang lebih kecil dari outstanding yang
dihapus buku, penyisihan dipakai lebih dulu sampai habis dan **sisanya dibebankan ke periode
berjalan** lewat event `HAPUS_BUKU_KEKURANGAN_PENYISIHAN` (debit Beban Penyisihan Penurunan Nilai
Piutang, kredit Piutang Pinjaman Mitra Binaan). Perlakuan ini adalah nilai default
`akuntansi.kekurangan_penyisihan_hapus_buku = BEBAN_PERIODE`; nilai `TOLAK` menolak hapus bukunya
sampai penyisihannya dibentuk lebih dulu.

**Kenapa:** `HAPUS_BUKU_PIUTANG` di Bagian 6.4 mendebit penyisihan sebesar **seluruh** outstanding.
Itu hanya benar kalau saldo penyisihan menutup outstanding, yang berlaku pada rate Macet 100
persen tetapi tidak berlaku pada dasar penurunan nilai kolektif yang menurut `docs/REGULASI.md`
justru dipakai di laporan PUMK yang diaudit. Dengan penyisihan yang lebih kecil, jurnal Bagian 6.4
apa adanya membuat akun kontra aset bersaldo debit, dan pengurang aset yang negatif tampil sebagai
**piutang yang lebih besar**, persis sebesar angka yang seharusnya keluar dari neraca. Jurnalnya
balance dan tetap salah, sehingga invarian "debit sama dengan kredit" tidak akan pernah
menangkapnya. Ini cacat di spesifikasi, bukan di implementasi.

**Dampak kalau salah:** kalau tim keuangan dan KAP menyatakan kekurangan penyisihan tidak boleh
menjadi beban periode berjalan (misalnya harus lewat koreksi penyisihan pada periode pembentukan,
atau hapus buku ditolak sampai penyisihannya cukup), ubah baris `konfigurasi` menjadi `TOLAK` dan
alur hapus buku akan menolak transaksinya dengan `PENYISIHAN_TIDAK_CUKUP`. Kalau yang berubah
adalah akun bebannya, yang berubah satu baris `event_jurnal_mapping`. Yang **tidak** boleh dilakukan
adalah kembali memakai `postingEvent("HAPUS_BUKU_PIUTANG")` untuk seluruh outstanding: itu
mengembalikan cacat neraca di atas. Konsumsi penyisihan dan pemisahan kekurangannya dikerjakan
`postingHapusBukuPiutang` di `apps/api/src/modules/jurnal`, dan dijaga oleh
`apps/api/src/modules/jurnal/jurnal-hapus-buku.test.ts`.

## A-39. Restrukturisasi yang menaikkan pokok mengkapitalisasi jasa administrasi terakrual

**Diasumsikan:** reschedule yang menaikkan pokok dicatat dengan `RESTRUKTUR_POKOK_NAIK`, debit
Piutang Pinjaman Mitra Binaan, kredit **Piutang Jasa Administrasi**.

**Kenapa:** pokok naik tanpa uang keluar berarti tagihan yang sudah diakui dikapitalisasi ke pokok,
dan kandidat yang paling mungkin adalah jasa administrasi yang sudah diakrual tetapi belum dibayar.
Total piutang tidak berubah karena ini reklasifikasi, bukan pengakuan tagihan baru.

**Dampak kalau salah:** kalau yang dikapitalisasi ternyata bukan jasa administrasi terakrual
(misalnya denda, biaya penagihan, atau pokok tambahan yang memang dicairkan), baris pemetaan
diganti dan jurnal berikutnya langsung ikut, tanpa deploy. Kalau ternyata kenaikan pokok **selalu**
disertai pencairan uang, event ini tidak dipakai sama sekali dan penambahan pokok memakai
`PENCAIRAN_PUMK`; dampaknya ada di modul restrukturisasi Fase 5, bukan di engine jurnal.

## A-40. Restrukturisasi yang menurunkan pokok diserap penyisihan lebih dulu

**Diasumsikan:** reschedule yang menurunkan pokok dicatat dengan `RESTRUKTUR_POKOK_TURUN`, debit
Penyisihan Penurunan Nilai Piutang, kredit Piutang Pinjaman Mitra Binaan. Kalau penyisihannya tidak
cukup, sisanya lewat `HAPUS_BUKU_KEKURANGAN_PENYISIHAN` dengan alasan yang sama seperti A-38.

**Kenapa:** penurunan pokok adalah pengurangan tagihan, dan tagihan yang berkurang wajar diserap
penyisihan yang sudah dibentuk untuk piutang bermasalah itu sebelum menjadi beban baru.

**Dampak kalau salah:** kalau tim keuangan menyatakan penurunan pokok adalah beban periode berjalan
tanpa menyentuh penyisihan (atau pengurang pendapatan), baris pemetaannya diganti. Yang perlu
diperiksa bersamaan: penurunan pokok yang menembus saldo penyisihan harus memakai pemisahan yang
sama seperti hapus buku, atau akun kontra asetnya akan negatif dengan cara yang sama.

## Catatan penghapustagihan (sengaja tanpa kode event)

Penghapustagihan **tidak** diberi kode event, dan itu bukan kelalaian. Menurut SK-277/MBU/10/2023,
penghapusbukuan mengeluarkan piutang dari neraca sementara hak tagih tetap ada dan dicatat
ekstrakomtabel. Menghapus hak tagih itu kemudian tidak menggeser saldo apa pun karena piutangnya
sudah tidak ada di neraca, jadi perlakuannya adalah peristiwa memorandum pada register
ekstrakomtabel, bukan jurnal. Kasus yang perlu menghapus tagihan atas piutang yang masih di neraca
dikerjakan dua langkah: hapus buku dulu, lalu hapus tagih. Dua kode event yang menghasilkan jurnal
identik adalah jebakan rekonsiliasi. Status pertanyaannya ada di `docs/REGULASI.md` butir 4 dan
menunggu jawaban unit TJSL klien.

---

# Parameter Non PUMK (A-41 sampai A-44)

Empat asumsi berikut berbeda derajatnya dari semua asumsi di atas, dan pembedanya penting.
Asumsi A-01 sampai A-40 adalah **tafsir atas angka atau aturan yang ada di spesifikasi**.
Empat yang berikut adalah **angka yang tidak ada sama sekali di spesifikasi**: Bagian 5.5
"Batasan Program" hanya memuat batasan PUMK (plafon, tenor, grace period, jaminan, jumlah akad
aktif, skor survey), sementara Bagian 9.2 tetap menuntut engine Non PUMK memeriksa rentang nilai
bantuan, ambang skor penilaian, dan tenggat LPJ. Jadi angkanya **kami karang**, dan dikirim di
`migrations/0022_parameter_non_pumk.sql` sebagai baris global (`bumn_id NULL`) dengan
`perlu_konfirmasi = true`.

Ini **bukan klaim kepatuhan**. Tidak satu pun dari keempat angka ini punya dasar regulasi atau
dasar spesifikasi; semuanya menunggu **konfirmasi tertulis unit TJSL dan tim keuangan klien**.
Yang bisa kami pertanggungjawabkan hanyalah alasan pemilihannya, dan bahwa mengubahnya adalah satu
baris data, bukan deploy: `UPDATE konfigurasi SET nilai = ... WHERE bumn_id IS NULL AND grup =
'batasan' AND kunci = ...`, atau override per BUMN lewat menu Konfigurasi.

Kalau klien menjawab "belum ada kebijakannya", jawaban itu sendiri adalah keputusan yang harus
dicatat: menghapus barisnya membuat engine Non PUMK menolak dengan `KONFIGURASI_TIDAK_ADA` dan
menghentikan seluruh alur, jadi pilihannya adalah menetapkan angka, bukan membiarkannya kosong.

## A-41. Nilai bantuan Non PUMK minimum Rp 1.000.000

**Diasumsikan:** `konfigurasi (bumn_id NULL, batasan, nilai_min_non_pumk) = 1000000.00`.

**Kenapa:** batas bawah ada supaya proposal yang biaya prosesnya melebihi manfaatnya tidak masuk
alur enam tahap (proposal, penilaian, review, persetujuan, penyaluran, LPJ). Rp 1 juta dipilih
sebagai angka bulat terkecil yang masih masuk akal untuk sebuah program dengan penerima manfaat,
bukan karena ada rujukan yang menyebut angka itu.

**Dampak kalau salah:** ganti nilainya di satu baris. Kalau klien menyatakan tidak boleh ada batas
bawah sama sekali, isi `0.00`; jangan menghapus barisnya, karena baris yang hilang membuat engine
menolak seluruh pengajuan, bukan melewatkan pemeriksaannya.

## A-42. Nilai bantuan Non PUMK maksimum Rp 500.000.000

**Diasumsikan:** `konfigurasi (bumn_id NULL, batasan, nilai_max_non_pumk) = 500000000.00`.

**Kenapa:** dua kali plafon PUMK Rp 250.000.000 yang **memang** ada di Bagian 5.5. Non PUMK adalah
hibah kepada lembaga untuk satu program, bukan pinjaman kepada satu usaha mikro, sehingga memakai
plafon yang sama terlalu rendah, sedangkan tanpa batas atas berarti tidak ada plafon sama sekali
dan setiap nilai lolos tanpa eskalasi.

**Dampak kalau salah:** satu baris. Yang perlu diperiksa bersamaan kalau angkanya naik: apakah di
atas nilai tertentu persetujuan harus naik ke Direksi atau ke BUMN Pembina. Spesifikasi tidak
menyebut jenjang persetujuan bertingkat untuk Non PUMK, jadi engine sekarang hanya mengenal satu
Approver; kalau klien menghendaki jenjang, itu perubahan alur (state machine Bagian 9.2), bukan
perubahan parameter, dan harus dijadwalkan sendiri.

## A-43. Skor penilaian minimum lolos Non PUMK 70

**Diasumsikan:** `konfigurasi (bumn_id NULL, batasan, skor_penilaian_minimum_lolos_non_pumk) = 70`.

**Kenapa:** sama dengan `skor_survey_minimum_lolos` = 70 yang Bagian 5.5 tetapkan untuk survey
PUMK. Dua program dalam satu sistem sebaiknya tidak punya ambang kelulusan yang berbeda **secara
tidak sengaja**; kalau klien memang ingin Non PUMK lebih ketat atau lebih longgar, sekarang itu
menjadi keputusan yang dinyatakan, bukan efek samping.

**Dampak kalau salah:** satu baris. Perlu diingat skalanya: `nonpumk_penilaian.skor_total` adalah
rata rata berbobot dari lima komponen Bagian 4.5 (kelayakan, urgensi, dampak, kesesuaian bidang,
kesesuaian SDG) pada skala 0 sampai 100, jadi mengubah **bobot** komponen mengubah arti angka 70
walau angkanya tidak diubah. Keduanya harus dikonfirmasi bersamaan.

## A-44. Batas penyampaian LPJ Non PUMK 60 hari sejak penyaluran terakhir

**Diasumsikan:** `konfigurasi (bumn_id NULL, batasan, batas_hari_lpj_non_pumk) = 60`, dihitung dari
tanggal penyaluran **terakhir** (bukan pertama), dan hanya menentukan flag `terlambat` di
monitoring.

**Kenapa:** Bagian 9.2 sendiri memakai ember aging 30, 60, dan 90 hari, jadi tenggatnya sebaiknya
salah satu dari ketiganya. Pada 30 hari, program yang berjalan satu kuartal sudah terlambat sebelum
selesai; pada 90 hari, dua ember pertama tidak akan pernah berisi LPJ terlambat dan dasbor
monitoring yang diminta spesifikasi baru menyala di ember terakhir. 60 hari adalah satu satunya
pilihan yang menyisakan dasbor itu berguna.

**Dampak kalau salah:** satu baris, dan efeknya hanya pada kolom `terlambat` serta laporan
monitoring; tidak ada jurnal dan tidak ada saldo yang bergantung padanya. Yang **belum** diputuskan
dan tidak diasumsikan di sini: apa akibat keterlambatan (blokir pengajuan berikutnya dari pemohon
yang sama, surat teguran, atau tidak ada akibat sama sekali). Ambang 30/60/90 itu sendiri konstanta
spesifikasi dan sengaja **tidak** dijadikan parameter.

## A-45. Kredit `PENGEMBALIAN_SISA_NON_PUMK` adalah akun beban bidang yang sama dengan debit penyalurannya

**Diasumsikan:** pada tabel Bagian 6.4, baris `PENYALURAN_NON_PUMK` menulis debit "Beban Penyaluran
Non PUMK **(per bidang)**" sedangkan baris `PENGEMBALIAN_SISA_NON_PUMK` menulis kredit "Beban
Penyaluran Non PUMK" tanpa keterangan itu. Kami membacanya sebagai **akun yang sama**, yaitu akun
beban bidang yang didebit saat penyaluran, bukan satu akun beban kolektif. Karena itu baris
pemetaannya sekarang `kredit_dari_payload = true` dan pemanggilnya mengirim `akun_beban_id` termin
yang bersangkutan.

**Kenapa:** pengembalian sisa adalah pembalikan sebagian dari penyaluran tertentu. Kalau uang keluar
lewat akun yang dipilih di form (per bidang) sementara uang kembali dikreditkan ke satu akun tetap,
maka untuk setiap bidang yang punya akun sendiri: beban bidang itu tetap lebih besar sebesar sisa
yang dikembalikan, dan akun kolektifnya bergerak negatif sebesar angka yang sama. Kedua jurnalnya
balance, jadi invarian "debit sama dengan kredit" tidak akan pernah menangkapnya; yang salah hanya
kelihatan di Laporan Rekap Penyaluran Non PUMK per Bidang (Bagian 10 laporan 13), berbulan bulan
kemudian. Membaca kedua baris itu sebagai akun yang berbeda menghasilkan laporan per bidang yang
salah secara diam diam, jadi pembacaan ini yang dipakai.

**Dampak kalau salah:** kalau tim keuangan menyatakan pengembalian sisa memang harus masuk satu akun
beban kolektif (misalnya karena pengembalian dilaporkan terpisah dari realisasi per bidang), yang
berubah satu baris `event_jurnal_mapping`: `kredit_dari_payload = false` dan `akun_kredit_id`
diarahkan ke akun kolektif itu. Tidak ada kode yang berubah, dan jurnal yang sudah terposting tidak
ikut berubah karena jurnal menyimpan `akun_id` hasil resolusinya, bukan pemetaannya.

## A-46. Jendela histori adalah satu satunya masukan tambahan yang perlu dibekukan untuk rate kolektif

**Diasumsikan:** `kolektibilitas_snapshot.sumber_rate` (migrasi 0024) hanya punya dua nilai,
`TABEL_KONFIGURASI` dan `KOLEKTIF_HISTORIS`, dan untuk nilai kedua **jendela histori**
(`rate_histori_dari`, `rate_histori_sampai`) sudah cukup untuk menghitung ulang rate-nya. Artinya
kami mengasumsikan rate kolektif adalah fungsi dari (jendela waktu, data penagihan), dan data
penagihan itu hidup di buku besar serta tabel angsuran yang bersifat append only, sehingga tidak
perlu ikut dibekukan.

**Kenapa:** yang hilang permanen kalau tidak dicatat hanyalah jendelanya, karena
`akuntansi.penyisihan_min_bulan_histori` adalah baris `konfigurasi` yang diubah di tempat dan pasti
sudah berbeda saat seseorang bertanya bertahun tahun kemudian. Angka penyisihannya sendiri sudah
bisa dibangun ulang dari kolom yang ada (`rate_penyisihan` kali basis, dijaga CHECK sejak 0011),
jadi yang ditambahkan 0024 adalah **asal** rate itu, bukan hasilnya. Menyimpan pointer ke versi
baris konfigurasi ditolak dengan alasan yang ditulis penuh di ADR 0014: `version` adalah penghitung
optimistic lock, bukan kunci riwayat, jadi pointer itu akan menunjuk ke nilai hari ini sambil
mengaku sebagai nilai yang dipakai.

**Dampak kalau salah:** kalau metode kolektif yang disepakati KAP ternyata memakai masukan lain di
luar jendela dan data penagihan (misalnya segmentasi populasi tersendiri, faktor pemulihan yang
ditetapkan manajemen, atau *management overlay*), maka jendela saja tidak cukup dan snapshot butuh
kolom tambahan untuk masukan itu. Perubahannya aditif: satu migrasi menambah kolom, `sumber_rate`
dan CHECK yang ada tidak berubah, dan periode yang sudah tertutup tetap terbaca. Yang **tidak**
diasumsikan di sini adalah rumus rate kolektifnya sendiri; itu masih pertanyaan terbuka ke tim
akuntansi klien (docs/REGULASI.md temuan 2).

## A-47. Pemegang `admin.closing.view` adalah Auditor dan Approver, bukan Maker atau Checker

**Diasumsikan:** kode izin baca saja untuk layar closing dipegang AUDITOR (lewat daftar read only)
dan APPROVER (eksplisit), sehingga ADMIN_CABANG mewarisinya dari APPROVER dan ADMIN_PUSAT dari
sebaran `PERMISSIONS`. MAKER dan CHECKER tidak memegangnya.

**Kenapa:** Bagian 2 memberi Auditor "read only penuh termasuk semua laporan dan audit trail" dan
skenario 23 Bagian 16 mengujinya, sementara checklist prasyarat, riwayat run, dan saldo beku bukan
salah satu dari 31 laporan Bagian 10, jadi `laporan.view` tidak menjangkaunya. Dua jalan keluar
lain sama sama salah: memakai `admin.closing.periode` berarti memberi kode **tulis** kepada peran
yang tidak boleh mengubah apa pun, dan membiarkan jalur baca tanpa izin membuat seluruh riwayat
closing terbaca oleh siapa pun yang bisa login. Approver mendapatkannya karena membaca checklist
adalah tindakan terpisah dari mengeksekusi closing, dan ia melakukan yang pertama sebelum
memutuskan yang kedua. Maker dan Checker tidak menutup periode dan dua layar closing di Bagian 9.3
adalah wewenang Approver.

**Dampak kalau salah:** kalau klien ingin Maker atau Checker ikut memantau kesiapan closing
(misalnya untuk membereskan jurnal DRAFT sebelum tutup buku), yang berubah satu baris: tambahkan
`"admin.closing.view"` ke daftar MAKER atau CHECKER di
`apps/api/src/modules/auth/permissions.ts` dan cerminkan di `apps/web/src/permissions.ts`. Tidak
ada jalur tulis yang ikut terbuka, karena kode ini tidak menggerakkan satu pun operasi closing.
