// The ONLY file another module or the app entrypoint may import from this
// module.
import { createOrganisasiRoutes } from "./routes";
import { createOrganisasiService, type OrganisasiServiceDeps } from "./service";
import type { Guards } from "./ports";

export type { CabangRow, KaryawanRow } from "./repo";
export { createOrganisasiService } from "./service";
export type { OrganisasiService } from "./service";

export function createOrganisasiModule(deps: OrganisasiServiceDeps & { guards: Guards }) {
  const service = createOrganisasiService(deps);
  return { service, routes: createOrganisasiRoutes(service, deps.guards) };
}
