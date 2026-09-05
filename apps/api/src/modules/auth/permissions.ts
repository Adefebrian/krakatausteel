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
  // TAKING A REPORT OUT OF THE SYSTEM as a file: spec 10's "ekspor ke Excel
  // dan PDF", on every one of the 31 reports.
  //
  // ITS OWN CODE, AND NOT `laporan.view`, BECAUSE READING AND EXPORTING ARE
  // NOT THE SAME ACT. A screen is bounded: it is scoped to the caller's
  // branches, it is paged, every open leaves a session behind it, and what
  // leaves the building leaves one screenful at a time. An export is a FILE.
  // It is a bulk extract of exactly the columns that make these reports
  // sensitive -- `mitra.nik`, `alamat`, `telepon`, outstanding per named
  // person -- in a form that is mailed, copied to a USB stick and opened on a
  // machine this system has never heard of, with no scope check on the far
  // side and no way to withdraw it. Merging the two would mean the system has
  // no way to say "read the report, do not take a copy of it", which is a
  // sentence a BUMN data owner has to be able to say.
  //
  // WHO HOLDS IT, and the answer is deliberately NOT "everyone who may read":
  //
  //   AUDITOR      yes. Spec 2 gives the role "read only penuh termasuk semua
  //                laporan" and spec 16 scenario 23 opens all of them; an
  //                auditor who may look at evidence but never take it away
  //                cannot produce a working paper, and the whole point of the
  //                role is to attest outside this application.
  //   APPROVER     yes, and so ADMIN_CABANG and ADMIN_PUSAT by inheritance.
  //                The Approver is the officer who signs what the entity
  //                reports; the signed artefact is the export.
  //   MAKER        no.
  //   CHECKER      no.
  //
  // The two input roles are the ones with the least reason to hold a whole
  // branch's partner register as a file and the most people in them, and spec
  // 2 gives neither of them a reporting duty beyond reading. If that turns out
  // to be wrong in practice -- a Maker who prepares the monthly disbursement
  // pack is a plausible workflow nobody has described to us yet -- it is one
  // line in `MAKER` below, and widening a grant later is a decision somebody
  // makes on purpose. Narrowing one after everybody has the file is not.
  // Filed as OPEN-QUESTIONS 30.
  //
  // Listed in `HANYA_BUKTI` so it is granted per role rather than inherited by
  // anything that can log in, exactly as `audit.view`, `admin.closing.view`
  // and `admin.rka.view` are.
  "laporan.export",

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
  // RUNNING THE MONTH-END ARITHMETIC: spec 8.2 penyisihan and spec 8.3 akrual
  // jasa administrasi.
  //
  // ITS OWN CODE, SPLIT OUT OF `admin.closing.periode` (OPEN-QUESTIONS 29).
  // One code used to gate three acts, so the decision that closing a period is
  // Admin Pusat's could not be implemented without also moving both monthly
  // computations to head office. That is not what was decided: what is
  // centralised is the DECLARATION THAT THE MONTH IS FINISHED, not the
  // arithmetic that prepares it. The provision and the accrual are recurring
  // branch work, they are repeatable while the period is still OPEN (invariant
  // 13), and everything they produce is re-derivable from the ledger; the close
  // freezes a trial balance and is undone only by an Admin Pusat reopen.
  //
  // Same shape as the `admin.rka` / `admin.rka.approve` split below, and the
  // same argument: when one code gates both a routine act and an irreversible
  // one, whoever needs the routine act decides who holds the irreversible one.
  "admin.closing.hitung",
  // DECLARING THE MONTH CLOSED, and nothing else. Held by ADMIN_PUSAT alone,
  // which is why it is absent from the APPROVER list below.
  "admin.closing.periode",
  "admin.periode.reopen",
  "admin.rka",
  // APPROVING an RKA, which is the act that turns a draft budget into the
  // baseline every "versus anggaran" figure in the system is measured against:
  // report 24, the "versus RKA" columns of reports 2 and 13, and the dashboard
  // over both.
  //
  // Its own code, and deliberately not a reuse of `admin.rka`. With one code,
  // the person who types the sector targets is the person who blesses them, and
  // the RKA becomes the one approved document in the system with no second
  // party anywhere in the record. Spec 9.3 gives the RKA a status and an
  // approval, and migrations/0012's `rka_disetujui_ck` makes `approved_by` and
  // `approved_at` mandatory on a DISETUJUI row, so the schema already expects
  // an approver; until now the catalogue had no way to say who may be one.
  //
  // It is not `konfigurasi.master` either: an annual budget is not master data,
  // and gating it there would put budget approval behind the same code as
  // editing the list of provinces.
  //
  // WHETHER THE SAME PERSON MAY HOLD BOTH AND USE BOTH is a separate question
  // and NOT settled by this catalogue. It is the configuration key
  // `rka.pemisahan_tugas_persetujuan`, whose default is an assumption
  // (ASSUMPTIONS.md A-31), because spec 2 scopes its segregation rules to the
  // two proposal modules and the RKA has no Checker stage.
  "admin.rka.approve",
  // READING the RKA: which versions exist, which one is DISETUJUI and is
  // therefore the baseline, who approved it and when. No right to write one.
  //
  // Same shape as `admin.closing.view`, and the same argument. The Auditor
  // holds `laporan.view`, so report 24 opens for it, but held nothing at all
  // that reaches the budget versions that report compares against; granting
  // `admin.rka` to close that gap would hand a WRITE code to a role spec 2
  // defines as "read only penuh ... tidak bisa mengubah apa pun", leaving
  // `ROLES_READ_ONLY` as the only thing between the grant and a write, which is
  // a far thinner guarantee than not holding the right.
  //
  // Granted to AUDITOR below, and listed in `HANYA_BUKTI` so the operational
  // roles do not inherit it: whether an Admin Cabang should be able to read its
  // own branch's RKA is a real question (`rka.cabang_id` is nullable precisely
  // so a branch can have one, yet only ADMIN_PUSAT holds `admin.rka`), and it
  // is filed as OPEN-QUESTIONS item 26 rather than answered here.
  "admin.rka.view",

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

  // Fase 8 (spec 12), THE ASSISTANT. Two codes rather than one, because the two
  // features serve different people at different moments: `ai.ekstraksi` speeds
  // up the Maker's data entry, `ai.anomali` orders the Checker's and Approver's
  // reading. Neither is a right to DO anything -- the assistant writes no
  // business state at all (modules/ai/index.ts) -- so both are read-shaped
  // privileges over a suggestion, and holding one says nothing about the other.
  "ai.ekstraksi",
  "ai.anomali",

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
  // The Auditor's other evidence codes. Spec 2 gives the role "read only penuh
  // termasuk semua laporan dan audit trail", and spec 16 scenario 23 requires
  // every report and every audit screen to open for it without one mutating
  // control. The closing checklist and the frozen balances are exactly that
  // kind of evidence, and so is the budget baseline a variance report is
  // measured against: a variance the Auditor cannot trace to an approved
  // version is not evidence of anything.
  "admin.closing.view",
  "admin.rka.view",
  // Taking the evidence away. An auditor who may read every report but never
  // export one cannot produce a working paper, and attesting outside this
  // application is the entire function of the role.
  "laporan.export",
  // The anomaly review queue (spec 12 priority 2). It is a GET over journals
  // the Auditor may already open, and ordering them by which deserves reading
  // first is exactly what an attestation does. Listed in `HANYA_BUKTI` below so
  // it does NOT flow to every operational role through `LIHAT`: the queue
  // orders somebody's review work, and a Maker does not review.
  "ai.anomali",
];

