// Segregation of duties, spec 2 rules 1 and 2.
//
// Tested at BOTH layers on purpose (see the header of ./segregation.ts):
//   - the pure predicate, so the rule is pinned without a database;
//   - the service against real PUMK tables, so the read-then-check path is
//     proven;
//   - the database trigger, so the guarantee that survives a bulk import is
//     proven too, AND so the error it raises is shown to arrive as a clean 409
//     rather than as a 500 with plpgsql text in it.
import { afterAll, describe, expect, test } from "bun:test";
import { createDbAdapter } from "../../core/adapters/db";
import { AppError, mapDatabaseError } from "../../core/http";
import { createFixture, tutupSemuaFixture } from "../../testing/harness";
import { createSegregationService, konflikPeran } from "./segregation";

// Fixture teardown, one call for the whole file. Every `createFixture` in here
// registers itself; this closes them all. Nothing else in this file changed.
// See the FIXTURE LEAK note in apps/api/src/testing/harness.ts.
afterAll(tutupSemuaFixture);

const db = createDbAdapter();
const sod = createSegregationService({ proposalTable: "pumk_proposal", reviewTable: "pumk_review" });

/** Minimal PUMK proposal, enough for the SoD guards to have something to read. */
async function buatProposal(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  makerUserId: string,
): Promise<{ proposalId: string; mitraId: string }> {
  const mitra = await fixture.db.query<{ id: string }>(
    `INSERT INTO mitra (cabang_id, kode_mitra, nama_lengkap, status)
     VALUES ($1, $2, 'Mitra Uji SoD', 'CALON') RETURNING id::text AS id`,
    [fixture.cabangA.id, `M-${fixture.suffix}-${crypto.randomUUID().slice(0, 6)}`],
  );
  const mitraId = mitra[0]!.id;
  const proposal = await fixture.db.query<{ id: string }>(
    `INSERT INTO pumk_proposal
       (cabang_id, mitra_id, no_proposal, tanggal_proposal, jumlah_diajukan, tenor_diajukan,
        status, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 10000000.00, 12, 'DRAFT', $4)
     RETURNING id::text AS id`,
    [fixture.cabangA.id, mitraId, `P-${fixture.suffix}-${crypto.randomUUID().slice(0, 6)}`, makerUserId],
  );
  return { proposalId: proposal[0]!.id, mitraId };
}

describe("konflikPeran, the rule with no database", () => {
  test("the same user in both roles is a conflict", () => {
    expect(konflikPeran("maker", "checker", "u1", "u1")).toMatch(/Maker dan Checker/);
    expect(konflikPeran("checker", "approver", "u1", "u1")).toMatch(/Checker dan Approver/);
  });

  test("different users are fine", () => {
    expect(konflikPeran("maker", "checker", "u1", "u2")).toBeNull();
    expect(konflikPeran("checker", "approver", "u1", "u2")).toBeNull();
  });

  test("an unknown counterpart is not a conflict", () => {
    // A proposal with created_by NULL (imported) must not block every review.
    expect(konflikPeran("maker", "checker", null, "u1")).toBeNull();
    expect(konflikPeran("maker", "checker", undefined, "u1")).toBeNull();
  });
});

describe("service layer, spec 2 rule 1: checker must not be the maker", () => {
  test("refuses with a 409 AppError and a readable message", async () => {
    const f = await createFixture();
    const { proposalId } = await buatProposal(f, f.users.MAKER.id);

    const err = await sod
      .assertCheckerBukanMaker(db, proposalId, f.users.MAKER.id)
      .then(() => null)
      .catch((e: unknown) => e as AppError);

    expect(err).toBeInstanceOf(AppError);
    expect(err!.code).toBe("SEGREGASI_TUGAS");
    expect(err!.status).toBe(409);
    expect(err!.message).toMatch(/tidak boleh menjadi Maker dan Checker/);
    // Not a raw trigger message.
    expect(err!.message).not.toContain("TJSL-SOD");
  });

  test("allows a different user to review", async () => {
    const f = await createFixture();
    const { proposalId } = await buatProposal(f, f.users.MAKER.id);
    await sod.assertCheckerBukanMaker(db, proposalId, f.users.CHECKER.id);
  });

  test("refuses to interpolate a table name that is not an identifier", () => {
    expect(() =>
      createSegregationService({ proposalTable: "pumk_proposal; DROP TABLE jurnal", reviewTable: "pumk_review" }),
    ).toThrow(/tidak valid/);
  });
});

