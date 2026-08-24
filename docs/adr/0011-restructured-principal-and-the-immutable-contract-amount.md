# 11. The restructured principal, and why the contract amount stays immutable

Date: 2026-08-23

## Status

Accepted

## Context

The angsuran engine's tests found that `pumk_reschedule.jenis` allows `RESTRUKTUR_POKOK` while
the table had no column for a changed principal. Spec 7.3 item 7 says a reschedule that changes
the principal must produce a correction journal, and one that does not must produce none. Only
the second half was testable: the first branch was unreachable from the schema, so the QA agent
correctly refused to invent a column and reported the gap instead.

Four things had to be decided rather than defaulted.

## Decision

### 1. Absolute value, frozen basis, and a generated delta. All three, not one of them.

`pumk_reschedule` now carries `outstanding_pokok_sebelum` (and `outstanding_jasa_sebelum`), the
outstanding computed at approval per spec 7.3 step 2, plus `pokok_baru`, the new absolute
principal. `delta_pokok` is a **stored generated column**, `pokok_baru - outstanding_pokok_sebelum`.

Storing only the absolute value would leave the journal amount depending on whatever
`outstanding_pokok` happens to be when someone asks, which changes with every later payment.
Storing only a delta would leave the new principal equally underdetermined. The correction
journal's amount is a difference, and a difference is unambiguous only when both operands are
recorded. Generating the delta from them means the journal amount can never disagree with the two
numbers it was derived from, and the whole restructure stays reconstructable years later.

Sign convention: positive is *penambahan pokok*, negative is *pengurangan*. `NULL` means no
principal change at all, which per spec 7.3 item 7 means no correction journal.

### 2. A CHECK, not a convention.

`pokok_baru` exists **if and only if** `jenis = 'RESTRUKTUR_POKOK'`
(`pumk_reschedule_pokok_baru_jenis_ck`). A tenor extension carrying a principal, and a principal
restructure without one, are both rejected by the database. Three companions:

- an approved reschedule must know the balance it restructured (`..._basis_ck`);
- an approved `RESTRUKTUR_POKOK` whose new principal equals the old one is refused
  (`..._delta_bukan_nol_ck`): that is a tenor or grace change wearing the wrong `jenis`;
- a correction journal can only hang off a `RESTRUKTUR_POKOK` row (`..._koreksi_jenis_ck`), which
  is spec 7.3 item 7's first half as a constraint; and a deferred trigger (`TJSL-RSC-001`)
  requires that an approved principal restructure actually *has* its correction journal, which is
  the second half.

### 3. The version-1 invariant finally has its companion.

`0008` enforced `SUM(pokok) = akad.pokok_pinjaman` for schedule version 1 only, and ASSUMPTIONS
A-19 recorded the gap: later versions were unchecked, because a reschedule restructures the
remaining balance rather than the contract principal. They are checkable after all, through the
link `pumk_jadwal_versi.reschedule_id` that `0008` already created. For version *v > 1* the basis
is `coalesce(pokok_baru, outstanding_pokok_sebelum)` of the reschedule that produced it, enforced
deferred exactly like version 1 (`TJSL-JDW-006`).

This also promotes "a version above 1 exists because of a reschedule" from expectation to rule
(`TJSL-JDW-004`): without the link there is no basis to check against, so the link is required.
Deferred, so the engine may insert the version header before it has the reschedule id as long as
both are set by COMMIT. **This is a contract the angsuran engine must satisfy**: any schedule
version above 1 must name its reschedule row.

### 4. `pumk_akad.pokok_pinjaman` stays immutable. The restructure is recorded separately.

This was the accounting question, and the conservative option is implemented:

- `pokok_pinjaman` remains the principal as contracted and signed;
- `pokok_restruktur_kumulatif` accumulates the approved deltas, signed;
- `pokok_pinjaman_efektif` is a **generated** column, `pokok_pinjaman + pokok_restruktur_kumulatif`,
  and is the figure the Kartu Piutang should present as the current principal.

Two arguments beyond bookkeeping taste made this decisive rather than a preference:

- mutating `pokok_pinjaman` would break the already-pushed version-1 invariant, because the
  original schedule's total would no longer equal the (new) contract principal, and that trigger
  fires on any later touch of a version-1 row;
- a principal **increase** would violate the old `CHECK (outstanding_pokok <= pokok_pinjaman)`.
  That is why `penambahan pokok` was not merely unmodelled but literally unrepresentable. The
  check is replaced with one against the effective principal, plus
  `pokok_pinjaman + pokok_restruktur_kumulatif > 0` so a reduction cannot pass through zero.

`pokok_restruktur_kumulatif` is maintained by the engine, not by a trigger: silently mutating one
financial row from another is how ledgers drift. But the two may never disagree, so a deferred
constraint trigger enforces equality with the sum of approved `RESTRUKTUR_POKOK` deltas for that
akad (`TJSL-RSC-002`), from both sides of the relationship.

Whether the client's accountants would rather restate the contract amount is a policy question,
not a technical one, and it is recorded in OPEN-QUESTIONS.md item 21. If they choose restatement,
this ADR gets superseded and the version-1 invariant has to be rethought at the same time,
because the two are the same decision seen from two ends.

## Consequences

- Spec 7.3 item 7 is now testable in both directions, which is what the QA agent was blocked on.
- The Kartu Piutang and every report showing "principal" must decide which of the two figures it
  means. `pokok_pinjaman_efektif` is almost always the right one for an operational view;
  `pokok_pinjaman` is the right one when reconciling against the signed akad document.
- An approved principal restructure cannot be recorded without its correction journal, so the
  engine must create both in one transaction. Deferred checks make the ordering inside that
  transaction free.
- A schedule version above 1 without a `reschedule_id` is now rejected at COMMIT. Legacy
  multi-version histories imported without reschedule rows would fail, which is deliberate: an
  unexplained version is a number nobody can defend. If the go-live import needs to carry such
  history, it should synthesise the reschedule rows that explain it.
