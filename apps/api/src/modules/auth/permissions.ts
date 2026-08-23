// The authoritative permission vocabulary. The server is the source of truth;
// apps/web/src/permissions.ts is a MIRROR of this file used only to turn a
// typo in the UI into a type error (its own header says so, and spec 2 rule 4
// says the check that matters is this one).
//
// The 39 codes below are exactly the codes the SPA renders its navigation
// from, so they cannot be renamed unilaterally. Spec 4.1 names its examples
// slightly differently (`pumk.proposal.create`, `periode.close`,
// `periode.reopen`), and rather than pick a winner and break one of the two,
// those spec spellings are registered as ALIASES: `requirePermission` resolves
// an alias to its canonical code before checking, so both spellings work and
// only the canonical set is ever sent to the client. Adding a genuinely new
// finer-grained permission later means adding a canonical code, not an alias.

export const PERMISSIONS = [
  "dashboard.view",

  "pumk.view",
  "pumk.create",
  "pumk.survey",
  "pumk.review",
  "pumk.approve",
  "pumk.akad",
  "pumk.pencairan",
  "pumk.angsuran",
  "pumk.reschedule",
  "pumk.hapusbuku",
  "pumk.penagihan",

  "nonpumk.view",
  "nonpumk.create",
  "nonpumk.penilaian",
  "nonpumk.review",
  "nonpumk.approve",
  "nonpumk.penyaluran",
  "nonpumk.lpj",

  "jurnal.view",
  "jurnal.create",
  "jurnal.verify",
  "jurnal.post",
  "jurnal.reversal",

  "laporan.view",

  "admin.closing.kolektibilitas",
  "admin.closing.periode",
  "admin.periode.reopen",
  "admin.rka",

  "konfigurasi.master",
  "konfigurasi.coa",
  "konfigurasi.user",
  "konfigurasi.parameter",

  "portal.view",
  "portal.konversi",

  "tools.import",
  "tools.rekonsiliasi",
  "tools.integritas",

  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

/**
 * Spec spellings that mean an existing canonical permission. Kept small and
 * explicit: an alias is a naming compromise, not a place to invent policy.
 */
export const PERMISSION_ALIASES: Readonly<Record<string, Permission>> = {
  // spec 4.1 examples
  "pumk.proposal.create": "pumk.create",
  "pumk.proposal.review": "pumk.review",
  "pumk.proposal.approve": "pumk.approve",
  "periode.close": "admin.closing.periode",
  "periode.reopen": "admin.periode.reopen",
  "kolektibilitas.close": "admin.closing.kolektibilitas",
  // spec 9.4 / this phase's brief: the konfigurasi write permission
  "konfigurasi.update": "konfigurasi.parameter",
  "konfigurasi.view": "konfigurasi.parameter",
};

/** Canonical form of a permission string, or null if it names nothing. */
export function canonicalPermission(code: string): Permission | null {
  if (PERMISSION_SET.has(code)) return code as Permission;
  return PERMISSION_ALIASES[code] ?? null;
}

/**
 * Resolves a required-permission list, failing loudly on an unknown code.
 * A typo in `requirePermission("jurnal.pos")` must not silently become an
 * unsatisfiable check that locks everyone out of a route with a 403 that
 * looks like a policy decision.
 */
export function resolveRequiredPermissions(codes: readonly string[]): Permission[] {
  return codes.map((code) => {
    const canonical = canonicalPermission(code);
    if (!canonical) {
      throw new Error(
        `Permission "${code}" tidak dikenal. Tambahkan ke PERMISSIONS atau PERMISSION_ALIASES ` +
          "di apps/api/src/modules/auth/permissions.ts (dan ke mirror-nya di apps/web).",
      );
    }
    return canonical;
  });
}

export const ROLE_CODES = [
  "MAKER",
  "CHECKER",
  "APPROVER",
  "ADMIN_CABANG",
  "ADMIN_PUSAT",
  "AUDITOR",
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const NAMA_ROLE: Readonly<Record<RoleCode, string>> = {
  MAKER: "Maker",
  CHECKER: "Checker",
  APPROVER: "Approver",
  ADMIN_CABANG: "Admin Cabang",
  ADMIN_PUSAT: "Admin Pusat",
  AUDITOR: "Auditor",
};

/**
 * Roles exempt from cabang scoping, spec 2 rule 3 verbatim: "Semua akses data
 * terikat scope cabang KECUALI role Admin Pusat dan Auditor". Nothing else
 * belongs in this set, ever; Admin Cabang is explicitly "semua di atas dalam
 * scope satu cabang".
 */
export const ROLES_LINTAS_CABANG: readonly RoleCode[] = ["ADMIN_PUSAT", "AUDITOR"];

/**
 * Roles that may never write. Spec 2: "Auditor / Viewer: Read only penuh ...
 * Tidak bisa mengubah apa pun", and spec 16 scenario 23 tests it. Enforced by
 * rejecting the HTTP method, so a route added in a later phase is read-only
 * for an Auditor before anyone remembers to think about it.
 */
export const ROLES_READ_ONLY: readonly RoleCode[] = ["AUDITOR"];

// --- role to permission mapping (spec 2 wewenang column) -------------------

const READ_ONLY: Permission[] = [
  "dashboard.view",
  "pumk.view",
  "nonpumk.view",
  "jurnal.view",
  "laporan.view",
  "portal.view",
  "audit.view",
];

/** Read access every operational role has. Only the Auditor sees audit.view. */
const LIHAT: Permission[] = READ_ONLY.filter((p) => p !== "audit.view");

const MAKER: Permission[] = [
  ...LIHAT,
  "pumk.create",
  "pumk.survey",
  "pumk.akad",
  "pumk.pencairan",
  "pumk.angsuran",
  "pumk.reschedule",
  "pumk.penagihan",
  "nonpumk.create",
  "nonpumk.penilaian",
  "nonpumk.penyaluran",
  "nonpumk.lpj",
  "jurnal.create",
  "portal.konversi",
  "tools.import",
];

const CHECKER: Permission[] = [
  ...LIHAT,
  "pumk.review",
  "nonpumk.review",
  "jurnal.verify",
  "tools.rekonsiliasi",
];

const APPROVER: Permission[] = [
  ...LIHAT,
  "pumk.approve",
  "pumk.hapusbuku",
  "nonpumk.approve",
  "jurnal.post",
  "jurnal.reversal",
  "admin.closing.kolektibilitas",
  "admin.closing.periode",
];

const ADMIN_CABANG: Permission[] = [
  ...new Set<Permission>([...MAKER, ...CHECKER, ...APPROVER, "konfigurasi.user", "tools.integritas"]),
];

const ADMIN_PUSAT: Permission[] = [...PERMISSIONS];

export const PERMISSIONS_BY_ROLE: Readonly<Record<RoleCode, readonly Permission[]>> = {
  MAKER,
  CHECKER,
  APPROVER,
  ADMIN_CABANG,
  ADMIN_PUSAT,
  AUDITOR: READ_ONLY,
};

/** Grouping for the `permission.grup` column, derived from the code prefix. */
export function permissionGroup(code: Permission): string {
  const [head, second] = code.split(".");
  return head === "admin" ? `admin.${second}` : (head ?? "lain");
}
