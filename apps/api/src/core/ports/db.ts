// Port interface for the relational database. Modules depend on this shape,
// never on `pg` directly. See core/adapters/db.ts for the concrete adapter.
//
// WHY A TRANSACTION IS PART OF THE PORT, NOT AN ADAPTER DETAIL
// Every financial operation in this system is multi-statement and must be all
// or nothing:
//   - spec 7.2 (alokasi setoran) is 8 steps: read schedule, allocate, write
//     payment lines, update outstanding, create the journal header, create its
//     lines, post, update the mitra state. Half of that on disk is a corrupt
//     ledger, not a retryable error.
//   - spec 6.3 (reversal) has to write the reversing journal AND revert the
//     business state it originally moved, together.
//   - ADR 0002: the balance and schedule-total guards are DEFERRED constraint
//     triggers, so they only fire at COMMIT. A service that does not own a
//     transaction boundary literally cannot observe those violations.
// So `transaction` is a capability of the port itself: a module that needs
// atomicity asks the port for it and never has to know a pool exists.

/**
 * The read/write surface shared by the pool and by a single transaction.
 * A repo should take this, not `DbPort`, so the same repo function works
 * inside and outside a transaction.
 */
export interface QueryRunner {
  /** Runs a parameterized query and returns the result rows. */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface DbPort extends QueryRunner {
  /**
   * Runs `fn` inside one BEGIN/COMMIT on a single connection. The runner
   * handed to `fn` is bound to that connection: every query it issues is
   * inside the transaction, and queries issued through the outer `DbPort`
   * are NOT (they take another pooled connection), which is deliberate and
   * why the callback receives its own runner instead of relying on ambient
   * state.
   *
   * Commits when `fn` resolves, ROLLBACKs when it rejects, and always
   * releases the connection. Rejection is re-thrown unchanged so a domain
   * error keeps its type; a COMMIT-time failure (deferred trigger, see
   * ADR 0002) surfaces as the thrown Postgres error.
   *
   * `QueryRunner` deliberately has no `transaction` method, so a nested
   * transaction is a compile error rather than a silent no-op savepoint.
   */
  transaction<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T>;
}
