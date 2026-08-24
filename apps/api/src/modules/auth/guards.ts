// Server-side authorisation middleware. Spec 2 rule 4: "Otorisasi divalidasi
// di layer server, bukan hanya di UI." Everything here is the enforcement
// point; the SPA's nav filter is a convenience and is explicitly not a
// control.
//
// EVERY DENIAL IS LOGGED (spec 2 rule 5), including the anonymous ones. The
// audit write is awaited before the 401/403 goes out and is NOT wrapped in a
// try/catch that swallows it: if the trail cannot be written the request fails
// with a 500 rather than quietly producing an unrecorded denial. audit_log is
// append-only (migrations/0014), so there is no path that rewrites this later.
import type { Context, MiddlewareHandler, Next } from "hono";
import { getCookie } from "hono/cookie";
import { AppError, forbidden, markDenialLogged, unauthenticated } from "../../core/http";
import { clientIp } from "../../core/hardening";
import { getPrincipal, setPrincipal, type Guards, type Principal } from "../../core/principal";
import type { AuditService } from "../audit";
import { resolveRequiredPermissions } from "./permissions";
import type { AuthService } from "./service";

export const SESSION_COOKIE = "tjsl_sid";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface GuardDeps {
  auth: AuthService;
  audit: AuditService;
}

/** Request facts every audit row needs, gathered in one place. */
export function auditActor(c: Context): { userId: string | null; ip: string | null; userAgent: string | null } {
  const principal = getPrincipal(c);
  return {
    userId: principal?.userId ?? null,
    ip: clientIp(c),
    // Truncated: user agents are attacker-controlled free text and this
    // column is read by humans.
    userAgent: (c.req.header("user-agent") ?? null)?.slice(0, 512) ?? null,
  };
}

export function createGuards({ auth, audit }: GuardDeps): Guards {
  async function denied(
    c: Context,
    error: AppError,
    entry: { aksi: string; entitas: string; entitasId?: string | null; keterangan: string },
  ): Promise<never> {
    await audit.recordFor(auditActor(c), {
      aksi: entry.aksi,
      entitas: entry.entitas,
      entitasId: entry.entitasId ?? null,
      nilaiBaru: { metode: c.req.method, path: c.req.path },
      hasil: "DITOLAK",
      keterangan: entry.keterangan,
    });
    // Tells the error handler (core/http.ts) that this request's denial is
    // already in audit_log, so it does not write a second row.
    markDenialLogged(c);
    throw error;
  }

  const requireSession: MiddlewareHandler = async (c: Context, next: Next) => {
    // Already resolved by an outer guard on this route: do not pay for a
    // second Redis read plus principal query.
    if (getPrincipal(c)) return next();

    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) {
      return denied(c, unauthenticated("Anda belum masuk"), {
        aksi: "auth.akses",
        entitas: "sesi",
        keterangan: "tidak ada cookie sesi",
      });
    }
    const resolved = await auth.resolveSession(cookie);
    if (!resolved) {
      return denied(c, unauthenticated("Sesi tidak valid atau sudah berakhir"), {
        aksi: "auth.akses",
        entitas: "sesi",
        keterangan: "sesi tidak ditemukan, kedaluwarsa, atau pengguna tidak aktif",
      });
    }
    setPrincipal(c, resolved.principal);
    return next();
  };

  /**
   * Read-only roles cannot mutate, structurally: the check is on the HTTP
   * METHOD, so a route written in Fase 3 by someone who never thought about
   * the Auditor is already safe (spec 16 scenario 23). A read-only role that
   * needs a POST for a genuinely non-mutating action (a report that takes a
   * long filter body) is a design smell to fix in the route, not here.
   */
  const rejectReadOnlyMutation: MiddlewareHandler = async (c: Context, next: Next) => {
    const principal = getPrincipal(c);
    if (principal?.readOnly && !SAFE_METHODS.has(c.req.method)) {
      return denied(
        c,
        forbidden("Peran Anda bersifat read only dan tidak dapat mengubah data"),
        {
          aksi: "auth.otorisasi",
          entitas: "sesi",
          entitasId: principal.userId,
          keterangan: `peran read only (${principal.roles.join(",")}) mencoba ${c.req.method} ${c.req.path}`,
        },
      );
    }
    return next();
  };

  /**
   * Paths a read-only role must still be able to POST to. Ending your own
   * session is not a data change, and logging in cannot be gated on the roles
   * of a session that does not exist yet.
   */
  const READ_ONLY_EXEMPT = new Set(["/auth/login", "/auth/logout"]);

  const enforceReadOnlyRoles: MiddlewareHandler = async (c: Context, next: Next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (READ_ONLY_EXEMPT.has(c.req.path)) return next();

    // No cookie: this is an anonymous mutation attempt, and whether that is
    // allowed is the route's own business (a public portal submission in
    // Fase 7 is legitimate). Nothing to check about roles.
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) return next();

    if (!getPrincipal(c)) {
      const resolved = await auth.resolveSession(cookie);
      // An invalid session is left for the route's requireSession to reject,
      // with its own audit row. Silently 401-ing here would double-log and
      // would answer 401 to public routes that do not need a session at all.
      if (resolved) setPrincipal(c, resolved.principal);
    }
    return rejectReadOnlyMutation(c, next);
  };

  const requirePermission = (...permissions: string[]): MiddlewareHandler => {
    // Resolved once at route-registration time, so an unknown permission code
    // is a boot-time error rather than a 403 that looks like policy.
    const required = resolveRequiredPermissions(permissions);
    if (required.length === 0) {
      throw new Error("requirePermission() dipanggil tanpa permission");
    }
    return async (c: Context, next: Next) => {
      const principal = getPrincipal(c);
      if (!principal) {
        // requirePermission without requireSession in front of it would be a
        // wiring bug; treat it as unauthenticated rather than crash.
        return denied(c, unauthenticated("Anda belum masuk"), {
          aksi: "auth.otorisasi",
          entitas: "sesi",
          keterangan: `permission ${required.join("|")} diminta tanpa sesi`,
        });
      }
      const granted = required.some((code) => principal.permissions.includes(code));
      if (!granted) {
        return denied(
          c,
          forbidden("Anda tidak punya wewenang untuk tindakan ini"),
          {
            aksi: "auth.otorisasi",
            entitas: "sesi",
            entitasId: principal.userId,
            keterangan:
              `permission kurang: butuh ${required.join(" atau ")}; ` +
              `peran ${principal.roles.join(",") || "(tanpa peran)"}`,
          },
        );
      }
      return next();
    };
  };

  return { requireSession, requirePermission, rejectReadOnlyMutation, enforceReadOnlyRoles };
}

/** Re-exported so route files can annotate their handler's principal. */
export type { Principal };
export { AppError };