describe("service layer, spec 2 rule 2: approver must not be the checker", () => {
  test("refuses when the approver already reviewed the document", async () => {
    const f = await createFixture();
    const { proposalId } = await buatProposal(f, f.users.MAKER.id);
    await f.db.query(
      `INSERT INTO pumk_review (proposal_id, reviewer_user_id, keputusan, created_by)
       VALUES ($1, $2, 'REKOMENDASI', $2)`,
      [proposalId, f.users.CHECKER.id],
    );

    const err = await sod
      .assertApproverBukanChecker(db, proposalId, f.users.CHECKER.id)
      .then(() => null)
      .catch((e: unknown) => e as AppError);

    expect(err).toBeInstanceOf(AppError);
    expect(err!.status).toBe(409);
    expect(err!.message).toMatch(/tidak boleh menjadi Checker dan Approver/);
  });

  test("allows a third user to approve", async () => {
    const f = await createFixture();
    const { proposalId } = await buatProposal(f, f.users.MAKER.id);
    await f.db.query(
      `INSERT INTO pumk_review (proposal_id, reviewer_user_id, keputusan, created_by)
       VALUES ($1, $2, 'REKOMENDASI', $2)`,
      [proposalId, f.users.CHECKER.id],
    );
    await sod.assertApproverBukanChecker(db, proposalId, f.users.APPROVER.id);
  });
});

describe("the database enforces it too, and its error maps to a clean 409", () => {
  test("the maker-as-checker trigger fires when the service check is skipped", async () => {
    // Deliberately bypassing the service, the way a bulk import or a psql
    // session would. ADR 0002: the trigger is the guarantee, the service is
    // the error message.
    const f = await createFixture();
    const { proposalId } = await buatProposal(f, f.users.MAKER.id);

    const err = await f.db
      .query(
        `INSERT INTO pumk_review (proposal_id, reviewer_user_id, keputusan, created_by)
         VALUES ($1, $2, 'REKOMENDASI', $2)`,
        [proposalId, f.users.MAKER.id],
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).not.toBeNull();
    expect(String((err as Error).message)).toContain("TJSL-SOD-001");

    // And this is what the API would answer, instead of a 500.
    const mapped = mapDatabaseError(err);
    expect(mapped).not.toBeNull();
    expect(mapped!.code).toBe("SEGREGASI_TUGAS");
    expect(mapped!.status).toBe(409);
    // The trigger's own Indonesian message is passed through, minus the code.
    expect(mapped!.message).toContain("tidak boleh menjadi checker");
    expect(mapped!.message).not.toContain("TJSL-SOD-001");
  });

  test("the checker-as-approver trigger fires and maps the same way", async () => {
    const f = await createFixture();
    const { proposalId } = await buatProposal(f, f.users.MAKER.id);
    await f.db.query(
      `INSERT INTO pumk_review (proposal_id, reviewer_user_id, keputusan, created_by)
       VALUES ($1, $2, 'REKOMENDASI', $2)`,
      [proposalId, f.users.CHECKER.id],
    );

    const err = await f.db
      .query(
        `INSERT INTO pumk_approval (proposal_id, approver_user_id, keputusan, plafon_disetujui, tenor_disetujui, created_by)
         VALUES ($1, $2, 'SETUJU', 10000000.00, 12, $2)`,
        [proposalId, f.users.CHECKER.id],
      )
      .then(() => null)
      .catch((e: unknown) => e);

    expect(String((err as Error).message)).toContain("TJSL-SOD-002");
    const mapped = mapDatabaseError(err);
    expect(mapped!.status).toBe(409);
    expect(mapped!.code).toBe("SEGREGASI_TUGAS");
  });
});

describe("mapDatabaseError", () => {
  test("maps other TJSL guard codes to 409 with their own message", () => {
    const mapped = mapDatabaseError(new Error("TJSL-JDW-002: jadwal angsuran bersifat immutable"));
    expect(mapped!.status).toBe(409);
    expect(mapped!.code).toBe("KONFLIK");
    expect(mapped!.message).toBe("jadwal angsuran bersifat immutable");
  });

  test("maps common SQLSTATEs to a client error instead of a 500", () => {
    expect(mapDatabaseError({ code: "23505" })!.status).toBe(409);
    expect(mapDatabaseError({ code: "23503" })!.status).toBe(400);
    expect(mapDatabaseError({ code: "23514" })!.status).toBe(400);
    expect(mapDatabaseError({ code: "22P02" })!.status).toBe(400);
  });

  test("returns null for anything it does not recognise, so a real bug stays a 500", () => {
    expect(mapDatabaseError(new Error("boom"))).toBeNull();
    expect(mapDatabaseError({ code: "08006" })).toBeNull();
  });
});
