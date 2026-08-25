// Translation layer: a database refusal becomes a domain rejection.
//
// Same job, same shape and same reasoning as modules/closing/kesalahan.ts,
// modules/nonpumk/kesalahan.ts, modules/pumk/kesalahan.ts and
// modules/jurnal/kesalahan.ts.
//
// migrations/0012 puts the two rules that matter most in Postgres:
//
//   trg_rka_detail_10_dimensi raises
//     'TJSL-RKA-001: baris RKA PUMK wajib punya sektor_id'
//     'TJSL-RKA-002: baris RKA Non PUMK wajib punya bidang_id'
//     'TJSL-RKA-003: baris RKA Keuangan wajib punya akun_id'
//   and two partial unique indexes carry the version rules:
//     rka_versi_uq     one row per (bumn, cabang, tahun, jenis, versi)
//     rka_baseline_uq  AT MOST ONE DISETUJUI row per (bumn, cabang, tahun, jenis)
//
// None of that text may reach a caller, an HTTP body or a log line a finance
// user reads. The engine validates FIRST and expects to be the one rejecting;
// when the database refuses anyway (two approvals racing for the same
// baseline) the refusal is mapped onto the same `RkaError` code and the raw
// text is kept in `penyebabDb`, for the server log only.
//
// MAPPING IS ON THE TRIGGER'S OWN CODE PREFIX AND ON THE CONSTRAINT NAME,
// never on prose: the trigger messages are Indonesian and will be reworded,
// `TJSL-RKA-001` and `err.constraint` will not.
//
// READ THE SQLSTATE FROM BOTH DRIVER SHAPES. `bun:sql` (the fixtures' port)
// puts it in `err.errno`; node-postgres (core/adapters/db.ts, i.e. the running
// server) puts it in `err.code`, and `err.code` on a `bun:sql` error is not a
// SQLSTATE at all. An earlier version of a sibling module read only `errno`,
// which left a whole branch dead in production while every test stayed green.
//
// The message catalogue is keyed with plain string literals rather than
// `[KODE_RKA.X]:` for the same reason the sibling modules' are: ./contract.ts
// imports ./service.ts, which imports this file, so reading `KODE_RKA` at
// module-evaluation time here would touch a binding still in its temporal dead
// zone. Every reference to it lives inside a function body.
import { RkaError, type KodeRka } from "./contract";

