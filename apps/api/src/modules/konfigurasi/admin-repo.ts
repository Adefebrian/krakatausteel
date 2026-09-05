// Data access for the ADMINISTRATION half of this module: the chart of accounts
// (spec 4.2, spec 9.4 "COA dengan tampilan tree dan validasi hierarki") and the
// five master reference tables (./master.ts).
//
// NO DELETE STATEMENT APPEARS IN THIS FILE, and for `akun` there could not be
// one: migration 0002 attaches `tjsl_block_delete` to it and 0021 blocks
// TRUNCATE, so the database refuses a physical delete outright. That is the
// schema agreeing with ADR 0005 rather than this file being cautious.
//
// IDENTIFIERS ARE NEVER INTERPOLATED FROM INPUT. The master statements build
// column lists from `DefinisiMaster`, which is a literal in ./master.ts; the
// route only ever chooses WHICH definition. `assertIdentifier` is the belt to
// that brace, and it throws rather than escaping, because a table name that
// needs escaping is a bug and not a value.
import type { QueryRunner } from "./ports";
import type { DefinisiMaster } from "./master";

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function ident(nama: string): string {
  if (!IDENT_RE.test(nama)) {
    throw new Error(`Nama kolom atau tabel tidak valid untuk master data: "${nama}"`);
  }
  return nama;
}

export interface AkunAdminRow {
  id: string;
  bumn_id: string;
  kode: string;
  nama: string;
  parent_id: string | null;
  parent_kode: string | null;
  level: number;
  tipe: string;
  saldo_normal: string;
  is_postable: boolean;
  is_kas: boolean;
  is_kontra: boolean;
  klasifikasi_arus_kas: string | null;
  klasifikasi_akun: string;
  aktif: boolean;
  version: number;
  /** Live children. A header with children can never become postable. */
  punya_anak: boolean;
  /** Named by an ACTIVE event mapping. The strongest reason to refuse a change. */
  dipakai_mapping: boolean;
  /** Carries at least one journal line. Its meaning is already in the books. */
  dipakai_jurnal: boolean;
}

export interface KlasifikasiRow {
  id: string;
  kode: string;
  nama: string;
  keterangan: string | null;
}

export interface BarisMaster {
  id: string;
  aktif: boolean;
  version: number;
  [kolom: string]: unknown;
}

export interface KonfigurasiAdminRepo {
  listAkun(runner: QueryRunner, bumnId: string): Promise<AkunAdminRow[]>;
  findAkunById(runner: QueryRunner, id: string): Promise<AkunAdminRow | null>;
  insertAkun(
    runner: QueryRunner,
    input: {
      bumnId: string;
      kode: string;
      nama: string;
      parentId: string | null;
      level: number;
      tipe: string;
      saldoNormal: string;
      isPostable: boolean;
      isKas: boolean;
      isKontra: boolean;
      klasifikasiArusKas: string | null;
      klasifikasiAkun: string;
      userId: string;
    },
  ): Promise<AkunAdminRow>;
  updateAkun(
    runner: QueryRunner,
    input: {
      id: string;
      nama: string | null;
      isKas: boolean | null;
      isKontra: boolean | null;
      isPostable: boolean | null;
      klasifikasiArusKas: string | null;
      klasifikasiAkun: string | null;
      userId: string;
      version: number | null;
    },
  ): Promise<AkunAdminRow | null>;
  setAktifAkun(
    runner: QueryRunner,
    input: { id: string; aktif: boolean; userId: string },
  ): Promise<AkunAdminRow | null>;
  kodeAkunDipakai(runner: QueryRunner, bumnId: string, kode: string): Promise<boolean>;
  listKlasifikasi(runner: QueryRunner, bumnId: string): Promise<KlasifikasiRow[]>;
  klasifikasiAda(runner: QueryRunner, bumnId: string, kode: string): Promise<boolean>;
  /** Event codes whose ACTIVE mapping names this account on either leg. */
  eventMappingUntukAkun(runner: QueryRunner, akunId: string): Promise<string[]>;

