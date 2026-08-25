// The programme master data of spec 4.1: sektor PUMK, bidang Non PUMK, SDG.
//
// WHY THIS FILE EXISTS. It was found in the browser, not in a test: the live
// Daftar Proposal screen showed "Belum diisi" in the Sektor column for every
// row and `GET /konfigurasi/sektor` answered with an empty array, because
// `bun run db:seed:dev` created no `sektor_pumk` row at all. The same hole ran
// through `bidang_non_pumk` and `sdg`, which spec 9.2 makes MANDATORY on a Non
// PUMK proposal ("wajib pemetaan ke bidang Non PUMK dan minimal satu SDG"): a
// mandatory foreign key with an empty target table is a form nobody can
// submit.
//
// The list is the spec's own, verbatim from 4.1: eight sektor, seven bidang,
// and the seventeen SDG. Nothing is invented here; where the spec writes
// "Contoh", it is still the only list the client has given, and it is
// reference data an operator can edit through Konfigurasi > Master afterwards
// (spec 9.6 lists Sektor PUMK, Bidang Non PUMK and SDGs as CRUD screens).
//
// SCOPE. `sektor_pumk` and `bidang_non_pumk` are PER BUMN (bumn_id NOT NULL),
// so they are seeded once per reporting entity, exactly like the COA and the
// event mapping. `sdg` is GLOBAL: the seventeen goals are the UN's and belong
// to no entity, and `sdg_nomor_uq` is UNIQUE (nomor) with no bumn column,
// which is what makes them shared.
//
// IDEMPOTENT, AND NEVER OVERWRITES. Every insert is ON CONFLICT DO NOTHING on
// the live partial unique index, so a second `db:seed` adds nothing and an
// operator who renamed "Lainnya" or deactivated a sektor keeps their change.
// This is reference data an accountant maintains, not a fixture we own.
import type { QueryRunner } from "../core/ports/db";

export interface ReferensiDef {
  kode: string;
  nama: string;
  keterangan?: string;
}

/**
 * Spec 4.1: "Contoh: Industri, Perdagangan, Pertanian, Peternakan,
 * Perkebunan, Perikanan, Jasa, Lainnya." In the spec's order, which is the
 * order the dropdown and every "per sektor" report (spec 10 reports 2, 3, 6,
 * 10, 24, 27) will show.
 *
 * The codes are short mnemonics rather than 01..08 because they end up in the
 * `dimensi_json` of a journal line and in a report header, where "TAN" is
 * readable and "03" is a lookup.
 */
export const SEKTOR_PUMK: readonly ReferensiDef[] = [
  { kode: "IND", nama: "Industri", keterangan: "Pengolahan dan manufaktur skala mikro dan kecil" },
  { kode: "DAG", nama: "Perdagangan", keterangan: "Perdagangan besar dan eceran" },
  { kode: "TAN", nama: "Pertanian", keterangan: "Tanaman pangan dan hortikultura" },
  { kode: "NAK", nama: "Peternakan", keterangan: "Ternak besar, ternak kecil dan unggas" },
  { kode: "BUN", nama: "Perkebunan", keterangan: "Tanaman perkebunan rakyat" },
  { kode: "KAN", nama: "Perikanan", keterangan: "Perikanan tangkap dan budidaya" },
  { kode: "JAS", nama: "Jasa", keterangan: "Jasa perorangan dan jasa usaha" },
  { kode: "LNY", nama: "Lainnya", keterangan: "Sektor yang belum terwakili kategori di atas" },
];

/**
 * Spec 4.1: "Contoh: Pendidikan, Kesehatan, Sarana Ibadah, Sarana Umum,
 * Bencana Alam, Pelestarian Alam, Pengentasan Kemiskinan." Spec 13 asks for
 * exactly these seven ("7 bidang Non PUMK").
 */
export const BIDANG_NON_PUMK: readonly ReferensiDef[] = [
  { kode: "PDD", nama: "Pendidikan" },
  { kode: "KES", nama: "Kesehatan" },
  { kode: "IBD", nama: "Sarana Ibadah" },
  { kode: "UMM", nama: "Sarana Umum" },
  { kode: "BNC", nama: "Bencana Alam" },
  { kode: "ALM", nama: "Pelestarian Alam" },
  { kode: "KMS", nama: "Pengentasan Kemiskinan" },
];

