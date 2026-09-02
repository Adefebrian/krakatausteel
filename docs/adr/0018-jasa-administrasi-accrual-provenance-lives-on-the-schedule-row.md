# 18. Accrual provenance for jasa administrasi lives on the schedule row

Date: 2026-09-02

## Status

Accepted

## Context

Piutang Jasa Administrasi (1.1.04) carried a **negative** balance of about
Rp -86,7 juta on the twenty four month demo world, while Pendapatan Jasa Administrasi showed
only Rp 12,6 juta on a Rp 4,6 miliar portfolio. Every one of the spec 9.6 integrity views
passed, all 46 acceptance checks of the seed passed, and the balance sheet balanced, because
the missing income and the missing receivable were the same amount with opposite signs. No
arithmetic was wrong anywhere. The CLASSIFICATION was.

Two modules, each defensible on its own:

1. `modules/angsuran` chose the jasa event for a receipt from a single configuration cell,
   `akuntansi.metode_pengakuan_jasa_adm`. That cell ships as `ACCRUAL`, so **every** receipt
   posted `ANGSURAN_JASA_ADM_AKRUAL`, which credits 1.1.04 on the assumption the receivable
   already exists.
2. `modules/closing` accrues `jasa_jatuh_tempo_periode - jasa_diterima_periode` per akad per
   period. An instalment PAID IN THE MONTH IT FALLS DUE nets to zero, so it is never accrued,
   so nothing ever DEBITS 1.1.04 for it.

The credit happened, the matching debit did not. On a portfolio where most instalments are paid
on time, that is most of the portfolio.

