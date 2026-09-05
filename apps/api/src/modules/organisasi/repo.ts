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

// ---------------------------------------------------------------------------
// WRITE SIDE (spec 9.4 "Manajemen User", "Master Cabang", "Master Karyawan")
// ---------------------------------------------------------------------------
//
// THERE IS NO DELETE IN THIS FILE, AND THAT IS THE DESIGN.
//
// Every row here is referenced by posted history. A branch id sits on every
// journal, every akad and every document number ever issued; an employee id is
// the surveyor named on a proposal; a user id is `created_by` on rows an
// auditor will read years from now, and `audit_log.user_id` is a foreign key to
// `app_user` that append-only rows can never lose. Physically removing any of
// them either fails on a foreign key or, worse, succeeds and rewrites what the
// past meant. So the only "removal" this module offers is `aktif = false`:
// the row keeps answering every historical read and stops being offered to any
// new one. ADR 0005 is the general rule; this is it applied per entity.
//
// SOFT DELETE (`deleted_at`) IS NOT OFFERED EITHER, and that is a narrower
// decision. The columns exist, and the partial unique indexes are written so a
// soft-deleted row releases its code, which means soft-deleting a branch would
// let a second branch take code "01" and make two different branches share one
// prefix in the document numbering series. Deactivation keeps the code
// reserved, which is what history needs.

export interface PenggunaRow {
  id: string;
  cabang_id: string;
  cabang_kode: string;
  cabang_nama: string;
  bumn_id: string;
  nip: string | null;
  nama: string;
  email: string;
  username: string;
  aktif: boolean;
  harus_ganti_sandi: boolean;
  last_login_at: string | null;
  sandi_diubah_at: string | null;
  version: number;
  /** `KODE` or `KODE@cabangId` for a role granted in another branch. */
  peran: string[] | null;
}

export interface PeranGrant {
  kode: string;
  scopeCabangId: string | null;
}

export interface BuatPenggunaInput {
  cabangId: string;
  nip: string | null;
  nama: string;
  email: string;
  username: string;
  passwordHash: string;
  userId: string;
}

export interface UbahPenggunaInput {
  id: string;
  nama: string | null;
  email: string | null;
  nip: string | null;
  cabangId: string | null;
  userId: string;
  version: number | null;
}

export interface BuatCabangInput {
  bumnId: string;
  kode: string;
  nama: string;
  alamat: string | null;
  kotaId: string | null;
  isPusat: boolean;
  userId: string;
}

export interface BuatKaryawanInput {
  cabangId: string;
  nip: string | null;
  nama: string;
  jabatan: string | null;
  unit: string | null;
  userId: string;
}

const KOLOM_PENGGUNA = `u.id::text AS id, u.cabang_id::text AS cabang_id, c.kode AS cabang_kode,
  c.nama AS cabang_nama, c.bumn_id::text AS bumn_id, u.nip, u.nama, u.email, u.username,
  u.aktif, u.harus_ganti_sandi, u.last_login_at::text AS last_login_at,
  u.sandi_diubah_at::text AS sandi_diubah_at, u.version,
  COALESCE((
    SELECT array_agg(r.kode || COALESCE('@' || ur.scope_cabang_id::text, '') ORDER BY r.kode)
      FROM user_role ur JOIN app_role r ON r.id = ur.role_id
     WHERE ur.user_id = u.id AND r.deleted_at IS NULL
  ), '{}') AS peran`;

