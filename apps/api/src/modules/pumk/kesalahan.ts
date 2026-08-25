// Translation layer: a database refusal becomes a domain rejection.
//
// Same job, same shape and same reasoning as modules/jurnal/kesalahan.ts and
// modules/angsuran/kesalahan.ts. migrations/0008 puts the segregation rules,
// the one-live-loan-per-mitra rule and the akad/proposal branch agreement in
// Postgres, so the last line of defence raises text like
//   'TJSL-SOD-001: user 9f2c... adalah maker proposal ini ...'
//   'duplicate key value violates unique constraint "pumk_akad_satu_aktif_..."'
// which names triggers, constraints and SQLSTATEs. That text must never reach
// a caller, an HTTP body or a log line a finance user reads. The engine
// validates first and EXPECTS to be the one rejecting; when the database
// refuses anyway (a real race between two concurrent approvals), the refusal
// is mapped onto the same `PumkError` code and the raw text is kept in
// `penyebabDb`, for the server log only.
//
// MAPPING IS ON THE TRIGGER'S OWN CODE PREFIX AND ON THE CONSTRAINT NAME,
// never on prose: trigger messages are Indonesian and will be reworded,
// `TJSL-SOD-001` and `err.constraint` will not.
//
// The message catalogue is keyed with plain string literals rather than
// `[KODE_PUMK.X]:` for the same reason the other two modules' are: ./contract.ts
// imports ./service.ts, which imports this file, so reading `KODE_PUMK` at
// module-evaluation time here would touch a binding still in its temporal dead
// zone. Every reference to it lives inside a function body.
import { PumkError, type KodePumk } from "./contract";