/**
 * The seventeen Tujuan Pembangunan Berkelanjutan, in the Indonesian wording
 * Bappenas uses (Perpres 111/2022), because spec 10 report 14 prints "SDG
 * nomor dan nama" in an Indonesian report.
 *
 * `target_json` is left at its default `[]`: the 169 targets under these
 * goals are not in the spec and are not something to invent. The column is
 * there for when the client's TJSL unit says which targets they report
 * against.
 */
export const SDG: readonly { nomor: number; nama: string }[] = [
  { nomor: 1, nama: "Tanpa Kemiskinan" },
  { nomor: 2, nama: "Tanpa Kelaparan" },
  { nomor: 3, nama: "Kehidupan Sehat dan Sejahtera" },
  { nomor: 4, nama: "Pendidikan Berkualitas" },
  { nomor: 5, nama: "Kesetaraan Gender" },
  { nomor: 6, nama: "Air Bersih dan Sanitasi Layak" },
  { nomor: 7, nama: "Energi Bersih dan Terjangkau" },
  { nomor: 8, nama: "Pekerjaan Layak dan Pertumbuhan Ekonomi" },
  { nomor: 9, nama: "Industri, Inovasi dan Infrastruktur" },
  { nomor: 10, nama: "Berkurangnya Kesenjangan" },
  { nomor: 11, nama: "Kota dan Permukiman Berkelanjutan" },
  { nomor: 12, nama: "Konsumsi dan Produksi yang Bertanggung Jawab" },
  { nomor: 13, nama: "Penanganan Perubahan Iklim" },
  { nomor: 14, nama: "Ekosistem Lautan" },
  { nomor: 15, nama: "Ekosistem Daratan" },
  { nomor: 16, nama: "Perdamaian, Keadilan dan Kelembagaan yang Tangguh" },
  { nomor: 17, nama: "Kemitraan untuk Mencapai Tujuan" },
];

export interface SeedMasterProgramResult {
  sektor: number;
  bidang: number;
  sdg: number;
}

/**
 * Seeds the seventeen SDG, which are global and therefore seeded once for the
 * whole database rather than per bumn.
 */
export async function seedSdg(
  runner: QueryRunner,
  userId: string | null = null,
): Promise<number> {
  let inserted = 0;
  for (const s of SDG) {
    const rows = await runner.query<{ id: string }>(
      `INSERT INTO sdg (nomor, nama, created_by, updated_by)
       VALUES ($1::smallint, $2, $3, $3)
       ON CONFLICT (nomor) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id::text AS id`,
      [s.nomor, s.nama, userId],
    );
    if (rows.length > 0) inserted += 1;
  }
  return inserted;
}

/**
 * Seeds sektor PUMK and bidang Non PUMK for ONE bumn, plus the global SDG set.
 *
 * `urutan` is written from the array index so the spec's order survives a
 * later rename: the dropdown sorts by urutan, then kode (see
 * modules/konfigurasi/repo.ts `listSektor`).
 */
export async function seedMasterProgram(
  runner: QueryRunner,
  bumnId: string,
  userId: string | null = null,
): Promise<SeedMasterProgramResult> {
  let sektor = 0;
  for (const [i, s] of SEKTOR_PUMK.entries()) {
    const rows = await runner.query<{ id: string }>(
      `INSERT INTO sektor_pumk (bumn_id, kode, nama, keterangan, urutan, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::smallint, $6, $6)
       ON CONFLICT (bumn_id, kode) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id::text AS id`,
      [bumnId, s.kode, s.nama, s.keterangan ?? null, i + 1, userId],
    );
    if (rows.length > 0) sektor += 1;
  }

  let bidang = 0;
  for (const [i, b] of BIDANG_NON_PUMK.entries()) {
    const rows = await runner.query<{ id: string }>(
      `INSERT INTO bidang_non_pumk (bumn_id, kode, nama, urutan, created_by, updated_by)
       VALUES ($1, $2, $3, $4::smallint, $5, $5)
       ON CONFLICT (bumn_id, kode) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id::text AS id`,
      [bumnId, b.kode, b.nama, i + 1, userId],
    );
    if (rows.length > 0) bidang += 1;
  }

  const sdg = await seedSdg(runner, userId);
  return { sektor, bidang, sdg };
}
