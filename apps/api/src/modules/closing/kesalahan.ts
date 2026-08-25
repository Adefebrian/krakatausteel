// Translation layer: a database refusal becomes a domain rejection.
//
// Same job, same shape and same reasoning as modules/pumk/kesalahan.ts,
// modules/nonpumk/kesalahan.ts, modules/jurnal/kesalahan.ts and
// modules/angsuran/kesalahan.ts.
//
// migrations/0007 puts the two period rules that matter most in Postgres, as a
// BEFORE UPDATE trigger on `periode`, so the last line of defence raises text
// like
//   'TJSL-PER-001: tidak bisa closing 2026-3: masih ada 1 periode sebelumnya yang belum CLOSED'
//   'TJSL-PER-002: tidak bisa reopen 2026-1: ada 2 periode CLOSED yang lebih baru; ...'
//   'TJSL-PER-003: reopen periode wajib menyertakan alasan_reopen'
//   'TJSL-JRN-004: ... periode ... sudah CLOSED'
// and migrations/0011 adds constraint names like
// `kolektibilitas_snapshot_uq` and `penyisihan_periode_beban_ck`. None of that
// may reach a caller, an HTTP body or a log line a finance user reads. The
// engine validates FIRST and expects to be the one rejecting; when the database
// refuses anyway (a real race between two closings, or a snapshot written twice
// by two concurrent runs) the refusal is mapped onto the same `ClosingError`
// code and the raw text is kept in `penyebabDb`, for the server log only.
//
// MAPPING IS ON THE TRIGGER'S OWN CODE PREFIX AND ON THE CONSTRAINT NAME,
// never on prose: the trigger messages are Indonesian and will be reworded,
// `TJSL-PER-001` and `err.constraint` will not.
//
// READ THE SQLSTATE FROM BOTH DRIVER SHAPES. `bun:sql` (the fixtures' port)
// puts it in `err.errno`; node-postgres (core/adapters/db.ts, i.e. the running
// server) puts it in `err.code`, and `err.code` on a `bun:sql` error is not a
// SQLSTATE at all. An earlier version of a sibling module read only `errno`,
// which left a whole branch dead in production while every test stayed green.
//
// The message catalogue is keyed with plain string literals rather than
// `[KODE_CLOSING.X]:` for the same reason the sibling modules' are:
// ./contract.ts imports ./service.ts, which imports this file, so reading
// `KODE_CLOSING` at module-evaluation time here would touch a binding still in
// its temporal dead zone. Every reference to it lives inside a function body.
import { ClosingError, type KodeClosing } from "./contract";

/** User-facing Indonesian prose, one per code. Free of any driver internals. */
const PESAN: Record<KodeClosing, string> = {
  PERIODE_TIDAK_DITEMUKAN: "Periode akuntansi tidak ditemukan.",
  CABANG_TIDAK_DITEMUKAN: "Cabang tidak ditemukan untuk BUMN ini.",
  AKAD_TIDAK_DITEMUKAN: "Akad tidak ditemukan.",

  PERIODE_TIDAK_OPEN:
    "Langkah closing ini hanya bisa dijalankan selama periodenya masih OPEN. Buka kembali periode itu lebih dulu bila memang perlu diulang.",
  PERIODE_SUDAH_CLOSED: "Periode ini sudah ditutup.",
  PERIODE_BELUM_CLOSED: "Periode ini belum pernah ditutup, jadi tidak ada yang bisa dibuka kembali.",
  URUTAN_PERIODE:
    "Periode harus ditutup berurutan. Masih ada periode sebelumnya yang belum ditutup.",
  REOPEN_BUKAN_PERIODE_TERAKHIR:
    "Hanya periode terakhir yang ditutup yang boleh dibuka kembali. Buka periode yang lebih baru lebih dulu, satu per satu.",
  ALASAN_WAJIB: "Membuka kembali periode wajib menyertakan alasan tertulis.",
  REOPEN_TIDAK_DIIZINKAN:
    "Membuka kembali periode sedang dimatikan lewat konfigurasi akuntansi.",

  PRASYARAT_GAGAL:
    "Closing periode ditolak karena ada prasyarat yang belum terpenuhi. Periksa daftar prasyarat dan selesaikan yang bertanda gagal.",
  KONFIRMASI_KAS_NEGATIF_WAJIB:
    "Saldo kas dan setara kas di periode ini negatif. Closing tetap bisa dilanjutkan, tetapi kondisi ini wajib dikonfirmasi lebih dulu.",

  KOLEKTIBILITAS_BELUM_DIJALANKAN:
    "Closing kolektibilitas periode ini belum dijalankan, jadi langkah ini belum punya dasar perhitungan.",
  RANGE_KOLEKTIBILITAS_TIDAK_LENGKAP:
    "Ada jumlah hari tunggakan yang tidak tercakup satu pun rentang kolektibilitas yang dikonfigurasi. Lengkapi dulu rentangnya alih alih memakai klasifikasi tebakan.",
  RANGE_KOLEKTIBILITAS_TUMPANG_TINDIH:
    "Ada rentang hari kolektibilitas yang saling tumpang tindih, sehingga klasifikasinya tidak tunggal. Perbaiki dulu konfigurasinya.",

  RATE_PENYISIHAN_TIDAK_ADA:
    "Rate penyisihan untuk salah satu kelas kolektibilitas belum dikonfigurasi. Lengkapi dulu tabel rate penyisihan.",
  HISTORI_TIDAK_CUKUP:
    "Data histori penerimaan belum mencukupi untuk menghitung penyisihan secara kolektif. Perpanjang histori atau pakai mode rate tabel.",

  KONFIGURASI_TIDAK_ADA:
    "Parameter konfigurasi yang dibutuhkan belum ada. Lengkapi dulu konfigurasinya.",
  KONFIGURASI_TIDAK_VALID:
    "Nilai parameter konfigurasi tidak valid, jadi proses dihentikan alih alih memakai nilai tebakan.",
  EVENT_MAPPING_BELUM_ADA:
    "Belum ada pemetaan jurnal yang disahkan untuk peristiwa ini, jadi transaksi ditolak dan tidak ditebak.",
  SKEMA_BELUM_LENGKAP:
    "Struktur penyimpanan yang dibutuhkan langkah ini belum lengkap, jadi hasilnya tidak akan bisa direkonstruksi nanti dan proses dihentikan.",

  JURNAL_GAGAL: "Jurnal untuk langkah closing ini gagal dibuat, jadi seluruh langkah dibatalkan.",

  NILAI_BUKAN_DESIMAL:
    "Nilai uang harus desimal dengan dua angka di belakang koma, misalnya 1500000.00.",
  TANGGAL_TIDAK_VALID: "Tanggal tidak valid. Format yang dipakai adalah YYYY-MM-DD.",

  TIDAK_BERWENANG: "Pengguna ini tidak punya wewenang untuk menjalankan langkah closing tersebut.",
  CABANG_DILUAR_SCOPE: "Data ini berada di cabang di luar wewenang pengguna.",
  IZIN_BELUM_TERDAFTAR:
    "Kewenangan untuk tindakan ini belum terdaftar di katalog izin, jadi tindakan ditolak sampai kewenangannya ditambahkan.",
};

