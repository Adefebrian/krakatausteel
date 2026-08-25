# 15. What the closing tables record, and what they only appear to record

Date: 2026-08-25

## Status

Accepted

## Context

ADR 0014 fixed one reconstruction gap, in `kolektibilitas_snapshot`, and named two more places to
look. The closing engine has since been implemented, which turned one of those from a design
question into a settled fact and turned a second, previously invisible, into a visible one.

Three records are judged here. They are one ADR rather than three because they are one question:
does a row in a closing table say what a reader will take it to say, three years later, with the
configuration changed and the engine's source unavailable.

## Decision

### 1. `akrual_jasa_snapshot` records the method and the eligible classes. Per row.

`akuntansi.metode_pengakuan_jasa_adm` decides whether spec 8.3 runs;
`akuntansi.akrual_hanya_untuk_kolektibilitas` decides which akads it runs over. `HasilAkrual`
computes both and discards them, and both live in `konfigurasi`, which is mutated in place. So an
edit to either left a closed period's report 30 unable to say why its population is its
population. migrations/0025 adds `metode` and `kelas_diakrual`, both `NOT NULL`, neither with a
default, and refuses to run against pre-existing rows rather than guessing what produced them.

**Why a per-row column is right now and was not right in 0014's review.** At that point the fact
was per run and the accrual had no run header to hang it on, so inventing a shape while the engine
was being written would have been the guess this project keeps refusing to make. The engine settled
it: `jalankanAkrualJasaAdm` writes one row per akad in the configured classes *including akads with
zero fee due*, because with no run header, a period where the step ran and produced nothing was
indistinguishable from a period where it never ran. There is now a per-akad row, and repeating a
per-run value on every row of the run is exactly what `kolektibilitas_snapshot` already does with
`rate_penyisihan` and `dasar_perhitungan`. No new table, no header to invent.

**What this recovers.** In any period where at least one akad fell in the configured classes, every
row carries the list, so the list is recovered and it explains *every* exclusion in that period: an
akad with no row was not in `kelas_diakrual`. That is the whole of the reporting question for every
period in which an accrual journal was posted.

**What it does not recover, stated plainly.** A period whose class list excluded the entire
portfolio has no rows, so it carries no list. Worse than the missing list: such a period has no
trace of the accrual step at all. No snapshot, no journal, and no audit record either, because
`jalankanAkrualJasaAdm` writes none. Prerequisite check 6 passes it through the
`adaRun && !adaKandidat` branch, and that branch reads `akrual_hanya_untuk_kolektibilitas` **as it
is at the moment the checklist runs**, not as it was at the close. So re-running the checklist over
that closed period after the list widens can report GAGAL for a period that is already CLOSED.

**Is that acceptable?** Yes for now, no permanently, and the distinction is not a hedge:

- It is acceptable *today* because the unexplained thing is a checklist pass, not a number. No
  journal was posted, no balance depends on it, and no figure in the financial statements traces
  back to it. Every period that moved money is fully explained by the columns 0025 adds.
- It is not acceptable *permanently*, because "the step ran" is a fact the schema should hold and
  currently infers from the presence of rows. The zero-row-per-akad design shrinks that problem
  rather than solving it: it works precisely when the population is non-empty and fails exactly
  when it is empty.

**So it does argue for a run-header table, and I am saying so rather than calling the question
closed.** The eventual shape is `closing_akrual (periode_id, cabang_id, metode, kelas_diakrual,
dijalankan_oleh, tanggal_jalan, ...)`, unique per (periode, cabang), mirroring
`closing_kolektibilitas`, with check 6 reading the header instead of counting rows and the
per-row copies kept for report 30's convenience. It is not built here because it is a change to a
module whose engine shipped two hours ago, it touches check 6's pass condition, and it is not
urgent: 0025 covers every period that posts anything. Recorded as OPEN-QUESTIONS item 23 with an
owner and a deadline, which is before the first production close, not "someday".

