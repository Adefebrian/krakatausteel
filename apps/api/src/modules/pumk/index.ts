// The ONLY file another module or the app entrypoint may import from this
// module. A future ./service.ts, ./repo.ts, ./kesalahan.ts and this folder's
// ./test-support.ts stay private.
//
// THE HTTP SURFACE IS HERE NOW (./routes.ts), wired with the guard set from
// modules/auth exactly as every other module's router is. The module was built
// tests-first: the state machine, the authorisation rules, the akad and
// disbursement path and the read models were pinned by failing tests before a
// line of behaviour existed, and the routes were added last, over an engine
// that already refused everything it had to refuse.
//
// ./service.ts, ./repo.ts, ./baca.ts, ./kesalahan.ts, ./uang.ts and this
// folder's ./test-support.ts stay private.
import { buatPumkBaca, type PorterAngsuranBaca, type PorterKonfigurasiPumk, type PumkBaca } from "./baca";
import { createPumkEngine, type PumkEngine, type PumkEngineDeps } from "./contract";
import { createPumkRoutes, type PorterPenyimpananPumk } from "./routes";
import type { Guards } from "../../core/principal";

export {
  createPumkEngine,
  PumkError,
  KODE_PUMK,
  KUNCI_KONFIGURASI_PUMK,
  PERMISSION_PUMK,
  STATUS_TERMINAL,
  TRANSISI_SAH,
  transisiUntuk,
} from "./contract";
export type {
  AksiProposal,
  Akad,
  AnggotaCluster,
  BuatAkadInput,
  BuatProposalInput,
  DefinisiTransisi,
  FilterProposal,
  HasilPencairan,
  InputSurveyInput,
  JaminanInput,
  JenisPengakhiran,
  JenisTindakLanjut,
  KartuPiutang,
  KeputusanApprovalInput,
  KeputusanApprover,
  KeputusanChecker,
  KodePumk,
  KonversiPortalInput,
  MetodePerhitungan,
  PencairanInput,
  Pengakhiran,
  PengakhiranInput,
  PorterAngsuranPumk,
  PorterJurnalPumk,
  Proposal,
  PumkContext,
  PumkDbPort,
  PumkEngine,
  PumkEngineDeps,
  PumkTx,
  RateTahunan,
  ReviewInput,
  StatusAkad,
  StatusProposal,
  Survey,
  TerimaAngsuranInput,
  TindakLanjut,
  TindakLanjutInput,
  TransisiProposal,
  Uang,
} from "./contract";

/**
 * Builds the module. Called from the composition root
 * (apps/api/src/core/app.ts), the only place allowed to know both a module and
 * an adapter:
 *
 *   const jurnal = createJurnalModule({ db });
 *   const angsuran = createAngsuranModule({ db, jurnal: jurnal.engine });
 *   const pumk = createPumkModule({ db, angsuran: angsuran.engine, jurnal: jurnal.engine });
 *
 * Both engines satisfy the ports this module declares structurally, so there
 * is no adapter in between and invariants 8 and 11 hold by construction: this
 * module has no other route to a schedule row or a journal row.
 *
 * THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for the reason modules/jurnal
 * and modules/angsuran both record: a module-global instance gets re-pointed
 * by whichever `createApp` ran last, so with a per-fixture app a call can land
 * on another fixture's connection pool.
 */
export function createPumkModule(deps: PumkEngineDeps): { engine: PumkEngine } {
  return { engine: createPumkEngine(deps) };
}

export type { PorterAngsuranBaca, PorterKonfigurasiPumk, PorterPenyimpananPumk, PumkBaca };
export type {
  BarisAkad,
  BarisAnggotaCluster,
  BarisCluster,
  BarisJaminan,
  BarisProposal,
  BarisTransisi,
  BatasanPumk,
  DetailProposal,
  OpsiReferensi,
  PratinjauPengakhiran,
  PratinjauReschedule,
  RingkasanMitra,
} from "./baca";

export interface PumkModuleDeps extends PumkEngineDeps {
  /**
   * The SAME instalment engine instance the write path is given. The preview
   * of a rescheduled table and the table the approval actually generates must
   * come from one engine, or spec 7.5 item 11's identity is hopeful rather
   * than structural.
   */
  angsuran: PumkEngineDeps["angsuran"] & PorterAngsuranBaca;
  /** modules/konfigurasi's service. `GET /pumk/batasan` reads spec 5.5 from it. */
  konfigurasi: PorterKonfigurasiPumk;
  /** Object storage for `POST /pumk/lampiran`. Satisfied by ObjectStorePort. */
  penyimpanan: PorterPenyimpananPumk;
  guards: Guards;
}

/**
 * The module WITH its HTTP surface, for the composition root. Kept separate
 * from `createPumkModule` above so a caller that only needs the engine (a
 * seed, a later batch job, this folder's own fixtures) does not have to invent
 * a guard set and an object store to get one.
 */
export function createPumkHttpModule(deps: PumkModuleDeps): {
  engine: PumkEngine;
  baca: PumkBaca;
  routes: ReturnType<typeof createPumkRoutes>;
} {
  const engine = createPumkEngine(deps);
  const baca = buatPumkBaca({
    db: deps.db,
    angsuran: deps.angsuran,
    konfigurasi: deps.konfigurasi,
  });
  return {
    engine,
    baca,
    routes: createPumkRoutes({
      engine,
      baca,
      penyimpanan: deps.penyimpanan,
      guards: deps.guards,
    }),
  };
}
