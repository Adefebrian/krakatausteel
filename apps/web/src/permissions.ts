// Permission vocabulary for the UI.
//
// The authoritative permission set for a signed in user always comes from the
// server, in the `permissions` array of GET /auth/session. This file only
// names the strings the UI checks against, so a typo becomes a type error
// instead of a silently hidden menu.
//
// Hiding a menu item is a convenience, never a control: spec section 2 rule 4
// requires every one of these to be enforced again on the API. The nav filter
// below is not security.

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

export type Role =
  | "MAKER"
  | "CHECKER"
  | "APPROVER"
  | "ADMIN_CABANG"
  | "ADMIN_PUSAT"
  | "AUDITOR";

export const NAMA_ROLE: Record<Role, string> = {
  MAKER: "Maker",
  CHECKER: "Checker",
  APPROVER: "Approver",
  ADMIN_CABANG: "Admin Cabang",
  ADMIN_PUSAT: "Admin Pusat",
  AUDITOR: "Auditor",
};

const READ_ONLY: Permission[] = [
  "dashboard.view",
  "pumk.view",
  "nonpumk.view",
  "jurnal.view",
  "laporan.view",
  "portal.view",
  "audit.view",
];

const MAKER: Permission[] = [
  ...READ_ONLY.filter((permission) => permission !== "audit.view"),
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
  ...READ_ONLY.filter((permission) => permission !== "audit.view"),
  "pumk.review",
  "nonpumk.review",
  "jurnal.verify",
  "tools.rekonsiliasi",
];

const APPROVER: Permission[] = [
  ...READ_ONLY.filter((permission) => permission !== "audit.view"),
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

/**
 * Frontend mirror of the server side role to permission mapping. Used by the
 * demo stub in ./api/auth.ts and by the tests. The signed in session's own
 * permission array always wins over this table.
 */
export const PERMISSIONS_BY_ROLE: Record<Role, readonly Permission[]> = {
  MAKER: MAKER,
  CHECKER: CHECKER,
  APPROVER: APPROVER,
  ADMIN_CABANG: ADMIN_CABANG,
  ADMIN_PUSAT: ADMIN_PUSAT,
  AUDITOR: READ_ONLY,
};

export function hasPermission(
  permissions: readonly string[],
  required: Permission | undefined,
): boolean {
  if (!required) return true;
  return permissions.includes(required);
}
