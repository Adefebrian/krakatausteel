# 13. Physical-deletion guards must be statement level, not only row level

Date: 2026-08-23

## Status

Accepted

## Context

Security finding F-5: `TRUNCATE audit_log` succeeded, despite `migrations/0014` installing an
append-only trigger that refuses UPDATE and DELETE. The reason is mechanical: that trigger is
`FOR EACH ROW`, and TRUNCATE never touches rows. It swaps the relation's storage, so no
row-level trigger fires.

Checking whether this was one instance or a pattern turned up seven:

| Table | Guard | Blind spot |
|---|---|---|
| `audit_log` | append-only, `FOR EACH ROW` (0014) | TRUNCATE |
| `jurnal` | delete blocked, `FOR EACH ROW` (0010) | TRUNCATE |
| `jurnal_baris` | update/delete frozen, `FOR EACH ROW` (0010) | TRUNCATE |
| `periode` | delete blocked via `tjsl_attach_block_delete` (0007) | TRUNCATE |
| `akun` | same (0010) | TRUNCATE |
| `pumk_jadwal_angsuran` | same (0008) | TRUNCATE |
| `jurnal_ekspor` | same (0016) | TRUNCATE |

One reported instance, seven real ones, because the shared helper that made the convention easy
to apply also made the hole easy to inherit.

TRUNCATE requires TRUNCATE privilege, which in practice means the table owner. This deployment
connects as the owner, so the application role can issue it today. That is precisely why the
control belongs in the database rather than in a policy document.

## Decision

`migrations/0021` adds `tjsl_block_truncate()`, a `BEFORE TRUNCATE ... FOR EACH STATEMENT`
trigger that always raises (`TJSL-DEL-002`), attached to all seven tables. It also redefines
`tjsl_attach_block_delete()` so it attaches **both** guards from now on: a row-level DELETE guard
without its statement-level twin is a guard with a documented bypass, and a table added in a
later migration should not be able to inherit the hole by using the convention correctly. 0002 is
pushed, so the helper is redefined in 0021 rather than edited in place.

Two properties worth stating because they were verified rather than hoped for:

- A `BEFORE TRUNCATE` trigger **also fires when the table is reached by `TRUNCATE ... CASCADE`
  from elsewhere**. So guarding the ledger does not only refuse `TRUNCATE jurnal`; it refuses
  `TRUNCATE bumn CASCADE`, which would otherwise have taken an entire entity's books, its
  periods, its chart of accounts and its audit log with it. Proven in the handover output: the
  cascade enumerates 70 tables and then aborts.
- The guard is not defeated by truncating a child alone: `TRUNCATE jurnal_baris` is refused on its
  own account.

**What is deliberately left unprotected**, because the rule is narrower than "nothing may ever be
deleted": derived, regenerable snapshots (`saldo_akun_periode`, `kolektibilitas_snapshot`,
`saldo_akun_eksternal`, and the rest) keep no TRUNCATE guard, for the same reason they keep no
DELETE guard. Reopening a period is *defined* as dropping its balance snapshot (spec 8.4), and a
figure that can be recomputed from the ledger is not evidence. The encoded rule is:

> what cannot be reconstructed is what cannot be removed.

## Consequences

- The audit trail and the ledger can no longer be erased by a single statement, including through
  a cascade from an unrelated table.
- `bun run db:reset` still works, because it drops and recreates the `public` schema rather than
  truncating tables. DROP is not TRUNCATE and is not guarded; a migration runner and a developer
  resetting a `_test` database both need it. The safety rail there is `tools/db.ts` refusing any
  database whose name does not end in `_test`, which is the right place for that check.
- Any future test helper that wants a fast wipe of a guarded table must drop the schema or delete
  through the sanctioned path, not TRUNCATE. This is friction on purpose.
- The class of bug is worth remembering beyond this instance: a trigger's timing and level are
  part of its contract, and "we have a trigger for that" is not the same as "that cannot happen".
  Row-level guards do not see TRUNCATE; `UPDATE OF (columns)` guards do not see INSERT; deferred
  constraints do not fire on statements that are rolled back. Each of those has already produced
  a real bug in this schema.