/** User-facing Indonesian prose, one per code. Free of any driver internals. */
const PESAN: Record<KodeRka, string> = {
  RKA_TIDAK_DITEMUKAN: "RKA yang diminta tidak ditemukan.",
  BASELINE_TIDAK_ADA:
    "Belum ada RKA yang disetujui untuk tahun, jenis dan cabang ini, jadi belum ada pembanding untuk laporan. Setujui dulu satu versi.",
  VERSI_TIDAK_DITEMUKAN: "Versi RKA yang diminta tidak ada untuk tahun dan jenis ini.",
  PERIODE_TIDAK_DITEMUKAN: "Periode akuntansi untuk bulan yang diminta tidak ditemukan.",
  AKUN_TIDAK_DITEMUKAN: "Akun yang dipakai di baris anggaran tidak ditemukan.",
  SEKTOR_TIDAK_DITEMUKAN: "Sektor yang dipakai di baris anggaran tidak ditemukan.",
  BIDANG_TIDAK_DITEMUKAN: "Bidang yang dipakai di baris anggaran tidak ditemukan.",

  RKA_SUDAH_DISETUJUI:
    "RKA yang sudah disetujui tidak bisa diubah. Buat revisi, yang akan menjadi versi baru dan meninggalkan versi lama tetap utuh.",
  RKA_BUKAN_DRAFT: "Hanya RKA berstatus DRAFT yang bisa disetujui.",
  REVISI_HARUS_DARI_DISETUJUI:
    "Revisi hanya bisa dibuat dari versi yang sudah disetujui. Versi yang masih DRAFT cukup diubah langsung.",
  REVISI_MASIH_TERBUKA:
    "Masih ada revisi berstatus DRAFT untuk tahun, jenis dan cabang ini. Selesaikan atau setujui dulu revisi tersebut.",
  VERSI_GANDA:
    "Versi RKA dengan nomor yang sama sudah ada untuk tahun, jenis dan cabang ini. Muat ulang datanya lalu coba lagi.",
  BASELINE_GANDA:
    "Sudah ada RKA lain yang disetujui untuk tahun, jenis dan cabang ini. Muat ulang datanya lalu coba lagi.",

  DIMENSI_TIDAK_SESUAI_JENIS:
    "Baris anggaran tidak memakai dimensi yang sesuai jenis RKA-nya: RKA PUMK per sektor, RKA Non PUMK per bidang, RKA Keuangan per akun.",
  BARIS_DUPLIKAT: "Ada dua baris anggaran untuk dimensi dan bulan yang sama.",
  BULAN_TIDAK_VALID: "Bulan anggaran harus antara 1 sampai 12, atau kosong untuk angka tahunan.",
  TAHUN_TIDAK_VALID: "Tahun anggaran tidak valid.",
  AKUN_TIDAK_DAPAT_DIANGGARKAN:
    "Akun ini tidak bisa dipakai di RKA Keuangan. Yang bisa dianggarkan adalah akun beban dan akun pendapatan yang boleh diposting.",
  NILAI_BUKAN_DESIMAL:
    "Nilai uang harus desimal dengan dua angka di belakang koma, misalnya 1500000.00.",
  NILAI_NEGATIF: "Jumlah anggaran tidak boleh negatif.",
  UNIT_TIDAK_VALID: "Jumlah unit target tidak boleh negatif.",

  SKEMA_BELUM_LENGKAP:
    "Angka realisasi untuk periode yang sudah ditutup belum bisa dibaca dari data beku, sehingga laporannya tidak akan bisa direkonstruksi lagi nanti. Laporan dihentikan alih alih menyajikan angka yang tidak bisa dipertanggungjawabkan.",
  SALDO_PERIODE_TIDAK_ADA:
    "Periode ini sudah ditutup tetapi saldo bekunya tidak ada, jadi realisasinya tidak bisa dibaca. Periksa proses closing periode tersebut.",

  KONFIGURASI_TIDAK_ADA:
    "Parameter konfigurasi yang dibutuhkan belum ada. Lengkapi dulu konfigurasinya.",
  KONFIGURASI_TIDAK_VALID:
    "Nilai parameter konfigurasi tidak valid, jadi proses dihentikan alih alih memakai nilai tebakan.",

  TIDAK_BERWENANG: "Pengguna ini tidak punya wewenang untuk tindakan RKA tersebut.",
  CABANG_DILUAR_SCOPE: "Data ini berada di cabang di luar wewenang pengguna.",
  KONFLIK_MAKER_APPROVER:
    "Penyusun RKA ini tidak boleh sekaligus menyetujuinya. Mintakan persetujuan ke pengguna lain.",
  IZIN_BELUM_TERDAFTAR:
    "Kewenangan untuk tindakan ini belum terdaftar di katalog izin, jadi tindakan ditolak sampai kewenangannya ditambahkan.",
};

/** Builds the module's only error type, with the catalogue message. */
export function tolak(
  kode: KodeRka,
  detail: Record<string, unknown> = {},
  penyebabDb?: string,
): RkaError {
  return new RkaError(kode, PESAN[kode], detail, penyebabDb);
}

/**
 * A configuration refusal that NAMES THE KEY in the user-facing message.
 *
 * Not a leak: `rka.pemisahan_tugas_persetujuan` is a parameter an operator
 * edits in the Konfigurasi screen, not a database internal. A refusal that says
 * only "a parameter is missing" leaves the operator with nothing to act on,
 * which is how a fail-closed guard turns into a permanent outage nobody can
 * diagnose.
 */
