// Tests for DbPort.transaction against a REAL Postgres (tjsl_test).
//
// A fake would prove nothing here: the property under test is that a failure
// halfway through leaves NOTHING on disk, and that is a database behaviour, not
// a TypeScript one. ADR 0002 also makes this load-bearing for later phases,
// because the journal balance and schedule-total guards are DEFERRED constraint
// triggers that only fire at COMMIT.
import { afterAll, describe, expect, test } from "bun:test";
import { createDbAdapter } from "./adapters/db";
import type { QueryRunner } from "./ports/db";
import { tandaiBumnUjiTerhapus } from "../testing/harness";

const db = createDbAdapter();

/** Unique per test, because other agents reset this database mid-run. */
function uniq(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function bumnCount(kode: string): Promise<number> {
  const rows = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM bumn WHERE kode = $1", [kode]);
  return Number(rows[0]?.n ?? "0");
}

/** Every kode this file inserted under, committed or not. */
const kodeDibuat: string[] = [];

async function insertBumn(runner: QueryRunner, kode: string): Promise<string> {
  kodeDibuat.push(kode);
  const rows = await runner.query<{ id: string }>(
    "INSERT INTO bumn (kode, nama) VALUES ($1, $2) RETURNING id::text AS id",
    [kode, `Uji ${kode}`],
  );
  return rows[0]!.id;
}

// Closes whatever actually committed. Tracked by KODE, not by id, because the
// rollback tests hand back ids for rows that never landed; resolving kode ->
// id here means the rolled-back ones simply do not come back, and `bumnCount`
// above still sees every row while the tests that assert on it are running.
// See the FIXTURE LEAK note in apps/api/src/testing/harness.ts.
afterAll(async () => {
  if (kodeDibuat.length === 0) return;
  const rows = await db
    .query<{ id: string }>(
      "SELECT id::text AS id FROM bumn WHERE kode = ANY($1::text[]) AND deleted_at IS NULL",
      [kodeDibuat],
    )
    .catch(() => [] as { id: string }[]);
  for (const row of rows) {
    await tandaiBumnUjiTerhapus(db, row.id).catch(() => {});
  }
});

describe("DbPort.transaction", () => {
  test("commits every statement when the callback resolves", async () => {
    const kode = uniq("TX-OK");
    const cabangKode = uniq("C").slice(0, 8);
    const result = await db.transaction(async (tx) => {
      const bumnId = await insertBumn(tx, kode);
      await tx.query("INSERT INTO cabang (bumn_id, kode, nama) VALUES ($1, $2, $3)", [
        bumnId,
        cabangKode,
        "Cabang Uji",
      ]);
      return bumnId;
    });
    expect(result).toMatch(/^[0-9a-f-]{36}$/);
    expect(await bumnCount(kode)).toBe(1);
    const cabang = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM cabang WHERE bumn_id = $1",
      [result],
    );
    expect(Number(cabang[0]!.n)).toBe(1);
  });

  test("rolls back EVERY write when the callback throws, leaving no partial state", async () => {
    const kode = uniq("TX-ROLLBACK");
    const boom = new Error("gagal di tengah operasi");
    let bumnIdSeenInside: string | undefined;

    await expect(
      db.transaction(async (tx) => {
        bumnIdSeenInside = await insertBumn(tx, kode);
        // Visible INSIDE the transaction...
        const inside = await tx.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM bumn WHERE kode = $1",
          [kode],
        );
        expect(Number(inside[0]!.n)).toBe(1);
        await tx.query("INSERT INTO cabang (bumn_id, kode, nama) VALUES ($1, '99', 'Akan hilang')", [
          bumnIdSeenInside,
        ]);
        throw boom;
      }),
    ).rejects.toThrow("gagal di tengah operasi");

    // ...and gone afterwards. Both rows, not just the last one.
    expect(await bumnCount(kode)).toBe(0);
    const cabang = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM cabang WHERE bumn_id = $1",
      [bumnIdSeenInside!],
    );
    expect(Number(cabang[0]!.n)).toBe(0);
  });

  test("re-throws the original error object, so a domain error keeps its type", async () => {
    class DomainError extends Error {
      readonly kode = "TJSL-UJI-001";
    }
    const err = await db
      .transaction(async () => {
        throw new DomainError("aturan bisnis dilanggar");
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).kode).toBe("TJSL-UJI-001");
  });

  test("a database error inside the transaction also rolls the whole thing back", async () => {
    const kode = uniq("TX-DBERR");
    await expect(
      db.transaction(async (tx) => {
        await insertBumn(tx, kode);
        // NOT NULL violation on cabang.nama: a real Postgres error, not a
        // thrown JS one, so this covers the path where the driver rejects.
        await tx.query("INSERT INTO cabang (bumn_id, kode, nama) VALUES (NULL, '98', NULL)");
      }),
    ).rejects.toThrow();
    expect(await bumnCount(kode)).toBe(0);
  });

  test("a rolled-back transaction does not leave its audit_log row behind", async () => {
    // The reason audit writes take a QueryRunner: an operation that did not
    // happen must not have a SUKSES row claiming it did.
    const marker = uniq("audit-rollback");
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO audit_log (aksi, entitas, entitas_id, hasil, keterangan)
           VALUES ('uji.rollback', 'uji', $1, 'SUKSES', 'seharusnya hilang')`,
          [marker],
        );
        throw new Error("batal");
      }),
    ).rejects.toThrow("batal");

    const rows = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_log WHERE entitas_id = $1",
      [marker],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  test("the connection is usable again after a rollback (it was released)", async () => {
    // A transaction that failed without releasing its client would drain the
    // pool and hang the next request instead of failing it.
    for (let i = 0; i < 12; i += 1) {
      await db.transaction(async () => {
        throw new Error(`gagal ${i}`);
      }).catch(() => {});
    }
    const rows = await db.query<{ ok: number }>("SELECT 1 AS ok");
    expect(rows[0]!.ok).toBe(1);
  });

  test("queries through the outer port are NOT inside the transaction", async () => {
    // Documented behaviour of the port: the callback gets its own runner
    // precisely so this cannot be ambiguous. A service that reaches for the
    // pool mid-transaction is writing outside it, and that is worth pinning.
    const kode = uniq("TX-OUTSIDE");
    await db
      .transaction(async (tx) => {
        await insertBumn(tx, `${kode}-in`);
        await insertBumn(db, `${kode}-out`); // deliberate misuse
        throw new Error("batal");
      })
      .catch(() => {});
    expect(await bumnCount(`${kode}-in`)).toBe(0);
    expect(await bumnCount(`${kode}-out`)).toBe(1);
  });
});