/**
 * Read access every operational role has: the whole Auditor list MINUS the
 * evidence codes that are not everybody's. `audit.view` is the audit trail,
 * `admin.closing.view` is the closing evidence, `admin.rka.view` is the budget
 * baseline, `laporan.export` is a report leaving the building as a file, and
 * each is granted deliberately per role below rather than inherited by anyone
 * who can log in.
 */
const HANYA_BUKTI: readonly Permission[] = [
  "audit.view",
  "admin.closing.view",
  "admin.rka.view",
  "laporan.export",
  "ai.anomali",
];

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
  // Spec 12 priority 1, and spec 12 says who it is for: "Manfaat terbesar bagi
  // Maker". It buys a proposed set of form fields and nothing else -- no
  // proposal is created, no mitra is created, nothing is saved from the
  // extraction alone -- so it is safe on the role that files the paperwork.
  "ai.ekstraksi",
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
  // The review queue. A Checker deciding which entries to verify first is the
  // exact use spec 12 describes, and the queue blocks nothing: a flagged
  // journal is still a valid journal.
  "ai.anomali",
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
  // and preparing is now all it does: see the next comment.
  "admin.closing.view",
  "admin.closing.kolektibilitas",
  // THE MONTH-END ARITHMETIC, AND NOT THE CLOSE (OPEN-QUESTIONS 29, decided by
  // the repo owner 2026-09-02: closing a period is Admin Pusat only).
  //
  // `admin.closing.periode` is deliberately NOT in this list any more, and that
  // absence is the whole of the change. It used to be, and because the same
  // code also gated `jalankanPenyisihan` and `jalankanAkrualJasaAdm`, removing
  // it as-is would have moved both monthly computations to head office as a
  // side effect of a decision that was only ever about who declares the month
  // finished. The catalogue now carries two codes; this role holds the
  // computing one, and ADMIN_CABANG inherits it through the spread below.
  //
  // Kolektibilitas already had its own code and is unchanged. So an Approver
  // runs spec 8.1, 8.2 and 8.3, reads the ten-item checklist, and hands a green
  // checklist to an Admin Pusat, who closes.
  "admin.closing.hitung",
  // The officer who signs what the entity reports is the officer who produces
  // the signed artefact. ADMIN_CABANG and ADMIN_PUSAT inherit it from here,
  // which is the intended reach: a branch admin exports their own branch, and
  // the engine's branch scope is what keeps that true.
  "laporan.export",
  // The Approver reads the same queue before posting and before handing a green
  // checklist to head office. It orders reading; it refuses nothing.
  "ai.anomali",
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
    // DECIDED (OPEN-QUESTIONS 26). A branch admin may READ a budget, scoped to
    // their own branch by the same rule as every other read here. Entering and
    // approving one stays with ADMIN_PUSAT: this grant is `admin.rka.view`, not
    // `admin.rka`.
    //
    // Two reasons. A branch whose performance is measured against a budget
    // (report 24) should be able to read the document it is measured against;
    // and `rka.cabang_id` is nullable precisely so a branch can have its own,
    // which would otherwise be a document nobody at that branch may open.
    //
    // The second reason is the one that decided it: without a branch-scoped
    // role holding a read code, the branch-scope check on RKA reads can never
    // fire. Enforcement that no reachable caller can trigger is not
    // enforcement, it is unexercised code that looks like a guarantee.
    "admin.rka.view",
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