export interface OrganisasiAdminRepo {
  listPengguna(
    runner: QueryRunner,
    bumnId: string,
    cabangIds: readonly string[] | null,
  ): Promise<PenggunaRow[]>;
  findPenggunaById(runner: QueryRunner, id: string): Promise<PenggunaRow | null>;
  insertPengguna(runner: QueryRunner, input: BuatPenggunaInput): Promise<PenggunaRow>;
  updatePengguna(runner: QueryRunner, input: UbahPenggunaInput): Promise<PenggunaRow | null>;
  setAktifPengguna(
    runner: QueryRunner,
    input: { id: string; aktif: boolean; userId: string },
  ): Promise<PenggunaRow | null>;
  setSandiPengguna(
    runner: QueryRunner,
    input: { id: string; passwordHash: string; harusGanti: boolean; userId: string },
  ): Promise<number>;
  gantiPeran(
    runner: QueryRunner,
    input: { userId: string; peran: readonly PeranGrant[]; olehUserId: string },
  ): Promise<void>;
  /** Role ids by code, for the grant write. Unknown codes simply do not appear. */
  roleIdByKode(runner: QueryRunner, kode: readonly string[]): Promise<Map<string, string>>;
  jumlahPenggunaAktif(runner: QueryRunner, cabangId: string): Promise<number>;
  /**
   * Which of `username` / `email` is already taken, ignoring `kecualiId`.
   *
   * The unique indexes are still the guarantee; this read is what turns
   * "duplicate key value violates constraint app_user_username_uq" into a
   * sentence naming the field. core/http.ts logs a full stack whenever a
   * database guard fires, precisely so a missing service-layer mirror like this
   * one is visible in the log rather than silently costing error quality.
   */
  kredensialDipakai(
    runner: QueryRunner,
    input: { username: string | null; email: string | null; kecualiId: string | null },
  ): Promise<{ username: boolean; email: boolean }>;
  kodeCabangDipakai(runner: QueryRunner, bumnId: string, kode: string): Promise<boolean>;
  nipKaryawanDipakai(runner: QueryRunner, nip: string, kecualiId: string | null): Promise<boolean>;

  insertCabang(runner: QueryRunner, input: BuatCabangInput): Promise<CabangRow>;
  updateCabang(
    runner: QueryRunner,
    input: {
      id: string;
      nama: string | null;
      alamat: string | null;
      kotaId: string | null;
      userId: string;
      version: number | null;
    },
  ): Promise<CabangRow | null>;
  setAktifCabang(
    runner: QueryRunner,
    input: { id: string; aktif: boolean; userId: string },
  ): Promise<CabangRow | null>;
  adaPusat(runner: QueryRunner, bumnId: string): Promise<boolean>;

  insertKaryawan(runner: QueryRunner, input: BuatKaryawanInput): Promise<KaryawanRow>;
  updateKaryawan(
    runner: QueryRunner,
    input: {
      id: string;
      nama: string | null;
      nip: string | null;
      jabatan: string | null;
      unit: string | null;
      cabangId: string | null;
      userId: string;
      version: number | null;
    },
  ): Promise<KaryawanRow | null>;
  setAktifKaryawan(
    runner: QueryRunner,
    input: { id: string; aktif: boolean; userId: string },
  ): Promise<KaryawanRow | null>;
}

const KOLOM_CABANG = `id::text AS id, bumn_id::text AS bumn_id, kode, nama, alamat, is_pusat, aktif`;
const KOLOM_KARYAWAN = `k.id::text AS id, k.cabang_id::text AS cabang_id, c.bumn_id::text AS bumn_id,
  k.nip, k.nama, k.jabatan, k.unit, k.aktif`;

