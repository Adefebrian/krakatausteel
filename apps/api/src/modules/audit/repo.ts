// Data access for audit_log (spec 4.10). This module owns that table and is
// the only writer of it in the codebase.
//
// audit_log is APPEND ONLY, enforced by trg_audit_log_90_append_only in
// migrations/0014: no UPDATE, no DELETE, for anyone. So there is no update or
// delete function here, and there never will be one.
import type { QueryRunner } from "./ports";

/** Result of an action, spec 4.10: SUKSES or DITOLAK. */
export type AuditHasil = "SUKSES" | "DITOLAK";

export interface AuditEntry {
  /** Null for an anonymous attempt (a failed login has no user yet). */
  userId?: string | null;
  /**
   * Real client IP, already resolved through the trusted-proxy rules in
   * core/client-ip.ts. Stored in an INET column, so an unresolvable address
   * must be null, never the string "unknown".
   */
  ip?: string | null;
  userAgent?: string | null;
  /** Dotted action name, e.g. "auth.login", "konfigurasi.update". */
  aksi: string;
  /** Entity/table the action targeted, e.g. "app_user", "konfigurasi". */
  entitas: string;
  entitasId?: string | null;
  nilaiLama?: unknown;
  nilaiBaru?: unknown;
  hasil: AuditHasil;
  keterangan?: string | null;
}

export interface AuditRow {
  id: string;
  waktu: string;
  user_id: string | null;
  ip: string | null;
  user_agent: string | null;
  aksi: string;
  entitas: string;
  entitas_id: string | null;
  nilai_lama_json: unknown;
  nilai_baru_json: unknown;
  hasil: AuditHasil;
  keterangan: string | null;
}

export interface AuditFilter {
  userId?: string | undefined;
  entitas?: string | undefined;
  entitasId?: string | undefined;
  aksi?: string | undefined;
  hasil?: AuditHasil | undefined;
  limit: number;
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export interface AuditRepo {
  insert(runner: QueryRunner, entry: AuditEntry): Promise<string>;
  list(runner: QueryRunner, filter: AuditFilter): Promise<AuditRow[]>;
}

export function createAuditRepo(): AuditRepo {
  return {
    async insert(runner, entry) {
      const rows = await runner.query<{ id: string }>(
        `INSERT INTO audit_log
           (user_id, ip, user_agent, aksi, entitas, entitas_id,
            nilai_lama_json, nilai_baru_json, hasil, keterangan)
         VALUES ($1, $2::inet, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
         RETURNING id::text AS id`,
        [
          entry.userId ?? null,
          entry.ip ?? null,
          entry.userAgent ?? null,
          entry.aksi,
          entry.entitas,
          entry.entitasId ?? null,
          jsonOrNull(entry.nilaiLama),
          jsonOrNull(entry.nilaiBaru),
          entry.hasil,
          entry.keterangan ?? null,
        ],
      );
      const id = rows[0]?.id;
      if (!id) {
        // Cannot happen with RETURNING on a successful INSERT; if it ever
        // does, it must be loud rather than a silently unlogged action.
        throw new Error("audit_log INSERT tidak mengembalikan id");
      }
      return id;
    },

    async list(runner, filter) {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, value: unknown): void => {
        params.push(value);
        where.push(sql.replace("$?", `$${params.length}`));
      };
      if (filter.userId) add("user_id = $?", filter.userId);
      if (filter.entitas) add("entitas = $?", filter.entitas);
      if (filter.entitasId) add("entitas_id = $?", filter.entitasId);
      if (filter.aksi) add("aksi = $?", filter.aksi);
      if (filter.hasil) add("hasil = $?", filter.hasil);
      params.push(filter.limit);
      return runner.query<AuditRow>(
        `SELECT id::text AS id, waktu, user_id::text AS user_id, ip::text AS ip,
                user_agent, aksi, entitas, entitas_id, nilai_lama_json,
                nilai_baru_json, hasil, keterangan
           FROM audit_log
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY waktu DESC, id DESC
          LIMIT $${params.length}`,
        params,
      );
    },
  };
}
