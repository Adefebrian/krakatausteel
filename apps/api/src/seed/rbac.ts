// RBAC seed: the permission catalogue, the six system roles from spec 2, and
// the grants between them.
//
// WHY THIS IS A SEED AND NOT A MIGRATION
// migrations/0003 creates the permission / app_role / role_permission tables
// but ships no rows, deliberately: spec 4.1 wants RBAC AS DATA, so the set of
// permissions is a fact about the application version, not about the schema.
// Keeping it here means adding a permission in Fase 3 is a code change plus
// `db:seed`, not a migration that has to be applied in lockstep.
//
// Idempotent by construction (ON CONFLICT DO NOTHING / DO UPDATE on the code
// columns), because it runs on every `db:seed` and is also called by the test
// harness at the top of each authorisation test file. Another agent running
// `db:reset` mid-run wipes it; the next file that needs it puts it back.
import { PERMISSIONS, PERMISSIONS_BY_ROLE, NAMA_ROLE, ROLE_CODES, permissionGroup } from "../modules/auth";
import type { DbPort, QueryRunner } from "../core/ports/db";

export interface SeedRbacResult {
  permissions: number;
  roles: number;
  grants: number;
}

const DESKRIPSI_ROLE: Readonly<Record<string, string>> = {
  MAKER:
    "Input proposal, hasil survey, akad, jadwal angsuran, pencairan, penerimaan angsuran, jurnal DRAFT (spec 2)",
  CHECKER: "Review dan rekomendasi hasil survey, verifikasi jurnal DRAFT. Tidak bisa input data baru (spec 2)",
  APPROVER: "Setujui atau tolak proposal, posting jurnal, eksekusi closing (spec 2)",
  ADMIN_CABANG: "Semua kewenangan operasional dalam scope satu cabang, kelola user cabang (spec 2)",
  ADMIN_PUSAT: "Semua kewenangan, semua cabang, master data, COA, reopen periode (spec 2)",
  AUDITOR: "Read only penuh termasuk audit trail. Tidak bisa mengubah apa pun (spec 2)",
};

export async function seedRbac(db: DbPort): Promise<SeedRbacResult> {
  return db.transaction(async (tx) => {
    // Permissions. `deskripsi`/`grup` are refreshed on conflict so a renamed
    // group does not need a manual fix, but `kode` is never rewritten: it is
    // the contract with apps/web.
    let permissions = 0;
    for (const kode of PERMISSIONS) {
      await tx.query(
        `INSERT INTO permission (kode, grup, deskripsi, aktif)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (kode) DO UPDATE SET grup = EXCLUDED.grup, aktif = true, updated_at = now()`,
        [kode, permissionGroup(kode), kode],
      );
      permissions += 1;
    }

    let roles = 0;
    for (const kode of ROLE_CODES) {
      await tx.query(
        `INSERT INTO app_role (kode, nama, deskripsi, is_system, aktif)
         VALUES ($1, $2, $3, true, true)
         ON CONFLICT (kode) WHERE deleted_at IS NULL
         DO UPDATE SET nama = EXCLUDED.nama, deskripsi = EXCLUDED.deskripsi, is_system = true`,
        [kode, NAMA_ROLE[kode], DESKRIPSI_ROLE[kode] ?? null],
      );
      roles += 1;
    }

    // Grants. Set semantics: a permission removed from PERMISSIONS_BY_ROLE is
    // REVOKED, not left behind. A stale grant is a real privilege-escalation
    // path, so this is a full reconciliation per role rather than an insert.
    let grants = 0;
    for (const kode of ROLE_CODES) {
      const wanted = PERMISSIONS_BY_ROLE[kode];
      await tx.query(
        `DELETE FROM role_permission
          WHERE role_id = (SELECT id FROM app_role WHERE kode = $1 AND deleted_at IS NULL)
            AND permission_id NOT IN (SELECT id FROM permission WHERE kode = ANY($2::text[]))`,
        [kode, wanted],
      );
      await tx.query(
        `INSERT INTO role_permission (role_id, permission_id)
         SELECT r.id, p.id
           FROM app_role r
           JOIN permission p ON p.kode = ANY($2::text[])
          WHERE r.kode = $1 AND r.deleted_at IS NULL
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [kode, wanted],
      );
      grants += wanted.length;
    }

    return { permissions, roles, grants };
  });
}

/**
 * The permissions a role actually holds, read from the database.
 *
 * EXISTS SO A TEST FIXTURE NEVER HARDCODES A PERMISSION ARRAY. A fixture that
 * writes `permissions: ["jurnal.create", "jurnal.post"]` into a context object
 * is asserting against its own opinion, not against the grant matrix, so a
 * permission the engine checks but no role is granted (exactly what happened
 * with `jurnal.update` and `jurnal.delete`) still looks green. Resolve through
 * this instead and a missing grant fails the test that needs it.
 *
 * Takes a `QueryRunner`, so a fixture can pass its own transactional handle.
 */
export async function permissionsForRole(runner: QueryRunner, roleKode: string): Promise<string[]> {
  const rows = await runner.query<{ kode: string }>(
    `SELECT p.kode
       FROM app_role r
       JOIN role_permission rp ON rp.role_id = r.id
       JOIN permission p ON p.id = rp.permission_id
      WHERE r.kode = $1 AND r.deleted_at IS NULL AND p.aktif
      ORDER BY p.kode`,
    [roleKode],
  );
  if (rows.length === 0) {
    throw new Error(
      `permissionsForRole: role "${roleKode}" tidak punya permission di database. ` +
        "Jalankan seedRbac lebih dulu (atau periksa ejaan kode role).",
    );
  }
  return rows.map((row) => row.kode);
}
