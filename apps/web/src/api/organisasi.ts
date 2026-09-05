// Typed client for /organisasi: branches, employees, users and the role
// catalogue. The routes landed in apps/api/src/modules/organisasi/routes.ts.
//
// TYPES COME FROM THE SERVER, TYPE ONLY, exactly as ./jurnal.ts and ./tools.ts
// do. Nothing is redeclared here, so a change on either side is a type error in
// this file rather than a screen that quietly sends the wrong field.
//
// THREE THINGS THIS FILE DELIBERATELY DOES NOT HAVE.
//
//   NO DELETE, ANYWHERE. Not an omission: a branch is inside every document
//   number it ever issued, an employee is the named surveyor on a posted
//   survey, and a user id is the actor on every audit row. The server has no
//   DELETE on this surface at all, and the only removal is `aktif = false`.
//
//   NO CLIENT SIDE RULE ABOUT WHICH ROLE MAY BE GRANTED. `GET /organisasi/peran`
//   already answers that per caller, annotated with the server's own reason
//   (see ./peran.ts on the API). A second opinion in the browser would be a
//   second answer, and the one on screen would be the one nobody can defend.
//
//   NO WAY TO READ A TEMPORARY PASSWORD BACK. `buatPengguna` and `resetSandi`
//   are the only two calls that ever carry one, each answers it once, and the
//   server marks both responses `Cache-Control: no-store`.
import type {
  BuatPenggunaBody,
  HasilSandiSementara,
  PenggunaTampil,
  UbahPenggunaBody,
} from "@krakatausteel/api/src/modules/organisasi/admin-service";
import type { PeranTersedia } from "@krakatausteel/api/src/modules/organisasi/peran";
import type { CabangRow, KaryawanRow } from "@krakatausteel/api/src/modules/organisasi/repo";
import { apiGet, apiPatch, apiPost, apiPut, buildQuery } from "./http";

export type { BuatPenggunaBody, CabangRow, HasilSandiSementara, KaryawanRow, PenggunaTampil, PeranTersedia, UbahPenggunaBody };

/** A newly created account: the profile AND the one time password, together. */
export type PenggunaBaru = PenggunaTampil & HasilSandiSementara;

/** One role grant. `scopeCabangId` is null for a grant in the user's own branch. */
export interface GrantPeran {
  kode: string;
  scopeCabangId?: string | null;
}

interface Daftar<T> {
  data: T[];
}

// --------------------------------------------------------------------- cabang

export function daftarCabang(): Promise<Daftar<CabangRow>> {
  return apiGet("/organisasi/cabang");
}

export function buatCabang(body: {
  kode: string;
  nama: string;
  alamat?: string | null;
  kotaId?: string | null;
  isPusat?: boolean;
}): Promise<CabangRow> {
  return apiPost("/organisasi/cabang", body);
}

/**
 * `kode` and `isPusat` are NOT in the body type, and the omission is the point.
 * The router answers 400 on either of them rather than ignoring them, because a
 * branch code is printed inside every document number the branch ever issued.
 * The screen renders both as fixed facts with that reason next to them.
 */
export function ubahCabang(
  id: string,
  body: { nama?: string | null; alamat?: string | null; kotaId?: string | null },
): Promise<CabangRow> {
  return apiPatch(`/organisasi/cabang/${encodeURIComponent(id)}`, body);
}

export function setAktifCabang(id: string, aktif: boolean): Promise<CabangRow> {
  return apiPost(`/organisasi/cabang/${encodeURIComponent(id)}/status`, { aktif });
}

// ------------------------------------------------------------------- karyawan

export function daftarKaryawan(cabangId?: string | null): Promise<Daftar<KaryawanRow>> {
  return apiGet(`/organisasi/karyawan${buildQuery({ cabangId })}`);
}

export function buatKaryawan(body: {
  cabangId: string;
  nama: string;
  nip?: string | null;
  jabatan?: string | null;
  unit?: string | null;
}): Promise<KaryawanRow> {
  return apiPost("/organisasi/karyawan", body);
}

export function ubahKaryawan(
  id: string,
  body: {
    nama?: string | null;
    nip?: string | null;
    jabatan?: string | null;
    unit?: string | null;
    cabangId?: string | null;
  },
): Promise<KaryawanRow> {
  return apiPatch(`/organisasi/karyawan/${encodeURIComponent(id)}`, body);
}

export function setAktifKaryawan(id: string, aktif: boolean): Promise<KaryawanRow> {
  return apiPost(`/organisasi/karyawan/${encodeURIComponent(id)}/status`, { aktif });
}

// --------------------------------------------------------------------- peran

/**
 * The role catalogue, ALREADY ANNOTATED FOR THIS CALLER. `dapatDiberikan` says
 * whether the signed in officer may grant it and `alasan` says why not when
 * they may not. The screen renders the refusal; it never recomputes it.
 */
export function daftarPeran(): Promise<Daftar<PeranTersedia>> {
  return apiGet("/organisasi/peran");
}

// ------------------------------------------------------------------ pengguna

export function daftarPengguna(): Promise<Daftar<PenggunaTampil>> {
  return apiGet("/organisasi/pengguna");
}

export function satuPengguna(id: string): Promise<PenggunaTampil> {
  return apiGet(`/organisasi/pengguna/${encodeURIComponent(id)}`);
}

/** Answers the profile AND the one time password. Shown once, never re-read. */
export function buatPengguna(body: BuatPenggunaBody): Promise<PenggunaBaru> {
  return apiPost("/organisasi/pengguna", body);
}

/**
 * `username` and `peran` are absent from the body type on purpose. The router
 * refuses both: a username is what every audit row is read back through by a
 * human, and roles have their own endpoint so that one path writes `user_role`.
 */
export function ubahPengguna(id: string, body: UbahPenggunaBody): Promise<PenggunaTampil> {
  return apiPatch(`/organisasi/pengguna/${encodeURIComponent(id)}`, body);
}

/** The WHOLE role set, replaced. Refused on your own account by the server. */
export function gantiPeran(id: string, peran: readonly GrantPeran[]): Promise<PenggunaTampil> {
  return apiPut(`/organisasi/pengguna/${encodeURIComponent(id)}/peran`, { peran });
}

export function setAktifPengguna(
  id: string,
  aktif: boolean,
  alasan: string | null,
): Promise<PenggunaTampil> {
  return apiPost(`/organisasi/pengguna/${encodeURIComponent(id)}/status`, { aktif, alasan });
}

/** A NEW one time password. The previous one stops working the moment this lands. */
export function sandiSementara(id: string): Promise<HasilSandiSementara> {
  return apiPost(`/organisasi/pengguna/${encodeURIComponent(id)}/sandi-sementara`);
}
