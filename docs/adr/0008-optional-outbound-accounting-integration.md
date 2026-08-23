# 8. Optional outbound accounting integration, with the book of record undecided

Date: 2026-08-23

## Status

Accepted

## Context

The repo owner has settled the target product: **Accurate Online** (not Accurate 5 desktop),
so an official API exists. What is **not** settled is the bigger question:

> Does this system hold the authoritative TJSL books, or does Accurate Online?

Both answers are defensible.

- Spec section 1 says the TJSL unit is a separate reporting entity with its own financial
  statements in non-profit format (Posisi Keuangan, Aktivitas, Arus Kas, Perubahan Aset Neto).
  Read literally, this system is the book of record and reports 17 to 20 are the real thing.
- The parent BUMN already runs Accurate Online, and a KAP audits what Accurate holds. Making
  Accurate authoritative removes the risk of two ledgers with no clear owner.

The consequences differ enough that guessing is expensive:

| If decided | Consequence |
|---|---|
| This system stays the book of record | Accurate receives summarised journals for the parent's consolidation only. Reports 17 to 20 keep their status. Smallest change. |
| Accurate becomes the book of record | Our COA must mirror Accurate's exactly, reports 17 to 20 drop to management and reconciliation status, and the reporting phase changes scope substantially. |

A researcher is separately verifying Accurate Online's actual API (auth model, journal voucher
endpoint, whether an external reference is supported at all, line limits, period locking
behaviour) and owns `docs/INTEGRASI-ACCURATE.md`. So a second thing is also unknown: what the
integration is even capable of.

Two unknowns, and a schema that is already carrying committed ledger data. The question is what
to build now such that either answer, and either API outcome, costs a migration rather than a
rewrite.

## Decision

**Do not decide the ownership question in the schema. Build the integration as an optional,
inert, outbound layer, and keep the current default.**

Concretely:

1. **The default stands and is unchanged.** This system holds the books, produces the section
   10.3 statements in full, and `saldo_akun_periode` remains the reporting source of truth. This
   migration (`0016`) adds no column to `jurnal`, changes no trigger in `0007` or `0010`, demotes
   no report, and touches no account. Roll the integration layer back and the system behaves
   exactly as it did at `0015`.

2. **Inert until configured.** `sistem_eksternal` ships one pre-registered row
   (`ACCURATE_ONLINE`) with `aktif = false`, `konfigurasi.integrasi_akuntansi_aktif` defaults to
   `false`, and every other integration table starts empty. The four views in `0017` return zero
   rows and are referenced by no constraint. There is no code path that becomes mandatory because
   these tables exist.

3. **Export state does NOT gate period closing yet.** BUILD-PLAN item 5 (no journal in the period
   may be in the failed-send state) is the right rule *once pushes are really in use*. Wiring it
   now would make an undecided, inactive integration a hard dependency of the accounting cutoff,
   which is exactly backwards. The data is already there (`v_jurnal_belum_terkirim` reports failed
   and unsent journals per period), so coupling it later is one `BEFORE UPDATE` trigger on
   `periode` next to `trg_periode_10_transisi`.

4. **Account mapping is a table, not a column on `akun`.** `pemetaan_akun_eksternal` carries the
   target system, our account, Accurate's account number, Accurate's internal id, a name snapshot,
   an active flag and the standard audit block. Reasons, in order of weight:
   - a column on `akun` would only fit one target system and one identifier, and Accurate needs
     at least two identifiers (the number a human reconciles against, the surrogate id an API
     expects back);
   - the mapping is versionable and auditable in its own right, which a column is not: when a
     push starts landing in the wrong account, the question is "who changed the mapping, when",
     and that has to be answerable;
   - a mapping can be deactivated without touching the account, which matters because the account
     is referenced by posted journal lines and must not be edited casually;
   - and it keeps `akun` free of a foreign concern in the case where this system stays
     authoritative and the mapping is only used for a summarised consolidation feed.

   The mapping references `akun(postable_id)` (the generated column from ADR 0003), so only
   accounts that can actually appear in a journal line can be mapped, and a mapped account cannot
   be flipped to non-postable. Both directions are unique while active, so the mapping is a
   bijection and per-account reconciliation has a well-defined answer.

   **Missing mappings are found before a push, not during one.** `v_akun_belum_dipetakan` lists
   every account that is already in use (it has POSTED or REVERSED journal lines, or an active
   `event_jurnal_mapping` points at it) and has no active mapping, and it includes
   registered-but-inactive targets on purpose, because validating the mapping is a
   pre-activation step.

5. **Idempotency is anchored on our `no_jurnal`.** `jurnal_ekspor.referensi_eksternal` is our
   journal number, forced equal to `jurnal.no_jurnal` by trigger and unique per target system.
   This choice survives both API outcomes: if Accurate accepts an external reference, that value
   is the reference and duplicate posting is impossible on their side; if it does not, the same
   column is the key of our own guard and duplicate posting is impossible on ours. Anchoring on
   an id that Accurate generates would have been the natural alternative and is strictly worse
   here: it does not exist until after the first attempt, which is precisely the moment a retry
   after a timeout needs it.

