// Translation layer: a database refusal becomes a domain rejection.
//
// Same job, same shape and same reasoning as modules/jurnal/kesalahan.ts.
// ADR 0002 puts the receivable invariants in Postgres, so the last line of
// defence raises text like
//   'TJSL-JDW-001: total pokok jadwal versi 1 (...) harus sama persis ...'
// which names triggers, constraints and SQLSTATEs. That text must never reach
// a caller, an HTTP body or a log line a finance user reads, so the engine
// validates first, expects to be the one rejecting, and maps the refusal onto
// the same `AngsuranError` code when the database refuses anyway. The raw text
// is kept in `penyebabDb`, for the server log only.
//
// MAPPING IS ON THE TRIGGER'S OWN CODE PREFIX AND ON SQLSTATE/CONSTRAINT,
// never on prose: trigger messages are Indonesian and will be reworded,
// `TJSL-JDW-001` and `err.errno` / `err.constraint` will not.
//
// The message catalogue is keyed with plain string literals rather than
// `[KODE_ANGSURAN.X]:` for the same reason the journal's is: ./contract.ts
// imports the engine, which imports this file, so reading `KODE_ANGSURAN` at
// module-evaluation time here would touch a binding still in its temporal dead
// zone. Every reference to it lives inside a function body.
import { AngsuranError, type KodeAngsuran } from "./contract";

/** User-facing Indonesian prose, one per code. Free of any driver internals. */
const PESAN: Record<KodeAngsuran, string> = {
  AKAD_TIDAK_DITEMUKAN: "Akad tidak ditemukan.",
  AKAD_TIDAK_BISA_DIANGSUR:
    "Status akad ini tidak menerima angsuran atau perubahan jadwal. Akad yang sudah lunas, dihapus buku, atau belum dicairkan tidak bisa diproses.",
  JADWAL_TIDAK_DITEMUKAN:
    "Akad ini belum punya jadwal angsuran yang aktif. Buat jadwalnya dulu lewat langkah akad.",
  JADWAL_SUDAH_ADA:
    "Akad ini sudah punya jadwal angsuran. Perubahan jadwal hanya lewat reschedule, yang membuat versi baru.",

  POKOK_TIDAK_VALID: "Pokok pinjaman harus lebih besar dari nol.",
  POKOK_DILUAR_PLAFON: "Pokok pinjaman berada di luar batas plafon yang dikonfigurasi.",
  TENOR_TIDAK_VALID: "Tenor harus lebih besar dari nol bulan.",
  TENOR_DILUAR_BATAS: "Jumlah bulan grace period ditambah tenor melampaui batas tenor maksimum.",
  GRACE_DILUAR_BATAS: "Grace period melampaui batas maksimum yang dikonfigurasi.",
  RATE_TIDAK_VALID: "Rate jasa administrasi tidak valid.",
  METODE_TIDAK_DIKENAL: "Metode perhitungan angsuran tidak dikenal.",
  TANGGAL_TIDAK_VALID: "Tanggal tidak valid. Format yang dipakai adalah YYYY-MM-DD.",
  NILAI_BUKAN_DESIMAL:
    "Nilai uang harus desimal dengan dua angka di belakang koma, misalnya 1500000.00, dan rate dengan enam angka, misalnya 0.030000.",

  PEMBULATAN_TIDAK_VALID:
    "Nilai konfigurasi pembulatan angsuran harus salah satu dari 0, 100, atau 1000 rupiah.",
  TOTAL_POKOK_TIDAK_COCOK:
    "Total pokok seluruh baris jadwal tidak sama dengan pokok pinjaman akad, jadi jadwal tidak disimpan.",
  JADWAL_IMMUTABLE:
    "Baris jadwal angsuran tidak bisa diubah. Perubahan jadwal dilakukan lewat reschedule, yang membuat versi baru.",

  SETORAN_TIDAK_POSITIF: "Jumlah setoran harus lebih besar dari nol.",
  PRESET_ALOKASI_TIDAK_DITEMUKAN:
    "Preset urutan alokasi setoran yang dikonfigurasi tidak ada di daftar preset. Lengkapi dulu presetnya, alokasi tidak memakai urutan bawaan.",
  PRESET_ALOKASI_TIDAK_LENGKAP:
    "Preset urutan alokasi setoran belum memuat seluruh komponen yang dibutuhkan.",
  AKUN_KAS_TIDAK_VALID: "Akun kas yang dipilih tidak ditemukan, tidak aktif, atau bukan akun kas.",
  OUTSTANDING_NEGATIF:
    "Alokasi ini akan membuat piutang menjadi negatif. Kelebihan setoran harus masuk ke Kelebihan Pembayaran Angsuran.",
  JURNAL_GAGAL: "Jurnal untuk setoran ini gagal dibuat, jadi seluruh alokasi dibatalkan.",

  AKRUAL_TIDAK_TERTAMPUNG:
    "Jasa administrasi yang sudah diakrual sebagai piutang tidak tertampung di jadwal baru, jadi perubahan ini ditolak. Menghapusnya berarti membatalkan pendapatan yang sudah diakui, dan itu keputusan akuntansi tersendiri, bukan efek samping reschedule.",
  RESCHEDULE_TIDAK_DITEMUKAN: "Pengajuan reschedule tidak ditemukan.",
  RESCHEDULE_BELUM_DISETUJUI: "Reschedule ini belum disetujui, jadi belum berlaku.",
  RESCHEDULE_SUDAH_DIPROSES: "Pengajuan reschedule ini sudah pernah diproses.",
  ALASAN_WAJIB: "Alasan reschedule wajib diisi.",
  APPROVER_TIDAK_BOLEH_MAKER: "Pengaju reschedule tidak boleh menyetujui pengajuannya sendiri.",

  BASIS_EKUIVALENSI_BELUM_DIPUTUSKAN:
    "Basis ekuivalensi rate yang diminta belum diputuskan, jadi konversi ditolak dan tidak ditebak.",

  KONFIGURASI_TIDAK_ADA: "Parameter konfigurasi yang dibutuhkan belum ada. Lengkapi dulu konfigurasinya.",
  KONFIGURASI_TIDAK_VALID: "Nilai parameter konfigurasi tidak valid, jadi perhitungan dihentikan.",
  TIDAK_BERWENANG: "Pengguna ini tidak punya wewenang untuk tindakan tersebut pada angsuran.",
  CABANG_DILUAR_SCOPE: "Akad ini berada di cabang di luar wewenang pengguna.",
};

