// The ONLY file another module or the app entrypoint may import from this
// module. Later phases (the journal, instalment and closing engines) read
// every business parameter through the service exported here.
import { createKonfigurasiAdminService, type KonfigurasiAdminDeps } from "./admin-service";
import { createKonfigurasiRoutes } from "./routes";
import { createKonfigurasiService, type KonfigurasiServiceDeps } from "./service";
import type { Guards } from "./ports";

export {
  KATALOG,
  entriTambahan,
  entriPerluKonfirmasiKlien,
  periksaNilai,
  tipeDataUntuk,
  compareDesimal,
} from "./katalog";
export type { AsalNilai, KatalogEntri, BentukNilai } from "./katalog";
export { createKonfigurasiService, konfigurasiRusak, CACHE_TTL_SECONDS } from "./service";
export { createKonfigurasiAdminService } from "./admin-service";
export type { AkunTampil, KonfigurasiAdminService } from "./admin-service";
export { definisiMaster, MASTER } from "./master";
export type { DefinisiMaster } from "./master";
export type { ReferensiRow } from "./repo";
export type {
  AkuntansiConfig,
  AngsuranConfig,
  BatasanConfig,
  JasaAdmConfig,
  KonfigurasiService,
  NilaiResolusi,
} from "./service";

export function createKonfigurasiModule(
  deps: KonfigurasiServiceDeps & KonfigurasiAdminDeps & { guards: Guards },
) {
  const service = createKonfigurasiService(deps);
  const admin = createKonfigurasiAdminService(deps);
  return { service, admin, routes: createKonfigurasiRoutes(service, admin, deps.guards) };
}