  listMaster(runner: QueryRunner, def: DefinisiMaster, bumnId: string): Promise<BarisMaster[]>;
  findMasterById(
    runner: QueryRunner,
    def: DefinisiMaster,
    id: string,
    bumnId: string,
  ): Promise<BarisMaster | null>;
  insertMaster(
    runner: QueryRunner,
    def: DefinisiMaster,
    input: { nilai: Record<string, unknown>; bumnId: string; userId: string },
  ): Promise<BarisMaster>;
  updateMaster(
    runner: QueryRunner,
    def: DefinisiMaster,
    input: {
      id: string;
      nilai: Record<string, unknown>;
      bumnId: string;
      userId: string;
      version: number | null;
    },
  ): Promise<BarisMaster | null>;
  setAktifMaster(
    runner: QueryRunner,
    def: DefinisiMaster,
    input: { id: string; aktif: boolean; bumnId: string; userId: string },
  ): Promise<BarisMaster | null>;
  masterKunciDipakai(
    runner: QueryRunner,
    def: DefinisiMaster,
    input: { nilai: Record<string, unknown>; bumnId: string; kecualiId: string | null },
  ): Promise<boolean>;
  refAda(
    runner: QueryRunner,
    tabel: string,
    id: string,
    bumnId: string | null,
  ): Promise<boolean>;
}

const KOLOM_AKUN = `a.id::text AS id, a.bumn_id::text AS bumn_id, a.kode, a.nama,
  a.parent_id::text AS parent_id, p.kode AS parent_kode, a.level, a.tipe, a.saldo_normal,
  a.is_postable, a.is_kas, a.is_kontra, a.klasifikasi_arus_kas, a.klasifikasi_akun,
  a.aktif, a.version,
  EXISTS (SELECT 1 FROM akun anak WHERE anak.parent_id = a.id AND anak.deleted_at IS NULL
            AND anak.aktif) AS punya_anak,
  EXISTS (SELECT 1 FROM event_jurnal_mapping m
           WHERE (m.akun_debit_id = a.id OR m.akun_kredit_id = a.id)
             AND m.aktif AND m.deleted_at IS NULL) AS dipakai_mapping,
  EXISTS (SELECT 1 FROM jurnal_baris jb WHERE jb.akun_id = a.id) AS dipakai_jurnal`;

const FROM_AKUN = `FROM akun a LEFT JOIN akun p ON p.id = a.parent_id`;

