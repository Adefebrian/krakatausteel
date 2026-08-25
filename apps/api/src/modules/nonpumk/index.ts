// The ONLY file another module or the app entrypoint may import from this
// module. A future ./service.ts, ./repo.ts, ./kesalahan.ts and this folder's
// ./test-support.ts stay private.
//
// NO HTTP SURFACE YET, deliberately. This is the tests-first contract for
// Fase 4 (spec 9.2): the state machine, the authorisation rules, the staged
// disbursement, the LPJ and the late-LPJ ageing are specified and pinned by
// failing tests before a line of behaviour is written. ./routes.ts arrives
// with the implementation, wired with the guard set from modules/auth.
import {
  createNonPumkEngine,
  type NonPumkEngine,
  type NonPumkEngineDeps,
} from "./contract";

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

/**
 * Builds the Non PUMK engine. Called from the composition root
 * (apps/api/src/core/app.ts), which is the only place allowed to know both a
 * module and an adapter. `jurnal.engine` satisfies `PorterJurnalNonPumk`
 * structurally, so the wiring is
 * `createNonPumkModule({ db, jurnal: jurnal.engine })` with no adapter in
 * between and invariant 11 holds by construction.
 */
export function createNonPumkModule(deps: NonPumkEngineDeps): { engine: NonPumkEngine } {
  return { engine: createNonPumkEngine(deps) };
}
