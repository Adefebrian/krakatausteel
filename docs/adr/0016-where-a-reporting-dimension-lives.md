# 16. Where a reporting dimension lives, and when it is frozen

Date: 2026-08-25

## Status

Accepted

## Context

The RKA suite (spec 9.3, report 24) filed two findings as fail-closed tests rather than working
around them. They look like two problems and they are one:

1. `saldo_akun_periode` is keyed `(periode, cabang, akun)` and carries no analytic dimension, so a
   CLOSED period has no frozen figure per sektor (RKA PUMK) or per bidang (RKA Non PUMK). Spec 10's
   rule that a closed period is read from the frozen snapshot cannot be satisfied for two of the
   three budget types at all.
2. `PENCAIRAN_PUMK` writes no `sektorId` into `jurnal_baris.dimensi_json`, so the only per-sector
   figure available comes from joining `pumk_akad -> pumk_proposal.sektor_id`, which is editable
   master data. `rka-fixture.test.ts` does not assert this, it demonstrates the consequence:
   reclassifying a proposal moves a figure for a month that has already been reported.

One question underlies both. **A reporting dimension is a fact about a transaction, and it has to be
recorded where transactions are recorded and frozen where amounts are frozen.** Where it is instead
re-derived from master data, the report is only correct until someone edits the master row, and
nothing detects the change because every row still looks right.

## Decision

### 1. The frozen decomposition is a CHILD of the frozen account row, not columns on it

`migrations/0027` adds `saldo_akun_dimensi_periode`: `(saldo_akun_periode_id, sumbu, sektor_id,
bidang_id, mutasi_debit, mutasi_kredit)`.

**Not columns on `saldo_akun_periode`.** Three reasons, in order of weight:

- Every existing reader of that table sums it unfiltered: Neraca Lajur, the trial balance, reports
  28 to 30, `v_saldo_periode_terakhir`. Dimensioned rows in the same table make all of them wrong
  the day the first one is written, and the fix would be retrofitting `AND sektor_id IS NULL` onto
  every reader that exists and every one written later. That is the brief's own description of the
  hazard: a total that inflates while every row looks right.
- `saldo_akun_periode_identitas_ck` would force a per-sektor `saldo_awal`, and for the first period
  after the migration there is no prior per-sektor balance to carry. A stated zero is a claim, not a
  blank.
- A per-dimension BALANCE is not what is missing. Report 24 measures a period MOVEMENT, and
  outstanding piutang per sektor is already frozen per akad, with `sektor_id` on the row, in
  `kolektibilitas_snapshot`. A second frozen per-sektor balance would be two frozen answers to one
  question.

So the child carries FLOW ONLY, no `saldo_awal`, no `saldo_akhir`, and no identity CHECK, because it
makes no claim about a balance. The parent stays the sole authority for balances.

**A dimensioned row and an undimensioned row cannot disagree, because the decomposition is TOTAL.**
For one frozen account row and one axis, the children's `mutasi_debit` sums to the parent's exactly,
and likewise `mutasi_kredit`, enforced by a deferred constraint trigger installed on both tables
(TJSL-SDP-002, the construction migration 0026 used, for the same reason). Movement carrying no
dimension is not omitted, it is an explicit RESIDUAL row with both id columns NULL, which is why the
sum can be exact rather than "at most". A partial decomposition, the state in which per-sektor
figures quietly add up to less than the account, is unrepresentable.

**`sumbu` (axis) exists so a second partition cannot inflate the first.** Sektor and bidang are
independent partitions of the same movement; summed together they would double the account while
every row stayed correct. Each axis reconciles to the parent on its own.

**Reopen needed no change to the closing engine.** `bukaKembaliPeriode` runs
`DELETE FROM saldo_akun_periode WHERE periode_id = $1`, so an `ON DELETE CASCADE` from the parent
sweeps the decomposition in the same statement. A stale per-sektor figure cannot survive into a
re-close and reconcile against a new parent row. CASCADE here and RESTRICT in 0026 is not taste: a
provision's journal links are evidence nothing deletes, these rows are derived, regenerable, and
deleting them on reopen is the defined behaviour of spec 8.4.

### 2. `PENCAIRAN_PUMK` must carry `sektorId` on the receivable leg

Yes, it belongs there, exactly the way `mitraId` and `akadId` already do, and for a stronger reason
than symmetry: `postingEvent` puts analytic dimensions on the leg that carries the economics rather
than on the cash movement, so on this event it lands on the piutang leg by construction.

The counter-argument, that fixing item 1 makes item 2 unnecessary because the freeze pins the figure
anyway, does not survive. Freezing at close stops the figure moving AFTER the close. It does not
stop it moving before: an edit between the disbursement and the month end changes what gets frozen,
so the month's report during the open period and the frozen figure disagree, and both are
defensible. A frozen figure derived from a mutable join is only correct until someone edits the
join, and the freeze does not make the derivation trustworthy, it only makes the last derivation
permanent.

