// The ONLY file another module or the app entrypoint may import from this
// module.
import { createAuditRoutes } from "./routes";
import { createAuditService, type AuditServiceDeps } from "./service";
import type { Guards } from "./ports";

export type { AuditEntry, AuditHasil, AuditRow } from "./repo";
export type { AuditActor, AuditService } from "./service";
export { createAuditService } from "./service";

export function createAuditModule(deps: AuditServiceDeps & { guards: Guards }) {
  const service = createAuditService(deps);
  return { service, routes: createAuditRoutes(service, deps.guards) };
}
