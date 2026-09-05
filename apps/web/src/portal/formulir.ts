// THE PUBLIC FORM'S ALLOWLIST, AS THE SCREEN SEES IT.
//
// The server's allowlist in apps/api/src/modules/portal/contract.ts is the
// authority: a key that is not there is a 400, and no amount of agreement here
// changes that. This table exists for one reason the server cannot serve, and
// it is worth stating plainly.
//
// A REFUSAL FROM THE ENGINE ARRIVES AS ONE SENTENCE WITH NO FIELDS ON IT.
// `PortalError` carries a per-field `detail`, but core/http.ts serialises a
// coded domain error as `{error, code, kodeDomain}` and drops `detail`, so
// "Data pengajuan belum lengkap atau tidak sesuai format" is everything the
// browser is told. An applicant cannot act on that. So the form checks every
// rule here BEFORE the round trip and puts each message under its own field,
// and the server's refusal is still shown, as the authority, when one gets
// through.
//
// DRIFT IS PINNED AT THE GATE, NOT BY HOPE. ../portal.test.tsx imports the
// server's own `FIELD_PUMK` and `FIELD_NON_PUMK` and asserts this table equals
// them key for key and limit for limit. A test file is not bundled, so the
// check costs the browser nothing; the day someone widens a limit on the
// server, the suite says so instead of an applicant meeting a 400.
import type { AturanField, JenisDokumen, JenisPengajuan } from "../api/portal-publik";

/** Field key to rule, and the label and hint the applicant reads. */
export interface FieldPublik {
  kunci: string;
  label: string;
  aturan: AturanField;
  /** How the control is drawn. `panjang` is a textarea. */
  bentuk: "teks" | "panjang" | "uang" | "bulat";
  hint?: string;
}

export const FORM_PUMK: readonly FieldPublik[] = [
  {
    kunci: "nama_lengkap",
    label: "Nama lengkap",
    aturan: { jenis: "teks", maks: 120, wajib: true },
    bentuk: "teks",
    hint: "Sesuai KTP.",
  },
  {
    kunci: "nama_usaha",
    label: "Nama usaha",
    aturan: { jenis: "teks", maks: 120, wajib: true },
    bentuk: "teks",
  },
  {
    kunci: "sektor",
    label: "Sektor usaha",
    aturan: { jenis: "teks", maks: 60, wajib: false },
    bentuk: "teks",
    hint: "Misalnya perdagangan, pertanian, jasa. Boleh dikosongkan.",
  },
  {
    kunci: "alamat",
    label: "Alamat usaha",
    aturan: { jenis: "teks", maks: 240, wajib: true },
    bentuk: "panjang",
  },
  {
    kunci: "jumlah_diajukan",
    label: "Jumlah pendanaan yang diajukan",
    aturan: { jenis: "uang", maksSen: 100_000_000_000_000n, wajib: true },
    bentuk: "uang",
    hint: "Jumlah akhir ditentukan petugas setelah survei, bukan oleh angka ini.",
  },
  {
    kunci: "tenor_diajukan",
    label: "Lama angsuran (bulan)",
    aturan: { jenis: "bulat", min: 1, maks: 120, wajib: true },
    bentuk: "bulat",
  },
  {
    kunci: "tujuan_penggunaan",
    label: "Tujuan penggunaan dana",
    aturan: { jenis: "teks", maks: 500, wajib: true },
    bentuk: "panjang",
  },
];

export const FORM_NON_PUMK: readonly FieldPublik[] = [
  {
    kunci: "nama_pemohon",
    label: "Nama pemohon",
    aturan: { jenis: "teks", maks: 120, wajib: true },
    bentuk: "teks",
  },
  {
    kunci: "nama_lembaga",
    label: "Nama lembaga",
    aturan: { jenis: "teks", maks: 120, wajib: false },
    bentuk: "teks",
    hint: "Boleh dikosongkan bila mengajukan atas nama pribadi.",
  },
  {
    kunci: "judul_program",
    label: "Judul program",
    aturan: { jenis: "teks", maks: 160, wajib: true },
    bentuk: "teks",
  },
  {
    kunci: "alamat",
    label: "Alamat pelaksanaan",
    aturan: { jenis: "teks", maks: 240, wajib: true },
    bentuk: "panjang",
  },
  {
    kunci: "jumlah_diajukan",
    label: "Jumlah bantuan yang diajukan",
    aturan: { jenis: "uang", maksSen: 100_000_000_000_000n, wajib: true },
    bentuk: "uang",
  },
  {
    kunci: "penerima_manfaat_estimasi",
    label: "Perkiraan jumlah penerima manfaat",
    aturan: { jenis: "bulat", min: 0, maks: 10_000_000, wajib: false },
    bentuk: "bulat",
    hint: "Perkiraan jumlah orang yang akan merasakan manfaat program.",
  },
  {
    kunci: "deskripsi",
    label: "Deskripsi program",
    aturan: { jenis: "teks", maks: 1000, wajib: true },
    bentuk: "panjang",
  },
];

