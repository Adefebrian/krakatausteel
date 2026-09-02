// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts and ./routes.ts stay private.
//
// SPEC 9.5, THE INTAKE HALF. This module owns `portal_submission` and nothing
// else. It takes no journal port, so there is no path from a public form to a
// `jurnal` row at all: invariant 11 is not merely respected here, it is
// unreachable. It also cannot create a mitra, a proposal or an akad; the one
// transition that turns a submission into operational data is
// `pumk.konversiSubmissionPortal` under `portal.konversi`, a staff act, and
// this module deliberately cannot reach the `DIKONVERSI` status that would
// claim such a proposal exists.
//
// The mitra's own login and self-service reads are NOT here: they are a second
// kind of PRINCIPAL, which is a different problem with a different threat
// model, and they live in modules/mitra.
import { createPortalEngine } from "./service";
import { createPortalRoutes } from "./routes";
import type { Guards } from "../../core/principal";
import type { RateLimiterPort } from "../../core/ports/ratelimit";
import type { PortalEngine, PortalEngineDeps } from "./contract";

export {
  createPortalEngine,
  buatNoTiket,
  validasiFormulir,
  validasiDokumen,
  tanggalLahirValid,
} from "./service";
export {
  PortalError,
  KODE_PORTAL,
  PERMISSION_PORTAL,
  FIELD_PUMK,
  FIELD_NON_PUMK,
  JENIS_DOKUMEN,
  POLA_TIKET,
  POLA_UANG,
  BATAS_BARIS_BAWAAN,
  BATAS_BARIS_MAKS,
  BATAS_CEK_PER_IP,
  BATAS_CEK_PER_TIKET,
  BATAS_PENGAJUAN_PER_IP,
  BATAS_PENGAJUAN_PER_IP_HARIAN,
  JENDELA_CEK_DETIK,
  JENDELA_PENGAJUAN_DETIK,
  MAKS_DOKUMEN,
} from "./contract";
export type {
  BatasPortal,
  CekStatusInput,
  DetailSubmission,
  DokumenPengajuan,
  FilterSubmission,
  HasilPengajuan,
  JenisDokumen,
  JenisPengajuan,
  KodePortal,
  PengajuanInput,
  PortalContext,
  PortalEngine,
  PortalEngineDeps,
  PortalPublikContext,
  RingkasanSubmission,
  StatusPengajuan,
  StatusSubmission,
  TindakInput,
  TindakanPetugas,
} from "./contract";
export { MAKS_BADAN_PORTAL } from "./routes";

/**
 * Builds the engine. THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for the
 * reason modules/jurnal records: a module-global instance gets re-pointed by
 * whichever `createApp` ran last, so with a per-fixture app a call can land on
 * another fixture's pool.
 */
export function createPortalModule(deps: PortalEngineDeps): { engine: PortalEngine } {
  return { engine: createPortalEngine(deps) };
}

export interface PortalModuleDeps extends PortalEngineDeps {
  guards: Guards;
  /**
   * The FAIL CLOSED limiter, the same policy modules/auth's login uses. Redis
   * is where the counters live; if it is down, refusing a public write beats
   * handing an attacker an unmetered window by knocking the cache over first.
   */
  pembatasRute: RateLimiterPort;
}

export function createPortalHttpModule(deps: PortalModuleDeps): {
  engine: PortalEngine;
  routes: ReturnType<typeof createPortalRoutes>;
} {
  const engine = createPortalEngine(deps);
  return {
    engine,
    routes: createPortalRoutes({
      engine,
      guards: deps.guards,
      pembatas: deps.pembatasRute,
      ...(deps.batas ? { batas: deps.batas } : {}),
      ...(deps.keyPrefix ? { keyPrefix: `${deps.keyPrefix}:portal-rute` } : {}),
    }),
  };
}