6. **Export state lives outside `jurnal`, in `jurnal_ekspor`.** Four reasons:
   - `jurnal` is immutable once POSTED (ADR 0005). Export state changes many times *after*
     posting: queued, attempted, failed, retried, sent. Columns on `jurnal` would force the
     immutability guard to carve out a mutable region in the middle of the ledger row, which is
     exactly the kind of exception that later gets abused.
   - Export state is per target. One journal can eventually go to more than one system; columns
     on `jurnal` can hold only one destination.
   - It keeps the optional layer optional. Delete `jurnal_ekspor` and the ledger is untouched.
   - It is a different lifecycle with a different owner: the ledger is written by the accounting
     engine, the export trail by a background pusher, and separating them means the pusher never
     holds a write lock on a ledger row.

   The table carries attempt bookkeeping, the adapter used, an optional export-file link, and a
   **payload fingerprint pair**: `sidik_payload` (what the canonical payload hashes to now) and
   `sidik_payload_terkirim` (what was hashed at the moment of the send). A mismatch means the
   payload changed after the send, and `v_ekspor_payload_berubah` reports it, so a silently
   altered payload cannot masquerade as the same send. The evidence of a send is frozen once
   recorded: no re-send, no downgrade, no rewriting the reference, the sent fingerprint or their
   id. A correction is a reversing journal, which becomes its own export row.

   The exact state machine, and why `TERKIRIM` is terminal for the *send* but not a permanent
   claim about the *remote record*, is ADR 0009: it follows from what the API research found and
   is worth its own decision record.

7. **One export port, two adapters, selected as data.** `sistem_eksternal.adapter_aktif` and
   `jurnal_ekspor.adapter_dipakai` are `API` or `FILE`, and `berkas_ekspor` models a file-based
   push (with a CHECK that the file's totals balance, because a one-sided export file is a bug,
   not an edge case). If the API turns out to be restrictive, the file path is already modelled,
   not retrofitted.

8. **External balances land in a table, not in a live API call.**
   `saldo_akun_eksternal` snapshots what the other system reports, per period per account, with
   the same debit-positive convention and the same self-checking identity as
   `saldo_akun_periode`. Reconciling a closed period against a live API would break invariant 14:
   re-running last quarter's reconciliation would compare our frozen snapshot against whatever
   Accurate says today, and the report would change under the auditor. `v_rekonsiliasi_eksternal`
   compares the two snapshots and is deliberately symmetric: it is the same query whichever side
   turns out to be authoritative, only the *meaning* of a difference changes.

9. **Two-way journal sync is rejected outright, in either outcome.** Nothing is ever written into
   this ledger from outside. This is encoded, not merely documented: `sistem_eksternal.arah` has a
   `CHECK (arah = 'KELUAR')`, so an inbound configuration cannot be represented without an
   explicit, reviewable schema change. The reason is ownership of correctness: a bidirectional
   journal sync means two writers, two clocks and two idempotency schemes over the same
   double-entry data, and the failure mode is a silent duplicate or a silent gap in a set of books
   that will be audited. Reconciliation gives the same visibility with none of that risk, which is
   why the reconciliation snapshot is inbound but journals never are.

10. **Nothing endpoint-specific enters the schema.** No URL, endpoint, field name or auth scheme.
    What the API research can still change is data (`adapter_ekspor`, `granularitas_push`,
    `referensi_eksternal_didukung`, `maks_baris_per_dokumen`) rather than DDL.

## Consequences

- The ownership decision stays genuinely open, and taking either branch is now cheap: keeping the
  books means using `granularitas_push = REKAP_PERIODE` and nothing else changes; making Accurate
  authoritative means filling in the mapping, switching `pemegang_buku_resmi` to `EXTERNAL`,
  coupling export state to closing, and restating reports 17 to 20 as management reports. Neither
  branch needs a schema rewrite.
- The cost of being undecided is five tables and four views that may stay empty for months. That
  is the cheapest insurance available against the alternative, which is discovering the answer
  after 20 periods are closed.
- There is a real risk this ADR is superseded rather than amended. If Accurate becomes
  authoritative, "our COA must mirror theirs" is a constraint on the chart of accounts itself, and
  that deserves its own ADR because it changes what `akun` is allowed to be, not just what it maps
  to.
- ADR 0009 extends this one with the consequences of the API research (no idempotency on their
  side, mutable vouchers, silent sub-ledger party mismatch). It refines the export state model and
  the reconciliation landing shape; it does not reopen the ownership question.
- The pending API research can invalidate specific columns (for example `id_eksternal` may never
  be populated). Every such column is nullable and recorded in ASSUMPTIONS.md, so the failure mode
  is an unused column, not a broken constraint.
- The export layer intentionally has no schedule, worker or retry policy in the schema. Retry
  budget is `konfigurasi.maks_percobaan_kirim`; the rest is the application's business.
