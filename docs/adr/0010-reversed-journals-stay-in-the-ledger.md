# 10. A REVERSED journal stays in the ledger

Date: 2026-08-23

## Status

Accepted

## Context

Two bugs were found by the journal engine implementation and confirmed with a standalone SQL
probe. They looked unrelated and were not: both came from treating `REVERSED` as if it meant
"withdrawn" rather than "still in the ledger, offset by its reversal".

1. `trg_jurnal_10_periode` (from `0010`) fires `BEFORE INSERT OR UPDATE OF (..., status)`, so
   marking an original `POSTED -> REVERSED` re-ran the closed-period validation against the
   **original** journal's transaction date. Once that period had closed, `TJSL-JRN-004` fired and
   the entire reversal rolled back. This is precisely the case spec 6.3 requires to work: the
   reversing journal is dated in the current OPEN period *because* the original's period may
   already be closed. ADR 0002 already claimed the immutability guard "allows only the reversal
   transition", so the intent was written down and the trigger simply did not implement it.

2. `v_rekonsiliasi_piutang` (from `0015`) filtered `j.status = 'POSTED'` when summing journal
   lines. Marking an original `REVERSED` dropped its lines out of the sum while the reversing
   journal (`POSTED`) subtracted again, so an akad's ledger balance moved by **twice** the
   reversed amount. The probe measured 400.000.000 where 200.000.000 was correct. This view is
   spec 8.4 check 10, the receivable sub-ledger reconciliation, which blocks period closing, so
   the bug manufactured a hard blocker on every corrected akad.

Correction by reversing entry (invariant 4, spec 6.3) adds two rows and removes none. Any query
that filters `POSTED` alone therefore counts one half of a correction pair. That is a class of
bug, not an incident.

## Decision

Fixed forward in `0018` (`0007`, `0010` and `0015` are pushed and are not edited in place).

**1. The closed-period guard early-returns for exactly the reversal transition.**

```
TG_OP = 'UPDATE'
AND OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
AND NEW.tanggal_transaksi = OLD.tanggal_transaksi
AND NEW.periode_id = OLD.periode_id
```

Invariant 5 survives, verified case by case rather than assumed:

- `INSERT` is untouched, so a new journal dated into a CLOSED period is still refused, including
  the reversing journal itself. That is what actually keeps corrections out of closed periods.
- `DRAFT -> POSTED` is untouched, because the early return requires `OLD.status = 'POSTED'`. The
  important variant of this (a draft created while the period was open, posted after it closed) is
  still refused.
- No date can move through this path: both `tanggal_transaksi` and `periode_id` must be unchanged
  for the early return to apply.
- The `bumn_id`/`cabang_id` consistency check (`TJSL-JRN-001`) is skipped on this path, and that is
  safe rather than lucky: `trg_jurnal_20_immutable` is also `BEFORE UPDATE` on `jurnal`, sorts
  after this trigger, carries no column list so it always fires, and raises `TJSL-JRN-011` for any
  identity or financial column change on a non-DRAFT row. An update that both reverses and moves
  the branch still aborts, one trigger later.
- Deliberately **not** broadened to `NEW.status = OLD.status`, which reads harmless and is not:
  `trg_jurnal_20_immutable` returns early for DRAFT rows, so a no-op status rewrite that also
  changed `cabang_id` on a DRAFT dated in a closed period would then bypass both guards.

Accepted residual: re-writing `status = 'REVERSED'` on a row that is *already* REVERSED, in a
closed period, still raises `TJSL-JRN-004`. It is a no-op the application never performs, and
leaving `REVERSED` is forbidden anyway.

**2. The ledger predicate is stated once, in `v_ledger_baris`.**

Rather than fixing one `WHERE` clause, `0018` introduces `v_ledger_baris` as the single definition
of "this line counts in the ledger": journal `POSTED` or `REVERSED`, nothing soft-deleted, with
`nilai_debit_positif` precomputed as `debit - kredit`. `v_rekonsiliasi_piutang` is rebuilt on top
of it with an unchanged column list, so existing readers get the right number without a code
change. Every future ledger aggregate reads the view; getting this wrong again now requires
bypassing a view whose comment explains why.

Audit of every other place that sums or scans journal lines:

| Object | Verdict |
|---|---|
| `v_integritas_jurnal` (0015) | Correct. No status filter, and it checks each journal's internal balance; a REVERSED journal still balances. |
| `v_integritas_jadwal`, `v_integritas_snapshot` (0015) | No journal sums. |
| `v_akun_belum_dipetakan`, `v_baris_jurnal_pihak_bermasalah`, `v_jurnal_belum_terkirim` (0017) | Already `IN ('POSTED','REVERSED')`. |
| `v_rekonsiliasi_eksternal`, `v_drift_saldo_eksternal` (0017) | Read frozen snapshots, not journal lines. Correct here. |
| `tjsl_akun_cegah_hapus_terpakai` (0010) | Already `IN ('POSTED','REVERSED')`. |
| `tjsl_jurnal_cek_balance` (0010) | Per journal, fires when status is not DRAFT. Correct. |

**3. A covering index, because a correctness fix should not lose its index.**

`jurnal_cabang_tanggal_idx` (0010) is partial on `status = 'POSTED'`, which the corrected
predicate cannot use. `0018` adds `jurnal_ledger_cabang_tanggal_idx` and `jurnal_ledger_periode_idx`
on `status IN ('POSTED','REVERSED')` and leaves the original in place (it still serves queries that
genuinely want only POSTED, and dropping an index created by a pushed migration is a separate
decision).

## Consequences

- Reversal now works across a closed period, which is what spec 6.3 asks for, and the reversing
  journal is still validated on its own INSERT, which is what invariant 5 asks for.
- The reconciliation number is right, so period closing is no longer blocked by a fabricated
  difference on every corrected akad.
- `v_ledger_baris` becomes a small, load-bearing dependency. It is a plain view over two tables,
  so the planner inlines it; if a hot report ever needs a different shape, add a sibling view with
  the same predicate rather than re-deriving the filter inline.
- **One exposure remains outside the schema, and it is the same bug class.**
  `saldo_akun_periode` is written by the closing engine, not by a view. If that code sums journal
  lines with `status = 'POSTED'` alone, every closed period's frozen trial balance carries this
  double-count, and because the snapshot is frozen the error becomes permanent and invisible to
  the views here (`v_rekonsiliasi_eksternal` reads the snapshot and would faithfully report the
  wrong number). The closing-engine owner must use `v_ledger_baris`. Recorded in
  OPEN-QUESTIONS.md item 20.
- The `down` section of `0018` restores the pre-0018 definitions verbatim, bugs included. A
  rollback undoes a change; it does not half-keep it.
