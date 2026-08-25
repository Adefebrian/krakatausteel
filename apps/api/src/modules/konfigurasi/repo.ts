// Data access for the konfigurasi table (spec 4.10, spec 5).
//
// SCOPE RESOLUTION, as documented at the top of migrations/0004: a row with
// bumn_id NULL is the platform default shipped by the migration, and a row
// with bumn_id set is that entity's override. Reads take both and prefer the
// override; writes never mutate a shipped default, they insert or update an
// override, so "what did we ship" stays recoverable.
import type { QueryRunner } from "./ports";

export interface KonfigurasiRow {
  id: string;
  bumn_id: string | null;
  grup: string;
  kunci: string;
  nilai: string | null;
  tipe_data: string;
  pilihan_json: unknown;
  deskripsi: string | null;
  perlu_konfirmasi: boolean;
  diubah_oleh: string | null;
  diubah_at: string;
  version: number;
}

export interface KolektibilitasRangeRow {
  kelas_kode: string;
  hari_min: number;
  hari_max: number | null;
  berlaku_dari: string;
}

export interface PenyisihanRateRow {
  kelas_kode: string;
  rate: string;
  dasar_perhitungan: string;
  berlaku_dari: string;
}

/** The shape every reference picker in the SPA renders: id, code, label. */
export interface ReferensiRow {
  id: string;
  kode: string;
  nama: string;
}

export interface AlokasiPresetRow {
  komponen: string;
  urutan: number;
}

export interface KonfigurasiRepo {
  /** Every row visible to `bumnId`: its overrides plus the global defaults. */
  listForBumn(runner: QueryRunner, bumnId: string | null): Promise<KonfigurasiRow[]>;
  /** Locks the override row for update, or returns null when there is none yet. */
  lockOverride(
    runner: QueryRunner,
    bumnId: string,
    grup: string,
    kunci: string,
  ): Promise<KonfigurasiRow | null>;
  findGlobal(runner: QueryRunner, grup: string, kunci: string): Promise<KonfigurasiRow | null>;
  insertOverride(
    runner: QueryRunner,
    input: {
      bumnId: string;
      grup: string;
      kunci: string;
      nilai: string;
      tipeData: string;
      pilihan: readonly string[] | null;
      deskripsi: string | null;
      userId: string;
    },
  ): Promise<KonfigurasiRow>;
  updateOverride(
    runner: QueryRunner,
    input: { id: string; nilai: string; userId: string; version?: number | undefined },
  ): Promise<KonfigurasiRow | null>;
  kolektibilitasRanges(
    runner: QueryRunner,
    bumnId: string | null,
    perTanggal: string,
  ): Promise<KolektibilitasRangeRow[]>;
  penyisihanRates(
    runner: QueryRunner,
    bumnId: string | null,
    perTanggal: string,
  ): Promise<PenyisihanRateRow[]>;
  alokasiPreset(runner: QueryRunner, kode: string): Promise<AlokasiPresetRow[]>;
  /** Active sektor usaha for a bumn (spec 4.3, the PUMK proposal filter). */
  listSektor(runner: QueryRunner, bumnId: string): Promise<ReferensiRow[]>;
  /**
   * Postable cash and bank accounts (spec 4.2 `is_kas`). The one list a form
   * may offer where a transaction names an account: the journal engine refuses
   * anything else, so offering more would only produce a rejected posting.
   */
  listAkunKas(runner: QueryRunner, bumnId: string): Promise<ReferensiRow[]>;
}

const KOLOM = `id::text AS id, bumn_id::text AS bumn_id, grup, kunci, nilai, tipe_data,
               pilihan_json, deskripsi, perlu_konfirmasi, diubah_oleh::text AS diubah_oleh,
               diubah_at, version`;

