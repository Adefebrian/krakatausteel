// The interfaces this module consumes. Re-exported, never redefined.
//
// WHY THE DB AND JOURNAL PORTS ARE DECLARED IN ./contract.ts AND NOT TAKEN
// FROM core/
// `AngsuranDbPort` is wider than `core/ports/db.ts`'s query-only `DbPort`
// because this engine cannot be built on autocommit queries: spec 7.2 puts all
// eight allocation steps in one transaction, spec 7.3 flips a version off and
// writes a new one, and the total-pokok guards are DEFERRED constraint
// triggers that only raise at COMMIT. `PorterJurnalAngsuran` is declared here
// rather than imported from modules/jurnal for the reason given on the type
// itself: spec 7.2 step 8 needs ONE journal with several lines, which is a
// capability `postingEvent` does not have, `bun tools/check-boundaries.ts`
// forbids a deep import into a sibling module, and the rollback requirement is
// only testable if a test can inject a poster that fails.
//
// Consolidating the DB port onto core's is one deliberate later change, and
// this file is the only one that moves.
export type {
  AngsuranContext,
  AngsuranDbPort,
  AngsuranEngineDeps,
  AngsuranTx,
  KomponenJurnal,
  PorterJurnalAngsuran,
} from "./contract";
