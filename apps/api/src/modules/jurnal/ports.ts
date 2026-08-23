// The interfaces this module consumes. Re-exported, never redefined.
//
// WHY THE DB PORT IS DECLARED IN ./contract.ts AND NOT TAKEN FROM core/
// `JurnalDbPort` is the same shape as `core/ports/db.ts`'s `DbPort`
// (query + transaction) and is structurally assignable to it, which is how
// this module hands its port to the `nomor` service without naming a core
// type. It is declared locally because the journal engine's transaction
// requirements are part of ITS contract (postingBatch atomicity,
// same-transaction business-state reversal, a deferred balance trigger that
// only raises at COMMIT), and because core/** is owned by another workstream
// while this engine is being built. Consolidating the two onto the core port
// is one deliberate later change, and this file is the only one that moves.
export type { JurnalDbPort, JurnalTx, PembalikStateBisnis } from "./contract";