/** Builds the module's only error type, with the catalogue message. */
export function tolak(
  kode: KodeAngsuran,
  detail: Record<string, unknown> = {},
  penyebabDb?: string,
): AngsuranError {
  return new AngsuranError(kode, PESAN[kode], detail, penyebabDb);
}

/**
 * Trigger codes from migrations/0008_pumk.sql and 0019_restruktur_pokok.sql,
 * mapped onto the domain code the engine would have raised itself.
 */
const PETA_KODE_TRIGGER: Record<string, KodeAngsuran> = {
  "TJSL-AKD-001": "CABANG_DILUAR_SCOPE",
  "TJSL-JDW-001": "TOTAL_POKOK_TIDAK_COCOK",
  "TJSL-JDW-002": "JADWAL_IMMUTABLE",
  "TJSL-JDW-003": "JADWAL_TIDAK_DITEMUKAN",
  "TJSL-JDW-004": "JADWAL_TIDAK_DITEMUKAN",
  "TJSL-JDW-005": "TOTAL_POKOK_TIDAK_COCOK",
  "TJSL-JDW-006": "TOTAL_POKOK_TIDAK_COCOK",
  "TJSL-RSC-001": "RESCHEDULE_SUDAH_DIPROSES",
  "TJSL-RSC-002": "TOTAL_POKOK_TIDAK_COCOK",
};

/** Constraint names, for the refusals that are declarative rather than raised. */
const PETA_CONSTRAINT: Record<string, KodeAngsuran> = {
  pumk_jadwal_versi_aktif_uq: "JADWAL_SUDAH_ADA",
  pumk_jadwal_versi_uq: "JADWAL_SUDAH_ADA",
  pumk_jadwal_terbayar_ck: "OUTSTANDING_NEGATIF",
  // migrations/0030: a row may never claim more accrued jasa than it still
  // owes. The engine bounds every write by that already, so a refusal here is
  // the same class of fault as an overpayment reaching the column.
  pumk_jadwal_akrual_ck: "AKRUAL_TIDAK_TERTAMPUNG",
  pumk_jadwal_lunas_ck: "OUTSTANDING_NEGATIF",
  pumk_angsuran_alokasi_ck: "OUTSTANDING_NEGATIF",
  pumk_angsuran_jumlah_diterima_check: "SETORAN_TIDAK_POSITIF",
  pumk_akad_outstanding_pokok_check: "OUTSTANDING_NEGATIF",
  pumk_akad_outstanding_jasa_check: "OUTSTANDING_NEGATIF",
  pumk_akad_outstanding_pokok_max_ck: "OUTSTANDING_NEGATIF",
  pumk_angsuran_akun_kas_id_fkey: "AKUN_KAS_TIDAK_VALID",
  // The forward links to `jurnal` added by migrations/0010. A refusal here
  // means the journal port returned an id for a journal that does not exist,
  // which is a broken ledger write, not a business rejection: the allocation
  // rolls back and the caller is told the journal failed, with the driver text
  // confined to penyebabDb.
  pumk_angsuran_jurnal_fk: "JURNAL_GAGAL",
  pumk_kelebihan_jurnal_terima_fk: "JURNAL_GAGAL",
  pumk_reschedule_pokok_baru_jenis_ck: "POKOK_TIDAK_VALID",
  pumk_reschedule_basis_ck: "POKOK_TIDAK_VALID",
  pumk_reschedule_delta_bukan_nol_ck: "POKOK_TIDAK_VALID",
  pumk_reschedule_disetujui_ck: "RESCHEDULE_SUDAH_DIPROSES",
};

interface KesalahanDb {
  message?: unknown;
  errno?: unknown;
  constraint?: unknown;
}

/**
 * Maps anything thrown by the driver onto an `AngsuranError`, or returns null
 * when the failure is not one this module can explain. A null answer means the
 * caller must rethrow the original: inventing a domain code for an unknown
 * fault would hide a real bug behind a business-sounding message.
 */
export function terjemahkanKesalahanDb(err: unknown): AngsuranError | null {
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
    if (err instanceof AngsuranError) throw err;
    const domain = terjemahkanKesalahanDb(err);
    if (domain) throw domain;
    throw err;
  }
}

/** Type guard, so ./service.ts can recognise a domain rejection. */
export function adalahAngsuranError(err: unknown): err is AngsuranError {
  return err instanceof AngsuranError;
}
