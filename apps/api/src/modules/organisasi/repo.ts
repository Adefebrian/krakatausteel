// Data access for the organisation master data this module owns: cabang and
// karyawan (spec 4.1).
//
// NOTE ON THE SCOPE PATTERN, which every later phase copies:
// `findKaryawanById` takes ONLY the id and returns the row INCLUDING its
// cabang_id. It does not take the caller's branch and does not filter by it.
// That is deliberate: the service reads the row, then asks
// `assertCabangAllowed` about the branch THE ROW SAYS IT IS IN. Filtering
// inside the query would work too, but it makes "not found" and "not yours"
// indistinguishable in the code, and the moment one query forgets the filter
// the hole is silent. Read then check is auditable at a glance.
import type { QueryRunner } from "./ports";

export interface CabangRow {
  id: string;
  bumn_id: string;
  kode: string;
  nama: string;
  alamat: string | null;
  is_pusat: boolean;
  aktif: boolean;
}

export interface KaryawanRow {
  id: string;
  cabang_id: string;
  /** Denormalised from cabang so the service can pin the row to one entity. */
  bumn_id: string;
  nip: string | null;
  nama: string;
  jabatan: string | null;
  unit: string | null;
  aktif: boolean;
}

export interface OrganisasiRepo {
  listCabang(runner: QueryRunner, bumnId: string, cabangIds: readonly string[] | null): Promise<CabangRow[]>;
  findCabangById(runner: QueryRunner, id: string): Promise<CabangRow | null>;
  listKaryawan(runner: QueryRunner, cabangIds: readonly string[] | null, bumnId: string): Promise<KaryawanRow[]>;
  findKaryawanById(runner: QueryRunner, id: string): Promise<KaryawanRow | null>;
}

export function createOrganisasiRepo(): OrganisasiRepo {
  return {
    async listCabang(runner, bumnId, cabangIds) {
      return runner.query<CabangRow>(
        `SELECT id::text AS id, bumn_id::text AS bumn_id, kode, nama, alamat, is_pusat, aktif
           FROM cabang
          WHERE bumn_id = $1
            AND deleted_at IS NULL
            AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
          ORDER BY is_pusat DESC, kode`,
        [bumnId, cabangIds],
      );
    },

    async findCabangById(runner, id) {
      const rows = await runner.query<CabangRow>(
        `SELECT id::text AS id, bumn_id::text AS bumn_id, kode, nama, alamat, is_pusat, aktif
           FROM cabang
          WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      return rows[0] ?? null;
    },

    async listKaryawan(runner, cabangIds, bumnId) {
      return runner.query<KaryawanRow>(
        `SELECT k.id::text AS id, k.cabang_id::text AS cabang_id, c.bumn_id::text AS bumn_id,
                k.nip, k.nama, k.jabatan, k.unit, k.aktif
           FROM karyawan k
           JOIN cabang c ON c.id = k.cabang_id
          WHERE k.deleted_at IS NULL
            AND c.bumn_id = $2
            AND ($1::uuid[] IS NULL OR k.cabang_id = ANY($1::uuid[]))
          ORDER BY k.nama`,
        [cabangIds, bumnId],
      );
    },

    async findKaryawanById(runner, id) {
      const rows = await runner.query<KaryawanRow>(
        `SELECT k.id::text AS id, k.cabang_id::text AS cabang_id, c.bumn_id::text AS bumn_id,
                k.nip, k.nama, k.jabatan, k.unit, k.aktif
           FROM karyawan k
           JOIN cabang c ON c.id = k.cabang_id
          WHERE k.id = $1 AND k.deleted_at IS NULL AND c.deleted_at IS NULL`,
        [id],
      );
      return rows[0] ?? null;
    },
  };
}