OPEN-QUESTIONS item 3 had recorded the ambiguity in 6.4 and 8.3 since before the engine was
built, and had already named the right rule ("engine bisa memutuskan per rupiah: sebesar yang
pernah diakrual pakai event akrual, sisanya pakai event non akrual"). What it had wrong was
where the fact would come from: it assumed `akrual_jasa_snapshot` would be enough.

## Decision

### 1. The receipt follows the FACT, not the policy cell

The event for a receipt's jasa leg is decided per rupiah by whether that rupiah was actually
accrued. `akuntansi.metode_pengakuan_jasa_adm` is no longer read by `modules/angsuran` at all.

This is not a way of avoiding the policy question; it answers it as a consequence. Under
`CASH_BASIS` the accrual step writes nothing, so every row reports zero accrued and every
receipt is direct income, exactly as before. It additionally gets two cases the config cell
cannot see:

- an akad whose class is outside `akrual_hanya_untuk_kolektibilitas` was never accrued, so its
  jasa is always direct income. The standard non-performing treatment falls out of the same
  rule instead of needing a branch of its own;
- a config edited from `ACCRUAL` to `CASH_BASIS` still has to collect the receivables already
  booked under the old policy. Reading the cell would have re-recognised that income.

### 2. The fact belongs on the schedule row, not on the period snapshot

`akrual_jasa_snapshot` is per akad per period and carries one total. A receipt arriving in M+2
against instalments due in M and M+1 cannot ask it "how much of THIS line's jasa is already in
1.1.04" without re-deriving the answer from the whole accrual and collection history, and a
re-derivation that disagrees with the ledger is precisely the failure that produced the defect.

`0030` therefore adds `pumk_jadwal_angsuran.jasa_akrual_belum_tertagih`: a live remaining
balance, set by the accrual step, consumed by a receipt, restored by a reversal. Not an
accrued-ever total, because the question a receipt asks is "how much is STILL there", and an
accrued-ever column would force every reader to subtract a collection history it does not have.

### 3. The CHECK is the actual control, not the TypeScript

```sql
CHECK (jasa_akrual_belum_tertagih >= 0
   AND jasa_akrual_belum_tertagih <= jasa_adm - jasa_terbayar)
```

A receipt may credit 1.1.04 only for jasa the row says is there; the row may never claim more
than it still owes; and `pumk_jadwal_terbayar_ck` already forbids overpaying a row. Together
those bound total credits to 1.1.04 by total debits to it, so a negative Piutang Jasa
Administrasi is structurally unreachable rather than merely unlikely. Consistent with ADR 0002:
the invariant that matters is in Postgres, and the engine re-checks it only so the caller gets a
sentence instead of a constraint name.

### 4. Two legs on one journal, when the receipt needs both

A partial payment against a partly-accrued row clears the receivable up to what was accrued and
recognises the remainder as income. Those are two accounts, so they are two COMPONENTS of the
same journal. Spec 7.2 step 8 forbids a second journal, not a second line, and
`postingEventGabungan` already takes a component list, so no event model change was needed. The
brief anticipated that it might be, and asked for two events rather than a bypass; it was not.

### 5. Accrued jasa moves with a reschedule, and a restructure that cannot hold it is REFUSED

Accrued jasa on a retired schedule version is money already in the ledger. Allocation only walks
the ACTIVE version, so leaving it behind would strand a receivable no future receipt could ever
clear. `setujuiReschedule` carries the balance onto the new version's rows, earliest first,
inside the same transaction.

When the new version has no room for it, the engine refuses with `AKRUAL_TIDAK_TERTAMPUNG`
rather than dropping the remainder. That case means the restructure recognises less jasa than
has already been booked as income: it is a WAIVER, it needs a correcting journal, and spec 6.4
lists no event for one. Same seam and same answer as `RESTRUKTUR_POKOK`, which this engine
already refuses for the same reason.

### 6. Reversal restores exactly what was taken, from a provenance row

`pumk_angsuran_akrual` records what each receipt consumed, per schedule row.
`pulihkanAkrualSetoran` gives it back and is idempotent. A recomputed approximation would land
on whichever row looks plausible later, which leaves 1.1.04 right in total and wrong per akad,
and per akad is exactly what spec 8.4 check 10 reconciles.

## Consequences

- On the regenerated demo world (24 months to 2026-09), Piutang Jasa Administrasi is
  **+Rp 2.057.620,67** and Pendapatan Jasa Administrasi is **Rp 101.363.917,77**, against
  -Rp 86.693.337,67 and Rp 12.612.959,43 under the old rule on the same data. 1.1.04 equals
  `SUM(jasa_akrual_belum_tertagih)` over active schedule rows to the sen, income equals jasa
  collected plus jasa accrued-but-uncollected to the sen, and 1.1.04 is non-negative at every
  one of the twenty four month ends. All 46 acceptance checks still pass.
- The accrual step is now idempotent per row by construction: it SETS
  `jasa_adm - jasa_terbayar` rather than adding, so re-running a period's accrual after a
  collection lands on the smaller correct number. An akad that has dropped OUT of the population
  between runs is reset to zero rather than left carrying a stale balance.
- **`modules/angsuran` and `modules/closing` are now coupled through a column.** That coupling
  is the point (it is what makes the two engines agree), but it is a real constraint: any future
  writer of `AKRUAL_JASA_ADM` journals must write this column in the same transaction, or the
  ledger and the sub-ledger diverge again in exactly the old way. Stated on the column comment
  as well as here.
- **Receipt reversal is still not implemented, and this ADR does not implement it.** No
  `PembalikStateBisnis` is registered for `referensi_tipe = 'pumk_angsuran'`, so `reversalJurnal`
  refuses such a journal outright, and `pumk_angsuran` stores no per-row allocation to un-apply.
  What exists now is the half this module owns. The ordering contract is not optional: a future
  reverser must restore the payment columns FIRST and then call `pulihkanAkrualSetoran`, because
  the CHECK in decision 3 leaves a row whose jasa reads as collected with no room for the
  receivable back.
- **A pre-existing defect this work uncovered and did NOT fix.** Re-running a period's accrual
  with a different total posts a SECOND `AKRUAL_JASA_ADM` journal without reversing the first
  (`jalankanAkrualJasaAdm` keys idempotency on `closing:akrual:<periode>:<cabang>:<total>` and
  `hapusAkrual` deletes only the snapshot rows). The per-row column stays correct because it is
  set rather than added, so the sub-ledger is right and the LEDGER is double-counted, which is
  the mirror image of the defect this ADR closes. Recorded in OPEN-QUESTIONS.