/** User-facing Indonesian prose, one per code. Free of any driver internals. */
const PESAN: Record<KodePumk, string> = {
  PROPOSAL_TIDAK_DITEMUKAN: "Proposal tidak ditemukan.",
  MITRA_TIDAK_DITEMUKAN: "Mitra binaan tidak ditemukan.",
  AKAD_TIDAK_DITEMUKAN: "Akad tidak ditemukan.",
  SEKTOR_TIDAK_DITEMUKAN: "Sektor usaha tidak ditemukan.",
  CLUSTER_TIDAK_DITEMUKAN: "Cluster tidak ditemukan.",
  SUBMISSION_TIDAK_DITEMUKAN: "Pengajuan dari portal tidak ditemukan.",

  TRANSISI_TIDAK_VALID:
    "Tindakan ini tidak tersedia dari status proposal saat ini. Periksa kembali tahapan proposal di halaman detail.",
  STATUS_TERMINAL:
    "Proposal ini sudah berada di tahap akhir dan tidak bisa diproses lagi. Buat proposal baru bila memang diperlukan.",
  CATATAN_WAJIB: "Catatan atau alasan wajib diisi untuk tindakan ini.",

  PLAFON_DILUAR_BATAS: "Jumlah pinjaman berada di luar batas plafon yang dikonfigurasi.",
  TENOR_DILUAR_BATAS: "Tenor berada di luar batas jumlah bulan yang dikonfigurasi.",
  GRACE_DILUAR_BATAS: "Grace period melampaui batas maksimum yang dikonfigurasi.",
  JAMINAN_WAJIB:
    "Pengajuan di atas ambang ini wajib disertai jaminan riil, bukan tanpa jaminan.",
  MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF:
    "Mitra ini masih punya pinjaman berjalan, sehingga belum bisa mengajukan pinjaman baru.",
  NILAI_BUKAN_DESIMAL:
    "Nilai uang harus desimal positif dengan dua angka di belakang koma, misalnya 1500000.00, dan rate dengan enam angka, misalnya 0.030000.",
  TANGGAL_TIDAK_VALID: "Tanggal tidak valid. Format yang dipakai adalah YYYY-MM-DD.",

  SURVEY_SUDAH_ADA: "Proposal ini sudah punya hasil survey; hasil survey tidak bisa ditimpa.",
  SURVEY_BELUM_ADA: "Proposal ini belum punya hasil survey untuk direview.",
  SKOR_DIBAWAH_MINIMUM:
    "Skor survey berada di bawah ambang minimum kelulusan yang dikonfigurasi.",
  KEPUTUSAN_TIDAK_VALID:
    "Keputusan ini belum lengkap. Persetujuan wajib menyebut plafon dan tenor yang disetujui.",

  AKAD_SUDAH_ADA: "Proposal ini sudah punya akad.",
  JADWAL_BELUM_SIAP: "Jadwal angsuran belum dibuat, jadi pencairan belum bisa dicatat.",
  PENCAIRAN_SUDAH_ADA: "Akad ini sudah pernah dicairkan.",
  NILAI_PENCAIRAN_TIDAK_COCOK:
    "Nilai pencairan harus sama persis dengan pokok pinjaman pada akad.",
  AKUN_KAS_TIDAK_VALID: "Akun kas yang dipilih tidak ditemukan, tidak aktif, atau bukan akun kas.",

  PENGAKHIRAN_SUDAH_ADA: "Akad ini sudah punya catatan pengakhiran.",
  AKAD_TIDAK_BISA_DIAKHIRI:
    "Status akad ini tidak bisa diakhiri dengan cara tersebut. Periksa outstanding dan status akadnya.",

  MITRA_SUDAH_DI_CLUSTER:
    "Mitra ini masih tercatat sebagai anggota aktif sebuah cluster. Keluarkan dulu dari cluster lamanya.",
  MITRA_BUKAN_ANGGOTA_CLUSTER: "Mitra ini bukan anggota aktif cluster tersebut.",

  SUBMISSION_SUDAH_DIKONVERSI:
    "Pengajuan portal ini sudah pernah dikonversi menjadi proposal internal.",
  SUBMISSION_BUKAN_PUMK: "Pengajuan portal ini bukan pengajuan PUMK.",
  SUBMISSION_DATA_TIDAK_LENGKAP:
    "Data pengajuan portal belum lengkap, jadi tidak bisa dikonversi. Lengkapi dulu bersama pemohon.",

  JURNAL_GAGAL: "Jurnal untuk transaksi ini gagal dibuat, jadi seluruh langkah dibatalkan.",
  JADWAL_GAGAL: "Jadwal angsuran untuk akad ini gagal diproses, jadi langkah ini dibatalkan.",
  SETORAN_GAGAL: "Penerimaan angsuran ini gagal diproses, jadi tidak ada yang tersimpan.",

  TIDAK_BERWENANG: "Pengguna ini tidak punya wewenang untuk tindakan tersebut pada pendanaan UMK.",
  CABANG_DILUAR_SCOPE: "Data ini berada di cabang di luar wewenang pengguna.",
  KONFLIK_MAKER_CHECKER:
    "Pembuat proposal tidak boleh menjadi checker atas proposalnya sendiri.",
  KONFLIK_CHECKER_APPROVER:
    "Checker proposal ini tidak boleh menjadi approver atas proposal yang sama.",
  IZIN_BELUM_TERDAFTAR:
    "Kewenangan untuk tindakan ini belum terdaftar di katalog izin, jadi tindakan ditolak sampai kewenangannya ditambahkan.",

  KONFIGURASI_TIDAK_ADA:
    "Parameter konfigurasi yang dibutuhkan belum ada. Lengkapi dulu konfigurasinya.",
  KONFIGURASI_TIDAK_VALID:
    "Nilai parameter konfigurasi tidak valid, jadi proses dihentikan alih alih memakai nilai tebakan.",
  EVENT_MAPPING_BELUM_ADA:
    "Belum ada pemetaan jurnal yang disahkan untuk peristiwa ini, jadi transaksi ditolak dan tidak ditebak.",
  KEBIJAKAN_BELUM_DIPUTUSKAN:
    "Kebijakan untuk kasus ini belum diputuskan pemiliknya, jadi transaksi ditolak alih alih dipilihkan.",
};

/** Builds the module's only error type, with the catalogue message. */
export function tolak(
  kode: KodePumk,
  detail: Record<string, unknown> = {},
  penyebabDb?: string,
): PumkError {
  return new PumkError(kode, PESAN[kode], detail, penyebabDb);
}

/**
 * Trigger codes from migrations/0008_pumk.sql, mapped onto the domain code the
 * engine would have raised itself. TJSL-AKD-001 is the akad/proposal branch
 * disagreement, which at this layer can only be a scope mistake.
 */
