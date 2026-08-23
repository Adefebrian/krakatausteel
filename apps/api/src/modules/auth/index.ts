// The ONLY file another module or the app entrypoint may import from this
// module. Exposes the router, the guard set every other module's routes are
// wired with, the permission vocabulary, and the segregation-of-duties
// service; everything else (service.ts, repo.ts, session.ts internals) stays
// private to this folder.
import { createGuards, SESSION_COOKIE } from "./guards";
import { createAuthRoutes } from "./routes";
import { createAuthService, type AuthService, type AuthServiceDeps } from "./service";
import type { AuditService } from "../audit";

export { SESSION_COOKIE } from "./guards";
export { auditActor } from "./guards";
export { serializeSessionCookie } from "./cookie";
export {
  canonicalPermission,
  NAMA_ROLE,
  PERMISSIONS,
  PERMISSION_ALIASES,
  PERMISSIONS_BY_ROLE,
  permissionGroup,
  ROLE_CODES,
  ROLES_LINTAS_CABANG,
  ROLES_READ_ONLY,
  resolveRequiredPermissions,
  type Permission,
  type RoleCode,
} from "./permissions";
export { createSegregationService, konflikPeran, type SegregationService } from "./segregation";
export {
  createSessionStore,
  generateSessionId,
  DEFAULT_IDLE_TTL_SECONDS,
  DEFAULT_ABSOLUTE_TTL_SECONDS,
  type SessionRecord,
  type SessionStore,
} from "./session";
export { createAuthService } from "./service";
export type { AuthService, LoginResult, SessionPayload } from "./service";

export interface AuthModule {
  service: AuthService;
  guards: ReturnType<typeof createGuards>;
  routes: ReturnType<typeof createAuthRoutes>;
  cookieName: string;
}

export function createAuthModule(deps: AuthServiceDeps & { audit: AuditService }): AuthModule {
  const service = createAuthService(deps);
  const guards = createGuards({ auth: service, audit: deps.audit });
  return {
    service,
    guards,
    routes: createAuthRoutes(service, guards),
    cookieName: SESSION_COOKIE,
  };
}