export function createKonfigurasiRepo(): KonfigurasiRepo {
  return {
    async listForBumn(runner, bumnId) {
      return runner.query<KonfigurasiRow>(
        `SELECT ${KOLOM}
           FROM konfigurasi
          WHERE deleted_at IS NULL
            AND (bumn_id IS NULL OR bumn_id = $1)
          ORDER BY grup, kunci, bumn_id NULLS LAST`,
        [bumnId],
      );
    },

    async lockOverride(runner, bumnId, grup, kunci) {
      // FOR UPDATE so two concurrent edits of the same parameter serialise
      // instead of one silently overwriting the other's before-value in the
      // audit log.
      const rows = await runner.query<KonfigurasiRow>(
        `SELECT ${KOLOM}
           FROM konfigurasi
          WHERE bumn_id = $1 AND grup = $2 AND kunci = $3 AND deleted_at IS NULL
          FOR UPDATE`,
        [bumnId, grup, kunci],
      );
      return rows[0] ?? null;
    },

    async findGlobal(runner, grup, kunci) {
      const rows = await runner.query<KonfigurasiRow>(
        `SELECT ${KOLOM}
           FROM konfigurasi
          WHERE bumn_id IS NULL AND grup = $1 AND kunci = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [grup, kunci],
      );
      return rows[0] ?? null;
    },

    async insertOverride(runner, input) {
      const rows = await runner.query<KonfigurasiRow>(
        `INSERT INTO konfigurasi
           (bumn_id, grup, kunci, nilai, tipe_data, pilihan_json, deskripsi,
            perlu_konfirmasi, diubah_oleh, diubah_at, created_by, updated_by)
         -- $6::text::jsonb, not $6::jsonb: with a bun:sql-backed QueryRunner the
         -- latter stores the JSON as a string SCALAR instead of an array, so
         -- pilihan_json would stop being queryable. See modules/audit/repo.ts.
         VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, false, $8, now(), $8, $8)
         RETURNING ${KOLOM}`,
        [
          input.bumnId,
          input.grup,
          input.kunci,
          input.nilai,
          input.tipeData,
          input.pilihan ? JSON.stringify(input.pilihan) : null,
          input.deskripsi,
          input.userId,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("INSERT konfigurasi tidak mengembalikan baris");
      return row;
    },

    async updateOverride(runner, input) {
      // Optimistic concurrency when the caller sent a version (ADR 0005 says
      // the API should use it): a stale version updates nothing, which the
      // service turns into a 409 rather than a last-write-wins overwrite.
      const rows = await runner.query<KonfigurasiRow>(
        `UPDATE konfigurasi
            SET nilai = $2,
                diubah_oleh = $3,
                diubah_at = now(),
                updated_by = $3,
                perlu_konfirmasi = false
          WHERE id = $1
            AND deleted_at IS NULL
            AND ($4::int IS NULL OR version = $4)
        RETURNING ${KOLOM}`,
        [input.id, input.nilai, input.userId, input.version ?? null],
      );
      return rows[0] ?? null;
    },

    async kolektibilitasRanges(runner, bumnId, perTanggal) {
      // Effective dating (migrations/0004): the row in force on a date is the
      // one with the greatest berlaku_dari <= that date, per class. An entity
      // override wins over the global default outright (it is ordered first),
      // because "this BUMN decided differently" is not something a later
      // platform-wide default should quietly undo.
      return runner.query<KolektibilitasRangeRow>(
        `SELECT DISTINCT ON (kelas_kode) kelas_kode, hari_min, hari_max, berlaku_dari
           FROM kolektibilitas_range
          WHERE deleted_at IS NULL AND aktif
            AND berlaku_dari <= $2::date
            AND (bumn_id IS NULL OR bumn_id = $1)
          ORDER BY kelas_kode, (bumn_id IS NOT NULL) DESC, berlaku_dari DESC`,
        [bumnId, perTanggal],
      );
    },

    async penyisihanRates(runner, bumnId, perTanggal) {
      return runner.query<PenyisihanRateRow>(
        `SELECT DISTINCT ON (kelas_kode) kelas_kode, rate::text AS rate, dasar_perhitungan, berlaku_dari
           FROM penyisihan_rate
          WHERE deleted_at IS NULL AND aktif
            AND berlaku_dari <= $2::date
            AND (bumn_id IS NULL OR bumn_id = $1)
          ORDER BY kelas_kode, (bumn_id IS NOT NULL) DESC, berlaku_dari DESC`,
        [bumnId, perTanggal],
      );
    },

    async listSektor(runner, bumnId) {
      return runner.query<ReferensiRow>(
        `SELECT id::text AS id, kode, nama
           FROM sektor_pumk
          WHERE bumn_id = $1 AND aktif AND deleted_at IS NULL
          ORDER BY urutan ASC, kode ASC`,
        [bumnId],
      );
    },

    async listAkunKas(runner, bumnId) {
      return runner.query<ReferensiRow>(
        `SELECT id::text AS id, kode, nama
           FROM akun
          WHERE bumn_id = $1 AND is_kas AND is_postable AND aktif AND deleted_at IS NULL
          ORDER BY kode ASC`,
        [bumnId],
      );
    },

    async alokasiPreset(runner, kode) {
      return runner.query<AlokasiPresetRow>(
        `SELECT komponen, urutan
           FROM alokasi_setoran_preset
          WHERE kode = $1 AND aktif
          ORDER BY urutan`,
        [kode],
      );
    },
  };
}