const PETA_KODE_TRIGGER: Record<string, KodePumk> = {
  "TJSL-SOD-001": "KONFLIK_MAKER_CHECKER",
  "TJSL-SOD-002": "KONFLIK_CHECKER_APPROVER",
  "TJSL-AKD-001": "CABANG_DILUAR_SCOPE",
  "TJSL-JDW-001": "JADWAL_GAGAL",
  "TJSL-JDW-002": "JADWAL_GAGAL",
  "TJSL-JDW-003": "JADWAL_GAGAL",
  "TJSL-JRN-015": "JURNAL_GAGAL",
};

/** Constraint names, for the refusals that are declarative rather than raised. */
const PETA_CONSTRAINT: Record<string, KodePumk> = {
  pumk_akad_satu_aktif_per_mitra_uq: "MITRA_SUDAH_PUNYA_PINJAMAN_AKTIF",
  pumk_akad_proposal_uq: "AKAD_SUDAH_ADA",
  pumk_akad_no_uq: "AKAD_SUDAH_ADA",
  pumk_proposal_portal_uq: "SUBMISSION_SUDAH_DIKONVERSI",
  pumk_proposal_sumber_ck: "SUBMISSION_SUDAH_DIKONVERSI",
  portal_submission_konversi_ck: "SUBMISSION_SUDAH_DIKONVERSI",
  cluster_anggota_aktif_uq: "MITRA_SUDAH_DI_CLUSTER",
  cluster_anggota_tanggal_ck: "TANGGAL_TIDAK_VALID",
  pumk_survey_proposal_uq: "SURVEY_SUDAH_ADA",
  pumk_approval_setuju_ck: "KEPUTUSAN_TIDAK_VALID",
  pumk_akad_tanggal_ck: "TANGGAL_TIDAK_VALID",
  pumk_akad_outstanding_pokok_max_ck: "NILAI_PENCAIRAN_TIDAK_COCOK",
  pumk_pencairan_akun_kas_id_fkey: "AKUN_KAS_TIDAK_VALID",
  pumk_pencairan_jurnal_fk: "JURNAL_GAGAL",
  pumk_pengakhiran_jurnal_fk: "JURNAL_GAGAL",
};

interface KesalahanDb {
  message?: unknown;
  constraint?: unknown;
}

/**
 * Maps anything thrown by the driver onto a `PumkError`, or returns null when
 * the failure is not one this module can explain. A null answer means the
 * caller must rethrow the original: inventing a domain code for an unknown
 * fault would hide a real bug behind a business-sounding message.
 */
export function terjemahkanKesalahanDb(err: unknown): PumkError | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as KesalahanDb;
  const pesan = typeof e.message === "string" ? e.message : "";
  const constraint = typeof e.constraint === "string" ? e.constraint : "";

  for (const [prefiks, kode] of Object.entries(PETA_KODE_TRIGGER)) {
    if (pesan.startsWith(prefiks) || pesan.includes(`${prefiks}:`)) {
      return tolak(kode, {}, pesan);
    }
  }
  if (constraint && PETA_CONSTRAINT[constraint]) {
    return tolak(PETA_CONSTRAINT[constraint], {}, pesan);
  }
  // bun:sql does not always populate `constraint`, so the name is also looked
  // for in the message text. Still a NAME match, never prose.
  for (const [nama, kode] of Object.entries(PETA_CONSTRAINT)) {
    if (pesan.includes(`"${nama}"`)) return tolak(kode, {}, pesan);
  }
  return null;
}

/**
 * Wraps a unit of work so no driver text can escape. Domain errors pass
 * through untouched; unexplainable faults are rethrown as-is, loudly, because
 * a corrupt receivable is worse than a 500.
 */
export async function bersihkanKesalahan<T>(jalankan: () => Promise<T>): Promise<T> {
  try {
    return await jalankan();
  } catch (err) {
    if (err instanceof PumkError) throw err;
    const domain = terjemahkanKesalahanDb(err);
    if (domain) throw domain;
    throw err;
  }
}

/** The raw text of a collaborator's failure, for `penyebabDb` and nowhere else. */
export function penyebab(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
