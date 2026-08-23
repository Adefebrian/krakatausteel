// Audit trail service. Spec 4.10 for the shape, spec 2 rule 5 for the reason:
// every authorisation denial is recorded, not just every success.
//
// TWO PROPERTIES THAT ARE NOT NEGOTIABLE
//
// 1. A failed write is an error, never a swallowed one. audit_log is
//    append-only (migrations/0014) and it is the evidence an auditor will ask
//    for; an action that happened without a log row is worse than an action
//    that failed. So `record` throws, and callers let it throw. The one place
//    that must not throw is the deny path itself, and even there the failure
//    turns into a 500 rather than the request quietly succeeding.
//
// 2. It accepts a QueryRunner. A mutation that runs in a transaction logs
//    inside that same transaction, so a rolled-back financial operation does
//    not leave a SUKSES row claiming it happened. Denials and login attempts
//    have no transaction and go straight to the pool.
import type { DbPort, QueryRunner } from "./ports";
import { createAuditRepo, type AuditEntry, type AuditFilter, type AuditRepo, type AuditRow } from "./repo";

export interface AuditServiceDeps {
  db: DbPort;
  repo?: AuditRepo;
}

/** Request-scoped facts every entry needs, gathered once by the route layer. */
export interface AuditActor {
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditService {
  /** Writes one row. Throws if it cannot. */
  record(entry: AuditEntry, runner?: QueryRunner): Promise<string>;
  /** Convenience for the common shape: actor + action + outcome. */
  recordFor(
    actor: AuditActor,
    entry: Omit<AuditEntry, "userId" | "ip" | "userAgent">,
    runner?: QueryRunner,
  ): Promise<string>;
  list(filter: AuditFilter): Promise<AuditRow[]>;
}

export function createAuditService({ db, repo = createAuditRepo() }: AuditServiceDeps): AuditService {
  return {
    async record(entry, runner) {
      return repo.insert(runner ?? db, entry);
    },
    async recordFor(actor, entry, runner) {
      return repo.insert(runner ?? db, {
        ...entry,
        userId: actor.userId ?? null,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
      });
    },
    async list(filter) {
      return repo.list(db, filter);
    },
  };
}
