// The authenticated caller, and the guard contract every module's routes use.
//
// WHY THIS LIVES IN core/ AND NOT IN modules/auth/
// Two-way traffic would otherwise exist between modules: the auth module needs
// the audit module (spec 2 rule 5, every denial is logged) and the audit
// module's own routes need the auth module's guards. Naming both sides'
// contract here, in core, means each module depends on core and neither
// depends on the other. It is also the honest description of the thing: a
// Principal is not owned by authentication, it is what every domain module
// receives on every request.
import type { Context, MiddlewareHandler } from "hono";
import { forbidden, unauthenticated } from "./http";

/** Context keys. Read them through the helpers below, not by hand. */
export const PRINCIPAL_VAR = "principal";

export interface PrincipalCabang {
  id: string;
  kode: string;
  nama: string;
}

/**
 * Everything an authorisation decision needs, resolved once per request from
 * the session id in the cookie. Never trusts anything the client sent beyond
 * that opaque id.
 */
export interface Principal {
  sessionId: string;
  userId: string;
  username: string;
  nama: string;
  /** The user's home branch. `app_user.cabang_id`, spec 4.1. */
  cabang: PrincipalCabang;
  bumnId: string;
  /** Role codes, e.g. ["MAKER"]. A user may hold several. */
  roles: readonly string[];
  /** Flat, canonical permission codes. This is what the SPA renders from. */
  permissions: readonly string[];
  /**
   * True for Admin Pusat and Auditor only (spec 2 rule 3): every other role's
   * data access is bound to `cabang`.
   */
  lintasCabang: boolean;
  /**
   * True for a role that may never write (Auditor). Enforced structurally by
   * rejecting every non-GET request, not by hiding buttons (spec 16 #23).
   */
  readOnly: boolean;
  /** Branches this principal may act in. One entry unless lintasCabang. */
  cabangTersedia: readonly PrincipalCabang[];
}

/** The principal for this request, or null when unauthenticated. */
export function getPrincipal(c: Context): Principal | null {
  return (c.get(PRINCIPAL_VAR as never) as Principal | undefined) ?? null;
}

/** The principal for this request; throws 401 when there is none. */
export function requirePrincipal(c: Context): Principal {
  const principal = getPrincipal(c);
  if (!principal) throw unauthenticated();
  return principal;
}

export function setPrincipal(c: Context, principal: Principal): void {
  c.set(PRINCIPAL_VAR as never, principal as never);
}

/**
 * Branch-scope check, spec 2 rule 3 and spec 16 scenario 24.
 *
 * Called with the `cabang_id` of the row (or of the request body) being
 * touched. Admin Pusat and Auditor pass for any branch; everyone else passes
 * only for a branch in `cabangTersedia` (their own, plus any branch granted
 * explicitly through `user_role.scope_cabang_id`). The caller is responsible
 * for having READ the row's real cabang_id from the database rather than
 * trusting one sent by the client, which is what makes URL id manipulation
 * fail: the id in the URL selects the row, the row states its own branch.
 */
export function assertCabangAllowed(principal: Principal, cabangId: string | null | undefined): void {
  if (principal.lintasCabang) return;
  if (!cabangId) {
    throw forbidden("Data tanpa cabang tidak dapat diakses oleh peran yang terikat cabang");
  }
  if (!principal.cabangTersedia.some((cabang) => cabang.id === cabangId)) {
    // Deliberately does not say which branch the row belongs to, and is the
    // same message whether the row exists or not: otherwise a 403 becomes an
    // oracle for enumerating another branch's data.
    throw forbidden("Data ini berada di luar cabang Anda");
  }
}

/** Branch ids this principal may act in. Empty means "no restriction". */
export function allowedCabangIds(principal: Principal): string[] {
  return principal.lintasCabang ? [] : principal.cabangTersedia.map((cabang) => cabang.id);
}

/**
 * SQL fragment for scoping a query to what the principal may see.
 * `{ sql: "TRUE" }` for lintasCabang, otherwise membership in the allowed
 * branch list. Returned as a fragment plus params so a caller cannot forget
 * to parameterise, and as `= ANY(...)` so the shape does not change when a
 * user holds a cross-branch role grant.
 */
export function cabangScopeFilter(
  principal: Principal,
  column = "cabang_id",
  nextParamIndex = 1,
): { sql: string; params: unknown[] } {
  const ids = allowedCabangIds(principal);
  if (ids.length === 0) return { sql: "TRUE", params: [] };
  return { sql: `${column} = ANY($${nextParamIndex}::uuid[])`, params: [ids] };
}

/**
 * The guard surface a module's routes are handed by core/app.ts. Implemented
 * by modules/auth; consumed by every other module. Declared here so no module
 * has to import another module to be guarded.
 */
export interface Guards {
  /** Resolves the session cookie into a Principal, or 401. */
  requireSession: MiddlewareHandler;
  /**
   * Requires ANY of the listed permissions (they are alternatives, which is
   * how "either the config editor or the auditor may read this" is spelled).
   * Every denial writes a DITOLAK row to audit_log (spec 2 rule 5).
   */
  requirePermission: (...permissions: string[]) => MiddlewareHandler;
  /** Rejects every non-GET request from a read-only role. */
  rejectReadOnlyMutation: MiddlewareHandler;
  /**
   * GLOBAL structural guard for read-only roles, registered once in
   * core/app.ts before any route. Resolves the session only when it matters
   * (a mutating method with a session cookie present) and refuses it if the
   * caller's roles are all read-only.
   *
   * This is what makes spec 16 scenario 23 ("Auditor: tidak ada satu pun
   * tombol yang mengubah data") true for routes nobody has written yet: a
   * POST added in Fase 3 is read-only-safe before its author thinks about it.
   */
  enforceReadOnlyRoles: MiddlewareHandler;
}
