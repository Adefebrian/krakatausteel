// Translation layer: a database refusal becomes a domain rejection.
//
// Same job, same shape and same reasoning as modules/pumk/kesalahan.ts,
// modules/jurnal/kesalahan.ts and modules/angsuran/kesalahan.ts.
// migrations/0009 puts the segregation rules, the disbursement ceiling and the
// LPJ reconciliation in Postgres, so the last line of defence raises text like
//   'TJSL-SOD-001: user 9f2c... adalah maker proposal ini ...'
//   'TJSL-NPK-002: total penyaluran (...) melebihi nilai disetujui (...)'
//   'duplicate key value violates unique constraint "nonpumk_lpj_proposal_uq"'
// which names triggers, constraints and SQLSTATEs. That text must never reach
// a caller, an HTTP body or a log line a finance user reads. The engine
// validates first and EXPECTS to be the one rejecting; when the database
// refuses anyway (a real race between two concurrent termin), the refusal is
// mapped onto the same `NonPumkError` code and the raw text is kept in
// `penyebabDb`, for the server log only.
//
// BOTH NPK TRIGGERS ARE DEFERRED and fire at COMMIT, which makes the point
// sharper rather than softer: by then the transaction is unwindable only as a
// whole and the caller has no idea which of several writes offended. So the
// mapping below is a backstop for a race, never a validator.
//
// MAPPING IS ON THE TRIGGER'S OWN CODE PREFIX AND ON THE CONSTRAINT NAME,
// never on prose: trigger messages are Indonesian and will be reworded,
// `TJSL-NPK-002` and `err.constraint` will not.
//
// The message catalogue is keyed with plain string literals rather than
// `[KODE_NONPUMK.X]:` for the same reason the sibling modules' are:
// ./contract.ts imports ./service.ts, which imports this file, so reading
// `KODE_NONPUMK` at module-evaluation time here would touch a binding still in
// its temporal dead zone. Every reference to it lives inside a function body.
import { NonPumkError, type KodeNonPumk } from "./contract";

