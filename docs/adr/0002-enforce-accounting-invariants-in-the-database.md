# 2. Enforce accounting invariants in the database

Date: 2026-08-23

## Status

Accepted

## Context

The TJSL spec (section 3) lists 14 invariants and says they should be held "idealnya dengan
constraint database, bukan hanya validasi aplikasi". The numbers this system produces will be
audited under Permen BUMN PER-05/MBU/04/2021, and the spec's own priority order is
correct > complete > fast > tidy.

Application-only validation fails in the ways that matter most here. A seed script, a bulk
Excel import, a migration, a psql session during an incident, and a future second service all
bypass service-layer checks. An unbalanced posted journal that reaches disk is not a bug you
fix later; it is a restatement.

The counter-argument is real: constraints and triggers are harder to test, produce errors far
from the call site, and can block legitimate intermediate states.

## Decision

Every invariant that can be expressed in Postgres 15 without breaking a legitimate workflow is
expressed there, and the service layer validates the same rules again for good error messages.
Specifically:

| Invariant | Mechanism | Where |
|---|---|---|
| 1 balanced, 2 verify column totals | deferred constraint trigger on `jurnal`, fires when status is not DRAFT | 0010 |
| 3 one side per line | table CHECK on `jurnal_baris` | 0010 |
| 4 POSTED is immutable | BEFORE UPDATE guard (allows only the reversal transition), BEFORE DELETE guard on header and lines | 0010 |
| 5 no posting into a CLOSED period | BEFORE INSERT/UPDATE trigger resolving `tanggal_transaksi` to its period | 0010 |
| 6 periods close in order | BEFORE UPDATE trigger on `periode` (also gates reopen) | 0007 |
| 7 fixed-precision money | NUMERIC(20,2) on every money column, NUMERIC(9,6) on rates | all |
| 8 schedules are immutable | BEFORE UPDATE guard on priced columns plus a physical-delete block | 0008 |
| 9 schedule principal equals the loan | deferred constraint trigger, version 1 only | 0008 |
| 10 receivables never negative | CHECK `outstanding_pokok >= 0` and `<= pokok_pinjaman` | 0008 |
| 12 soft delete plus audit columns | shared trigger `tjsl_audit_touch`, CHECK pairing deleted_at with deleted_by | 0002 |
| 13 closing is idempotent | unique keys per closing scope plus `jurnal.kunci_idempotensi` | 0010, 0011 |
| only postable accounts | foreign key to a generated column, see ADR 0003 | 0005, 0010 |
| segregation of duties (spec 2) | triggers comparing reviewer to maker and approver to reviewer | 0008, 0009 |

Two invariants stay in the application layer on purpose:

- 11 (all automatic journals go through one path). A database cannot tell which code path
  inserted a row. `event_jurnal_mapping` plus the `is_auto_generated` flag make violations
  visible, and the boundary checker plus code review enforce the rule. See ADR 0004.
- 14 (reports are reproducible). Enforced structurally instead: closed periods are read from
  `saldo_akun_periode` and `kolektibilitas_snapshot`, and those snapshots carry the inputs they
  used (rate, basis) so they can be re-derived.

Deferred constraint triggers, not immediate ones, are used for the two multi-row arithmetic
rules (journal balance, schedule principal). A DRAFT journal mid-edit is legitimately
unbalanced, and even posting needs to write a header and its lines in one transaction in any
order. The check therefore runs at COMMIT.

Every guard raises a message prefixed with a stable code (`TJSL-JRN-031`, `TJSL-PER-001`, ...)
so the API layer can map database errors to user-facing messages without parsing prose.

## Consequences

- Wrong numbers cannot be persisted, whatever writes them: service, seeder, import tool, or a
  human with psql.
- Balance and schedule-total errors surface on COMMIT, not on the offending statement. The
  service layer must post inside an explicit transaction and treat commit failure as a
  validation error. This is documented at the top of `migrations/0010_jurnal.sql`.
- Some legitimate flows are constrained: a schedule must be inserted in one transaction, and an
  account cannot be flipped from postable to non-postable once it has journal lines. Both are
  acceptable and arguably desirable.
- Tests must cover the database, not only the engine. The proof suite for this phase exercises
  each guard by attempting the violation and asserting the raise.
- Error text is Indonesian, matching the domain language of the spec and of the users.
