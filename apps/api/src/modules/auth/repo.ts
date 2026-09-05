// Data access for authentication and authorisation: app_user, app_role,
// permission, role_permission, user_role, cabang (spec 4.1) plus the current
// periode (spec 4.7) the SPA session payload needs.
//
// Every read filters `deleted_at IS NULL` (ADR 0005: soft delete is the only
// delete, so a missing filter resurrects a deactivated account) and `aktif`,
// so deactivating a user invalidates their next request without anyone having
// to hunt down their sessions.
import type { QueryRunner } from "./ports";

export interface UserCredentialRow {
  id: string;
  username: string;
  nama: string;
  password_hash: string;
  aktif: boolean;
}

export interface PrincipalRow {
  user_id: string;
  username: string;
  nama: string;
  cabang_id: string;
  cabang_kode: string;
  cabang_nama: string;
  bumn_id: string;
  roles: string[] | null;
  permissions: string[] | null;
  /** migrations/0035: still holding the password an administrator issued. */
  harus_ganti_sandi: boolean;
  /** Extra branches granted through user_role.scope_cabang_id. */
  scope_cabang_ids: string[] | null;
}

export interface CabangRow {
  id: string;
  kode: string;
  nama: string;
}

export interface PeriodeRow {
  tahun: number;
  bulan: number;
  status: "OPEN" | "CLOSING_IN_PROGRESS" | "CLOSED";
}

export interface AuthRepo {
  findCredentialByUsername(runner: QueryRunner, username: string): Promise<UserCredentialRow | null>;
  loadPrincipal(runner: QueryRunner, userId: string): Promise<PrincipalRow | null>;
  listCabang(runner: QueryRunner, bumnId: string): Promise<CabangRow[]>;
  findCabangByIds(runner: QueryRunner, ids: readonly string[]): Promise<CabangRow[]>;
  currentPeriode(runner: QueryRunner, bumnId: string): Promise<PeriodeRow | null>;
  touchLastLogin(runner: QueryRunner, userId: string): Promise<void>;
  /**
   * The hash and the forced-change flag for one user id, for "change my own
   * password". Separate from `findCredentialByUsername` because that one is
   * the LOGIN path and is written for a constant-time username lookup.
   */
  findCredentialById(runner: QueryRunner, userId: string): Promise<UserCredentialRow | null>;
  /**
   * Replaces a password with one the OWNER chose: the forced-change flag drops
   * and `sandi_diubah_at` moves. An administrator's reset takes the other path
   * (modules/organisasi), where the timestamp deliberately does not move.
   */
  simpanSandiSendiri(runner: QueryRunner, userId: string, passwordHash: string): Promise<number>;
}

export function createAuthRepo(): AuthRepo {
  return {
    async findCredentialByUsername(runner, username) {
      // lower(username) matches the partial unique index app_user_username_uq,
      // so this is an index lookup and login is case-insensitive.
      const rows = await runner.query<UserCredentialRow>(
        `SELECT id::text AS id, username, nama, password_hash, aktif
           FROM app_user
          WHERE lower(username) = lower($1) AND deleted_at IS NULL
          LIMIT 1`,
        [username],
      );
      return rows[0] ?? null;
    },

    async loadPrincipal(runner, userId) {
      // One round trip: the role and permission sets are correlated
      // subqueries rather than joins, so a user with three roles does not
      // multiply the user row and need de-duplication in JS.
      const rows = await runner.query<PrincipalRow>(
        `SELECT u.id::text        AS user_id,
                u.username        AS username,
                u.nama            AS nama,
                u.harus_ganti_sandi AS harus_ganti_sandi,
                c.id::text        AS cabang_id,
                c.kode            AS cabang_kode,
                c.nama            AS cabang_nama,
                c.bumn_id::text   AS bumn_id,
                COALESCE((
                  SELECT array_agg(DISTINCT r.kode)
                    FROM user_role ur
                    JOIN app_role r ON r.id = ur.role_id
                   WHERE ur.user_id = u.id AND r.aktif AND r.deleted_at IS NULL
                ), '{}')          AS roles,
                COALESCE((
                  SELECT array_agg(DISTINCT p.kode)
                    FROM user_role ur
                    JOIN app_role r ON r.id = ur.role_id
                    JOIN role_permission rp ON rp.role_id = r.id
                    JOIN permission p ON p.id = rp.permission_id
                   WHERE ur.user_id = u.id AND r.aktif AND r.deleted_at IS NULL AND p.aktif
                ), '{}')          AS permissions,
                COALESCE((
                  SELECT array_agg(DISTINCT ur.scope_cabang_id::text)
                    FROM user_role ur
                    JOIN app_role r ON r.id = ur.role_id
                   WHERE ur.user_id = u.id AND ur.scope_cabang_id IS NOT NULL
                     AND r.aktif AND r.deleted_at IS NULL
                ), '{}')          AS scope_cabang_ids
           FROM app_user u
           JOIN cabang c ON c.id = u.cabang_id
          WHERE u.id = $1
            AND u.aktif
            AND u.deleted_at IS NULL
            AND c.deleted_at IS NULL
          LIMIT 1`,
        [userId],
      );
      return rows[0] ?? null;
    },

    async listCabang(runner, bumnId) {
      return runner.query<CabangRow>(
        `SELECT id::text AS id, kode, nama
           FROM cabang
          WHERE bumn_id = $1 AND aktif AND deleted_at IS NULL
          ORDER BY is_pusat DESC, kode`,
        [bumnId],
      );
    },

    async findCabangByIds(runner, ids) {
      if (ids.length === 0) return [];
      return runner.query<CabangRow>(
        `SELECT id::text AS id, kode, nama
           FROM cabang
          WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
          ORDER BY is_pusat DESC, kode`,
        [ids],
      );
    },

    async currentPeriode(runner, bumnId) {
      // The working period is the OLDEST period that is not CLOSED: invariant
      // 6 closes periods in order, so everything before it is closed and
      // everything after it is not yet reachable.
      const rows = await runner.query<PeriodeRow>(
        `SELECT tahun, bulan, status
           FROM periode
          WHERE bumn_id = $1 AND status <> 'CLOSED' AND deleted_at IS NULL
          ORDER BY tahun, bulan
          LIMIT 1`,
        [bumnId],
      );
      return rows[0] ?? null;
    },

    async findCredentialById(runner, userId) {
      const rows = await runner.query<UserCredentialRow>(
        `SELECT id::text AS id, username, nama, password_hash, aktif
           FROM app_user
          WHERE id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [userId],
      );
      return rows[0] ?? null;
    },

    async simpanSandiSendiri(runner, userId, passwordHash) {
      const rows = await runner.query<{ id: string }>(
        `UPDATE app_user
            SET password_hash = $2,
                harus_ganti_sandi = false,
                sandi_diubah_at = now(),
                updated_by = $1
          WHERE id = $1 AND deleted_at IS NULL AND aktif
        RETURNING id::text AS id`,
        [userId, passwordHash],
      );
      return rows.length;
    },

    async touchLastLogin(runner, userId) {
      // updated_by/updated_at are the shared audit block; the row's own
      // trigger bumps updated_at and version (migrations/0002).
      await runner.query(
        `UPDATE app_user SET last_login_at = now(), updated_by = $1 WHERE id = $1`,
        [userId],
      );
    },
  };
}