/** User-facing Indonesian prose, one per code. Free of any driver internals. */
const PESAN: Record<KodeNonPumk, string> = {
  PROPOSAL_TIDAK_DITEMUKAN: "Proposal Non PUMK tidak ditemukan.",
  BIDANG_TIDAK_DITEMUKAN: "Bidang Non PUMK tidak ditemukan untuk BUMN ini.",
  SDG_TIDAK_DITEMUKAN: "Salah satu SDG yang dipilih tidak ditemukan.",
  PENYALURAN_TIDAK_DITEMUKAN: "Termin penyaluran tidak ditemukan.",
  LPJ_TIDAK_DITEMUKAN: "Laporan pertanggungjawaban belum ada untuk proposal ini.",

  TRANSISI_TIDAK_VALID:
    "Tindakan ini tidak tersedia dari status proposal saat ini. Periksa kembali tahapan proposal di halaman detail.",
  STATUS_TERMINAL:
    "Proposal ini sudah berada di tahap akhir dan tidak bisa diproses lagi. Buat proposal baru bila memang diperlukan.",
  CATATAN_WAJIB: "Catatan atau alasan wajib diisi untuk tindakan ini.",

  NILAI_DILUAR_BATAS:
    "Nilai bantuan berada di luar batas yang dikonfigurasi untuk program Non PUMK.",
  SDG_WAJIB: "Proposal wajib dipetakan ke minimal satu SDG.",
  SDG_DUPLIKAT: "Ada SDG yang dipilih lebih dari satu kali. Pilih setiap SDG paling banyak sekali.",
  BOBOT_SDG_TIDAK_VALID:
    "Bobot SDG harus lebih besar dari nol dan paling besar satu, dengan paling banyak enam angka di belakang koma.",
  PENERIMA_MANFAAT_WAJIB:
    "Jumlah penerima manfaat wajib diisi dengan bilangan bulat nol atau lebih.",
  NILAI_BUKAN_DESIMAL:
    "Nilai uang harus desimal dengan dua angka di belakang koma, misalnya 1500000.00.",
  TANGGAL_TIDAK_VALID: "Tanggal tidak valid. Format yang dipakai adalah YYYY-MM-DD.",

  PENILAIAN_BELUM_ADA: "Proposal ini belum punya hasil penilaian untuk direview.",
  SKOR_DIBAWAH_MINIMUM:
    "Skor penilaian berada di bawah ambang minimum kelulusan yang dikonfigurasi.",
  KEPUTUSAN_TIDAK_VALID: "Keputusan yang dikirim tidak dikenali untuk tahapan ini.",
  NILAI_DISETUJUI_WAJIB:
    "Persetujuan wajib menyebut nilai yang disetujui, karena nilai itulah pagu penyalurannya.",
  NILAI_DISETUJUI_MELEBIHI_PENGAJUAN:
    "Nilai yang disetujui tidak boleh melebihi nilai yang diajukan. Approver boleh memotong, bukan menaikkan.",

  PLAFON_PENYALURAN_TERLAMPAUI:
    "Termin ini membuat total penyaluran melebihi nilai yang disetujui.",
  BELUM_DISETUJUI: "Proposal ini belum disetujui, jadi belum ada pagu untuk disalurkan.",
  TERMIN_SUDAH_ADA: "Nomor termin ini sudah terpakai pada proposal tersebut.",
  AKUN_KAS_TIDAK_VALID: "Akun kas yang dipilih tidak ditemukan, tidak aktif, atau bukan akun kas.",
  AKUN_BEBAN_TIDAK_VALID:
    "Akun beban yang dipilih tidak ditemukan, tidak aktif, atau bukan akun beban yang bisa diposting.",

  LPJ_SUDAH_DIAJUKAN: "Laporan pertanggungjawaban untuk proposal ini sudah diajukan.",
  LPJ_BELUM_DIAJUKAN: "Laporan pertanggungjawaban untuk proposal ini belum diajukan.",
  REALISASI_MELEBIHI_PENYALURAN:
    "Nilai realisasi tidak boleh melebihi total dana yang benar benar disalurkan.",
  LPJ_TIDAK_REKONSILIASI:
    "Realisasi ditambah sisa yang dikembalikan harus sama dengan total dana yang disalurkan.",

  JURNAL_GAGAL: "Jurnal untuk transaksi ini gagal dibuat, jadi seluruh langkah dibatalkan.",

  TIDAK_BERWENANG: "Pengguna ini tidak punya wewenang untuk tindakan tersebut pada program Non PUMK.",
  CABANG_DILUAR_SCOPE: "Data ini berada di cabang di luar wewenang pengguna.",
  KONFLIK_MAKER_CHECKER: "Pembuat proposal tidak boleh menjadi checker atas proposalnya sendiri.",
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
  kode: KodeNonPumk,
  detail: Record<string, unknown> = {},
  penyebabDb?: string,
): NonPumkError {
  return new NonPumkError(kode, PESAN[kode], detail, penyebabDb);
}

/**
 * A configuration refusal that NAMES THE KEY in the user-facing message.
 *
 * Not cosmetic and not a leak: `batasan.batas_hari_lpj_non_pumk` is a
 * parameter an operator edits in the konfigurasi screen, not a database
 * internal. A refusal that says only "a parameter is missing" leaves the
 * operator with nothing to act on, which is how a fail-closed guard turns into
 * a permanent outage nobody can diagnose.
 */
export function tolakKonfigurasi(
  kode: "KONFIGURASI_TIDAK_ADA" | "KONFIGURASI_TIDAK_VALID",
  grup: string,
  kunci: string,
  nilai?: string,
): NonPumkError {
  const jalur = `${grup}.${kunci}`;
  return new NonPumkError(kode, `${PESAN[kode]} Parameter: ${jalur}.`, { kunci: jalur, nilai });
}