**What it cannot fix, stated plainly.** `jurnal_baris` is immutable (ADR 0005), so already-posted
disbursements will never gain the dimension. For every period closed before modules/pumk lands this,
the per-sektor freeze can only be derived from the join, and the freeze is then a record of the
classification as it stood at the close, which is the best available answer and should be labelled
as such rather than presented as ledger data.

This is a change to `apps/api/src/modules/pumk`, handed over rather than made here.

### 3. Non PUMK is genuinely safe in the ledger, and safe by accident in the schema

`PENYALURAN_NON_PUMK` and `PENGEMBALIAN_SISA_NON_PUMK` both pass `dimensi: { bidangId }`, read from
the proposal at posting time and written into an immutable line, on the expense leg in both
directions. That is correct, and it is deliberate: the seed's comment on the refund event records
that binding the refund's credit to a pooled account while the disbursement debited a per-bidang one
left the bidang overstated by exactly the refund, with both journals balancing.

It is safe **by accident** in one respect that matters. Nothing in the schema requires a line on a
per-bidang expense account to carry a `bidangId`. It is correct because one call site passes it. A
manual journal to that account, or a later event that forgets, produces an amount attributable to no
bidang, the per-bidang report silently under-reports, and nothing announces it.

The detection mechanism now exists and costs nothing: 0027's residual row. A freeze that cannot
attribute part of an account's movement must write the remainder into the residual bucket, so
unattributed money becomes a visible line rather than a missing one. Making the dimension
*mandatory* per event is the stronger fix and belongs in `event_jurnal_mapping`, which is already
data (ADR 0004); filed rather than built, because it changes a table three modules post through.

### 4. Where else the problem exists, having looked rather than guessed

- **PUMK repayments** (`ANGSURAN_POKOK`, `ANGSURAN_JASA_ADM` and the accrual) carry `mitraId` and
  `akadId` and no `sektorId`, so any per-sektor view of collections has the same defect as the
  disbursement. Same fix, same place.
- **Report 3, "matriks Provinsi kali Sektor"**, reaches its geography through `mitra`, whose address
  is mutable and, unlike a sector classification, legitimately changes when a partner moves. This is
  a different question with a different answer, and it should be decided (report the address at
  disbursement, or the current one) rather than inherited from whichever join someone writes first.
- **Report 14, SDGs**, cannot be a journal dimension at all. `nonpumk_proposal_sdg` is many to many,
  so one disbursement maps to several SDGs and a single `sdgId` on a line would either lose all but
  one or triple count the amount. 0027's totality rule refuses it correctly: a set of overlapping
  buckets is not a partition. Report 14 needs an explicit allocation rule from the client, or it
  reports counts and beneficiaries rather than money split by SDG.
- **`dimensi_json.sdgId` and `dimensi_json.programId` are declared and written by nothing**, which
  is worth knowing before someone builds a report on the assumption that they are populated.
- **The counter-example, and the model to copy:** `kolektibilitas_snapshot` carries `sektor_id` per
  akad, copied at run time, so per-sektor collectibility (report 10) is already immune to a later
  reclassification. That is the same idea as this ADR, arrived at two migrations earlier.

## Consequences

- `modules/closing` must extend `tutupPeriode` to write `saldo_akun_dimensi_periode` from
  `jurnal_baris.dimensi_json` using the same ADR 0010 ledger predicate it already uses for the
  parent, including a residual row wherever attribution is incomplete. Until it does, a closed
  period has no dimensioned rows and `modules/rka` must keep refusing rather than fall back to the
  live ledger. Same fail-closed handover as 0024, 0025 and 0026.
- `modules/pumk` must pass `dimensi: { sektorId }` on `PENCAIRAN_PUMK`. When it does,
  `rka-fixture.test.ts`'s two PENCAIRAN tests go red, which is the signal to delete them.
- `modules/rka`'s `metodeRealisasi` gains a third answer it can give for a closed period, and its
  `SKEMA_BELUM_LENGKAP` refusal narrows from "always, for PUMK and Non PUMK" to "when this period's
  freeze produced no decomposition on the axis this budget type needs".
- The pinned test `kolomAda("saldo_akun_periode", "sektor_id") === false` stays GREEN under this
  design and must be RE-PINNED to the existence of `saldo_akun_dimensi_periode`. A column-shaped pin
  cannot detect a table-shaped fix, and leaving it as-is would record the gap as open after it was
  closed.
- Report 14 stays unbuilt as a money report until the client supplies an allocation rule.