export function formulirUntuk(jenis: JenisPengajuan): readonly FieldPublik[] {
  return jenis === "PUMK" ? FORM_PUMK : FORM_NON_PUMK;
}

/**
 * The attachment kinds the server accepts, with words a member of the public
 * uses. `JenisDokumen` types the key, so a kind removed from the server's list
 * is a type error here rather than a 400 the applicant meets at submit.
 */
export const DOKUMEN_PILIHAN: readonly { jenis: JenisDokumen; label: string }[] = [
  { jenis: "KTP", label: "KTP" },
  { jenis: "KK", label: "Kartu Keluarga" },
  { jenis: "NPWP", label: "NPWP" },
  { jenis: "SIUP", label: "SIUP" },
  { jenis: "NIB", label: "NIB" },
  { jenis: "FOTO_USAHA", label: "Foto usaha" },
  { jenis: "SURAT_KETERANGAN_USAHA", label: "Surat keterangan usaha" },
  { jenis: "LAINNYA", label: "Dokumen lain" },
];

export const MAKS_DOKUMEN_PUBLIK = 10;
export const MAKS_NAMA_FILE_PUBLIK = 160;

/** Rejects the control characters the server rejects, rather than stripping. */
const POLA_KENDALI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * One field's complaint, or null when it is acceptable.
 *
 * WRITTEN AGAINST THE RULE, NOT AGAINST THE FIELD. Every message names the
 * limit it is about, so an applicant is told what to change rather than that
 * something is wrong.
 */
export function periksaField(field: FieldPublik, mentah: string): string | null {
  const nilai = mentah.trim();
  const aturan = field.aturan;

  if (nilai === "") {
    return aturan.wajib ? "Wajib diisi." : null;
  }
  if (POLA_KENDALI.test(nilai)) {
    return "Ada karakter yang tidak bisa diterima. Ketik ulang tanpa menyalin dari dokumen lain.";
  }

  if (aturan.jenis === "teks") {
    return nilai.length > aturan.maks ? `Maksimal ${aturan.maks} karakter.` : null;
  }

  if (aturan.jenis === "bulat") {
    if (!/^\d+$/.test(nilai)) return "Isi dengan angka bulat.";
    const angka = Number(nilai);
    if (angka < aturan.min || angka > aturan.maks) {
      return `Isi antara ${aturan.min} dan ${aturan.maks}.`;
    }
    return null;
  }

  // Money. The value handed here is already `parseUang`'s output ("1500000.00")
  // or "" when the text could not be read, so an unreadable figure arrives as
  // empty and is reported as such rather than as a zero.
  if (!/^\d{1,15}\.\d{2}$/.test(nilai)) return "Isi jumlah dalam rupiah, misalnya 5.000.000.";
  const sen = BigInt(nilai.replace(".", ""));
  if (sen <= 0n) return "Jumlah harus lebih besar dari nol.";
  if (sen > aturan.maksSen) return "Jumlah yang diisi terlalu besar.";
  return null;
}

/** What the server does with a value before storing it, mirrored. */
export function nilaiTerkirim(field: FieldPublik, mentah: string): unknown {
  const nilai = mentah.trim();
  if (nilai === "") return undefined;
  if (field.aturan.jenis === "bulat") return Number(nilai);
  return nilai;
}

export const POLA_TIKET_PUBLIK = /^TKT-\d{6}-[0-9A-HJKMNP-TV-Z]{10}$/;
export const POLA_NIK_PUBLIK = /^\d{16}$/;
