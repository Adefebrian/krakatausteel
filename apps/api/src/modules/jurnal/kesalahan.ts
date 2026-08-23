// Translation layer: a database refusal becomes a domain rejection.
//
// WHY THIS FILE EXISTS AT ALL
// ADR 0002 puts the accounting invariants in Postgres, so the LAST line of
// defence raises text like
//   'TJSL-JRN-031: jurnal UMUM/202602/00007 tidak balance: total debit ...'
// or a bare unique-index failure. That text names triggers, constraints and
// SQLSTATEs; it must never reach a caller, an HTTP body, or a log line a
// finance user reads. The engine validates first and expects to be the one
// rejecting; when the DB still refuses (a race, a deferred trigger firing at
// COMMIT, a path the engine has not thought of), this file maps the refusal
// onto the same `JurnalError` code the engine would have produced, keeps the
// raw text in `penyebabDb` for the server log, and hands the caller a sentence.
//
// MAPPING IS ON SQLSTATE + THE TRIGGER'S OWN CODE PREFIX, never on prose.
// Trigger messages are Indonesian and will be reworded; `TJSL-JRN-031` and
// `errno`/`constraint` will not.
//
// The message catalogue below is keyed with plain string literals rather than
// `[KODE_JURNAL.X]:`. That is not a style choice: ./contract.ts imports the
// engine (which imports this file), so reading `KODE_JURNAL` at module
// evaluation time here would touch a binding that is still in its temporal
// dead zone. Every reference to it lives inside a function body.
import { JurnalError, type KodeJurnal } from "./contract";

/** User-facing Indonesian prose, one per code. Free of any driver internals. */
const PESAN: Record<KodeJurnal, string> = {
  PERIODE_TIDAK_OPEN:
    "Tanggal transaksi tidak berada di periode yang masih terbuka. Koreksi periode lampau dibuat sebagai jurnal pembalik di periode terbuka.",
  MINIMAL_DUA_BARIS: "Jurnal harus punya minimal dua baris.",
  SATU_SISI_PER_BARIS:
    "Setiap baris jurnal harus mengisi debit atau kredit, tidak keduanya dan tidak nol di keduanya.",
  NILAI_NEGATIF: "Nilai jurnal tidak boleh negatif. Balikkan sisi debit atau kreditnya.",
  TIDAK_BALANCE: "Jumlah debit dan jumlah kredit harus sama persis, tanpa toleransi.",
  AKUN_TIDAK_VALID:
    "Ada akun yang tidak ditemukan, tidak aktif, atau bukan akun yang bisa dijurnal (akun induk tidak bisa dipakai).",
  CABANG_DILUAR_SCOPE: "Cabang di header jurnal berada di luar wewenang pengguna ini.",
  DIMENSI_PIUTANG_SALAH_AKUN:
    "Baris yang memuat Mitra Binaan atau akad hanya boleh memakai akun piutang pinjaman mitra binaan.",
  NOMOR_JURNAL_DUPLIKAT: "Nomor jurnal sudah terpakai. Ulangi penyimpanan agar nomor baru diambil.",
  NILAI_BUKAN_DESIMAL:
    "Nilai uang harus desimal dengan dua angka di belakang koma, misalnya 1500000.00.",

  JURNAL_TIDAK_DITEMUKAN: "Jurnal tidak ditemukan.",
  JURNAL_TIDAK_DRAFT:
    "Jurnal ini tidak berstatus DRAFT, jadi tidak bisa diubah, dihapus, atau diposting. Koreksi lewat jurnal pembalik.",
  JURNAL_BELUM_POSTED: "Jurnal belum diposting, jadi tidak bisa dibalik. Hapus draftnya saja.",
  JURNAL_SUDAH_REVERSED: "Jurnal ini sudah pernah dibalik.",
  POSTING_BENTROK: "Jurnal ini sedang diposting oleh permintaan lain. Muat ulang untuk melihat hasilnya.",
  BATCH_GAGAL: "Satu jurnal dalam batch tidak sah, jadi tidak ada satu pun yang diposting.",

  TIDAK_BERWENANG: "Pengguna ini tidak punya wewenang untuk tindakan tersebut pada jurnal.",
  MAKER_TIDAK_BOLEH_CHECKER: "Pembuat jurnal tidak boleh memverifikasi jurnalnya sendiri.",

  ALASAN_WAJIB: "Alasan pembalikan wajib diisi.",
  TIDAK_ADA_PERIODE_OPEN: "Tidak ada periode yang terbuka, jadi jurnal pembalik tidak bisa ditanggali.",
  PEMBALIK_STATE_BISNIS_TIDAK_TERDAFTAR:
    "Jurnal ini berasal dari peristiwa bisnis yang belum punya pembalik state bisnis, jadi pembalikan ditolak agar data tidak setengah jadi.",

  EVENT_MAPPING_TIDAK_DITEMUKAN:
    "Pemetaan jurnal untuk event ini tidak ada atau tidak aktif. Lengkapi dulu pemetaan akunnya.",
  EVENT_PAYLOAD_TIDAK_LENGKAP:
    "Event ini menuntut akun yang ditentukan saat transaksi, dan akun itu tidak disertakan.",

  KAS_BANK_TANPA_AKUN_KAS: "Jurnal Kas Bank harus memakai akun kas atau bank di salah satu sisinya.",
  PINBUK_AKUN_SALAH: "Jurnal Pinbuk harus memakai akun beban pembinaan kemitraan sesuai pemetaan.",
  PINBUK_TANPA_TAUTAN: "Jurnal Pinbuk harus ditautkan ke Mitra Binaan atau ke Cluster.",
  PINBUK_KATEGORI_TIDAK_VALID:
    "Kategori kegiatan Pinbuk wajib diisi dan harus salah satu kategori yang dikonfigurasi.",
};

