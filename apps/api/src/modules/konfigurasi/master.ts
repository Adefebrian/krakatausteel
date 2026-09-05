// THE MASTER REFERENCE REGISTRY.
//
// Five tables (sektor_pumk, bidang_non_pumk, provinsi, kota, sdg) that differ
// only in their columns. One table-driven surface rather than five near-identical
// routers, for three reasons:
//
//   1. The RULES are identical and the rules are the hard part: pinned to the
//      caller's entity where the table has one, deactivate-never-delete, code
//      uniqueness inside its scope, an audit row carrying before and after. Five
//      copies means five chances for one of them to drift.
//   2. The SPA gets one contract shape for five screens.
//   3. A sixth reference table later is a row in this file, not a module.
//
// EVERY IDENTIFIER HERE IS A LITERAL IN THIS FILE. Table and column names are
// interpolated into SQL, so they can never come from a request: the route looks
// `jenis` up in this registry and gets a definition or a 404. The same discipline
// modules/auth/segregation.ts uses for its injected table names.
//
// SCOPE, and it is the one place these five genuinely differ. `sektor` and
// `bidang` belong to a reporting entity and carry `bumn_id`. `provinsi`, `kota`
// and `sdg` are PLATFORM reference data with no owner column: the BPS province
// list and the seventeen UN goals are not one entity's opinion. On a
// single-entity deployment (spec 15 #3) that distinction is invisible; it is
// recorded here so that it stays a decision rather than an oversight if the
// server ever hosts a second entity.

export type BentukField = "TEKS" | "ANGKA" | "ENUM" | "REF";

export interface FieldMaster {
  /** Name in the JSON contract, e.g. `kodeBps`. */
  nama: string;
  /** Column in the table, e.g. `kode_bps`. */
  kolom: string;
  bentuk: BentukField;
  wajib: boolean;
  /** Immutable after creation: it is what history refers to the row by. */
  kunci?: boolean;
  maks?: number;
  min?: number;
  pilihan?: readonly string[];
  /** For BENTUK "REF": the table this column points at. */
  refTabel?: string;
  /** For BENTUK "REF": whether the referenced row is scoped to the entity. */
  refScopeBumn?: boolean;
}

export interface DefinisiMaster {
  jenis: string;
  tabel: string;
  label: string;
  /** true when the table carries `bumn_id`; see the SCOPE note above. */
  scopeBumn: boolean;
  /** Columns that must be unique together, inside the scope. */
  kunciUnik: readonly string[];
  urutan: string;
  fields: readonly FieldMaster[];
}

const SEKTOR: DefinisiMaster = {
  jenis: "sektor",
  tabel: "sektor_pumk",
  label: "Sektor Usaha PUMK",
  scopeBumn: true,
  kunciUnik: ["kode"],
  urutan: "urutan ASC, kode ASC",
  fields: [
    { nama: "kode", kolom: "kode", bentuk: "TEKS", wajib: true, kunci: true, maks: 20 },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200 },
    { nama: "keterangan", kolom: "keterangan", bentuk: "TEKS", wajib: false, maks: 500 },
    { nama: "urutan", kolom: "urutan", bentuk: "ANGKA", wajib: false, min: 0, maks: 32767 },
  ],
};

const BIDANG: DefinisiMaster = {
  jenis: "bidang",
  tabel: "bidang_non_pumk",
  label: "Bidang Program Non PUMK",
  scopeBumn: true,
  kunciUnik: ["kode"],
  urutan: "urutan ASC, kode ASC",
  fields: [
    { nama: "kode", kolom: "kode", bentuk: "TEKS", wajib: true, kunci: true, maks: 20 },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200 },
    { nama: "urutan", kolom: "urutan", bentuk: "ANGKA", wajib: false, min: 0, maks: 32767 },
  ],
};

const PROVINSI: DefinisiMaster = {
  jenis: "provinsi",
  tabel: "provinsi",
  label: "Provinsi",
  scopeBumn: false,
  kunciUnik: ["kode_bps"],
  urutan: "kode_bps ASC",
  fields: [
    { nama: "kodeBps", kolom: "kode_bps", bentuk: "TEKS", wajib: true, kunci: true, maks: 10 },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200 },
  ],
};

const KOTA: DefinisiMaster = {
  jenis: "kota",
  tabel: "kota",
  label: "Kota / Kabupaten",
  scopeBumn: false,
  kunciUnik: ["kode_bps"],
  urutan: "kode_bps ASC",
  fields: [
    { nama: "kodeBps", kolom: "kode_bps", bentuk: "TEKS", wajib: true, kunci: true, maks: 10 },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200 },
    {
      nama: "provinsiId",
      kolom: "provinsi_id",
      bentuk: "REF",
      wajib: true,
      refTabel: "provinsi",
      refScopeBumn: false,
    },
    {
      nama: "tipe",
      kolom: "tipe",
      bentuk: "ENUM",
      wajib: true,
      pilihan: ["KOTA", "KABUPATEN"],
    },
  ],
};

const SDG: DefinisiMaster = {
  jenis: "sdg",
  tabel: "sdg",
  label: "Tujuan Pembangunan Berkelanjutan",
  scopeBumn: false,
  kunciUnik: ["nomor"],
  urutan: "nomor ASC",
  fields: [
    // The CHECK on the column is `BETWEEN 1 AND 17` and there are exactly
    // seventeen goals; the bounds are repeated here so an operator gets the
    // range in a sentence instead of `sdg_nomor_check`.
    { nama: "nomor", kolom: "nomor", bentuk: "ANGKA", wajib: true, kunci: true, min: 1, maks: 17 },
    { nama: "nama", kolom: "nama", bentuk: "TEKS", wajib: true, maks: 200 },
  ],
};

export const MASTER: readonly DefinisiMaster[] = [SEKTOR, BIDANG, PROVINSI, KOTA, SDG];

const BY_JENIS = new Map(MASTER.map((d) => [d.jenis, d]));

/** The definition for a path segment, or null. Never builds one from input. */
export function definisiMaster(jenis: string): DefinisiMaster | null {
  return BY_JENIS.get(jenis) ?? null;
}
