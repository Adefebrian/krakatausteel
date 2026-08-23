// Seeds the configuration keys that have no migration of their own.
//
// migrations/0004 ships every parameter named in spec 5 (21 rows). The
// regulation review in docs/BUILD-PLAN.md ("Dampak temuan regulasi ke
// kemampuan engine") then added capability switches that the spec does not
// mention: two penyisihan modes, flat-from-effective rate derivation, more
// than one live report template, the penghapusbukuan / penghapustagihan split,
// and short-term top-up. Those are DEFAULTS, not schema, so they are seeded
// as global rows (bumn_id NULL) rather than hidden as `?? "RATE_TABLE"` in the
// engine: a default in code cannot be changed without a deploy, which is
// exactly what spec rule 3 forbids.
//
// Idempotent: existing rows are never overwritten, so an operator's change
// survives the next `db:seed`.
import { entriTambahan, tipeDataUntuk } from "../modules/konfigurasi";
import type { DbPort } from "../core/ports/db";

export async function seedKonfigurasiTambahan(db: DbPort): Promise<{ inserted: number; total: number }> {
  const entries = entriTambahan();
  let inserted = 0;
  for (const entri of entries) {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO konfigurasi
         (bumn_id, grup, kunci, nilai, tipe_data, pilihan_json, deskripsi, perlu_konfirmasi)
       VALUES (NULL, $1, $2, $3, $4, $5::jsonb, $6, true)
       ON CONFLICT (bumn_id, grup, kunci) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id::text AS id`,
      [
        entri.grup,
        entri.kunci,
        entri.nilaiDefault,
        tipeDataUntuk(entri.bentuk),
        entri.pilihan ? JSON.stringify(entri.pilihan) : null,
        entri.deskripsi,
      ],
    );
    if (rows.length > 0) inserted += 1;
  }
  return { inserted, total: entries.length };
}
