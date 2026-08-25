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
  // Spec 9.1's cluster page ("kelola kelompok, tambah dan keluarkan anggota,
  // lihat performa kolektibilitas per cluster") had NO code in this catalogue,
  // so modules/pumk had to fail closed on every cluster operation and not even
  // Admin Pusat (built as a spread of PERMISSIONS) could hold it.
  //
  // It is its own code, deliberately, and neither of the two tempting reuses:
  // `pumk.create` would let any Maker restructure the very groups whose
  // kolektibilitas performance is reported per cluster, and `konfigurasi.master`
  // would put an operational PUMK screen behind Admin Pusat. Granted to
  // ADMIN_CABANG (and so to ADMIN_PUSAT) below: managing a group's roster is
  // branch operational administration, not day-to-day proposal work.
  "pumk.cluster",

  "nonpumk.view",
  "nonpumk.create",
  "nonpumk.penilaian",
  "nonpumk.review",
  "nonpumk.approve",
  "nonpumk.penyaluran",
  "nonpumk.lpj",
  // Verifying (and rejecting) the LPJ, spec 4.5: `nonpumk_lpj` carries a
  // DIVERIFIKASI status with verified_by / verified_at, and the Fase 4 exit
  // criterion is one proposal running "sampai LPJ diverifikasi". No code here
  // covered that act, so the engine had to fail closed for EVERY role,
  // including Admin Pusat (built as a spread of PERMISSIONS), and no
  // accountability report could ever be signed off. Same class of gap as
  // `pumk.cluster`.
  //
  // It is its own code, and none of the three tempting reuses:
  //   nonpumk.lpj     is the MAKER's own filing code, so reusing it would let
  //                   the author of a report verify their own report;
  //   nonpumk.review  is the review of the PROPOSAL, and the Approver who
  //                   released the money does not hold it;
  //   nonpumk.approve was the decision to give the money, months earlier, not
  //                   the decision that the money was accounted for.
  // Granted to CHECKER below.
  "nonpumk.lpj.verifikasi",

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

  // READING the closing evidence: the prerequisite checklist, the run history,
  // the migration matrix and a closed period's frozen balances. No right to
  // run anything.
  //
  // It is its own code, and neither of the two things that were available
  // without it. Gating the closing read paths on `admin.closing.periode` hands
  // a WRITE code to the Auditor, whom spec 2 makes read only ("Tidak bisa
  // mengubah apa pun") and whose evidence this is; `ROLES_READ_ONLY` would then
  // be the only thing standing between that grant and a write, which is a far
  // thinner guarantee than not holding the right. Leaving the reads ungated
  // makes the whole closing history readable to any authenticated account.
  //
  // `laporan.view` does not reach it either: how a period was closed, and
  // against which checklist, is not one of the 31 reports in spec 10.4, so a
  // code that gates those reports says nothing about this screen.
  //
  // Same shape as `pumk.cluster` and `nonpumk.lpj.verifikasi`: modules/closing
  // names the code (`PERMISSION_CLOSING.LIHAT`) and fails closed with
  // IZIN_BELUM_TERDAFTAR while it is absent. Granted to AUDITOR and APPROVER
  // below (and so to ADMIN_CABANG and ADMIN_PUSAT), deliberately NOT to Maker
  // or Checker: neither closes a period, and spec 9.3's two closing screens are
  // the Approver's.
  "admin.closing.view",
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
  // The Auditor's other evidence code. Spec 2 gives the role "read only penuh
  // termasuk semua laporan dan audit trail", and spec 16 scenario 23 requires
  // every report and every audit screen to open for it without one mutating
  // control. The closing checklist and the frozen balances are exactly that
  // kind of evidence.
  "admin.closing.view",
];

/**
 * Read access every operational role has: the whole Auditor list MINUS the two
 * evidence codes that are not everybody's. `audit.view` is the audit trail,
 * `admin.closing.view` is the closing evidence, and both are granted
 * deliberately per role below rather than inherited by anyone who can log in.
 */
const HANYA_BUKTI: readonly Permission[] = ["audit.view", "admin.closing.view"];

const LIHAT: Permission[] = READ_ONLY.filter((p) => !HANYA_BUKTI.includes(p));

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
  // Verifying the LPJ sits with the Checker for the same reason
  // `jurnal.verify` does: it is a decision ON SOMEONE ELSE'S FILING, not an
  // input. Spec 2 says the Checker inputs nothing, and it does not: the Maker
  // files the LPJ (`nonpumk.lpj`), the Checker accepts or rejects it. Putting
  // it on the Maker would let an author sign off their own report; putting it
  // on the Approver would make the person who released the money also the
  // person who certifies it was spent, which is the control this split exists
  // to keep. ADMIN_CABANG inherits it through this list, ADMIN_PUSAT through
  // the spread of PERMISSIONS.
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
  // Approver does the first before deciding whether to do the second.
  "admin.closing.view",
  "admin.closing.kolektibilitas",
  "admin.closing.periode",
];

// Everything the three operational roles can do, in ONE branch, plus branch
// user management. Deliberately NOT konfigurasi.parameter/update: spec 2 puts
// master data and parameters with Admin Pusat, and a branch admin who can
// change the jasa administrasi rate is a branch admin who can change every
// future journal in that branch.
const ADMIN_CABANG: Permission[] = [
  ...new Set<Permission>([
    ...MAKER,
    ...CHECKER,
    ...APPROVER,
    "konfigurasi.user",
    "tools.integritas",
    // Cluster membership is roster administration for the branch, so it sits
    // with the branch admin rather than with the Maker who files the proposals
    // whose kolektibilitas the cluster report aggregates.
    "pumk.cluster",
  ]),
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