**No `CHECK (kelas_diakrual ? kolektibilitas)`, deliberately.** It would pass today and it would
forbid the obvious way to close the residual hole, which is to write a row for every akad and let
that same expression distinguish accrued from excluded. Eligibility stays a read-time predicate,
correct under both population rules.

### 2. The provision is carried by a SET of journals. A join table says so, and checks it.

A corrected re-run posts a **second** journal for the delta and repoints `jurnal_id` at it. The
arithmetic is right and idempotent. The record is not: a column named `jurnal_id`, singular, on a
row whose amount is carried by one *or more* entries.

QA probed it rather than reasoning about it. A requirement of 10.200.000 posts one journal;
a corrected rate posts a second for 1.200.000; the ledger ends at 11.400.000, correctly; and
`penyisihan_periode` then states 11.400.000 next to a link to an entry worth 1.200.000. That is
spec 16 scenario 17: an operator reconciling Laporan Perhitungan Penyisihan against the provision
journal. Following `jurnal_id` reconstructs 1.200.000 against a stated 11.400.000 and fails the
check the specification asks for; summing every provision journal in the period reconciles. Both
readings are defensible from migrations/0011, and that is the defect: the schema does not say which
is correct.

**Delta posting is kept.** Reversing a correct entry to re-post a larger one puts churn in the
ledger for a refinement, and in this system a reversal MEANS a mistake was made (ADR 0010, spec
6.3). The ambiguity is a modelling defect and is fixed in the model, not by constraining the engine
to produce exactly one journal forever.

**migrations/0026 adds `penyisihan_periode_jurnal` and DROPS the singular column.** Leaving the
column beside the join table would preserve the exact ambiguity: a report author follows it because
it is there.

**Why not derive the set from `(periode_id, cabang_id, jenis = 'PENYISIHAN')`.** It is the cheap
option and it fails on both counts that matter. It is a heuristic rather than a record, because a
manual journal may legitimately carry that `jenis` for the same period and branch and would be
counted into the automated movement with nothing to distinguish it. And it is unenforceable: a
derived set cannot be checked against `beban_penyisihan_periode`, so the one property scenario 17
depends on would rest on a convention. An implicit link nothing verifies is the same class of thing
as a stored default nothing reads.

**A REVERSED POSITION, RECORDED RATHER THAN QUIETLY DROPPED.** The first draft of this ADR argued
for `jurnal.referensi_tipe` / `referensi_id`, the polymorphic back-reference the ledger already
ships and modules/pumk already uses: right multiplicity, right direction, no new table, indexed.
Held against the requirement that a disagreement must fail loudly, it does not survive. It carries
no signed contribution, so a formation and a recovery cannot be told apart without inspecting the
lines; `referensi_id` is deliberately not a foreign key, because it spans a dozen tables; and
enforcing the total through it would mean a closing-specific aggregate trigger on `jurnal` itself,
putting one module's arithmetic inside the shared ledger table. The engine should still set it, for
the audit trail and for the reversal registry, but it is not the record of the provision.

**The property, and how it is enforced.** `SUM(nilai)` over a row's live links equals its
`beban_penyisihan_periode`, or the transaction does not commit. A deferred constraint trigger,
because the row and its links are written in either order inside one transaction, and installed on
BOTH tables, because otherwise the movement could be restated without touching the links. It holds
exactly under the engine's own delta arithmetic including recoveries: 10.200.000, then +1.200.000,
then -2.400.000 sums to the 9.000.000 the row would then state. Precedent for a deferred cross-row
invariant is 0008's `SUM(pokok) = akad.pokok_pinjaman`, extended by 0019.

Three further guards, all demonstrated refusing real rows: a link must name a journal of the same
period and branch (TJSL-PEN-001), must not name a DRAFT journal (TJSL-PEN-002), and its signed
contribution must equal that journal's own amount (TJSL-PEN-003). Plus a unique index on
`jurnal_id` alone, not on the pair: a journal belongs to exactly one period-branch provision, and
double attribution across rows is how a total inflates while every individual row still looks
right.

