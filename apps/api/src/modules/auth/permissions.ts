// The authoritative permission vocabulary. The server is the source of truth;
// apps/web/src/permissions.ts is a MIRROR of this file used only to turn a
// typo in the UI into a type error (its own header says so, and spec 2 rule 4
// says the check that matters is this one).
//
// The codes below are the ones the SPA renders its navigation from
// (apps/web/src/permissions.ts must contain every code it checks), so a
// canonical code is not renamed unilaterally.
//
// SPEC 4.1 SPELLINGS ARE DOCUMENTED, NOT ALIASED.
// Spec 4.1 gives its examples as `pumk.proposal.create`, `jurnal.post`,
// `periode.close`, `periode.reopen`. Only `jurnal.post` is spelled that way
// here; the others map onto canonical codes as follows:
//
//   spec 4.1                  canonical code here
//   pumk.proposal.create  ->  pumk.create
//   pumk.proposal.review  ->  pumk.review
//   pumk.proposal.approve ->  pumk.approve
//   periode.close         ->  admin.closing.periode
//   periode.reopen        ->  admin.periode.reopen
//   kolektibilitas.close  ->  admin.closing.kolektibilitas
//
// Those were briefly registered as runtime ALIASES. They are not any more, on
// review: nothing called them, and an alias table full of codes with no call
// sites makes `canonicalPermission` look like it validates more than it does,
// which is precisely how a missing permission (jurnal.update / jurnal.delete)
// went unnoticed. `PERMISSION_ALIASES` stays as a mechanism, currently empty,
// for a genuine future RENAME of a code the SPA already ships, where both
// spellings must work during one deploy. Anything else is a new canonical
// code, so that `resolveRequiredPermissions` can reject a typo at boot.

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
  // Editing and cancelling a DRAFT journal are separate actions from creating
  // one: the journal engine gates `ubahJurnalDraft` and `batalkanJurnalDraft`
  // on exactly these two codes (modules/jurnal/service.ts). They were missing
  // from this catalogue, which meant NO role could hold them, not even Admin
  // Pusat (built as a spread of PERMISSIONS), so editing or cancelling a draft
  // would have been a 403 for every user in the system on the day the journal
  // screens shipped. Do not remove without changing the engine.
  "jurnal.update",
  "jurnal.delete",
  "jurnal.verify",
  "jurnal.post",
  // Reversing a POSTED journal. Deliberately NOT the same code as jurnal.post:
  // posting adds a new entry, reversal rewrites the meaning of one that is
  // already in the ledger and in a possibly-reported period, which is the
  // heavier privilege of the two (spec invariant 4, spec 6.3).
  "jurnal.reversal",

  "laporan.view",

  "admin.closing.kolektibilitas",
  "admin.closing.periode",
  "admin.periode.reopen",
  "admin.rka",

  "konfigurasi.master",
  "konfigurasi.coa",
  "konfigurasi.user",
  // Reading the parameter set and CHANGING it are different privileges: a
  // parameter is evidence for how a number was calculated, so read is wide
  // (the Auditor needs it), while write moves money in every future
  // calculation. Previously `konfigurasi.update` was an alias of
  // `konfigurasi.parameter`, which made the two call sites read as though
  // they were separate when they were not.
  "konfigurasi.parameter",
  "konfigurasi.update",

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
 * Renames in flight: old spelling -> current canonical code.
 *
 * EMPTY ON PURPOSE, and that is the healthy state. The only thing that belongs
 * here is a code the SPA (or a saved role definition, or another module)
 * already ships under an old name while a rename rolls out. It is not a place
 * to make a second name for an existing permission, and it is not a substitute
 * for adding a canonical code: see the spec 4.1 note in this file's header.
 */
export const PERMISSION_ALIASES: Readonly<Record<string, Permission>> = {};

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
  // The Maker owns its own DRAFT journals, so it must be able to correct and
  // cancel one before a Checker verifies it. Neither touches a POSTED entry:
  // the engine refuses that, and correction after posting is a reversal.
  "jurnal.update",
  "jurnal.delete",
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

// Everything the three operational roles can do, in ONE branch, plus branch
// user management. Deliberately NOT konfigurasi.parameter/update: spec 2 puts
// master data and parameters with Admin Pusat, and a branch admin who can
// change the jasa administrasi rate is a branch admin who can change every
// future journal in that branch.
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
