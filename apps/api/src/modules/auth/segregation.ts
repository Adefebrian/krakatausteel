// Segregation of duties, spec 2 rules 1 and 2:
//
//   1. one person cannot be Maker and Checker on the same document
//   2. one person cannot be Checker and Approver on the same document
//
// WHY THIS EXISTS WHEN THE DATABASE ALREADY ENFORCES IT
// migrations/0008 attaches tjsl_cek_reviewer_bukan_maker and
// tjsl_cek_approver_bukan_checker to pumk_review / pumk_approval (and 0009
// reuses them for Non PUMK). Those triggers are the real guarantee and they
// stay: a bulk import or a psql session must not be able to bypass the rule
// (ADR 0002).
//
// This module mirrors them for three reasons, none of which is redundancy:
//
//   1. ERROR QUALITY. A raised plpgsql exception reaches Hono as a 500 with
//      "error: TJSL-SOD-001: user 9f2c... adalah maker proposal ini". The
//      service layer turns the same rule into a 409 and a sentence naming the
//      role conflict. (core/http.ts also maps any TJSL-SOD-* that does slip
//      through to a 409, so the trigger is never a 500 either.)
//   2. TESTABILITY WITHOUT THE DATABASE. The pure predicate below is checkable
//      in a unit test, so the rule is pinned independently of schema state.
//   3. IT FAILS BEFORE SIDE EFFECTS. A trigger fires mid-transaction, after
//      the service may already have written a notification or an audit row and
//      called an S3 upload. Checking first keeps the rejection clean.
//
// The service check is a read-then-write and therefore racy under concurrency
// by construction. That is fine: the trigger is the serialisation point, and
// core/http.ts maps its error to the same 409. Never "simplify" by deleting
// either half.
import { segregationOfDuties } from "../../core/http";
import type { QueryRunner } from "./ports";

export type PeranDokumen = "maker" | "checker" | "approver";

const NAMA_PERAN: Readonly<Record<PeranDokumen, string>> = {
  maker: "Maker",
  checker: "Checker",
  approver: "Approver",
};

/**
 * The rule itself, with no database and no framework in sight.
 * Returns null when the pairing is allowed, or the reason it is not.
 */
export function konflikPeran(
  peranLain: PeranDokumen,
  peranBaru: PeranDokumen,
  userIdLain: string | null | undefined,
  userIdBaru: string,
): string | null {
  if (!userIdLain) return null;
  if (userIdLain !== userIdBaru) return null;
  return (
    `Pengguna yang sama tidak boleh menjadi ${NAMA_PERAN[peranLain]} dan ` +
    `${NAMA_PERAN[peranBaru]} pada dokumen yang sama`
  );
}

export interface SegregationDeps {
  /**
   * Table names are injected rather than interpolated from user input: this
   * module is used by PUMK (0008) and Non PUMK (0009), which have the same
   * shape under different names, and an identifier can never come from a
   * request.
   */
  proposalTable: string;
  reviewTable: string;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Nama tabel tidak valid untuk pemeriksaan segregasi tugas: "${name}"`);
  }
  return name;
}

export interface SegregationService {
  /** Spec 2 rule 1. Throws a 409 AppError when the reviewer made the document. */
  assertCheckerBukanMaker(runner: QueryRunner, proposalId: string, reviewerUserId: string): Promise<void>;
  /** Spec 2 rule 2. Throws a 409 AppError when the approver already reviewed it. */
  assertApproverBukanChecker(runner: QueryRunner, proposalId: string, approverUserId: string): Promise<void>;
}

export function createSegregationService({ proposalTable, reviewTable }: SegregationDeps): SegregationService {
  const proposal = assertIdentifier(proposalTable);
  const review = assertIdentifier(reviewTable);

  return {
    async assertCheckerBukanMaker(runner, proposalId, reviewerUserId) {
      const rows = await runner.query<{ created_by: string | null }>(
        `SELECT created_by::text AS created_by FROM ${proposal} WHERE id = $1 AND deleted_at IS NULL`,
        [proposalId],
      );
      const maker = rows[0]?.created_by ?? null;
      const konflik = konflikPeran("maker", "checker", maker, reviewerUserId);
      if (konflik) throw segregationOfDuties(konflik);
    },

    async assertApproverBukanChecker(runner, proposalId, approverUserId) {
      const rows = await runner.query<{ reviewer_user_id: string }>(
        `SELECT reviewer_user_id::text AS reviewer_user_id
           FROM ${review}
          WHERE proposal_id = $1 AND reviewer_user_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [proposalId, approverUserId],
      );
      const konflik = konflikPeran("checker", "approver", rows[0]?.reviewer_user_id, approverUserId);
      if (konflik) throw segregationOfDuties(konflik);
    },
  };
}
