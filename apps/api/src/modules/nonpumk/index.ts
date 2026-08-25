// The ONLY file another module or the app entrypoint may import from this
// module. ./service.ts, ./repo.ts, ./baca.ts, ./kesalahan.ts, ./uang.ts and
// this folder's ./test-support.ts and ./rute-test-support.ts stay private.
//
// THE HTTP SURFACE IS HERE NOW (./routes.ts), wired with the guard set the
// auth module hands the composition root, exactly the way the PUMK router is.
// The module was built tests-first: the state machine, the authorisation
// rules, the staged disbursement, the LPJ and the late-LPJ ageing were pinned
// by failing tests before a line of behaviour existed, and the routes were
// added last, over an engine that already refused everything it had to refuse.
import { buatNonPumkBaca, type NonPumkBaca, type PorterMesinNonPumk } from "./baca";
import {
  createNonPumkEngine,
  type NonPumkEngine,
  type NonPumkEngineDeps,
} from "./contract";
import { createNonPumkRoutes } from "./routes";
import type { Guards } from "../../core/principal";

export {
  createNonPumkEngine,
  NonPumkError,
  AMBANG_UMUR_LPJ,
  KODE_NONPUMK,
  KUNCI_KONFIGURASI_NONPUMK,
  PERMISSION_NONPUMK,
  STATUS_TERMINAL_NON_PUMK,
  TRANSISI_SAH_NON_PUMK,
  transisiNonPumkUntuk,
} from "./contract";
export type {
  AjukanLpjInput,
  AksiNonPumk,
  BarisMonitoringLpj,
  BuatProposalNonPumkInput,
  DefinisiTransisiNonPumk,
  EmberUmurLpj,
  FilterMonitoringLpj,
  FilterProposalNonPumk,
  InputPenilaianInput,
  KeputusanApprovalNonPumkInput,
  KeputusanApproverNonPumk,
  KeputusanCheckerNonPumk,
  KodeNonPumk,
  Lpj,
  NonPumkContext,
  NonPumkDbPort,
  NonPumkEngine,
  NonPumkEngineDeps,
  NonPumkTx,
  Penilaian,
  Penyaluran,
  PenyaluranInput,
  PorterJurnalNonPumk,
  ProposalNonPumk,
  ReviewNonPumkInput,
  RingkasanProposal,
  SdgInput,
  SdgProposal,
  StatusLpj,
  StatusProposalNonPumk,
  SumberPengajuanNonPumk,
  TolakLpjInput,
  TransisiProposalNonPumk,
  Uang,
  VerifikasiLpjInput,
} from "./contract";

export type {
  BarisMonitoringLpjBerlabel,
  BarisProposalNonPumk,
  BatasanNonPumk,
  DetailProposalNonPumk,
  NonPumkBaca,
  OpsiReferensi,
  OpsiSdg,
  PorterMesinNonPumk,
} from "./baca";

/**
 * Builds the Non PUMK engine. Called from the composition root
 * (apps/api/src/core/app.ts), which is the only place allowed to know both a
 * module and an adapter. The journal engine satisfies `PorterJurnalNonPumk`
 * structurally, so the wiring is
 * `createNonPumkModule({ db, jurnal: jurnal.engine })` with no adapter in
 * between and invariant 11 holds by construction.
 *
 * THE ENGINE IS A DEPENDENCY, NOT A SINGLETON, for the reason the ledger, the
 * instalment and the PUMK modules all record: a module-global instance gets
 * re-pointed by whichever `createApp` ran last, so with a per-fixture app a
 * call can land on another fixture's connection pool.
 */
export function createNonPumkModule(deps: NonPumkEngineDeps): { engine: NonPumkEngine } {
  return { engine: createNonPumkEngine(deps) };
}

export interface NonPumkModuleDeps extends NonPumkEngineDeps {
  guards: Guards;
}

/**
 * The module WITH its HTTP surface, for the composition root. Kept separate
 * from `createNonPumkModule` above so a caller that only needs the engine (a
 * seed, a later batch job, this folder's own fixtures) does not have to invent
 * a guard set to get one.
 *
 * The read side is handed THE SAME ENGINE INSTANCE the routes write through,
 * as `PorterMesinNonPumk`. That is what makes the list, detail and monitoring
 * screens unable to show a row the engine would have refused: there is no
 * second query carrying a second copy of the branch rule (spec 2 rule 3, spec
 * 16 scenario 24), only a projection over rows the engine already returned.
 */
export function createNonPumkHttpModule(deps: NonPumkModuleDeps): {
  engine: NonPumkEngine;
  baca: NonPumkBaca;
  routes: ReturnType<typeof createNonPumkRoutes>;
} {
  const engine = createNonPumkEngine(deps);
  const mesin: PorterMesinNonPumk = engine;
  const baca = buatNonPumkBaca({ db: deps.db, mesin });
  return {
    engine,
    baca,
    routes: createNonPumkRoutes({ engine, baca, guards: deps.guards }),
  };
}
