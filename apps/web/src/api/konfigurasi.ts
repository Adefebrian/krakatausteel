// Typed client for Parameter Sistem, spec 9.4.
//
// `NilaiResolusi` is imported, type only, from the konfigurasi module's own
// service so the screen cannot drift from what the endpoint answers. Two of
// its fields are the reason this screen exists at all, and they are NOT the
// same claim:
//
//   perluKonfirmasi     per ROW and per entity. "this VALUE still needs the
//                       client's written confirmation". It goes false the
//                       moment an operator types an override, because an
//                       explicit override IS the confirmation.
//   asalNilaiDefault    per CATALOGUE ENTRY. "where the SHIPPED DEFAULT came
//                       from". It never changes when the value does, because
//                       it is a fact about the default, not about the value.
//
// A value can be confirmed and still have been invented by us, and an invented
// number that nobody flagged is the exact failure this surfaces: an accountant
// reading a maximum grant value has no way to know we made it up.
import type {
  BarisMaster,
  KlasifikasiRow,
} from "@krakatausteel/api/src/modules/konfigurasi/admin-repo";
import type {
  AkunTampil,
  BuatAkunBody,
  UbahAkunBody,
} from "@krakatausteel/api/src/modules/konfigurasi/admin-service";
import type { AsalNilai } from "@krakatausteel/api/src/modules/konfigurasi/katalog";
import type { NilaiResolusi } from "@krakatausteel/api/src/modules/konfigurasi/service";
import { apiGet, apiPatch, apiPost } from "./http";

export type { AkunTampil, AsalNilai, BarisMaster, BuatAkunBody, KlasifikasiRow, NilaiResolusi, UbahAkunBody };

interface Daftar<T> {
  data: T[];
}

/** Every parameter visible to this bumn, resolved, sorted by `grup.kunci`. */
export function daftarKonfigurasi(): Promise<Daftar<NilaiResolusi>> {
  return apiGet("/konfigurasi");
}

export function satuKonfigurasi(grup: string, kunci: string): Promise<NilaiResolusi> {
  return apiGet(`/konfigurasi/${encodeURIComponent(grup)}/${encodeURIComponent(kunci)}`);
}

// ------------------------------------------------------------ bagan akun
//
// `AkunTampil` carries three facts a screen needs BEFORE it offers a control:
// `punyaAnak`, `dipakaiMapping` and `dipakaiJurnal`. They exist so a screen can
// disable a deactivation and say why, instead of offering it and letting a 409
// explain afterwards. The server refuses again either way.

export function daftarAkun(): Promise<Daftar<AkunTampil>> {
  return apiGet("/konfigurasi/coa");
}

/** The classification vocabulary a COA form picks from (migration 0028). */
export function daftarKlasifikasiAkun(): Promise<Daftar<KlasifikasiRow>> {
  return apiGet("/konfigurasi/klasifikasi-akun");
}

export function buatAkun(body: BuatAkunBody): Promise<AkunTampil> {
  return apiPost("/konfigurasi/coa", body);
}

/**
 * `kode`, `parentId`, `level`, `tipe` and `saldoNormal` are absent from
 * `UbahAkunBody` on the server, and the router answers 400 on each of them
 * rather than ignoring them. They are the identity and the position of the
 * account in the statements, and posted history points at both. The screen
 * shows all five as fixed facts with that reason, and never as inputs.
 */
export function ubahAkun(id: string, body: UbahAkunBody): Promise<AkunTampil> {
  return apiPatch(`/konfigurasi/coa/${encodeURIComponent(id)}`, body);
}

/** Deactivation, which is the only removal this API has. There is no DELETE. */
export function setAktifAkun(id: string, aktif: boolean): Promise<AkunTampil> {
  return apiPost(`/konfigurasi/coa/${encodeURIComponent(id)}/status`, { aktif });
}

// --------------------------------------------------------- master referensi

export interface JenisMaster {
  jenis: string;
  label: string;
  /** true when the table carries `bumn_id`, i.e. it belongs to this entity. */
  scopeBumn: boolean;
}

/** The registry itself, so five screens read one contract. */
export function daftarJenisMaster(): Promise<Daftar<JenisMaster>> {
  return apiGet("/konfigurasi/master");
}

/**
 * ROWS COME BACK KEYED BY COLUMN NAME, WRITES GO OUT KEYED BY FIELD NAME.
 *
 * `SELECT kode_bps, provinsi_id ...` on the read, `{ kodeBps, provinsiId }` on
 * the POST and the PATCH. That asymmetry is the server's, not ours, so it is
 * named here once and translated in one place (`FIELD_MASTER` below) rather
 * than guessed at by each of the five screens.
 */
