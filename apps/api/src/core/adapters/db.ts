// Concrete DbPort adapter, wrapping the lazily-constructed pg Pool in
// ../../lib/db. Importing this module never opens a socket; only an actual
// query does (see lib/db.ts), so it is always safe under `bun test`.
import { getDb } from "../../lib/db";
import type { DbPort, QueryRunner } from "../ports/db";

export function createDbAdapter(): DbPort {
  return {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await getDb().query(sql, params);
      return result.rows as T[];
    },

    async transaction<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> {
      // One checked-out client for the whole transaction. Using the pool
      // inside a transaction would silently run statements on a different
      // connection, i.e. outside the BEGIN, which is the classic way to lose
      // half a financial operation.
      const client = await getDb().connect();
      const tx: QueryRunner = {
        async query<R = unknown>(sql: string, params: unknown[] = []): Promise<R[]> {
          const result = await client.query(sql, params);
          return result.rows as R[];
        },
      };
      try {
        await client.query("BEGIN");
        const value = await fn(tx);
        // COMMIT can itself fail: the deferred constraint triggers from
        // ADR 0002 (journal balance, schedule principal) fire here. Letting
        // that reject out of `transaction` is correct; the finally block
        // still releases the connection.
        await client.query("COMMIT");
        return value;
      } catch (err) {
        // Best effort: if the connection is already broken, ROLLBACK will
        // fail too, and the original error is the one worth reporting.
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