/**
 * Trigger codes from migrations/0009_nonpumk.sql (and the shared SOD functions
 * defined in 0008), mapped onto the domain code the engine would have raised
 * itself. Every one of these is a BACKSTOP: the engine refuses first, and a
 * refusal that reaches here is a race, not an ordinary rejection.
 */
const PETA_KODE_TRIGGER: Record<string, KodeNonPumk> = {
  "TJSL-SOD-001": "KONFLIK_MAKER_CHECKER",
  "TJSL-SOD-002": "KONFLIK_CHECKER_APPROVER",
  "TJSL-NPK-001": "BELUM_DISETUJUI",
  "TJSL-NPK-002": "PLAFON_PENYALURAN_TERLAMPAUI",
  "TJSL-NPK-003": "LPJ_TIDAK_REKONSILIASI",
  "TJSL-JRN-015": "JURNAL_GAGAL",
};

/** Constraint names, for the refusals that are declarative rather than raised. */
const PETA_CONSTRAINT: Record<string, KodeNonPumk> = {
  nonpumk_proposal_sdg_pkey: "SDG_DUPLIKAT",
  nonpumk_proposal_sdg_bobot_check: "BOBOT_SDG_TIDAK_VALID",
  nonpumk_proposal_sdg_sdg_id_fkey: "SDG_TIDAK_DITEMUKAN",
  nonpumk_proposal_bidang_id_fkey: "BIDANG_TIDAK_DITEMUKAN",
  nonpumk_proposal_no_uq: "TRANSISI_TIDAK_VALID",
  nonpumk_proposal_jumlah_diajukan_check: "NILAI_DILUAR_BATAS",
  nonpumk_proposal_jumlah_disetujui_check: "NILAI_DILUAR_BATAS",
  nonpumk_proposal_penerima_manfaat_estimasi_check: "PENERIMA_MANFAAT_WAJIB",
  nonpumk_penilaian_proposal_uq: "PENILAIAN_BELUM_ADA",
  nonpumk_approval_setuju_ck: "NILAI_DISETUJUI_WAJIB",
  nonpumk_penyaluran_termin_uq: "TERMIN_SUDAH_ADA",
  nonpumk_penyaluran_jumlah_check: "NILAI_DILUAR_BATAS",
  nonpumk_penyaluran_akun_kas_id_fkey: "AKUN_KAS_TIDAK_VALID",
  nonpumk_penyaluran_akun_beban_id_fkey: "AKUN_BEBAN_TIDAK_VALID",
  nonpumk_penyaluran_jurnal_fk: "JURNAL_GAGAL",
  nonpumk_lpj_proposal_uq: "LPJ_SUDAH_DIAJUKAN",
  nonpumk_lpj_jumlah_realisasi_check: "REALISASI_MELEBIHI_PENYALURAN",
  nonpumk_lpj_jumlah_sisa_dikembalikan_check: "REALISASI_MELEBIHI_PENYALURAN",
  nonpumk_lpj_penerima_manfaat_aktual_check: "PENERIMA_MANFAAT_WAJIB",
  nonpumk_lpj_verifikasi_ck: "LPJ_BELUM_DIAJUKAN",
  nonpumk_lpj_jurnal_pengembalian_fk: "JURNAL_GAGAL",
};

interface KesalahanDb {
  message?: unknown;
  constraint?: unknown;
}

/**
 * Maps anything thrown by the driver onto a `NonPumkError`, or returns null
 * when the failure is not one this module can explain. A null answer means the
 * caller must rethrow the original: inventing a domain code for an unknown
 * fault would hide a real bug behind a business-sounding message.
 */
export function terjemahkanKesalahanDb(err: unknown): NonPumkError | null {
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
 * a corrupt grant ledger is worse than a 500.
 */
export async function bersihkanKesalahan<T>(jalankan: () => Promise<T>): Promise<T> {
  try {
    return await jalankan();
  } catch (err) {
    if (err instanceof NonPumkError) throw err;
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