export function tolakKonfigurasi(
  kode: "KONFIGURASI_TIDAK_ADA" | "KONFIGURASI_TIDAK_VALID",
  grup: string,
  kunci: string,
  masalah?: string,
): RkaError {
  const kunciPenuh = `${grup}.${kunci}`;
  const pesan =
    kode === "KONFIGURASI_TIDAK_ADA"
      ? `Parameter konfigurasi ${kunciPenuh} belum ada. Lengkapi dulu konfigurasinya sebelum menjalankan tindakan ini.`
      : `Nilai parameter konfigurasi ${kunciPenuh} tidak valid${masalah ? `: ${masalah}` : ""}. Proses dihentikan alih alih memakai nilai tebakan.`;
  return new RkaError(kode, pesan, { grup, kunci, masalah: masalah ?? null });
}

/**
 * A fail-closed refusal that NAMES THE PERMISSION the catalogue is missing.
 *
 * Same reasoning as `tolakKonfigurasi`: an administrator who is told only "you
 * are not authorised" will look for a role to grant, find nothing, and
 * conclude the feature is broken. Naming the code turns a dead end into a
 * one-line change in modules/auth/permissions.ts.
 */
export function tolakIzinBelumTerdaftar(kode: string): RkaError {
  return new RkaError(
    "IZIN_BELUM_TERDAFTAR",
    `Kewenangan "${kode}" belum terdaftar di katalog izin, jadi tindakan ini ditolak sampai kewenangannya ditambahkan.`,
    { permission: kode },
  );
}

// ---------------------------------------------------------------------------
// Driver error mapping
// ---------------------------------------------------------------------------

/** SQLSTATE, read from both driver shapes. See the file header. */
function sqlstate(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { errno?: unknown; code?: unknown };
  const dariBun = typeof e.errno === "string" ? e.errno : null;
  const dariPg = typeof e.code === "string" ? e.code : null;
  // A SQLSTATE is exactly five alphanumerics. node-postgres puts one in
  // `code`; bun:sql puts a driver name there, which this filter rejects.
  for (const kandidat of [dariBun, dariPg]) {
    if (kandidat && /^[0-9A-Z]{5}$/.test(kandidat)) return kandidat;
  }
  return null;
}

function namaConstraint(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { constraint?: unknown; constraint_name?: unknown };
  if (typeof e.constraint === "string") return e.constraint;
  if (typeof e.constraint_name === "string") return e.constraint_name;
  return null;
}

function pesanMentah(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Maps a driver refusal onto a domain code, or returns null when the failure
 * is not one this module recognises. A caller that gets null must rethrow:
 * swallowing an unknown database error while writing a budget version is how
 * half a revision gets committed.
 */
export function petakanKesalahanDb(err: unknown): RkaError | null {
  const mentah = pesanMentah(err);
  const state = sqlstate(err);
  const constraint = namaConstraint(err);

  // The dimension trigger, matched on its own stable code prefix. All three
  // map to one domain code: the caller's mistake is the same shape whichever
  // budget type it was, and the message names all three rules.
  if (/TJSL-RKA-00[123]/.test(mentah)) {
    return tolak("DIMENSI_TIDAK_SESUAI_JENIS", {}, mentah);
  }

  if (constraint === "rka_baseline_uq") return tolak("BASELINE_GANDA", { constraint }, mentah);
  if (constraint === "rka_versi_uq") return tolak("VERSI_GANDA", { constraint }, mentah);
  if (constraint === "rka_disetujui_ck") {
    // approved_by / approved_at missing on a DISETUJUI row is a bug in this
    // module, not an operator problem; it must still not leak a constraint
    // name to the screen.
    return tolak("RKA_BUKAN_DRAFT", { constraint }, mentah);
  }

  // 23503 foreign_key_violation on a dimension row that vanished.
  if (state === "23503") {
    if (/sektor/.test(mentah)) return tolak("SEKTOR_TIDAK_DITEMUKAN", {}, mentah);
    if (/bidang/.test(mentah)) return tolak("BIDANG_TIDAK_DITEMUKAN", {}, mentah);
    if (/akun/.test(mentah)) return tolak("AKUN_TIDAK_DITEMUKAN", {}, mentah);
    if (/rka/.test(mentah)) return tolak("RKA_TIDAK_DITEMUKAN", {}, mentah);
  }

  return null;
}
