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
  // Cluster roster administration. Was missing from this mirror while the
  // server had it, which is the drift this file exists to prevent: the nav
  // tests assert "what an Admin Cabang sees", and a code absent here makes
  // them assert a smaller menu than the server actually grants.
  "pumk.cluster",

  "nonpumk.view",
  "nonpumk.create",
  "nonpumk.penilaian",
  "nonpumk.review",
  "nonpumk.approve",
  "nonpumk.penyaluran",
  "nonpumk.lpj",
  // Verifying (accepting or rejecting) an LPJ. Deliberately its own code: the
  // Maker files the LPJ under `nonpumk.lpj`, and accepting one releases the
  // returned money into a journal, which is a different act by a different
  // person. Held by the CHECKER on the server, and inherited from there by
  // Admin Cabang and Admin Pusat.
  "nonpumk.lpj.verifikasi",

  "jurnal.view",
  "jurnal.create",
  "jurnal.verify",
  "jurnal.post",
  "jurnal.reversal",

  "laporan.view",

  // Reading the closing evidence (prerequisite checklist, run history, frozen
  // balances) without the right to run anything. Mirrors the server's own code:
  // the Auditor is read only (spec 2) and this is the screen its work lives on,
  // so gating those reads on `admin.closing.periode` would have meant handing a
  // write code to a role that must never write.
  "admin.closing.view",
  "admin.closing.kolektibilitas",
  // Running the month-end arithmetic (penyisihan, akrual jasa administrasi),
  // which is NOT the same act as declaring the month closed. Mirrors the
  // server's split (OPEN-QUESTIONS 29): one code used to gate all three, so
  // making the close Admin Pusat only would have moved both branch computations
  // to head office as a side effect.
  "admin.closing.hitung",
  // Declaring the month closed. Admin Pusat only, which is why it is absent
  // from the Approver list below.
  "admin.closing.periode",
  "admin.periode.reopen",
  "admin.rka",
  // Approving an RKA, and reading one, are separate codes from entering one.
  // Mirrors the server: `admin.rka` alone would mean the person who types the
  // sector targets also blesses the baseline every "versus anggaran" figure is
  // measured against, and would force an Auditor who needs to see WHICH budget
  // version a variance was measured against to hold a write code.
  "admin.rka.approve",
  "admin.rka.view",

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
  "admin.closing.view",
  "admin.rka.view",
];

/**
 * The evidence codes in READ_ONLY that are the Auditor's and not every signed
 * in user's. Mirrors `HANYA_BUKTI` on the server: the operational roles are
 * built from READ_ONLY minus these, and get them back only where the server
 * grants them (the Approver holds `admin.closing.view`, nobody but the Auditor
 * and Admin Pusat holds `audit.view` or `admin.rka.view`).
 */
const HANYA_BUKTI: readonly Permission[] = [
  "audit.view",
  "admin.closing.view",
  "admin.rka.view",
];

const LIHAT: Permission[] = READ_ONLY.filter(
  (permission) => !HANYA_BUKTI.includes(permission),
);

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
  // Verifying an LPJ is a decision ON SOMEONE ELSE'S FILING, so it sits with
  // the Checker for the same reason `jurnal.verify` does. Mirrors the server's
  // own grant in modules/auth/permissions.ts.
  "nonpumk.lpj.verifikasi",
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
  // Reading the checklist is a separate act from executing the close, and the
  // Approver does the first before deciding whether to do the second. Reading
  // and preparing is now all it does.
  "admin.closing.view",
  "admin.closing.kolektibilitas",
  // The month-end arithmetic, and NOT the close (OPEN-QUESTIONS 29, decided
  // 2026-09-02: closing a period is Admin Pusat only). `admin.closing.periode`
  // is deliberately absent, so a screen that offers "Tutup Periode" to an
  // Approver would be offering a button the server refuses.
  "admin.closing.hitung",
];

const ADMIN_CABANG: Permission[] = [
  ...new Set<Permission>([
    ...MAKER,
    ...CHECKER,
    ...APPROVER,
    "konfigurasi.user",
    "tools.integritas",
    "pumk.cluster",
    // Read only, and scoped to the branch's own budget by the same rule as
    // every other read. Entering and approving stay with Admin Pusat. See the
    // server's own note: without a branch-scoped role holding a read code, the
    // branch-scope check on budget reads can never fire.
    "admin.rka.view",
  ]),
];

const ADMIN_PUSAT: Permission[] = [...PERMISSIONS];

/**
 * Frontend mirror of the server side role to permission mapping, kept only so
 * the nav tests can assert "what a Maker sees" without standing up the API.
 * Runtime never reads it: the signed in session's own `permissions` array is
 * the only thing that gates the UI.
 */
export const PERMISSIONS_BY_ROLE: Record<Role, readonly Permission[]> = {
  MAKER: MAKER,
  CHECKER: CHECKER,
  APPROVER: APPROVER,
  ADMIN_CABANG: ADMIN_CABANG,
  ADMIN_PUSAT: ADMIN_PUSAT,
  AUDITOR: READ_ONLY,
};

/**
 * Role label for display. The API types `user.role` as a plain string and can
 * answer "TANPA_ROLE" for an account whose roles were revoked, so an unknown
 * value has to render as words rather than as an empty gap in the header.
 */
export function namaRole(role: string): string {
  return (NAMA_ROLE as Record<string, string | undefined>)[role] ?? "Tanpa role";
}

export function hasPermission(
  permissions: readonly string[],
  required: Permission | undefined,
): boolean {
  if (!required) return true;
  return permissions.includes(required);
}
