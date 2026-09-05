// The ONLY file another module or the app entrypoint may import from this
// module.
import { createOrganisasiAdminService, type OrganisasiAdminDeps } from "./admin-service";
import { createOrganisasiRoutes } from "./routes";
import { createOrganisasiService, type OrganisasiServiceDeps } from "./service";
import type { Guards } from "./ports";

export type { CabangRow, KaryawanRow, PenggunaRow } from "./repo";
export { createOrganisasiService } from "./service";
export type { OrganisasiService } from "./service";
export { createOrganisasiAdminService } from "./admin-service";
export type { OrganisasiAdminService, PenggunaTampil } from "./admin-service";
export { alasanTidakBolehMemberiPeran, peranUntukPemberi } from "./peran";
export type { PeranTersedia } from "./peran";

export type OrganisasiModuleDeps = OrganisasiServiceDeps & OrganisasiAdminDeps & { guards: Guards };

export function createOrganisasiModule(deps: OrganisasiModuleDeps) {
  const service = createOrganisasiService(deps);
  const admin = createOrganisasiAdminService(deps);
  return { service, admin, routes: createOrganisasiRoutes(service, admin, deps.guards) };
}
