// Data access for nomor_urut (spec 4.10). One counter row per
// (bumn, cabang, jenis_dokumen, tahun, bulan), matching the unique index
// nomor_urut_seri_uq (which is NULLS NOT DISTINCT, so a pusat-level series
// with cabang_id NULL and a yearly series with bulan NULL are each a single
// row rather than infinitely many "distinct" NULLs).
import type { QueryRunner } from "./ports";

export interface SeriKey {
  bumnId: string;
  /** null = a pusat-level (entity-wide) series. */
  cabangId: string | null;
  jenisDokumen: string;
  tahun: number;
  /** null = yearly series, no monthly reset. */
  bulan: number | null;
}

export interface NomorUrutRow {
  id: string;
  urutan_terakhir: number;
  format_template: string;
}

export interface NomorRepo {
  /** Creates the counter row if it does not exist yet. Idempotent, race-safe. */
  ensure(runner: QueryRunner, key: SeriKey, formatTemplate: string, userId: string | null): Promise<void>;
  /** Takes the row lock. MUST run inside a transaction. */
  lock(runner: QueryRunner, key: SeriKey): Promise<NomorUrutRow | null>;
  increment(runner: QueryRunner, id: string, userId: string | null): Promise<number>;
  peek(runner: QueryRunner, key: SeriKey): Promise<NomorUrutRow | null>;
}

const WHERE_SERI = `bumn_id = $1
  AND cabang_id IS NOT DISTINCT FROM $2::uuid
  AND jenis_dokumen = $3
  AND tahun = $4
  AND bulan IS NOT DISTINCT FROM $5::smallint`;

function keyParams(key: SeriKey): unknown[] {
  return [key.bumnId, key.cabangId, key.jenisDokumen, key.tahun, key.bulan];
}

export function createNomorRepo(): NomorRepo {
  return {
    async ensure(runner, key, formatTemplate, userId) {
      // ON CONFLICT DO NOTHING against nomor_urut_seri_uq: two concurrent
      // first-uses of a series both try to create it and exactly one wins,
      // with no error for the loser.
      await runner.query(
        `INSERT INTO nomor_urut
           (bumn_id, cabang_id, jenis_dokumen, tahun, bulan, urutan_terakhir, format_template,
            created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $7)
         ON CONFLICT (bumn_id, cabang_id, jenis_dokumen, tahun, bulan) DO NOTHING`,
        [...keyParams(key), formatTemplate, userId],
      );
    },

    async lock(runner, key) {
      // SELECT ... FOR UPDATE is the serialisation point: concurrent callers
      // queue here, so no two of them can read the same urutan_terakhir.
      const rows = await runner.query<NomorUrutRow>(
        `SELECT id::text AS id, urutan_terakhir, format_template
           FROM nomor_urut
          WHERE ${WHERE_SERI}
          FOR UPDATE`,
        keyParams(key),
      );
      return rows[0] ?? null;
    },

    async increment(runner, id, userId) {
      const rows = await runner.query<{ urutan_terakhir: number }>(
        `UPDATE nomor_urut
            SET urutan_terakhir = urutan_terakhir + 1,
                updated_by = COALESCE($2, updated_by)
          WHERE id = $1
        RETURNING urutan_terakhir`,
        [id, userId],
      );
      const next = rows[0]?.urutan_terakhir;
      if (next === undefined) throw new Error(`nomor_urut ${id} hilang saat increment`);
      return next;
    },

    async peek(runner, key) {
      const rows = await runner.query<NomorUrutRow>(
        `SELECT id::text AS id, urutan_terakhir, format_template
           FROM nomor_urut
          WHERE ${WHERE_SERI}`,
        keyParams(key),
      );
      return rows[0] ?? null;
    },
  };
}
