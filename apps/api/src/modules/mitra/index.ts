// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./sesi.ts, ./guards.ts and ./routes.ts stay
// private.
//
// THE SECOND KIND OF PRINCIPAL (spec 4.9). ./contract.ts's header is the
// argument for why a mitra is not an `app_user` with an empty role, and it is
// the first thing to read before changing anything in this folder.
//
// NO JOURNAL PORT, NO ANGSURAN PORT, NO PUMK PORT, and every mitra-facing
// route is a GET except "change my own password" and "log out". This engine
// issues SELECTs filtered by the session's own `mitra_id` and nothing else, so
// invariant 11 is unreachable from here rather than merely respected.
import { createMitraEngine } from "./service";
import { createMitraRoutes } from "./routes";
import { createMitraSessionStore } from "./sesi";
import type { Guards } from "../../core/principal";
import type { KeyValueStorePort } from "../../core/ports/keyvalue";
import type { RateLimiterPort } from "../../core/ports/ratelimit";
import type { MitraEngine, MitraEngineDeps } from "./contract";

export { createMitraEngine, buatSandiSementara } from "./service";
export { createMitraSessionStore, generateMitraSessionId } from "./sesi";
export {
  MITRA_COOKIE,
  MITRA_COOKIE_PATH,
  MITRA_PRINCIPAL_VAR,
  createMitraGuards,
  getMitraPrincipal,
  requireMitraPrincipal,
  serializeMitraCookie,
} from "./guards";
export {
  MitraError,
  KODE_MITRA,
  PERMISSION_MITRA,
  BATAS_MASUK_PER_EMAIL,
  BATAS_MASUK_PER_IP,
  JENDELA_MASUK_DETIK,
  IDLE_TTL_MITRA_DETIK,
  ABSOLUTE_TTL_MITRA_DETIK,
  MIN_PANJANG_SANDI,
  MAKS_PANJANG_SANDI,
} from "./contract";
export type {
  AkadMitra,
  BarisJadwalMitra,
  BuatAkunInput,
  HasilBuatAkun,
  HasilMasuk,
  JadwalMitra,
  KodeMitra,
  MasukInput,
  MitraDbPort,
  MitraEngine,
  MitraEngineDeps,
  MitraPrincipal,
  MitraSessionRecord,
  MitraSessionStore,
  PembayaranMitra,
  ProfilMitra,
} from "./contract";

export interface MitraModuleDeps extends Omit<MitraEngineDeps, "sesi"> {
  /** Strict store: a session that could not be written must fail the login. */
  kv: KeyValueStorePort;
  sesi?: MitraEngineDeps["sesi"];
  sessionOptions?: { idleTtlSeconds?: number; absoluteTtlSeconds?: number; now?: () => Date };
}

/**
 * Builds the engine. THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for the
 * reason modules/jurnal records: a module-global instance gets re-pointed by
 * whichever `createApp` ran last, so with a per-fixture app a call can land on
 * another fixture's pool.
 */
export function createMitraModule(deps: MitraModuleDeps): { engine: MitraEngine } {
  const sesi =
    deps.sesi ??
    createMitraSessionStore({
      kv: deps.kv,
      ...(deps.sessionOptions ?? {}),
      ...(deps.jam ? { now: deps.jam } : {}),
    });
  return { engine: createMitraEngine({ ...deps, sesi }) };
}

export interface MitraHttpModuleDeps extends MitraModuleDeps {
  /** The STAFF guards, for the two provisioning routes only. */
  guards: Guards;
  /** FAIL CLOSED, the same policy the staff login limiter uses. */
  pembatasRute: RateLimiterPort;
}

export function createMitraHttpModule(deps: MitraHttpModuleDeps): {
  engine: MitraEngine;
  routes: ReturnType<typeof createMitraRoutes>;
} {
  const { engine } = createMitraModule(deps);
  return {
    engine,
    routes: createMitraRoutes({
      engine,
      audit: deps.audit,
      guards: deps.guards,
      pembatas: deps.pembatasRute,
      ...(deps.keyPrefix ? { keyPrefix: `${deps.keyPrefix}:mitra-rute` } : {}),
    }),
  };
}