export function createKonfigurasiAdminRepo(): KonfigurasiAdminRepo {
  const repo: KonfigurasiAdminRepo = {
    async listAkun(runner, bumnId) {
      return runner.query<AkunAdminRow>(
        `SELECT ${KOLOM_AKUN} ${FROM_AKUN}
          WHERE a.bumn_id = $1 AND a.deleted_at IS NULL
          ORDER BY a.kode`,
        [bumnId],
      );
    },

    async findAkunById(runner, id) {
      const rows = await runner.query<AkunAdminRow>(
        `SELECT ${KOLOM_AKUN} ${FROM_AKUN} WHERE a.id = $1 AND a.deleted_at IS NULL`,
        [id],
      );
      return rows[0] ?? null;
    },

    async insertAkun(runner, input) {
      const rows = await runner.query<{ id: string }>(
        `INSERT INTO akun
           (bumn_id, kode, nama, parent_id, level, tipe, saldo_normal, is_postable, is_kas,
            is_kontra, klasifikasi_arus_kas, klasifikasi_akun, aktif, created_by, updated_by)
         VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $13)
         RETURNING id::text AS id`,
        [
          input.bumnId,
          input.kode,
          input.nama,
          input.parentId,
          input.level,
          input.tipe,
          input.saldoNormal,
          input.isPostable,
          input.isKas,
          input.isKontra,
          input.klasifikasiArusKas,
          input.klasifikasiAkun,
          input.userId,
        ],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("INSERT akun tidak mengembalikan baris");
      const row = await repo.findAkunById(runner, id);
      if (!row) throw new Error("akun baru tidak terbaca kembali");
      return row;
    },

    async updateAkun(runner, input) {
      // `kode`, `parent_id`, `level` and `tipe` are absent by design. They are
      // the identity and the position of the account in the tree, and both are
      // referred to by rows that are already posted. See the service.
      const rows = await runner.query<{ id: string }>(
        `UPDATE akun
            SET nama = COALESCE($2, nama),
                is_kas = COALESCE($3, is_kas),
                is_kontra = COALESCE($4, is_kontra),
                is_postable = COALESCE($5, is_postable),
                klasifikasi_arus_kas = COALESCE($6, klasifikasi_arus_kas),
                klasifikasi_akun = COALESCE($7, klasifikasi_akun),
                updated_by = $8
          WHERE id = $1 AND deleted_at IS NULL
            AND ($9::int IS NULL OR version = $9)
        RETURNING id::text AS id`,
        [
          input.id,
          input.nama,
          input.isKas,
          input.isKontra,
          input.isPostable,
          input.klasifikasiArusKas,
          input.klasifikasiAkun,
          input.userId,
          input.version,
        ],
      );
      if (!rows[0]) return null;
      return repo.findAkunById(runner, input.id);
    },

    async setAktifAkun(runner, input) {
      const rows = await runner.query<{ id: string }>(
        `UPDATE akun SET aktif = $2, updated_by = $3
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id::text AS id`,
        [input.id, input.aktif, input.userId],
      );
      if (!rows[0]) return null;
      return repo.findAkunById(runner, input.id);
    },

    async kodeAkunDipakai(runner, bumnId, kode) {
      const rows = await runner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM akun
          WHERE bumn_id = $1 AND kode = $2 AND deleted_at IS NULL`,
        [bumnId, kode],
      );
      return Number(rows[0]?.n ?? "0") > 0;
    },

    async listKlasifikasi(runner, bumnId) {
      return runner.query<KlasifikasiRow>(
        `SELECT id::text AS id, kode, nama, keterangan
           FROM klasifikasi_akun
          WHERE bumn_id = $1 AND deleted_at IS NULL
          ORDER BY urutan, kode`,
        [bumnId],
      );
    },

    async klasifikasiAda(runner, bumnId, kode) {
      const rows = await runner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM klasifikasi_akun
          WHERE bumn_id = $1 AND kode = $2 AND deleted_at IS NULL`,
        [bumnId, kode],
      );
      return Number(rows[0]?.n ?? "0") > 0;
    },

    async eventMappingUntukAkun(runner, akunId) {
      const rows = await runner.query<{ event_code: string }>(
        `SELECT DISTINCT event_code FROM event_jurnal_mapping
          WHERE (akun_debit_id = $1 OR akun_kredit_id = $1)
            AND aktif AND deleted_at IS NULL
          ORDER BY event_code`,
        [akunId],
      );
      return rows.map((r) => r.event_code);
    },

    // ---------------------------------------------------------- master data
    async listMaster(runner, def, bumnId) {
      const kolom = def.fields.map((f) => ident(f.kolom)).join(", ");
      const scope = def.scopeBumn ? "AND bumn_id = $1" : "";
      return runner.query<BarisMaster>(
        `SELECT id::text AS id, ${kolom}, aktif, version
           FROM ${ident(def.tabel)}
          WHERE deleted_at IS NULL ${scope}
          ORDER BY ${def.urutan}`,
        def.scopeBumn ? [bumnId] : [],
      );
    },

    async findMasterById(runner, def, id, bumnId) {
      const kolom = def.fields.map((f) => ident(f.kolom)).join(", ");
      const scope = def.scopeBumn ? "AND bumn_id = $2" : "";
      const rows = await runner.query<BarisMaster>(
        `SELECT id::text AS id, ${kolom}, aktif, version
           FROM ${ident(def.tabel)}
          WHERE id = $1 AND deleted_at IS NULL ${scope}`,
        def.scopeBumn ? [id, bumnId] : [id],
      );
      return rows[0] ?? null;
    },

    async insertMaster(runner, def, input) {
      const kolom: string[] = [];
      const params: unknown[] = [];
      for (const f of def.fields) {
        if (input.nilai[f.nama] === undefined) continue;
        kolom.push(ident(f.kolom));
        params.push(input.nilai[f.nama]);
      }
      if (def.scopeBumn) {
        kolom.push("bumn_id");
        params.push(input.bumnId);
      }
      kolom.push("created_by", "updated_by");
      params.push(input.userId, input.userId);
      const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
      const rows = await runner.query<{ id: string }>(
        `INSERT INTO ${ident(def.tabel)} (${kolom.join(", ")})
         VALUES (${placeholders})
         RETURNING id::text AS id`,
        params,
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`INSERT ${def.tabel} tidak mengembalikan baris`);
      const row = await repo.findMasterById(runner, def, id, input.bumnId);
      if (!row) throw new Error(`${def.tabel} baru tidak terbaca kembali`);
      return row;
    },

    async updateMaster(runner, def, input) {
      const set: string[] = [];
      const params: unknown[] = [input.id];
      for (const f of def.fields) {
        if (f.kunci) continue;
        if (input.nilai[f.nama] === undefined) continue;
        params.push(input.nilai[f.nama]);
        set.push(`${ident(f.kolom)} = $${params.length}`);
      }
      params.push(input.userId);
      set.push(`updated_by = $${params.length}`);
      params.push(input.version);
      const versi = `($${params.length}::int IS NULL OR version = $${params.length})`;
      let scope = "";
      if (def.scopeBumn) {
        params.push(input.bumnId);
        scope = `AND bumn_id = $${params.length}`;
      }
      const rows = await runner.query<{ id: string }>(
        `UPDATE ${ident(def.tabel)} SET ${set.join(", ")}
          WHERE id = $1 AND deleted_at IS NULL AND ${versi} ${scope}
        RETURNING id::text AS id`,
        params,
      );
      if (!rows[0]) return null;
      return repo.findMasterById(runner, def, input.id, input.bumnId);
    },

    async setAktifMaster(runner, def, input) {
      const params: unknown[] = [input.id, input.aktif, input.userId];
      let scope = "";
      if (def.scopeBumn) {
        params.push(input.bumnId);
        scope = `AND bumn_id = $${params.length}`;
      }
      const rows = await runner.query<{ id: string }>(
        `UPDATE ${ident(def.tabel)} SET aktif = $2, updated_by = $3
          WHERE id = $1 AND deleted_at IS NULL ${scope}
        RETURNING id::text AS id`,
        params,
      );
      if (!rows[0]) return null;
      return repo.findMasterById(runner, def, input.id, input.bumnId);
    },

    async masterKunciDipakai(runner, def, input) {
      const where: string[] = ["deleted_at IS NULL"];
      const params: unknown[] = [];
      for (const kolom of def.kunciUnik) {
        const field = def.fields.find((f) => f.kolom === kolom);
        if (!field) throw new Error(`kunci unik ${kolom} tidak ada di definisi ${def.jenis}`);
        params.push(input.nilai[field.nama] ?? null);
        where.push(`${ident(kolom)} = $${params.length}`);
      }
      if (def.scopeBumn) {
        params.push(input.bumnId);
        where.push(`bumn_id = $${params.length}`);
      }
      if (input.kecualiId) {
        params.push(input.kecualiId);
        where.push(`id <> $${params.length}::uuid`);
      }
      const rows = await runner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${ident(def.tabel)} WHERE ${where.join(" AND ")}`,
        params,
      );
      return Number(rows[0]?.n ?? "0") > 0;
    },

    async refAda(runner, tabel, id, bumnId) {
      const scope = bumnId === null ? "" : "AND bumn_id = $2";
      const rows = await runner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${ident(tabel)}
          WHERE id = $1 AND deleted_at IS NULL ${scope}`,
        bumnId === null ? [id] : [id, bumnId],
      );
      return Number(rows[0]?.n ?? "0") > 0;
    },
  };
  return repo;
}