/** Builds the module's only error type, with the catalogue message. */
export function tolak(
  kode: KodeClosing,
  detail: Record<string, unknown> = {},
  penyebabDb?: string,
): ClosingError {
  return new ClosingError(kode, PESAN[kode], detail, penyebabDb);
}

/**
 * A configuration refusal that NAMES THE KEY in the user-facing message.
 *
 * Not a leak: `akuntansi.mode_penyisihan` is a parameter an operator edits in
 * the Konfigurasi screen, not a database internal. A refusal that says only "a
 * parameter is missing" leaves the operator with nothing to act on, which is
 * how a fail-closed guard turns into a permanent outage nobody can diagnose.
 */
export function tolakKonfigurasi(
  kode: "KONFIGURASI_TIDAK_ADA" | "KONFIGURASI_TIDAK_VALID",
  grup: string,
  kunci: string,
  masalah?: string,
): ClosingError {
  const kunciPenuh = `${grup}.${kunci}`;
  const pesan =
    kode === "KONFIGURASI_TIDAK_ADA"
      ? `Parameter konfigurasi ${kunciPenuh} belum ada. Lengkapi dulu konfigurasinya sebelum menjalankan closing.`
      : `Nilai parameter konfigurasi ${kunciPenuh} tidak valid${masalah ? `: ${masalah}` : ""}. Proses dihentikan alih alih memakai nilai tebakan.`;
  return new ClosingError(kode, pesan, { grup, kunci, masalah: masalah ?? null });
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
 * swallowing an unknown database error inside a closing is how a half-written
 * trial balance gets committed.
 */
export function petakanKesalahanDb(err: unknown): ClosingError | null {
  const mentah = pesanMentah(err);
  const state = sqlstate(err);
  const constraint = namaConstraint(err);

  // The period triggers, matched on their own stable code prefix.
  if (mentah.includes("TJSL-PER-001")) return tolak("URUTAN_PERIODE", {}, mentah);
  if (mentah.includes("TJSL-PER-002")) return tolak("REOPEN_BUKAN_PERIODE_TERAKHIR", {}, mentah);
  if (mentah.includes("TJSL-PER-003")) return tolak("ALASAN_WAJIB", {}, mentah);
  if (mentah.includes("TJSL-PER-004")) return tolak("ALASAN_WAJIB", {}, mentah);
  // Invariant 5, raised by the journal guard when a closing step tries to post
  // into a period that closed underneath it.
  if (mentah.includes("TJSL-JRN-004")) return tolak("PERIODE_TIDAK_OPEN", {}, mentah);

  if (constraint === "kolektibilitas_snapshot_uq") {
    // Invariant 13. The engine owns idempotency; reaching this means two runs
    // raced, and the loser must be told something an operator can act on.
    return tolak("PERIODE_TIDAK_OPEN", { constraint }, mentah);
  }
  if (constraint === "penyisihan_periode_uq") {
    return tolak("PERIODE_TIDAK_OPEN", { constraint }, mentah);
  }
  if (constraint === "closing_kolektibilitas_selesai_uq") {
    return tolak("PERIODE_TIDAK_OPEN", { constraint }, mentah);
  }
  if (constraint === "penyisihan_periode_beban_ck") {
    // The arithmetic of spec 8.2 step 3 disagreeing with itself is a bug in
    // this module, not an operator problem; it must still not leak the
    // constraint name.
    return tolak("KONFIGURASI_TIDAK_VALID", { constraint }, mentah);
  }
  if (constraint === "kolektibilitas_snapshot_nilai_ck") {
    return tolak("KONFIGURASI_TIDAK_VALID", { constraint }, mentah);
  }
  if (constraint === "saldo_akun_periode_identitas_ck") {
    return tolak("KONFIGURASI_TIDAK_VALID", { constraint }, mentah);
  }

  // 23503 foreign_key_violation on a period or branch that vanished.
  if (state === "23503" && /periode/.test(mentah)) {
    return tolak("PERIODE_TIDAK_DITEMUKAN", {}, mentah);
  }

  return null;
}
