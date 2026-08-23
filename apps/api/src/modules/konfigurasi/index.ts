// The ONLY file another module or the app entrypoint may import from this
// module. Later phases (the journal, instalment and closing engines) read
// every business parameter through the service exported here.
import { createKonfigurasiRoutes } from "./routes";
import { createKonfigurasiService, type KonfigurasiServiceDeps } from "./service";
import type { Guards } from "./ports";

export { KATALOG, entriTambahan, periksaNilai, tipeDataUntuk, compareDesimal } from "./katalog";
export type { KatalogEntri, BentukNilai } from "./katalog";
export { createKonfigurasiService, konfigurasiRusak, CACHE_TTL_SECONDS } from "./service";
export type {
  AkuntansiConfig,
  AngsuranConfig,
  BatasanConfig,
  JasaAdmConfig,
  KonfigurasiService,
  NilaiResolusi,
} from "./service";

export function createKonfigurasiModule(deps: KonfigurasiServiceDeps & { guards: Guards }) {
  const service = createKonfigurasiService(deps);
  return { service, routes: createKonfigurasiRoutes(service, deps.guards) };
}