export function createOrganisasiAdminRepo(): OrganisasiAdminRepo {
  const repo: OrganisasiAdminRepo = {
    async listPengguna(runner, bumnId, cabangIds) {
      return runner.query<PenggunaRow>(
        `SELECT ${KOLOM_PENGGUNA}
           FROM app_user u
           JOIN cabang c ON c.id = u.cabang_id
          WHERE u.deleted_at IS NULL
            AND c.bumn_id = $1
            AND ($2::uuid[] IS NULL OR u.cabang_id = ANY($2::uuid[]))
          ORDER BY u.aktif DESC, u.nama`,
        [bumnId, cabangIds],
      );
    },

    async findPenggunaById(runner, id) {
      // Read then check, the pattern documented at the top of this file: the id
      // selects the row, the row states its branch, the service decides.
      const rows = await runner.query<PenggunaRow>(
        `SELECT ${KOLOM_PENGGUNA}
           FROM app_user u
           JOIN cabang c ON c.id = u.cabang_id
          WHERE u.id = $1 AND u.deleted_at IS NULL AND c.deleted_at IS NULL`,
        [id],
      );
      return rows[0] ?? null;
    },

    async insertPengguna(runner, input) {
      const rows = await runner.query<{ id: string }>(
        `INSERT INTO app_user
           (cabang_id, nip, nama, email, username, password_hash, aktif,
            harus_ganti_sandi, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, true, true, $7, $7)
         RETURNING id::text AS id`,
        [input.cabangId, input.nip, input.nama, input.email, input.username, input.passwordHash, input.userId],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("INSERT app_user tidak mengembalikan baris");
      const row = await repo.findPenggunaById(runner, id);
      if (!row) throw new Error("app_user baru tidak terbaca kembali");
      return row;
    },

    async updatePengguna(runner, input) {
      // COALESCE per column so a PATCH that omits a field leaves it alone, and
      // `($n::int IS NULL OR version = $n)` so a stale version updates nothing
      // and the service can answer 409 instead of last-write-wins (ADR 0005).
      const rows = await runner.query<{ id: string }>(
        `UPDATE app_user
            SET nama = COALESCE($2, nama),
                email = COALESCE($3, email),
                nip = COALESCE($4, nip),
                cabang_id = COALESCE($5::uuid, cabang_id),
                updated_by = $6
          WHERE id = $1 AND deleted_at IS NULL
            AND ($7::int IS NULL OR version = $7)
        RETURNING id::text AS id`,
        [input.id, input.nama, input.email, input.nip, input.cabangId, input.userId, input.version],
      );
      if (!rows[0]) return null;
      return repo.findPenggunaById(runner, input.id);
    },

    async setAktifPengguna(runner, input) {
      const rows = await runner.query<{ id: string }>(
        `UPDATE app_user SET aktif = $2, updated_by = $3
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id::text AS id`,
        [input.id, input.aktif, input.userId],
      );
      if (!rows[0]) return null;
      return repo.findPenggunaById(runner, input.id);
    },

    async setSandiPengguna(runner, input) {
      // `sandi_diubah_at` moves only when the OWNER chose the password. A reset
      // by an administrator leaves it where it was, because the question that
      // column answers is "when did this account last hold a secret only its
      // owner knew", and a handover is the opposite of that.
      const rows = await runner.query<{ id: string }>(
        `UPDATE app_user
            SET password_hash = $2,
                harus_ganti_sandi = $3,
                sandi_diubah_at = CASE WHEN $3 THEN sandi_diubah_at ELSE now() END,
                updated_by = $4
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id::text AS id`,
        [input.id, input.passwordHash, input.harusGanti, input.userId],
      );
      return rows.length;
    },

    async roleIdByKode(runner, kode) {
      if (kode.length === 0) return new Map();
      const rows = await runner.query<{ kode: string; id: string }>(
        // `= ANY($1::text[])`, with the cast spelled out: a JS array binds as a
        // comma-joined string otherwise and the comparison fails with 22P02.
        // See the driver note at the top of modules/jurnal/repo.ts.
        `SELECT kode, id::text AS id FROM app_role
          WHERE kode = ANY($1::text[]) AND aktif AND deleted_at IS NULL`,
        [kode],
      );
      return new Map(rows.map((r) => [r.kode, r.id]));
    },

    async gantiPeran(runner, input) {
      // REPLACE, not merge: the request states the complete set of roles the
      // account should hold, so a role left out is a role revoked. Merging
      // would make revocation impossible through this endpoint, and "remove a
      // privilege" is the operation that has to work.
      await runner.query(`DELETE FROM user_role WHERE user_id = $1`, [input.userId]);
      for (const grant of input.peran) {
        await runner.query(
          `INSERT INTO user_role (user_id, role_id, scope_cabang_id, created_by)
           SELECT $1, id, $3::uuid, $4 FROM app_role
            WHERE kode = $2 AND aktif AND deleted_at IS NULL`,
          [input.userId, grant.kode, grant.scopeCabangId, input.olehUserId],
        );
      }
    },

    async jumlahPenggunaAktif(runner, cabangId) {
      const rows = await runner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM app_user
          WHERE cabang_id = $1 AND aktif AND deleted_at IS NULL`,
        [cabangId],
      );
      return Number(rows[0]?.n ?? "0");
    },

    async kredensialDipakai(runner, input) {
      const rows = await runner.query<{ username_dipakai: boolean; email_dipakai: boolean }>(
        `SELECT bool_or($1::text IS NOT NULL AND lower(username) = lower($1)) AS username_dipakai,
                bool_or($2::text IS NOT NULL AND lower(email) = lower($2))    AS email_dipakai
           FROM app_user
          WHERE deleted_at IS NULL
            AND ($3::uuid IS NULL OR id <> $3::uuid)`,
        [input.username, input.email, input.kecualiId],
      );
      return {
        username: rows[0]?.username_dipakai === true,
        email: rows[0]?.email_dipakai === true,
      };
    },

    async kodeCabangDipakai(runner, bumnId, kode) {
      const rows = await runner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM cabang
          WHERE bumn_id = $1 AND kode = $2 AND deleted_at IS NULL`,
        [bumnId, kode],
      );
      return Number(rows[0]?.n ?? "0") > 0;
    },

    async nipKaryawanDipakai(runner, nip, kecualiId) {
      // `karyawan_nip_uq` is GLOBAL, not per branch or per entity: an NIP is a
      // national employee number, so the check has to be global too or the
      // service would clear a value the index then refuses.
      const rows = await runner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM karyawan
          WHERE nip = $1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [nip, kecualiId],
      );
      return Number(rows[0]?.n ?? "0") > 0;
    },

    async insertCabang(runner, input) {
      const rows = await runner.query<CabangRow>(
        `INSERT INTO cabang (bumn_id, kode, nama, alamat, kota_id, is_pusat, aktif, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5::uuid, $6, true, $7, $7)
         RETURNING ${KOLOM_CABANG}`,
        [input.bumnId, input.kode, input.nama, input.alamat, input.kotaId, input.isPusat, input.userId],
      );
      const row = rows[0];
      if (!row) throw new Error("INSERT cabang tidak mengembalikan baris");
      return row;
    },

    async updateCabang(runner, input) {
      // `kode` and `is_pusat` are absent on purpose; see the service.
      const rows = await runner.query<CabangRow>(
        `UPDATE cabang
            SET nama = COALESCE($2, nama),
                alamat = COALESCE($3, alamat),
                kota_id = COALESCE($4::uuid, kota_id),
                updated_by = $5
          WHERE id = $1 AND deleted_at IS NULL
            AND ($6::int IS NULL OR version = $6)
        RETURNING ${KOLOM_CABANG}`,
        [input.id, input.nama, input.alamat, input.kotaId, input.userId, input.version],
      );
      return rows[0] ?? null;
    },

    async setAktifCabang(runner, input) {
      const rows = await runner.query<CabangRow>(
        `UPDATE cabang SET aktif = $2, updated_by = $3
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING ${KOLOM_CABANG}`,
        [input.id, input.aktif, input.userId],
      );
      return rows[0] ?? null;
    },

    async adaPusat(runner, bumnId) {
      const rows = await runner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM cabang
          WHERE bumn_id = $1 AND is_pusat AND deleted_at IS NULL`,
        [bumnId],
      );
      return Number(rows[0]?.n ?? "0") > 0;
    },

    async insertKaryawan(runner, input) {
      const rows = await runner.query<{ id: string }>(
        `INSERT INTO karyawan (cabang_id, nip, nama, jabatan, unit, aktif, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, true, $6, $6)
         RETURNING id::text AS id`,
        [input.cabangId, input.nip, input.nama, input.jabatan, input.unit, input.userId],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error("INSERT karyawan tidak mengembalikan baris");
      const dibaca = await runner.query<KaryawanRow>(
        `SELECT ${KOLOM_KARYAWAN} FROM karyawan k JOIN cabang c ON c.id = k.cabang_id WHERE k.id = $1`,
        [id],
      );
      const row = dibaca[0];
      if (!row) throw new Error("karyawan baru tidak terbaca kembali");
      return row;
    },

    async updateKaryawan(runner, input) {
      const rows = await runner.query<{ id: string }>(
        `UPDATE karyawan
            SET nama = COALESCE($2, nama),
                nip = COALESCE($3, nip),
                jabatan = COALESCE($4, jabatan),
                unit = COALESCE($5, unit),
                cabang_id = COALESCE($6::uuid, cabang_id),
                updated_by = $7
          WHERE id = $1 AND deleted_at IS NULL
            AND ($8::int IS NULL OR version = $8)
        RETURNING id::text AS id`,
        [input.id, input.nama, input.nip, input.jabatan, input.unit, input.cabangId, input.userId, input.version],
      );
      if (!rows[0]) return null;
      const dibaca = await runner.query<KaryawanRow>(
        `SELECT ${KOLOM_KARYAWAN} FROM karyawan k JOIN cabang c ON c.id = k.cabang_id WHERE k.id = $1`,
        [input.id],
      );
      return dibaca[0] ?? null;
    },

    async setAktifKaryawan(runner, input) {
      const rows = await runner.query<{ id: string }>(
        `UPDATE karyawan SET aktif = $2, updated_by = $3
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id::text AS id`,
        [input.id, input.aktif, input.userId],
      );
      if (!rows[0]) return null;
      const dibaca = await runner.query<KaryawanRow>(
        `SELECT ${KOLOM_KARYAWAN} FROM karyawan k JOIN cabang c ON c.id = k.cabang_id WHERE k.id = $1`,
        [input.id],
      );
      return dibaca[0] ?? null;
    },
  };
  return repo;
}
