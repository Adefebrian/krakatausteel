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
  /**
   * Branches the caller may see, or null for no restriction (Admin Pusat,
   * Auditor). An EMPTY array is not the same as null: it means "no branch",
   * which returns nothing.
   *
   * WHY THIS EXISTS EVEN THOUGH audit_log HAS NO cabang_id: the rows are
   * scoped through their ACTOR (`user_id` -> `app_user.cabang_id`), because
   * that is the only branch fact a row carries. Today `audit.view` happens to
   * be granted only to the two cross-branch roles, so nothing is filtered in
   * practice; the moment a branch-bound role gets it (the Fase 8 user
   * management screens are the obvious candidate) an unscoped query would hand
   * that role every branch's activity. Scoping now costs one predicate.
   *
   * KNOWN LIMIT, worth stating rather than implying: rows whose subject lives
   * in another branch but whose ACTOR is in yours are visible, and anonymous
   * rows (a failed login, `user_id IS NULL`) are visible to everyone with the
   * permission, because attributing them to a branch is exactly the thing that
   * failed. Both are recorded in OPEN-QUESTIONS.md.
   */
  cabangIds?: readonly string[] | null | undefined;
}

/**
 * Serialises a payload for a `jsonb` column.
 *
 * MUST be bound with `$n::text::jsonb`, NOT `$n::jsonb`. The two casts behave
 * differently depending on which driver the caller's `QueryRunner` wraps, and
 * this repo is called with both:
 *
 *   node-postgres (core/adapters/db.ts)  `$n::jsonb`      -> jsonb object  OK
 *   bun:sql       (the journal engine's) `$n::jsonb`      -> jsonb STRING   BUG
 *   either                               `$n::text::jsonb` -> jsonb object  OK
 *
 * Under bun:sql the parameter is sent as jsonb already, so Postgres wraps the
 * JS string in quotes and stores a JSON string SCALAR: `jsonb_typeof` returns
 * `'string'` and `nilai_baru_json->>'status'` returns NULL. The row is written
 * and looks fine in a listing, and every query that reaches INSIDE the payload
 * silently finds nothing, which is the whole point of spec 4.10's
 * `nilai_lama_json` / `nilai_baru_json` and of the filterable audit-trail
 * report (spec 10.4 #31). Routing through `::text` forces Postgres to PARSE
 * the string, which is what both drivers then agree on.
 *
 * audit_log is append-only, so a row written the wrong way cannot be repaired
 * in place afterwards.
 */
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
         VALUES ($1, $2::inet, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9, $10)
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
      if (filter.cabangIds != null) {
        add(
          `(user_id IS NULL OR user_id IN (
              SELECT id FROM app_user WHERE cabang_id = ANY($?::uuid[]) AND deleted_at IS NULL))`,
          filter.cabangIds,
        );
      }
      params.push(filter.limit);
      return runner.query<AuditRow>(
        // host(ip), not ip::text: casting INET to text appends the netmask
        // ("203.0.113.7/32"), which is not what anyone reading an audit trail
        // wants and is not what the writer put in.
        `SELECT id::text AS id, waktu, user_id::text AS user_id, host(ip) AS ip,
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
