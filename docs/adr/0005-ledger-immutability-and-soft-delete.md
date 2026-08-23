# 5. Ledger immutability and soft delete

Date: 2026-08-23

## Status

Accepted

## Context

Spec invariants 4, 6 and 12: a POSTED journal can never be changed or physically deleted,
correction happens through a reversing journal, and every financial entity uses soft delete
plus an audit trail. Spec 10.4 report 31 adds that the audit trail cannot be deleted by anyone.

"Soft delete everywhere" is easy to say and easy to get wrong in two directions: forgetting the
columns on a table, and treating soft delete as a universal escape hatch (soft-deleting a
posted journal removes it from every report just as effectively as DELETE).

## Decision

Three tiers, applied deliberately per table.

1. Ordinary financial entities (proposals, akad, disbursements, instalments, budgets, ...) carry
   the full block `created_by, created_at, updated_by, updated_at, deleted_by, deleted_at,
   version`, a CHECK pairing `deleted_at` with `deleted_by`, and a shared BEFORE UPDATE trigger
   (`tjsl_audit_touch`, 0002) that sets `updated_at = now()` and `version = OLD.version + 1`.
   `updated_by` is deliberately not set by the trigger: the database does not know the acting
   user, and a trigger blanking it would corrupt the audit trail. Every unique index on these
   tables is partial (`WHERE deleted_at IS NULL`) so a soft-deleted row does not reserve its
   code.

2. Immutable-once-final rows. `jurnal` and `jurnal_baris` also get guards: a POSTED journal
   accepts only the transition to REVERSED plus its reversal link and audit columns, and
   `deleted_at` is explicitly in the forbidden set, so a posted journal cannot be soft-deleted
   either. Its lines reject every UPDATE and DELETE. `pumk_jadwal_angsuran` rejects changes to
   priced columns while leaving payment-progress columns writable, because that is how
   allocation records its effect.

3. Append-only tables. `audit_log` rejects UPDATE and DELETE outright, for everyone.
   `periode`, `akun` and `pumk_jadwal_angsuran` reject physical DELETE.

`jurnal_baris.jurnal_id` deliberately has no ON DELETE CASCADE. Deleting a DRAFT journal means
deleting its lines explicitly, which keeps the line-level guard able to inspect a parent row
that still exists.

Derived snapshots are the exception that proves the rule: `saldo_akun_periode` is physically
deletable, because spec 8.4 requires reopening a period to drop its balance snapshot, and that
data is fully regenerable from the ledger. Deleting derived data is safe; deleting a journal
never is.

## Consequences

- Correction of a posted entry always produces two rows in the ledger (original plus reversal),
  which is what an auditor expects to see and what makes the history readable.
- Every read path must filter `deleted_at IS NULL`. This is a permanent tax and a permanent
  source of bugs; the integrity views in 0015 are written with the filter so they can be copied
  rather than reinvented.
- `version` gives optimistic concurrency for free on every entity, and the API layer should use
  it (compare-and-set on update) rather than last-write-wins.
- Pruning the audit log later requires a migration that drops the guard deliberately, in the
  open, with its own ADR. That friction is the point.
