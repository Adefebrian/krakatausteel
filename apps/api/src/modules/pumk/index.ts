// The ONLY file another module or the app entrypoint may import from this
// module. A future ./service.ts, ./repo.ts, ./kesalahan.ts and this folder's
// ./test-support.ts stay private.
//
// NO HTTP SURFACE YET, deliberately. This is the tests-first contract for
// Fase 3 (spec 9.1): the state machine, the authorisation rules, the akad and
// disbursement path and the read models are specified and pinned by failing
// tests before a line of behaviour is written. ./routes.ts arrives with the
// implementation, wired with the guard set from modules/auth.
import { createPumkEngine, type PumkEngine, type PumkEngineDeps } from "./contract";

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