export function daftarMaster(jenis: string): Promise<{ jenis: string; data: BarisMaster[] }> {
  return apiGet(`/konfigurasi/master/${encodeURIComponent(jenis)}`);
}

export function buatMaster(jenis: string, body: Record<string, unknown>): Promise<BarisMaster> {
  return apiPost(`/konfigurasi/master/${encodeURIComponent(jenis)}`, body);
}

/**
 * The KEY field of a reference row is refused here, not ignored: it is what
 * every posted proposal, grant and journal refers the row back by. A screen
 * therefore renders it as a fixed fact once the row exists.
 */
export function ubahMaster(
  jenis: string,
  id: string,
  body: Record<string, unknown>,
): Promise<BarisMaster> {
  return apiPatch(
    `/konfigurasi/master/${encodeURIComponent(jenis)}/${encodeURIComponent(id)}`,
    body,
  );
}

export function setAktifMaster(jenis: string, id: string, aktif: boolean): Promise<BarisMaster> {
  return apiPost(
    `/konfigurasi/master/${encodeURIComponent(jenis)}/${encodeURIComponent(id)}/status`,
    { aktif },
  );
}

/**
 * THE FIELD SHAPE OF THE FIVE REFERENCE TABLES.
 *
 * The registry endpoint answers `{ jenis, label, scopeBumn }` and NOT the
 * columns, so a form cannot be generated from the wire alone. This mirror is
 * the smallest thing that closes the gap, and it is pinned: a test asserts it
 * equals `MASTER` in apps/api/src/modules/konfigurasi/master.ts field for
 * field, so drift is a red test rather than a form that posts a name the
 * server has never heard of.
 *
 * `kunci` marks the column history refers the row back by. Immutable after
 * creation, refused by the server on a PATCH, rendered as a fixed fact.
 */
export interface FieldMasterUi {
  /** Name in the JSON body of a POST or a PATCH. */
  nama: string;
  /** Column name, which is how the row comes back on a GET. */
  kolom: string;
  bentuk: "TEKS" | "ANGKA" | "ENUM" | "REF";
  wajib: boolean;
  kunci?: boolean;
  maks?: number;
  min?: number;
  pilihan?: readonly string[];
  refTabel?: string;
  refScopeBumn?: boolean;
  /** Label on the form. Not on the server: this is presentation only. */
  label: string;
}

export const FIELD_MASTER: Readonly<Record<string, readonly FieldMasterUi[]>> = {
  sektor: [
    { nama: "kode", kolom: "kode", bentuk: "TEKS", wajib: true, kunci: true, maks: 20, label: "Kode sektor" },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200, label: "Nama sektor" },
    { nama: "keterangan", kolom: "keterangan", bentuk: "TEKS", wajib: false, maks: 500, label: "Keterangan" },
    { nama: "urutan", kolom: "urutan", bentuk: "ANGKA", wajib: false, min: 0, maks: 32767, label: "Urutan tampil" },
  ],
  bidang: [
    { nama: "kode", kolom: "kode", bentuk: "TEKS", wajib: true, kunci: true, maks: 20, label: "Kode bidang" },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200, label: "Nama bidang" },
    { nama: "urutan", kolom: "urutan", bentuk: "ANGKA", wajib: false, min: 0, maks: 32767, label: "Urutan tampil" },
  ],
  provinsi: [
    { nama: "kodeBps", kolom: "kode_bps", bentuk: "TEKS", wajib: true, kunci: true, maks: 10, label: "Kode BPS" },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200, label: "Nama provinsi" },
  ],
  kota: [
    { nama: "kodeBps", kolom: "kode_bps", bentuk: "TEKS", wajib: true, kunci: true, maks: 10, label: "Kode BPS" },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200, label: "Nama kota atau kabupaten" },
    {
      nama: "provinsiId",
      kolom: "provinsi_id",
      bentuk: "REF",
      wajib: true,
      refTabel: "provinsi",
      refScopeBumn: false,
      label: "Provinsi induk",
    },
    {
      nama: "tipe",
      kolom: "tipe",
      bentuk: "ENUM",
      wajib: true,
      pilihan: ["KOTA", "KABUPATEN"],
      label: "Tipe wilayah",
    },
  ],
  sdg: [
    { nama: "nomor", kolom: "nomor", bentuk: "ANGKA", wajib: true, kunci: true, min: 1, maks: 17, label: "Nomor tujuan" },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200, label: "Nama tujuan" },
  ],
};
