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
import type { AsalNilai } from "@krakatausteel/api/src/modules/konfigurasi/katalog";
import type { NilaiResolusi } from "@krakatausteel/api/src/modules/konfigurasi/service";
import { apiGet } from "./http";

export type { AsalNilai, NilaiResolusi };

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