**Reversal does not break it, on purpose.** Reversing a provision journal is a supported correction
(closing-penyisihan.test.ts does it, "salah periode"), and the system reads the consequence from
the LEDGER: the next period's opening allowance comes from `v_ledger_baris`, never from these rows.
A link records which entry carried a decision when it was made, and a later reversal does not
retroactively unmake that fact. No trigger on `jurnal` fires here and that workflow is unchanged.
What the schema does NOT and should not guarantee is that the ledger still agrees with a closed
row after such a reversal; that is the business-state half of spec 6.3 and belongs to the
`PembalikStateBisnis` registry in the closing module.

**Reopen.** `bukaKembaliPeriode` deletes `saldo_akun_periode` and nothing else, so a reopened
period keeps its provision row, its journals and its links; re-running appends one more delta and
one more link, and the invariant holds across the re-close by construction. The foreign key to
`penyisihan_periode` is restrictive rather than ON DELETE CASCADE: nothing deletes that row today,
and a future deletion that would orphan the journals of a closed period should fail loudly.

### 3. `CLOSING_IN_PROGRESS` is kept, and stops being ambiguous.

Defined by the specification (Bagian 4.7), allowed by 0007's CHECK, written by nothing.

**Kept.** Three reasons, in order of weight. It is spec-named, and dropping a spec-named enum
member is a deviation that has to buy something; this one would buy nothing, because an unused
CHECK value costs no bytes and no code path. It is not inert: the ledger's period guard already
refuses any journal in a period that is not OPEN, so the value has a live and correct meaning the
day anyone writes it, "books frozen, month end in progress". And re-adding it later is a migration,
against a spec that will still name it.

**It is not a crash-recovery marker, and nobody should keep it on that argument.** `tutupPeriode`
runs in one transaction, so a crash rolls the whole close back and leaves nothing half-finished to
find; and no other session can observe an uncommitted status in any case. Writing it inside that
transaction would buy exactly nothing.

**What it is actually for**, if anything, is the month-end *sequence*, which spans four separate
transactions (8.1 collectibility, 8.2 provision, 8.3 accrual, 8.4 close) with ordinary posting
allowed in between. Whether the books should be frozen across that window is a client policy
question with a real operational cost either way, filed as OPEN-QUESTIONS item 24. Until it is
answered the value stays unwritten, and migrations/0025 says so in a `COMMENT` on the column, so
the next reader does not have to re-derive that it is unreachable.

## Consequences

- The accrual engine must supply `metode` and `kelas_diakrual` on every `akrual_jasa_snapshot`
  insert, and the provision engine must write a `penyisihan_periode_jurnal` row for every journal
  it posts and stop writing `penyisihan_periode.jurnal_id`, which no longer exists. Until both
  happen, those paths fail loudly at write time. Same fail-closed handover as 0024.
- Report 30 can state its own population without reading `konfigurasi`, and eligibility per row is
  `kelas_diakrual ? kolektibilitas`. Report 28 can list every entry making up a period's movement,
  with its signed contribution, and the database guarantees the list adds up.
- `PenyisihanPeriode.jurnalId` in the module contract becomes a set. `eventCode` stays useful as
  the direction of the LATEST movement, but the per-entry direction now lives on the link rows.
- A period with an empty accrual population remains unexplained, by decision, until the
  `closing_akrual` header lands. Nobody should describe OPEN-QUESTIONS item 23 as closed.
- Two follow-ups belong to the closing module, not to the schema. Populating
  `jurnal.referensi_tipe` / `referensi_id` on closing journals, with the `PembalikStateBisnis`
  handler that then becomes mandatory for reversing one. And a locking read of `periode` in
  `tutupPeriode`: `repo.periode` takes no row lock and `tandaiClosed`'s UPDATE carries no status
  predicate, so two concurrent closes both pass the checklist and both write a SUKSES audit record.
- One defect in this work was found by probing and not by reading, and it is worth remembering:
  plpgsql resolves every field reference in an expression it evaluates, so a single trigger
  function serving two tables must branch with IF statements, never with a CASE expression over
  `NEW`. It failed with "record new has no field" only when the OTHER table fired it.
