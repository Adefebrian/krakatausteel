// WHO MAY HAND OUT WHICH AUTHORITY. A pure predicate, no database in sight, so
// the rule is pinned by a unit test independently of any schema state and is
// readable in one screen by somebody deciding whether it is the right rule.
//
// THE RULE IS ABOUT PERMISSIONS, NOT ABOUT ROLE NAMES, and that distinction is
// the whole design. "You may only grant a role you hold yourself" reads well
// and is wrong here: an Admin Pusat holds exactly one role, ADMIN_PUSAT, so
// under that rule the one account that is supposed to onboard the entity could
// not create a single Maker. What actually matters is that a grant cannot
// WIDEN authority beyond the granter's own: the set of permissions the granted
// role carries must already be a subset of what the granter holds.
//
// Consequences of that reading, all of them intended:
//
//   ADMIN_PUSAT holds every permission, so it may grant every role.
//   ADMIN_CABANG holds MAKER + CHECKER + APPROVER plus a few of its own, so it
//     may grant those three, and may appoint another branch admin (a lateral
//     move inside the same authority, not an escalation).
//   ADMIN_CABANG may NOT grant ADMIN_PUSAT (konfigurasi.master, konfigurasi.coa,
//     admin.rka and the rest are outside its own set) and may NOT grant AUDITOR
//     (audit.view is outside it).
//   A MAKER holds no `konfigurasi.user` at all, so it never reaches this code:
//     the route permission refuses it first.
//
// THE SECOND RULE IS STRUCTURAL, NOT DERIVED. Only a caller who is itself
// exempt from branch scoping may grant a role that is exempt from branch
// scoping. The subset rule happens to refuse AUDITOR to a branch admin today,
// but only because of one permission (`audit.view`); a future catalogue edit
// could make the two sets coincide and silently hand a branch admin the power
// to mint an account that reads every branch. Spec 2 rule 3 names exactly two
// cross-branch roles, and that list is what this rule reads.
import { forbidden } from "../../core/http";
import {
  NAMA_ROLE,
  PERMISSIONS_BY_ROLE,
  ROLE_CODES,
  ROLES_LINTAS_CABANG,
  ROLES_READ_ONLY,
  type RoleCode,
} from "../auth";

export interface PeranTersedia {
  kode: RoleCode;
  nama: string;
  lintasCabang: boolean;
  readOnly: boolean;
  /** Whether THIS caller may grant it. */
  dapatDiberikan: boolean;
  /** Why not, when it may not. Rendered next to a disabled option. */
  alasan: string | null;
}

export function isRoleCode(value: unknown): value is RoleCode {
  return typeof value === "string" && (ROLE_CODES as readonly string[]).includes(value);
}

/**
 * Returns null when `peran` may be granted by a caller holding `izinPemberi`,
 * otherwise the sentence explaining the refusal.
 */
export function alasanTidakBolehMemberiPeran(
  peran: RoleCode,
  izinPemberi: readonly string[],
  pemberiLintasCabang: boolean,
): string | null {
  if (ROLES_LINTAS_CABANG.includes(peran) && !pemberiLintasCabang) {
    return (
      `Peran ${NAMA_ROLE[peran]} berlaku lintas cabang, dan hanya pengguna yang sendirinya ` +
      "lintas cabang boleh memberikannya"
    );
  }
  const dimiliki = new Set(izinPemberi);
  const kurang = PERMISSIONS_BY_ROLE[peran].filter((izin) => !dimiliki.has(izin));
  if (kurang.length > 0) {
    return (
      `Peran ${NAMA_ROLE[peran]} memuat wewenang yang tidak Anda miliki sendiri ` +
      `(${kurang.slice(0, 3).join(", ")}${kurang.length > 3 ? ", ..." : ""}), ` +
      "jadi Anda tidak dapat memberikannya"
    );
  }
  return null;
}

/** Throws a 403 when the grant would widen authority. */
export function assertBolehMemberiPeran(
  peran: RoleCode,
  izinPemberi: readonly string[],
  pemberiLintasCabang: boolean,
): void {
  const alasan = alasanTidakBolehMemberiPeran(peran, izinPemberi, pemberiLintasCabang);
  if (alasan) throw forbidden(alasan);
}

/** The whole catalogue, annotated for one caller. What the screen renders. */
export function peranUntukPemberi(
  izinPemberi: readonly string[],
  pemberiLintasCabang: boolean,
): PeranTersedia[] {
  return ROLE_CODES.map((kode) => {
    const alasan = alasanTidakBolehMemberiPeran(kode, izinPemberi, pemberiLintasCabang);
    return {
      kode,
      nama: NAMA_ROLE[kode],
      lintasCabang: ROLES_LINTAS_CABANG.includes(kode),
      readOnly: ROLES_READ_ONLY.includes(kode),
      dapatDiberikan: alasan === null,
      alasan,
    };
  });
}