/** Builds the module's only error type, with the catalogue message. */
export function tolak(
  kode: KodeJurnal,
  detail: Record<string, unknown> = {},
  penyebabDb?: string,
): JurnalError {
  return new JurnalError(kode, PESAN[kode], detail, penyebabDb);
}

/**
 * Type guard, so ./service.ts can recognise a domain rejection without
 * importing a runtime binding from ./contract.ts (which imports the engine and
 * would therefore be mid-evaluation). Same reason as the catalogue above.
 */
export function adalahJurnalError(err: unknown): err is JurnalError {
  return err instanceof JurnalError;
}

/**
 * Trigger codes from migrations/0010_jurnal.sql, mapped to the domain code the
 * engine would have raised itself. Values are plain literals, checked against
 * `KodeJurnal` by the Record type.
 */
const PETA_KODE_TRIGGER: Record<string, KodeJurnal> = {
  "TJSL-JRN-001": "CABANG_DILUAR_SCOPE",
  "TJSL-JRN-002": "PERIODE_TIDAK_OPEN",
  "TJSL-JRN-003": "PERIODE_TIDAK_OPEN",
  "TJSL-JRN-004": "PERIODE_TIDAK_OPEN",
  "TJSL-JRN-010": "JURNAL_TIDAK_DRAFT",
  "TJSL-JRN-011": "JURNAL_TIDAK_DRAFT",
  "TJSL-JRN-012": "JURNAL_TIDAK_DRAFT",
  "TJSL-JRN-013": "JURNAL_TIDAK_DRAFT",
  "TJSL-JRN-014": "JURNAL_TIDAK_DRAFT",
  "TJSL-JRN-020": "AKUN_TIDAK_VALID",
  "TJSL-JRN-030": "MINIMAL_DUA_BARIS",
  "TJSL-JRN-031": "TIDAK_BALANCE",
  "TJSL-JRN-032": "TIDAK_BALANCE",
};

/** Constraint names, for the refusals that are declarative rather than raised. */
const PETA_CONSTRAINT: Record<string, KodeJurnal> = {
  jurnal_no_uq: "NOMOR_JURNAL_DUPLIKAT",
  jurnal_baris_satu_sisi_ck: "SATU_SISI_PER_BARIS",
  jurnal_baris_akun_id_fkey: "AKUN_TIDAK_VALID",
  jurnal_reversal_of_uq: "JURNAL_SUDAH_REVERSED",
  jurnal_reversed_by_uq: "JURNAL_SUDAH_REVERSED",
};

interface KesalahanDb {
  message?: unknown;
  errno?: unknown;
  constraint?: unknown;
}

/** SQLSTATEs that mean "a lock could not be taken / the row moved under us". */
const SQLSTATE_KONKURENSI = new Set(["40001", "40P01", "55P03"]);

/**
 * Maps anything thrown by the driver onto a `JurnalError`, or returns null when
 * the failure is not one this module can explain. A null answer means the
 * caller must rethrow the original: inventing a domain code for an unknown
 * fault would hide a real bug behind a business-sounding message.
 */
export function terjemahkanKesalahanDb(err: unknown): JurnalError | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as KesalahanDb;
  const pesan = typeof e.message === "string" ? e.message : "";
  const sqlstate = typeof e.errno === "string" ? e.errno : "";
  const constraint = typeof e.constraint === "string" ? e.constraint : "";

  for (const [prefiks, kode] of Object.entries(PETA_KODE_TRIGGER)) {
    if (pesan.startsWith(prefiks)) return tolak(kode, {}, pesan);
  }
  if (constraint && PETA_CONSTRAINT[constraint]) {
    return tolak(PETA_CONSTRAINT[constraint], {}, pesan);
  }
  // A foreign key failure on a journal line can only be the akun_id -> postable
  // account key (ADR 0003): a header account has no postable key to point at.
  if (sqlstate === "23503" && /jurnal_baris/.test(constraint)) {
    return tolak("AKUN_TIDAK_VALID", {}, pesan);
  }
  if (SQLSTATE_KONKURENSI.has(sqlstate)) {
    return tolak("POSTING_BENTROK", {}, pesan);
  }
  return null;
}

/**
 * Wraps a unit of work so no driver text can escape. Domain errors pass
 * through untouched; unexplainable faults are rethrown as-is, loudly, because
 * a corrupt ledger is worse than a 500.
 */
export async function bersihkanKesalahan<T>(jalankan: () => Promise<T>): Promise<T> {
  try {
    return await jalankan();
  } catch (err) {
    if (err instanceof JurnalError) throw err;
    const domain = terjemahkanKesalahanDb(err);
    if (domain) throw domain;
    throw err;
  }
}
