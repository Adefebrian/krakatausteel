// The interfaces this module consumes from core. Re-exported, not redefined.
export type { DbPort, QueryRunner } from "../../core/ports/db";
export type { Guards, Principal } from "../../core/principal";

import type { QueryRunner } from "../../core/ports/db";

/**
 * The slice of the audit service this module needs, declared STRUCTURALLY so
 * the module depends on a shape rather than on `modules/audit`. The real
 * `AuditService` satisfies it, and so does a stub in a test.
 *
 * There is deliberately no journal port here and there never will be: this
 * module posts nothing. Invariant 11 says every financially consequential
 * event goes through `postingEvent`, and the cleanest way to keep a module out
 * of the ledger is to give it no way in (the same move `modules/tools` makes).
 */
export interface AuditPort {
  record(
    entry: {
      userId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      aksi: string;
      entitas: string;
      entitasId?: string | null;
      nilaiLama?: unknown;
      nilaiBaru?: unknown;
      hasil: "SUKSES" | "DITOLAK";
      keterangan?: string | null;
    },
    runner?: QueryRunner,
  ): Promise<string>;
}
